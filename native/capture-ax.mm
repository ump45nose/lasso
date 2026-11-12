#include <node_api.h>
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <QuartzCore/QuartzCore.h>
#import <Carbon/Carbon.h>
#include <cmath>
#include <algorithm>
#include <vector>
#include <string>

struct CaptureBounds { double x,y,w,h; };
struct Query { napi_async_work work; napi_deferred deferred; int pid; double x,y; std::vector<CaptureBounds> rects; int error=0; bool permission=false; bool granted=false; };
struct BridgeEvent { std::string name; std::string payload; };
struct FinderTrigger { double x, y; bool rightHold; };
struct CopyWatchEvent { bool doubleCopy; double timestamp; };

@interface SnapPreviewOverlay : NSWindow
@end
@implementation SnapPreviewOverlay
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

struct SnappedOrigin { AXUIElementRef window; NSRect original; NSRect snapped; };
struct DragSnapSession {
  AXUIElementRef window = nullptr;
  NSRect initial = NSZeroRect, original = NSZeroRect, target = NSZeroRect;
  NSPoint down = NSZeroPoint;
  double grabRatioX = 0.5, grabOffsetY = 0;
  bool active = false, canRestore = false, hasTarget = false;
};

static napi_threadsafe_function g_bridge_tsfn = nullptr;
static id g_present_obs = nil;
static id g_dismiss_obs = nil;
static id g_prefs_obs = nil;
static NSMutableArray<NSPanel*>* g_glow_panels = nil;
static napi_threadsafe_function g_finder_tsfn = nullptr;
static id g_finder_monitor = nil;
static dispatch_source_t g_finder_timer = nil;
static NSPoint g_finder_down;
static napi_threadsafe_function g_copy_tsfn = nullptr;
static id g_copy_monitor = nil;
static double g_last_copy_time = -1;
static id g_drag_snap_monitor = nil;
static SnapPreviewOverlay* g_snap_preview = nil;
static DragSnapSession g_drag_snap;
static std::vector<SnappedOrigin> g_snapped_origins;

static void onMain(void (^block)(void));

static napi_value number(napi_env e,double n){napi_value v;napi_create_double(e,n,&v);return v;}
static void prop(napi_env e,napi_value o,const char*k,double n){napi_set_named_property(e,o,k,number(e,n));}

static void execute(napi_env,void* data){@autoreleasepool {
 auto*q=(Query*)data;if(q->permission){q->granted=CGPreflightScreenCaptureAccess()||CGRequestScreenCaptureAccess();return;}AXUIElementRef app=AXUIElementCreateApplication(q->pid);AXUIElementSetMessagingTimeout(app,0.06);
 // Chromium exposes its document containers only after accessibility is enabled.
 AXUIElementSetAttributeValue(app,CFSTR("AXManualAccessibility"),kCFBooleanTrue);
 AXUIElementRef element=nullptr;AXError err=AXUIElementCopyElementAtPosition(app,q->x,q->y,&element);q->error=err;
 for(int depth=0;element&&depth<10;depth++){
  AXUIElementSetMessagingTimeout(element,0.04);CFTypeRef pos=nullptr,size=nullptr;
  if(AXUIElementCopyAttributeValue(element,kAXPositionAttribute,&pos)==kAXErrorSuccess&&AXUIElementCopyAttributeValue(element,kAXSizeAttribute,&size)==kAXErrorSuccess&&CFGetTypeID(pos)==AXValueGetTypeID()&&CFGetTypeID(size)==AXValueGetTypeID()){
   CGPoint p;CGSize s;if(AXValueGetValue((AXValueRef)pos,(AXValueType)kAXValueCGPointType,&p)&&AXValueGetValue((AXValueRef)size,(AXValueType)kAXValueCGSizeType,&s)&&s.width>=12&&s.height>=12)q->rects.push_back({p.x,p.y,s.width,s.height});
  }
  if(pos)CFRelease(pos);if(size)CFRelease(size);CFTypeRef parent=nullptr;AXUIElementCopyAttributeValue(element,kAXParentAttribute,&parent);CFRelease(element);element=(AXUIElementRef)parent;
 }if(element)CFRelease(element);CFRelease(app);
}}

static void complete(napi_env e,napi_status status,void*data){auto*q=(Query*)data;if(q->permission){napi_value result;napi_get_boolean(e,q->granted,&result);napi_resolve_deferred(e,q->deferred,result);napi_delete_async_work(e,q->work);delete q;return;}napi_value out,arr;napi_create_object(e,&out);napi_create_array(e,&arr);for(size_t i=0;i<q->rects.size();i++){auto r=q->rects[i];napi_value o;napi_create_object(e,&o);prop(e,o,"x",r.x);prop(e,o,"y",r.y);prop(e,o,"width",r.w);prop(e,o,"height",r.h);napi_set_element(e,arr,i,o);}napi_set_named_property(e,out,"rects",arr);prop(e,out,"error",q->error);napi_resolve_deferred(e,q->deferred,out);napi_delete_async_work(e,q->work);delete q;}

static napi_value query(napi_env e,napi_callback_info info){size_t n=3;napi_value args[3];napi_get_cb_info(e,info,&n,args,nullptr,nullptr);auto*q=new Query();if(n!=3||napi_get_value_int32(e,args[0],&q->pid)!=napi_ok||napi_get_value_double(e,args[1],&q->x)!=napi_ok||napi_get_value_double(e,args[2],&q->y)!=napi_ok){delete q;napi_throw_type_error(e,nullptr,"pid, x and y required");return nullptr;}napi_value promise,name;napi_create_promise(e,&q->deferred,&promise);napi_create_string_utf8(e,"capture-ax",NAPI_AUTO_LENGTH,&name);napi_create_async_work(e,nullptr,name,execute,complete,q,&q->work);napi_queue_async_work(e,q->work);return promise;}

static napi_value windows(napi_env e,napi_callback_info){@autoreleasepool {napi_value arr;napi_create_array(e,&arr);NSArray* list=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID));NSMutableDictionary<NSNumber*,NSString*>* bundles=[NSMutableDictionary dictionary];uint32_t idx=0;for(NSDictionary*w in list){if([w[(id)kCGWindowOwnerPID] intValue]==getpid()||[w[(id)kCGWindowLayer] intValue]!=0)continue;CGRect r;CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(id)kCGWindowBounds],&r);if(r.size.width<40||r.size.height<30)continue;NSNumber* pid=w[(id)kCGWindowOwnerPID];NSString* bundle=bundles[pid];if(!bundle){bundle=[NSRunningApplication runningApplicationWithProcessIdentifier:pid.intValue].bundleIdentifier?:@"";bundles[pid]=bundle;}napi_value o,b;napi_create_object(e,&o);prop(e,o,"x",r.origin.x);prop(e,o,"y",r.origin.y);prop(e,o,"width",r.size.width);prop(e,o,"height",r.size.height);prop(e,o,"pid",[w[(id)kCGWindowOwnerPID] intValue]);prop(e,o,"id",[w[(id)kCGWindowNumber] intValue]);napi_create_string_utf8(e,bundle.UTF8String,NAPI_AUTO_LENGTH,&b);napi_set_named_property(e,o,"bundleId",b);napi_set_element(e,arr,idx++,o);}return arr;}}

static napi_value windowOnScreen(napi_env e,napi_callback_info info){size_t n=1;napi_value args[1];napi_get_cb_info(e,info,&n,args,nullptr,nullptr);uint32_t windowId;if(n!=1||napi_get_value_uint32(e,args[0],&windowId)!=napi_ok){napi_throw_type_error(e,nullptr,"window id required");return nullptr;}bool onscreen;@autoreleasepool {NSArray* list=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,windowId));NSDictionary* w=list.firstObject;onscreen=[w[(id)kCGWindowIsOnscreen] boolValue];}napi_value result;napi_get_boolean(e,onscreen,&result);return result;}

static napi_value requestScreen(napi_env e,napi_callback_info){auto*q=new Query();q->permission=true;napi_value promise,name;napi_create_promise(e,&q->deferred,&promise);napi_create_string_utf8(e,"capture-permission",NAPI_AUTO_LENGTH,&name);napi_create_async_work(e,nullptr,name,execute,complete,q,&q->work);napi_queue_async_work(e,q->work);return promise;}

/** Synthesizes Cmd+V to replace the active selection in the frontmost application. */
static napi_value paste(napi_env e, napi_callback_info) {
  @autoreleasepool {
    CGEventSourceRef source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    CGEventRef down = CGEventCreateKeyboardEvent(source, (CGKeyCode)9, true); // 'v'
    CGEventRef up = CGEventCreateKeyboardEvent(source, (CGKeyCode)9, false);
    CGEventSetFlags(down, kCGEventFlagMaskCommand);
    CGEventSetFlags(up, kCGEventFlagMaskCommand);
    CGEventPost(kCGHIDEventTap, down);
    CGEventPost(kCGHIDEventTap, up);
    if (down) CFRelease(down);
    if (up) CFRelease(up);
    if (source) CFRelease(source);
  }
  napi_value undefined;
  napi_get_undefined(e, &undefined);
  return undefined;
}

static napi_value pasteboardMeta(napi_env e, napi_callback_info) {
  napi_value result, concealed;
  napi_create_object(e, &result);
  @autoreleasepool {
    NSPasteboard* board = NSPasteboard.generalPasteboard;
    NSArray<NSPasteboardType>* types = board.types;
    bool sensitive = [types containsObject:@"org.nspasteboard.ConcealedType"] ||
      [types containsObject:@"org.nspasteboard.TransientType"] ||
      [types containsObject:@"org.nspasteboard.AutoGeneratedType"];
    prop(e, result, "changeCount", board.changeCount);
    napi_get_boolean(e, sensitive, &concealed);
    napi_set_named_property(e, result, "concealed", concealed);
  }
  return result;
}

static napi_value pasteToProcess(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value args[1], result;
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  int32_t pid = 0;
  if (n != 1 || napi_get_value_int32(e, args[0], &pid) != napi_ok || pid <= 0) {
    napi_throw_type_error(e, nullptr, "positive process id required");
    return nullptr;
  }
  __block bool activated = false;
  onMain(^{
    NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    activated = app && !app.terminated && [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    if (!activated) return;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != pid) return;
      CGEventRef down = CGEventCreateKeyboardEvent(nullptr, 9, true);
      CGEventRef up = CGEventCreateKeyboardEvent(nullptr, 9, false);
      if (down && up) {
        CGEventSetFlags(down, kCGEventFlagMaskCommand);
        CGEventSetFlags(up, kCGEventFlagMaskCommand);
        CGEventPost(kCGHIDEventTap, down);
        CGEventPost(kCGHIDEventTap, up);
      }
      if (down) CFRelease(down);
      if (up) CFRelease(up);
    });
  });
  napi_get_boolean(e, activated, &result);
  return result;
}

static NSPanel* createGlowStrip(NSRect frame, CGPoint startPoint, CGPoint endPoint) {
  NSPanel* panel = [[NSPanel alloc] initWithContentRect:frame
                                              styleMask:(NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel)
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
  panel.floatingPanel = YES;
  panel.level = NSStatusWindowLevel;
  panel.opaque = NO;
  panel.backgroundColor = [NSColor clearColor];
  panel.hasShadow = NO;
  panel.ignoresMouseEvents = YES;
  panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;

  NSView* view = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, frame.size.width, frame.size.height)];
  view.wantsLayer = YES;
  CAGradientLayer* grad = [CAGradientLayer layer];
  grad.frame = view.bounds;
  grad.colors = @[
    (__bridge id)[NSColor colorWithSRGBRed:217.0/255.0 green:119.0/255.0 blue:87.0/255.0 alpha:0.65].CGColor,
    (__bridge id)[NSColor colorWithSRGBRed:217.0/255.0 green:119.0/255.0 blue:87.0/255.0 alpha:0.0].CGColor
  ];
  grad.startPoint = startPoint;
  grad.endPoint = endPoint;
  [view.layer addSublayer:grad];

  CABasicAnimation* pulse = [CABasicAnimation animationWithKeyPath:@"opacity"];
  pulse.fromValue = @(0.28);
  pulse.toValue = @(0.95);
  pulse.duration = 1.2;
  pulse.autoreverses = YES;
  pulse.repeatCount = HUGE_VALF;
  pulse.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
  [grad addAnimation:pulse forKey:@"breathe"];

  panel.contentView = view;
  return panel;
}

/** Shows or hides 4 click-through 28pt breathing terracotta edge strips across the active screen. */
static napi_value setGlow(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value args[1];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  bool enabled = false;
  if (n >= 1) napi_get_value_bool(e, args[0], &enabled);
  dispatch_async(dispatch_get_main_queue(), ^{
    @autoreleasepool {
      if (g_glow_panels) {
        for (NSPanel* p in g_glow_panels) [p orderOut:nil];
        [g_glow_panels removeAllObjects];
      }
      if (!enabled) return;
      NSScreen* screen = [NSScreen mainScreen] ?: NSScreen.screens.firstObject;
      if (!screen) return;
      if (!g_glow_panels) g_glow_panels = [NSMutableArray new];
      NSRect f = screen.frame;
      CGFloat t = 28.0;
      NSPanel* top = createGlowStrip(NSMakeRect(f.origin.x, NSMaxY(f) - t, f.size.width, t), CGPointMake(0.5, 1.0), CGPointMake(0.5, 0.0));
      NSPanel* bottom = createGlowStrip(NSMakeRect(f.origin.x, f.origin.y, f.size.width, t), CGPointMake(0.5, 0.0), CGPointMake(0.5, 1.0));
      NSPanel* left = createGlowStrip(NSMakeRect(f.origin.x, f.origin.y, t, f.size.height), CGPointMake(0.0, 0.5), CGPointMake(1.0, 0.5));
      NSPanel* right = createGlowStrip(NSMakeRect(NSMaxX(f) - t, f.origin.y, t, f.size.height), CGPointMake(1.0, 0.5), CGPointMake(0.0, 0.5));
      for (NSPanel* p in @[top, bottom, left, right]) {
        [p orderFrontRegardless];
        [g_glow_panels addObject:p];
      }
    }
  });
  napi_value undefined;
  napi_get_undefined(e, &undefined);
  return undefined;
}

static void callBridgeJS(napi_env env, napi_value cb, void*, void* data) {
  auto* ev = (BridgeEvent*)data;
  if (env && cb) {
    napi_value obj, nameVal, payloadVal;
    napi_create_object(env, &obj);
    napi_create_string_utf8(env, ev->name.c_str(), NAPI_AUTO_LENGTH, &nameVal);
    napi_create_string_utf8(env, ev->payload.c_str(), NAPI_AUTO_LENGTH, &payloadVal);
    napi_set_named_property(env, obj, "name", nameVal);
    napi_set_named_property(env, obj, "payload", payloadVal);
    napi_value recv;
    napi_get_undefined(env, &recv);
    napi_call_function(env, recv, cb, 1, &obj, nullptr);
  }
  delete ev;
}

static void stopBridgeMonitoring() {
  onMain(^{
    NSDistributedNotificationCenter* center = [NSDistributedNotificationCenter defaultCenter];
    if (g_present_obs) [center removeObserver:g_present_obs];
    if (g_dismiss_obs) [center removeObserver:g_dismiss_obs];
    if (g_prefs_obs) [center removeObserver:g_prefs_obs];
    g_present_obs = g_dismiss_obs = g_prefs_obs = nil;
    if (g_bridge_tsfn) napi_release_threadsafe_function(g_bridge_tsfn, napi_tsfn_abort);
    g_bridge_tsfn = nullptr;
  });
}

static napi_value startBridge(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value args[1];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  napi_valuetype type;
  if (n != 1 || napi_typeof(e, args[0], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(e, nullptr, "bridge callback required");
    return nullptr;
  }
  stopBridgeMonitoring();
  napi_value name;
  napi_create_string_utf8(e, "lasso-nook-bridge", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(e, args[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr,
                                    callBridgeJS, &g_bridge_tsfn) != napi_ok) {
    napi_throw_error(e, nullptr, "Could not create bridge callback");
    return nullptr;
  }
  napi_unref_threadsafe_function(e, g_bridge_tsfn);

  onMain(^{
    NSDistributedNotificationCenter* center = [NSDistributedNotificationCenter defaultCenter];
    auto handler = ^(NSNotification* note) {
      if (!g_bridge_tsfn) return;
      NSString* json = note.userInfo[@"payload"] ?: (([note.object isKindOfClass:[NSString class]]) ? (NSString*)note.object : @"{}");
      auto* ev = new BridgeEvent{ std::string(note.name.UTF8String), std::string(json.UTF8String) };
      if (napi_call_threadsafe_function(g_bridge_tsfn, ev, napi_tsfn_nonblocking) != napi_ok) delete ev;
    };
    g_present_obs = [center addObserverForName:@"com.lasso.island.present" object:nil queue:[NSOperationQueue mainQueue] usingBlock:handler];
    g_dismiss_obs = [center addObserverForName:@"com.lasso.island.dismiss" object:nil queue:[NSOperationQueue mainQueue] usingBlock:handler];
    g_prefs_obs = [center addObserverForName:@"com.lasso.island.prefs" object:nil queue:[NSOperationQueue mainQueue] usingBlock:handler];
  });
  napi_value undefined;
  napi_get_undefined(e, &undefined);
  return undefined;
}

static napi_value stopBridge(napi_env e, napi_callback_info) {
  stopBridgeMonitoring();
  napi_value result;
  napi_get_undefined(e, &result);
  return result;
}

static napi_value postBridge(napi_env e, napi_callback_info info) {
  size_t n = 2;
  napi_value args[2];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  if (n >= 2) {
    char nameBuf[256] = {0};
    size_t payloadLen = 0;
    napi_get_value_string_utf8(e, args[0], nameBuf, sizeof(nameBuf), nullptr);
    napi_get_value_string_utf8(e, args[1], nullptr, 0, &payloadLen);
    std::string payload(payloadLen, '\0');
    napi_get_value_string_utf8(e, args[1], &payload[0], payloadLen + 1, nullptr);
    @autoreleasepool {
      NSString* nsName = [NSString stringWithUTF8String:nameBuf];
      NSString* nsPayload = [NSString stringWithUTF8String:payload.c_str()];
      [[NSDistributedNotificationCenter defaultCenter] postNotificationName:nsName
                                                                     object:nil
                                                                   userInfo:@{ @"payload": nsPayload ?: @"{}" }
                                                         deliverImmediately:YES];
    }
  }
  napi_value undefined;
  napi_get_undefined(e, &undefined);
  return undefined;
}

static bool setAxWindowRect(AXUIElementRef win, double x, double y, double w, double h) {
  if (!win) return false;
  CGPoint pt = CGPointMake(x, y);
  CGSize sz = CGSizeMake(w, h);
  AXValueRef posVal = AXValueCreate(kAXValueTypeCGPoint, &pt);
  AXValueRef sizeVal = AXValueCreate(kAXValueTypeCGSize, &sz);
  AXError e1 = AXUIElementSetAttributeValue(win, kAXPositionAttribute, posVal);
  AXError e2 = AXUIElementSetAttributeValue(win, kAXSizeAttribute, sizeVal);
  // Set position a second time in case resizing across displays clamped origin first
  AXUIElementSetAttributeValue(win, kAXPositionAttribute, posVal);
  if (posVal) CFRelease(posVal);
  if (sizeVal) CFRelease(sizeVal);
  return e1 == kAXErrorSuccess || e2 == kAXErrorSuccess;
}

static AXUIElementRef copyFrontWindow() {
  if (!AXIsProcessTrusted()) return nullptr;
  NSRunningApplication* app = NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!app || app.processIdentifier <= 0 || app.processIdentifier == getpid()) return nullptr;
  AXUIElementRef appRef = AXUIElementCreateApplication(app.processIdentifier);
  AXUIElementSetMessagingTimeout(appRef, 0.2);
  CFTypeRef win = nullptr;
  AXError error = AXUIElementCopyAttributeValue(appRef, kAXFocusedWindowAttribute, &win);
  if ((error != kAXErrorSuccess || !win) &&
      AXUIElementCopyAttributeValue(appRef, kAXMainWindowAttribute, &win) != kAXErrorSuccess) {
    win = nullptr;
  }
  CFRelease(appRef);
  if (!win) return nullptr;
  if (CFGetTypeID(win) != AXUIElementGetTypeID()) { CFRelease(win); return nullptr; }
  AXUIElementSetMessagingTimeout((AXUIElementRef)win, 0.15);
  return (AXUIElementRef)win;
}

static napi_value focusedWindowFrame(napi_env e, napi_callback_info) {
  @autoreleasepool {
    AXUIElementRef win = copyFrontWindow();
    if (win) {
      CFTypeRef position = nullptr, size = nullptr;
      AXError posError = AXUIElementCopyAttributeValue(win, kAXPositionAttribute, &position);
      AXError sizeError = AXUIElementCopyAttributeValue(win, kAXSizeAttribute, &size);
      CGPoint point = CGPointZero;
      CGSize dimensions = CGSizeZero;
      bool ok = posError == kAXErrorSuccess && sizeError == kAXErrorSuccess && position && size &&
        CFGetTypeID(position) == AXValueGetTypeID() && CFGetTypeID(size) == AXValueGetTypeID() &&
        AXValueGetValue((AXValueRef)position, kAXValueTypeCGPoint, &point) &&
        AXValueGetValue((AXValueRef)size, kAXValueTypeCGSize, &dimensions) &&
        std::isfinite(point.x) && std::isfinite(point.y) &&
        std::isfinite(dimensions.width) && std::isfinite(dimensions.height) && dimensions.width > 0 && dimensions.height > 0;
      if (position) CFRelease(position);
      if (size) CFRelease(size);
      CFRelease(win);
      if (ok) {
        napi_value rect;
        napi_create_object(e, &rect);
        prop(e, rect, "x", point.x);
        prop(e, rect, "y", point.y);
        prop(e, rect, "width", dimensions.width);
        prop(e, rect, "height", dimensions.height);
        return rect;
      }
    }
  }
  napi_value result;
  napi_get_null(e, &result);
  return result;
}

static void onMain(void (^block)(void)) {
  if (NSThread.isMainThread) block();
  else dispatch_sync(dispatch_get_main_queue(), block);
}

static void stopCopyMonitoring() {
  onMain(^{
    if (g_copy_monitor) [NSEvent removeMonitor:g_copy_monitor];
    g_copy_monitor = nil;
    g_last_copy_time = -1;
    if (g_copy_tsfn) napi_release_threadsafe_function(g_copy_tsfn, napi_tsfn_abort);
    g_copy_tsfn = nullptr;
  });
}

static void callCopyJS(napi_env env, napi_value callback, void*, void* data) {
  auto* event = (CopyWatchEvent*)data;
  if (env && callback) {
    napi_value result, doubleCopy, receiver;
    napi_create_object(env, &result);
    napi_get_boolean(env, event->doubleCopy, &doubleCopy);
    napi_set_named_property(env, result, "doubleCopy", doubleCopy);
    prop(env, result, "timestamp", event->timestamp);
    napi_get_undefined(env, &receiver);
    napi_call_function(env, receiver, callback, 1, &result, nullptr);
  }
  delete event;
}

static napi_value startCopyWatch(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value args[1];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  napi_valuetype type;
  if (n != 1 || napi_typeof(e, args[0], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(e, nullptr, "copy watch callback required");
    return nullptr;
  }
  stopCopyMonitoring();
  napi_value name;
  napi_create_string_utf8(e, "lasso-copy-watch", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(e, args[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr,
                                    callCopyJS, &g_copy_tsfn) != napi_ok) {
    napi_throw_error(e, nullptr, "Could not create copy watch callback");
    return nullptr;
  }
  napi_unref_threadsafe_function(e, g_copy_tsfn);
  onMain(^{
    g_copy_monitor = [NSEvent addGlobalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^(NSEvent* event) {
      NSEventModifierFlags excluded = NSEventModifierFlagControl | NSEventModifierFlagOption | NSEventModifierFlagShift;
      if (event.keyCode != 8 || event.isARepeat || !(event.modifierFlags & NSEventModifierFlagCommand) ||
          (event.modifierFlags & excluded) || !g_copy_tsfn) return;
      double interval = event.timestamp - g_last_copy_time;
      bool doubleCopy = g_last_copy_time >= 0 && interval >= 0 && interval <= 0.450;
      g_last_copy_time = event.timestamp;
      auto* copy = new CopyWatchEvent{doubleCopy, NSDate.date.timeIntervalSince1970 * 1000.0};
      if (napi_call_threadsafe_function(g_copy_tsfn, copy, napi_tsfn_nonblocking) != napi_ok) delete copy;
    }];
  });
  napi_value result;
  napi_get_undefined(e, &result);
  return result;
}

static napi_value stopCopyWatch(napi_env e, napi_callback_info) {
  stopCopyMonitoring();
  napi_value result;
  napi_get_undefined(e, &result);
  return result;
}

static bool axWindowRect(AXUIElementRef window, NSRect* rect) {
  CFTypeRef position = nullptr, size = nullptr;
  CGPoint point = CGPointZero;
  CGSize dimensions = CGSizeZero;
  bool ok = AXUIElementCopyAttributeValue(window, kAXPositionAttribute, &position) == kAXErrorSuccess &&
    AXUIElementCopyAttributeValue(window, kAXSizeAttribute, &size) == kAXErrorSuccess && position && size &&
    CFGetTypeID(position) == AXValueGetTypeID() && CFGetTypeID(size) == AXValueGetTypeID() &&
    AXValueGetValue((AXValueRef)position, kAXValueTypeCGPoint, &point) &&
    AXValueGetValue((AXValueRef)size, kAXValueTypeCGSize, &dimensions) &&
    std::isfinite(point.x) && std::isfinite(point.y) && std::isfinite(dimensions.width) &&
    std::isfinite(dimensions.height) && dimensions.width > 0 && dimensions.height > 0;
  if (position) CFRelease(position);
  if (size) CFRelease(size);
  if (ok) *rect = NSMakeRect(point.x, point.y, dimensions.width, dimensions.height);
  return ok;
}

static double screenTop() { return NSMaxY(NSScreen.screens.firstObject.frame); }
static NSRect axRectFromScreenRect(NSRect rect) {
  return NSMakeRect(rect.origin.x, screenTop() - NSMaxY(rect), rect.size.width, rect.size.height);
}

static void resetDragSnap() {
  [g_snap_preview orderOut:nil];
  if (g_drag_snap.window) CFRelease(g_drag_snap.window);
  g_drag_snap = DragSnapSession{};
}

static void showSnapPreview(NSRect frame) {
  if (!g_snap_preview) {
    g_snap_preview = [[SnapPreviewOverlay alloc] initWithContentRect:frame styleMask:NSWindowStyleMaskBorderless
                                                          backing:NSBackingStoreBuffered defer:NO];
    g_snap_preview.releasedWhenClosed = NO;
    g_snap_preview.opaque = NO;
    g_snap_preview.backgroundColor = NSColor.clearColor;
    g_snap_preview.hasShadow = NO;
    g_snap_preview.ignoresMouseEvents = YES;
    g_snap_preview.level = NSScreenSaverWindowLevel;
    g_snap_preview.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
      NSWindowCollectionBehaviorFullScreenAuxiliary | NSWindowCollectionBehaviorStationary |
      NSWindowCollectionBehaviorIgnoresCycle;
    g_snap_preview.contentView.wantsLayer = YES;
    CAShapeLayer* shape = [CAShapeLayer layer];
    NSColor* clay = [NSColor colorWithSRGBRed:217.0/255.0 green:119.0/255.0 blue:87.0/255.0 alpha:1];
    shape.strokeColor = clay.CGColor;
    shape.fillColor = [clay colorWithAlphaComponent:0.16].CGColor;
    shape.lineWidth = 2;
    [g_snap_preview.contentView.layer addSublayer:shape];
  }
  [g_snap_preview setFrame:frame display:NO];
  CAShapeLayer* shape = (CAShapeLayer*)g_snap_preview.contentView.layer.sublayers.firstObject;
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  shape.frame = NSMakeRect(0, 0, frame.size.width, frame.size.height);
  CGPathRef path = CGPathCreateWithRoundedRect(CGRectInset(shape.bounds, 1, 1), 12, 12, nullptr);
  shape.path = path;
  [CATransaction commit];
  CGPathRelease(path);
  [g_snap_preview orderFrontRegardless];
}

static bool snapTargetAtPoint(NSPoint point, NSRect* target) {
  for (NSScreen* screen in NSScreen.screens) {
    NSRect frame = screen.frame;
    if (point.x < NSMinX(frame) || point.x > NSMaxX(frame) ||
        point.y < NSMinY(frame) || point.y > NSMaxY(frame)) continue;
    NSRect visible = screen.visibleFrame;
    double left = point.x - NSMinX(frame), right = NSMaxX(frame) - point.x;
    double bottom = point.y - NSMinY(frame), top = NSMaxY(frame) - point.y;
    double visibleTop = NSMaxY(visible) - point.y;
    double visibleBottom = point.y - NSMinY(visible);
    double halfW = visible.size.width / 2, halfH = visible.size.height / 2;
    bool nearTop = top <= 48 || (visibleTop >= -8 && visibleTop <= 28);
    bool nearBottom = bottom <= 48 || (visibleBottom >= -8 && visibleBottom <= 32);
    if ((left <= 48 || right <= 48) && (nearTop || nearBottom)) {
      *target = NSMakeRect(visible.origin.x + (right <= 48 ? halfW : 0),
        visible.origin.y + (nearTop ? halfH : 0), halfW, halfH);
    } else if (left <= 24 || right <= 24) {
      *target = NSMakeRect(visible.origin.x + (right <= 24 ? halfW : 0), visible.origin.y, halfW, visible.size.height);
    } else if (nearTop && left > 48 && right > 48) {
      *target = visible;
    } else return false;
    return true;
  }
  return false;
}

static void recordSnappedWindow(AXUIElementRef win, NSRect original, NSRect target) {
  NSRect actual = target;
  axWindowRect(win, &actual);
  auto origin = std::find_if(g_snapped_origins.begin(), g_snapped_origins.end(),
    [win](const SnappedOrigin& item) { return CFEqual(item.window, win); });
  if (origin != g_snapped_origins.end()) {
    origin->original = original;
    origin->snapped = actual;
  } else {
    g_snapped_origins.push_back({(AXUIElementRef)CFRetain(win), original, actual});
  }
}

static void bindDragSnapWindow(NSPoint point) {
  AXUIElementRef window = copyFrontWindow();
  NSRect rect;
  if (!window) return;
  AXUIElementSetMessagingTimeout(window, 0.12);
  if (!axWindowRect(window, &rect)) { CFRelease(window); return; }
  g_drag_snap.window = window;
  g_drag_snap.initial = g_drag_snap.original = rect;
  g_drag_snap.down = point;
  g_drag_snap.grabRatioX = std::clamp((point.x - rect.origin.x) / rect.size.width, 0.0, 1.0);
  g_drag_snap.grabOffsetY = std::clamp(screenTop() - point.y - rect.origin.y, 0.0, rect.size.height);
  for (auto it = g_snapped_origins.begin(); it != g_snapped_origins.end(); ++it) {
    if (!CFEqual(it->window, window)) continue;
    if (std::abs(rect.size.width - it->snapped.size.width) <= 16 &&
        std::abs(rect.size.height - it->snapped.size.height) <= 16) {
      g_drag_snap.original = it->original;
      g_drag_snap.canRestore = true;
    } else {
      CFRelease(it->window);
      g_snapped_origins.erase(it);
    }
    break;
  }
}

static void handleDragSnap(NSEvent* event) {
  NSPoint point = NSEvent.mouseLocation;
  if (event.type == NSEventTypeLeftMouseDown) {
    resetDragSnap();
    bindDragSnapWindow(point);
    return;
  }
  if (!g_drag_snap.window && event.type == NSEventTypeLeftMouseDragged) {
    bindDragSnapWindow(point);
  }
  if (!g_drag_snap.window) return;
  if (event.type == NSEventTypeLeftMouseUp) {
    [g_snap_preview orderOut:nil];
    if (g_drag_snap.active && g_drag_snap.hasTarget) {
      AXUIElementRef win = (AXUIElementRef)CFRetain(g_drag_snap.window);
      NSRect original = g_drag_snap.original;
      NSRect target = axRectFromScreenRect(g_drag_snap.target);
      if (setAxWindowRect(win, target.origin.x, target.origin.y, target.size.width, target.size.height)) {
        recordSnappedWindow(win, original, target);
      }
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 35 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
        if (setAxWindowRect(win, target.origin.x, target.origin.y, target.size.width, target.size.height)) {
          recordSnappedWindow(win, original, target);
        }
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 65 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
          setAxWindowRect(win, target.origin.x, target.origin.y, target.size.width, target.size.height);
          recordSnappedWindow(win, original, target);
          CFRelease(win);
        });
      });
    }
    resetDragSnap();
    return;
  }
  NSRect current;
  if (!axWindowRect(g_drag_snap.window, &current)) { resetDragSnap(); return; }
  if (std::abs(current.size.width - g_drag_snap.initial.size.width) > 12 ||
      std::abs(current.size.height - g_drag_snap.initial.size.height) > 12) {
    for (auto it = g_snapped_origins.begin(); it != g_snapped_origins.end(); ++it) {
      if (!CFEqual(it->window, g_drag_snap.window)) continue;
      CFRelease(it->window);
      g_snapped_origins.erase(it);
      break;
    }
    resetDragSnap();
    return;
  }
  if (!g_drag_snap.active) {
    if (std::hypot(current.origin.x - g_drag_snap.initial.origin.x, current.origin.y - g_drag_snap.initial.origin.y) < 0.5) return;
    g_drag_snap.active = true;
  }
  if (g_drag_snap.canRestore && std::hypot(point.x - g_drag_snap.down.x, point.y - g_drag_snap.down.y) > 18) {
    NSRect original = g_drag_snap.original;
    double x = point.x - original.size.width * g_drag_snap.grabRatioX;
    double y = screenTop() - point.y - std::min(g_drag_snap.grabOffsetY, original.size.height);
    if (setAxWindowRect(g_drag_snap.window, x, y, original.size.width, original.size.height)) {
      for (auto it = g_snapped_origins.begin(); it != g_snapped_origins.end(); ++it) {
        if (!CFEqual(it->window, g_drag_snap.window)) continue;
        CFRelease(it->window);
        g_snapped_origins.erase(it);
        break;
      }
      g_drag_snap.canRestore = false;
    }
  }
  g_drag_snap.hasTarget = snapTargetAtPoint(point, &g_drag_snap.target);
  if (g_drag_snap.hasTarget) showSnapPreview(g_drag_snap.target);
  else [g_snap_preview orderOut:nil];
}

static void stopDragSnapMonitoring() {
  onMain(^{
    if (g_drag_snap_monitor) [NSEvent removeMonitor:g_drag_snap_monitor];
    g_drag_snap_monitor = nil;
    resetDragSnap();
    [g_snap_preview close];
    g_snap_preview = nil;
    for (const auto& origin : g_snapped_origins) CFRelease(origin.window);
    g_snapped_origins.clear();
  });
}

static napi_value setWindowDragSnapEnabled(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value args[1];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  bool enabled = false;
  if (n != 1 || napi_get_value_bool(e, args[0], &enabled) != napi_ok) {
    napi_throw_type_error(e, nullptr, "drag snap enabled boolean required");
    return nullptr;
  }
  if (!enabled) stopDragSnapMonitoring();
  else onMain(^{
    if (g_drag_snap_monitor) return;
    g_drag_snap_monitor = [NSEvent addGlobalMonitorForEventsMatchingMask:
      NSEventMaskLeftMouseDown | NSEventMaskLeftMouseDragged | NSEventMaskLeftMouseUp
      handler:^(NSEvent* event) { handleDragSnap(event); }];
  });
  napi_value result;
  napi_get_undefined(e, &result);
  return result;
}

static void cancelFinderHold() {
  if (g_finder_timer) {
    dispatch_source_cancel(g_finder_timer);
    g_finder_timer = nil;
  }
}

static void stopFinderMonitoring() {
  onMain(^{
    cancelFinderHold();
    if (g_finder_monitor) {
      [NSEvent removeMonitor:g_finder_monitor];
      g_finder_monitor = nil;
    }
    if (g_finder_tsfn) {
      napi_release_threadsafe_function(g_finder_tsfn, napi_tsfn_abort);
      g_finder_tsfn = nullptr;
    }
  });
}

static bool finderIsFrontmost() {
  return [NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier isEqualToString:@"com.apple.finder"];
}

static void callFinderJS(napi_env env, napi_value callback, void*, void* data) {
  auto* point = (FinderTrigger*)data;
  if (env && callback) {
    napi_value result, trigger, receiver;
    napi_create_object(env, &result);
    prop(env, result, "x", point->x);
    prop(env, result, "y", point->y);
    napi_create_string_utf8(env, point->rightHold ? "right-hold" : "middle", NAPI_AUTO_LENGTH, &trigger);
    napi_set_named_property(env, result, "trigger", trigger);
    napi_get_undefined(env, &receiver);
    napi_call_function(env, receiver, callback, 1, &result, nullptr);
  }
  delete point;
}

static void emitFinderTrigger(NSPoint point, bool rightHold) {
  NSScreen* primary = NSScreen.screens.firstObject;
  if (!g_finder_tsfn || !primary) return;
  auto* event = new FinderTrigger{point.x, NSMaxY(primary.frame) - point.y, rightHold};
  if (napi_call_threadsafe_function(g_finder_tsfn, event, napi_tsfn_nonblocking) != napi_ok) delete event;
}

static napi_value startFinderTrigger(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value args[1];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  napi_valuetype type;
  if (n != 1 || napi_typeof(e, args[0], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(e, nullptr, "Finder trigger callback required");
    return nullptr;
  }
  stopFinderMonitoring();
  napi_value name;
  napi_create_string_utf8(e, "lasso-finder-trigger", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(e, args[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr,
                                    callFinderJS, &g_finder_tsfn) != napi_ok) {
    napi_throw_error(e, nullptr, "Could not create Finder trigger callback");
    return nullptr;
  }
  napi_unref_threadsafe_function(e, g_finder_tsfn);
  onMain(^{
    NSEventMask mask = NSEventMaskOtherMouseDown | NSEventMaskRightMouseDown | NSEventMaskRightMouseUp |
                       NSEventMaskRightMouseDragged | NSEventMaskLeftMouseDown;
    g_finder_monitor = [NSEvent addGlobalMonitorForEventsMatchingMask:mask handler:^(NSEvent* event) {
      if (event.type == NSEventTypeRightMouseUp || event.type == NSEventTypeLeftMouseDown) {
        cancelFinderHold();
        return;
      }
      if (!finderIsFrontmost()) { cancelFinderHold(); return; }
      NSPoint point = NSEvent.mouseLocation;
      if (event.type == NSEventTypeOtherMouseDown && event.buttonNumber == 2) {
        cancelFinderHold();
        emitFinderTrigger(point, false);
      } else if (event.type == NSEventTypeRightMouseDragged) {
        if (std::hypot(point.x - g_finder_down.x, point.y - g_finder_down.y) > 6.0) cancelFinderHold();
      } else if (event.type == NSEventTypeRightMouseDown) {
        cancelFinderHold();
        g_finder_down = point;
        g_finder_timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
        dispatch_source_set_timer(g_finder_timer, dispatch_time(DISPATCH_TIME_NOW, 250 * NSEC_PER_MSEC), DISPATCH_TIME_FOREVER, 0);
        dispatch_source_set_event_handler(g_finder_timer, ^{
          cancelFinderHold();
          if (!finderIsFrontmost()) return;
          CGEventRef down = CGEventCreateKeyboardEvent(nullptr, kVK_Escape, true);
          CGEventRef up = CGEventCreateKeyboardEvent(nullptr, kVK_Escape, false);
          if (down) { CGEventPost(kCGHIDEventTap, down); CFRelease(down); }
          if (up) { CGEventPost(kCGHIDEventTap, up); CFRelease(up); }
          emitFinderTrigger(g_finder_down, true);
        });
        dispatch_resume(g_finder_timer);
      }
    }];
  });
  napi_value result;
  napi_get_undefined(e, &result);
  return result;
}

static napi_value stopFinderTrigger(napi_env e, napi_callback_info) {
  stopFinderMonitoring();
  napi_value result;
  napi_get_undefined(e, &result);
  return result;
}

static napi_value snapWindow(napi_env e, napi_callback_info info) {
  size_t n = 4;
  napi_value args[4];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  bool ok = false;
  if (n >= 4 && AXIsProcessTrusted()) {
    double x = 0, y = 0, w = 800, h = 600;
    napi_get_value_double(e, args[0], &x);
    napi_get_value_double(e, args[1], &y);
    napi_get_value_double(e, args[2], &w);
    napi_get_value_double(e, args[3], &h);
    @autoreleasepool {
      AXUIElementRef win = copyFrontWindow();
      if (win) {
        ok = setAxWindowRect(win, x, y, w, h);
        CFRelease(win);
      }
    }
  }
  napi_value res;
  napi_get_boolean(e, ok, &res);
  return res;
}

static napi_value tileTwoWindows(napi_env e, napi_callback_info info) {
  size_t n = 8;
  napi_value args[8];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  int moved = 0;
  if (n >= 8 && AXIsProcessTrusted()) {
    double coords[8] = {0};
    for (int i = 0; i < 8; i++) napi_get_value_double(e, args[i], &coords[i]);
    @autoreleasepool {
      CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
      if (list) {
        pid_t selfPid = getpid();
        std::vector<pid_t> seenPids;
        for (NSDictionary* w in (__bridge NSArray*)list) {
          if ([w[(id)kCGWindowLayer] intValue] != 0) continue;
          pid_t pid = [w[(id)kCGWindowOwnerPID] intValue];
          if (pid <= 0 || pid == selfPid) continue;
          if (std::find(seenPids.begin(), seenPids.end(), pid) != seenPids.end()) continue;
          AXUIElementRef appRef = AXUIElementCreateApplication(pid);
          CFTypeRef winRef = nullptr;
          if (AXUIElementCopyAttributeValue(appRef, kAXFocusedWindowAttribute, &winRef) == kAXErrorSuccess && winRef) {
            int base = moved * 4;
            if (setAxWindowRect((AXUIElementRef)winRef, coords[base], coords[base + 1], coords[base + 2], coords[base + 3])) {
              seenPids.push_back(pid);
              moved++;
            }
            CFRelease(winRef);
          }
          CFRelease(appRef);
          if (moved >= 2) break;
        }
        CFRelease(list);
      }
    }
  }
  napi_value res;
  napi_create_int32(e, moved, &res);
  return res;
}

static napi_value frontmostApp(napi_env e, napi_callback_info) {
  napi_value obj;
  napi_create_object(e, &obj);
  @autoreleasepool {
    NSRunningApplication* app = [[NSWorkspace sharedWorkspace] frontmostApplication];
    NSString* bundleId = app.bundleIdentifier ?: @"";
    NSString* name = app.localizedName ?: @"";
    napi_value bVal, nVal, pVal;
    napi_create_string_utf8(e, bundleId.UTF8String, NAPI_AUTO_LENGTH, &bVal);
    napi_create_string_utf8(e, name.UTF8String, NAPI_AUTO_LENGTH, &nVal);
    napi_create_int32(e, app ? app.processIdentifier : 0, &pVal);
    napi_set_named_property(e, obj, "bundleId", bVal);
    napi_set_named_property(e, obj, "name", nVal);
    napi_set_named_property(e, obj, "pid", pVal);
  }
  return obj;
}

static pid_t g_cached_front_pid = 0;
static double g_cached_menu_time = 0.0;
static double g_cached_left_menu_right = 320.0;
static double g_cached_extras_time = 0.0;
static double g_cached_right_status_left = 0.0;

static napi_value notchGeometry(napi_env e, napi_callback_info) {
  napi_value obj;
  napi_create_object(e, &obj);
  bool hasNotch = false;
  double notchWidth = 156.0;
  double notchHeight = 28.0;
  double menuBarHeight = 28.0;
  double leftSafeWidth = 136.0;
  double rightSafeWidth = 108.0;
  double anchorX = 0.0;
  @autoreleasepool {
    NSScreen* screen = NSScreen.screens.firstObject ?: [NSScreen mainScreen];
    if (screen) {
      NSRect frame = screen.frame;
      NSRect visible = screen.visibleFrame;
      menuBarHeight = std::max(24.0, (double)(NSMaxY(frame) - NSMaxY(visible)));
      double screenWidth = frame.size.width;
      anchorX = frame.origin.x + screenWidth / 2.0;

      bool physicalNotch = false;
      double notchLeftX = frame.origin.x + (screenWidth - notchWidth) / 2.0;
      double notchRightX = notchLeftX + notchWidth;
      if (@available(macOS 12.0, *)) {
        NSEdgeInsets insets = screen.safeAreaInsets;
        NSRect leftAux = screen.auxiliaryTopLeftArea;
        NSRect rightAux = screen.auxiliaryTopRightArea;
        if (insets.top > 0.0 && leftAux.size.width > 0.0 && rightAux.size.width > 0.0) {
          physicalNotch = true;
          notchLeftX = NSMaxX(leftAux);
          notchRightX = rightAux.origin.x;
          notchWidth = std::max(120.0, notchRightX - notchLeftX);
          notchHeight = (double)insets.top;
          menuBarHeight = std::max(menuBarHeight, notchHeight);
        }
      }

      double now = CFAbsoluteTimeGetCurrent();
      double leftMenuRightX = frame.origin.x + 310.0;
      double minRightStatusX = NSMaxX(frame) - 240.0;

      if (AXIsProcessTrusted()) {
        NSRunningApplication* front = [[NSWorkspace sharedWorkspace] frontmostApplication];
        pid_t frontPid = front ? front.processIdentifier : 0;
        if (frontPid > 0 && frontPid == g_cached_front_pid && (now - g_cached_menu_time) < 2.5) {
          leftMenuRightX = g_cached_left_menu_right;
        } else if (frontPid > 0) {
          AXUIElementRef appRef = AXUIElementCreateApplication(frontPid);
          AXUIElementSetMessagingTimeout(appRef, 0.04f);
          CFTypeRef menuBarRef = nullptr;
          if (AXUIElementCopyAttributeValue(appRef, kAXMenuBarAttribute, &menuBarRef) == kAXErrorSuccess && menuBarRef) {
            CFTypeRef childrenRef = nullptr;
            if (AXUIElementCopyAttributeValue((AXUIElementRef)menuBarRef, kAXChildrenAttribute, &childrenRef) == kAXErrorSuccess && childrenRef) {
              double maxRight = 0.0;
              for (id child in (__bridge NSArray*)childrenRef) {
                AXUIElementRef item = (__bridge AXUIElementRef)child;
                CFTypeRef posRef = nullptr, sizeRef = nullptr;
                CGPoint p = CGPointZero;
                CGSize s = CGSizeZero;
                if (AXUIElementCopyAttributeValue(item, kAXPositionAttribute, &posRef) == kAXErrorSuccess && posRef) {
                  AXValueGetValue((AXValueRef)posRef, kAXValueTypeCGPoint, &p);
                  CFRelease(posRef);
                }
                if (AXUIElementCopyAttributeValue(item, kAXSizeAttribute, &sizeRef) == kAXErrorSuccess && sizeRef) {
                  AXValueGetValue((AXValueRef)sizeRef, kAXValueTypeCGSize, &s);
                  CFRelease(sizeRef);
                }
                if (p.x >= frame.origin.x && p.x < frame.origin.x + screenWidth * 0.65 && s.width > 4.0) {
                  maxRight = std::max(maxRight, (double)(p.x + s.width));
                }
              }
              if (maxRight > frame.origin.x + 40.0) leftMenuRightX = maxRight;
              CFRelease(childrenRef);
            }
            CFRelease(menuBarRef);
          }
          CFRelease(appRef);
          g_cached_front_pid = frontPid;
          g_cached_menu_time = now;
          g_cached_left_menu_right = leftMenuRightX;
        }

        if (g_cached_right_status_left > 0.0 && (now - g_cached_extras_time) < 4.0) {
          minRightStatusX = g_cached_right_status_left;
        } else {
          double detectedMinX = NSMaxX(frame);
          bool foundExtras = false;
          for (NSRunningApplication* app in [[NSWorkspace sharedWorkspace] runningApplications]) {
            if (app.activationPolicy == NSApplicationActivationPolicyProhibited) continue;
            pid_t pid = app.processIdentifier;
            if (pid <= 0) continue;
            AXUIElementRef appRef = AXUIElementCreateApplication(pid);
            AXUIElementSetMessagingTimeout(appRef, 0.03f);
            CFTypeRef extrasRef = nullptr;
            if (AXUIElementCopyAttributeValue(appRef, CFSTR("AXExtrasMenuBar"), &extrasRef) == kAXErrorSuccess && extrasRef) {
              CFTypeRef childrenRef = nullptr;
              if (AXUIElementCopyAttributeValue((AXUIElementRef)extrasRef, kAXChildrenAttribute, &childrenRef) == kAXErrorSuccess && childrenRef) {
                for (id child in (__bridge NSArray*)childrenRef) {
                  AXUIElementRef item = (__bridge AXUIElementRef)child;
                  CFTypeRef posRef = nullptr, sizeRef = nullptr;
                  CGPoint p = CGPointZero;
                  CGSize s = CGSizeZero;
                  if (AXUIElementCopyAttributeValue(item, kAXPositionAttribute, &posRef) == kAXErrorSuccess && posRef) {
                    AXValueGetValue((AXValueRef)posRef, kAXValueTypeCGPoint, &p);
                    CFRelease(posRef);
                  }
                  if (AXUIElementCopyAttributeValue(item, kAXSizeAttribute, &sizeRef) == kAXErrorSuccess && sizeRef) {
                    AXValueGetValue((AXValueRef)sizeRef, kAXValueTypeCGSize, &s);
                    CFRelease(sizeRef);
                  }
                  if (p.y >= -4.0 && p.y <= menuBarHeight + 8.0 && p.x > leftMenuRightX + 20.0 && p.x < NSMaxX(frame) && s.width > 4.0) {
                    detectedMinX = std::min(detectedMinX, (double)p.x);
                    foundExtras = true;
                  }
                }
                CFRelease(childrenRef);
              }
              CFRelease(extrasRef);
            }
            CFRelease(appRef);
          }
          if (foundExtras) {
            minRightStatusX = detectedMinX;
            g_cached_right_status_left = minRightStatusX;
            g_cached_extras_time = now;
          }
        }
      }

      if (physicalNotch) {
        double leftFree = (notchLeftX - 8.0) - (leftMenuRightX + 12.0);
        double rightFree = (minRightStatusX - 12.0) - (notchRightX + 8.0);
        if (leftFree >= 88.0 && rightFree >= 72.0) {
          hasNotch = true;
          leftSafeWidth = std::clamp(leftFree, 88.0, 164.0);
          rightSafeWidth = std::clamp(rightFree, 72.0, 136.0);
          anchorX = (notchLeftX + notchRightX) / 2.0;
        } else {
          // Right side of the physical notch is occupied by status items: place unified capsule in the free gap on the left of the notch.
          hasNotch = false;
          double gapLeft = leftMenuRightX + 12.0;
          double gapRight = std::min(notchLeftX - 10.0, minRightStatusX - 12.0);
          double avail = std::clamp(gapRight - gapLeft, 168.0, 296.0);
          leftSafeWidth = std::round(avail * 0.62);
          rightSafeWidth = std::round(avail * 0.38);
          anchorX = std::clamp(notchLeftX - 10.0 - avail / 2.0, gapLeft + avail / 2.0, std::max(gapLeft + avail / 2.0, gapRight - avail / 2.0));
        }
      } else {
        hasNotch = false;
        double gapLeft = leftMenuRightX + 12.0;
        double gapRight = std::max(gapLeft + 168.0, minRightStatusX - 12.0);
        double avail = std::clamp(gapRight - gapLeft, 168.0, 304.0);
        leftSafeWidth = std::round(avail * 0.62);
        rightSafeWidth = std::round(avail * 0.38);
        double center = frame.origin.x + screenWidth / 2.0;
        anchorX = std::clamp(center, gapLeft + avail / 2.0, std::max(gapLeft + avail / 2.0, gapRight - avail / 2.0));
      }
    }
  }
  napi_value vHas;
  napi_get_boolean(e, hasNotch, &vHas);
  napi_set_named_property(e, obj, "hasNotch", vHas);
  prop(e, obj, "width", notchWidth);
  prop(e, obj, "height", notchHeight);
  prop(e, obj, "menuBarHeight", menuBarHeight);
  prop(e, obj, "leftSafeWidth", leftSafeWidth);
  prop(e, obj, "rightSafeWidth", rightSafeWidth);
  prop(e, obj, "anchorX", anchorX);
  return obj;
}

/** Keeps the window in place during Mission Control and out of Cmd-` cycling; Electron exposes neither behavior. */
static napi_value setStationaryWindow(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value args[1];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  void* bytes = nullptr;
  size_t length = 0;
  if (n >= 1 && napi_get_buffer_info(e, args[0], &bytes, &length) == napi_ok && length >= sizeof(void*)) {
    @autoreleasepool {
      NSWindow* win = ((__bridge NSView*)(*(void**)bytes)).window;
      // AppKit allows one behavior per group, and Chromium marks every top-level window Managed.
      NSWindowCollectionBehavior behavior = win.collectionBehavior & ~(NSWindowCollectionBehaviorManaged |
                                                                       NSWindowCollectionBehaviorTransient |
                                                                       NSWindowCollectionBehaviorParticipatesInCycle);
      win.collectionBehavior = behavior | NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;
    }
  }
  napi_value undefined;
  napi_get_undefined(e, &undefined);
  return undefined;
}

static napi_value init(napi_env e,napi_value exports){
  napi_property_descriptor d[]={
    {"query",nullptr,query,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"windows",nullptr,windows,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"windowOnScreen",nullptr,windowOnScreen,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"requestScreen",nullptr,requestScreen,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"paste",nullptr,paste,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"pasteboardMeta",nullptr,pasteboardMeta,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"pasteToProcess",nullptr,pasteToProcess,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"startCopyWatch",nullptr,startCopyWatch,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"stopCopyWatch",nullptr,stopCopyWatch,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setWindowDragSnapEnabled",nullptr,setWindowDragSnapEnabled,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setGlow",nullptr,setGlow,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"startBridge",nullptr,startBridge,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"stopBridge",nullptr,stopBridge,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"postBridge",nullptr,postBridge,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"snapWindow",nullptr,snapWindow,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"focusedWindowFrame",nullptr,focusedWindowFrame,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"startFinderTrigger",nullptr,startFinderTrigger,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"stopFinderTrigger",nullptr,stopFinderTrigger,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"tileTwoWindows",nullptr,tileTwoWindows,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"frontmostApp",nullptr,frontmostApp,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"notchGeometry",nullptr,notchGeometry,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setStationaryWindow",nullptr,setStationaryWindow,nullptr,nullptr,nullptr,napi_default,nullptr}
  };
  napi_define_properties(e,exports,sizeof(d)/sizeof(d[0]),d);
  napi_add_env_cleanup_hook(e, [](void*) {
    stopBridgeMonitoring();
    stopFinderMonitoring();
    stopCopyMonitoring();
    stopDragSnapMonitoring();
  }, nullptr);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
