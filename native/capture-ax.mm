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
static constexpr int64_t kLassoCopyEvent = 0x4c4153534f;

@interface SnapPreviewOverlay : NSWindow
@end
@implementation SnapPreviewOverlay
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

struct SnappedOrigin { AXUIElementRef window; NSRect original; NSRect snapped; };
struct DragSnapSession {
  AXUIElementRef window = nullptr;
  NSRect initial = NSZeroRect, original = NSZeroRect, target = NSZeroRect, pendingTarget = NSZeroRect;
  NSPoint down = NSZeroPoint;
  double grabRatioX = 0.5, grabOffsetY = 0;
  int dwellZone = 0;
  bool active = false, canRestore = false, hasTarget = false, dwellArmed = false;
};

static napi_threadsafe_function g_bridge_tsfn = nullptr;
static id g_present_obs = nil;
static id g_dismiss_obs = nil;
static id g_prefs_obs = nil;
static napi_threadsafe_function g_finder_tsfn = nullptr;
static id g_finder_monitor = nil;
static dispatch_source_t g_finder_timer = nil;
static NSPoint g_finder_down;
static bool g_finder_middle_enabled = true;
static bool g_finder_right_hold_enabled = true;
static napi_threadsafe_function g_copy_tsfn = nullptr;
static id g_copy_monitor = nil;
static double g_last_copy_time = -1;
static id g_drag_snap_monitor = nil;
static dispatch_source_t g_snap_dwell_timer = nil;
static int g_snap_dwell_ms = 250;
static SnapPreviewOverlay* g_snap_preview = nil;
static DragSnapSession g_drag_snap;
static std::vector<SnappedOrigin> g_snapped_origins;
static napi_threadsafe_function g_fullscreen_tsfn = nullptr;
static id g_fullscreen_space_obs = nil;
static id g_fullscreen_app_obs = nil;
static id g_fullscreen_screen_obs = nil;
static dispatch_source_t g_fullscreen_timer = nil;
static int g_last_fullscreen_state = -1;
static int g_fullscreen_exit_streak = 0;

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

static napi_value activateProcess(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value args[1], result;
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  int32_t pid = 0;
  bool ok = false;
  if (n == 1 && napi_get_value_int32(e, args[0], &pid) == napi_ok && pid > 0 && pid != getpid()) {
    __block bool activated = false;
    onMain(^{
      NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:(pid_t)pid];
      activated = app && !app.terminated && [app activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    });
    ok = activated;
  }
  napi_get_boolean(e, ok, &result);
  return result;
}

static napi_value pasteboardRich(napi_env e, napi_callback_info) {
  napi_value result, textVal, htmlVal;
  napi_create_object(e, &result);
  std::string text, html;
  @autoreleasepool {
    NSPasteboard* board = NSPasteboard.generalPasteboard;
    NSString* plain = [board stringForType:NSPasteboardTypeString];
    NSString* rich = [board stringForType:NSPasteboardTypeHTML];
    if (plain) text = plain.UTF8String;
    if (rich) html = rich.UTF8String;
  }
  napi_create_string_utf8(e, text.c_str(), text.size(), &textVal);
  napi_create_string_utf8(e, html.c_str(), html.size(), &htmlVal);
  napi_set_named_property(e, result, "text", textVal);
  napi_set_named_property(e, result, "html", htmlVal);
  return result;
}

static bool pressCopyMenuItem(pid_t pid) {
  if (!AXIsProcessTrusted()) return false;
  AXUIElementRef appRef = AXUIElementCreateApplication(pid);
  if (!appRef) return false;
  AXUIElementSetMessagingTimeout(appRef, 0.12f);
  bool pressed = false;
  CFTypeRef menuBarRef = nullptr;
  if (AXUIElementCopyAttributeValue(appRef, kAXMenuBarAttribute, &menuBarRef) == kAXErrorSuccess && menuBarRef) {
    CFTypeRef menusRef = nullptr;
    if (AXUIElementCopyAttributeValue((AXUIElementRef)menuBarRef, kAXChildrenAttribute, &menusRef) == kAXErrorSuccess && menusRef) {
      for (id menuBarItem in (__bridge NSArray*)menusRef) {
        CFTypeRef subMenusRef = nullptr;
        if (AXUIElementCopyAttributeValue((__bridge AXUIElementRef)menuBarItem, kAXChildrenAttribute, &subMenusRef) != kAXErrorSuccess || !subMenusRef) continue;
        for (id subMenu in (__bridge NSArray*)subMenusRef) {
          CFTypeRef itemsRef = nullptr;
          if (AXUIElementCopyAttributeValue((__bridge AXUIElementRef)subMenu, kAXChildrenAttribute, &itemsRef) != kAXErrorSuccess || !itemsRef) continue;
          for (id itemObj in (__bridge NSArray*)itemsRef) {
            AXUIElementRef item = (__bridge AXUIElementRef)itemObj;
            CFTypeRef cmdRef = nullptr;
            if (AXUIElementCopyAttributeValue(item, kAXMenuItemCmdCharAttribute, &cmdRef) == kAXErrorSuccess && cmdRef) {
              bool isC = CFGetTypeID(cmdRef) == CFStringGetTypeID() &&
                [(__bridge NSString*)cmdRef caseInsensitiveCompare:@"C"] == NSOrderedSame;
              CFRelease(cmdRef);
              if (isC) {
                int mods = 0;
                CFTypeRef modRef = nullptr;
                if (AXUIElementCopyAttributeValue(item, kAXMenuItemCmdModifiersAttribute, &modRef) == kAXErrorSuccess && modRef) {
                  if (CFGetTypeID(modRef) == CFNumberGetTypeID()) {
                    CFNumberGetValue((CFNumberRef)modRef, kCFNumberIntType, &mods);
                  }
                  CFRelease(modRef);
                }
                if (mods == 0) {
                  bool enabled = true;
                  CFTypeRef enRef = nullptr;
                  if (AXUIElementCopyAttributeValue(item, kAXEnabledAttribute, &enRef) == kAXErrorSuccess && enRef) {
                    if (CFGetTypeID(enRef) == CFBooleanGetTypeID()) enabled = CFBooleanGetValue((CFBooleanRef)enRef);
                    CFRelease(enRef);
                  }
                  if (enabled && AXUIElementPerformAction(item, kAXPressAction) == kAXErrorSuccess) {
                    pressed = true;
                    break;
                  }
                }
              }
            }
          }
          CFRelease(itemsRef);
          if (pressed) break;
        }
        CFRelease(subMenusRef);
        if (pressed) break;
      }
      CFRelease(menusRef);
    }
    CFRelease(menuBarRef);
  }
  CFRelease(appRef);
  return pressed;
}

static napi_value copySelectionToProcess(napi_env e, napi_callback_info info) {
  size_t n = 2;
  napi_value args[2], result;
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  int32_t pid = 0;
  bool forceKey = false;
  if (n >= 2) {
    bool flag = false;
    if (napi_get_value_bool(e, args[1], &flag) == napi_ok) forceKey = flag;
  }
  bool sent = false;
  if (n >= 1 && napi_get_value_int32(e, args[0], &pid) == napi_ok && pid > 0 && pid != getpid()) {
    @autoreleasepool {
      if (NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier == pid) {
        if (!forceKey && pressCopyMenuItem((pid_t)pid)) {
          sent = true;
        } else {
          CGEventRef down = CGEventCreateKeyboardEvent(nullptr, 8, true); // Cmd+C
          CGEventRef up = CGEventCreateKeyboardEvent(nullptr, 8, false);
          if (down && up) {
            CGEventSetFlags(down, kCGEventFlagMaskCommand);
            CGEventSetFlags(up, kCGEventFlagMaskCommand);
            CGEventSetIntegerValueField(down, kCGEventSourceUserData, kLassoCopyEvent);
            CGEventSetIntegerValueField(up, kCGEventSourceUserData, kLassoCopyEvent);
            CGEventPost(kCGHIDEventTap, down);
            usleep(12000);
            CGEventPost(kCGHIDEventTap, up);
            sent = true;
          }
          if (down) CFRelease(down);
          if (up) CFRelease(up);
        }
      }
    }
  }
  napi_get_boolean(e, sent, &result);
  return result;
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

static double primaryScreenTop() {
  NSScreen* first = NSScreen.screens.firstObject;
  return first ? NSMaxY(first.frame) : 0.0;
}

static NSRect axRectFromCocoaRect(NSRect rect) {
  return NSMakeRect(rect.origin.x, primaryScreenTop() - NSMaxY(rect), rect.size.width, rect.size.height);
}

static bool axVisibleForTarget(double x, double y, double w, double h, NSRect* outVisible) {
  double cx = x + w * 0.5, cy = y + h * 0.5;
  NSScreen* best = nil;
  double bestDist = 1e18;
  for (NSScreen* screen in NSScreen.screens) {
    NSRect axFrame = axRectFromCocoaRect(screen.frame);
    if (cx >= NSMinX(axFrame) && cx <= NSMaxX(axFrame) && cy >= NSMinY(axFrame) && cy <= NSMaxY(axFrame)) {
      best = screen;
      break;
    }
    double dx = cx < NSMinX(axFrame) ? NSMinX(axFrame) - cx : (cx > NSMaxX(axFrame) ? cx - NSMaxX(axFrame) : 0.0);
    double dy = cy < NSMinY(axFrame) ? NSMinY(axFrame) - cy : (cy > NSMaxY(axFrame) ? cy - NSMaxY(axFrame) : 0.0);
    double d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; best = screen; }
  }
  if (!best) return false;
  *outVisible = axRectFromCocoaRect(best.visibleFrame);
  return true;
}

static bool axActualWindowRect(AXUIElementRef window, NSRect* rect) {
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
  bool ok = (e1 == kAXErrorSuccess || e2 == kAXErrorSuccess);
  // Clamp inward if window enforced a minimum width/height so it never hides behind Dock or menu bar.
  NSRect axVisible = NSZeroRect, actual = NSZeroRect;
  if (ok && axVisibleForTarget(x, y, w, h, &axVisible) && axActualWindowRect(win, &actual)) {
    double padX = (x >= NSMinX(axVisible) + 6.0 && x + w <= NSMaxX(axVisible) - 6.0) ? 8.0 : 0.0;
    double padY = (y >= NSMinY(axVisible) + 6.0 && y + h <= NSMaxY(axVisible) - 6.0) ? 8.0 : 0.0;
    double leftLimit = NSMinX(axVisible) + padX;
    double rightLimit = NSMaxX(axVisible) - padX;
    double topLimit = NSMinY(axVisible) + padY;
    double bottomLimit = NSMaxY(axVisible) - padY;
    double clampedX = actual.origin.x;
    double clampedY = actual.origin.y;
    if (clampedX + actual.size.width > rightLimit) clampedX = std::max(leftLimit, rightLimit - actual.size.width);
    if (clampedX < leftLimit) clampedX = leftLimit;
    if (clampedY + actual.size.height > bottomLimit) clampedY = std::max(topLimit, bottomLimit - actual.size.height);
    if (clampedY < topLimit) clampedY = topLimit;
    if (std::abs(clampedX - actual.origin.x) >= 1.0 || std::abs(clampedY - actual.origin.y) >= 1.0) {
      CGPoint fixedPt = CGPointMake(clampedX, clampedY);
      AXValueRef fixedPos = AXValueCreate(kAXValueTypeCGPoint, &fixedPt);
      if (fixedPos) {
        AXUIElementSetAttributeValue(win, kAXPositionAttribute, fixedPos);
        CFRelease(fixedPos);
      }
    }
  }
  return ok;
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
      if (event.CGEvent && CGEventGetIntegerValueField(event.CGEvent, kCGEventSourceUserData) == kLassoCopyEvent) return;
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

static double screenTop() { return primaryScreenTop(); }
static NSRect axRectFromScreenRect(NSRect rect) { return axRectFromCocoaRect(rect); }

static void cancelSnapDwell() {
  if (g_snap_dwell_timer) {
    dispatch_source_cancel(g_snap_dwell_timer);
    g_snap_dwell_timer = nil;
  }
}

static void resetDragSnap() {
  cancelSnapDwell();
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
    shape.strokeColor = [clay colorWithAlphaComponent:0.85].CGColor;
    shape.fillColor = [clay colorWithAlphaComponent:0.14].CGColor;
    shape.lineWidth = 1.5;
    [g_snap_preview.contentView.layer addSublayer:shape];
  }
  [g_snap_preview setFrame:frame display:NO];
  CAShapeLayer* shape = (CAShapeLayer*)g_snap_preview.contentView.layer.sublayers.firstObject;
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  shape.frame = NSMakeRect(0, 0, frame.size.width, frame.size.height);
  CGPathRef path = CGPathCreateWithRoundedRect(CGRectInset(shape.bounds, 1, 1), 10, 10, nullptr);
  shape.path = path;
  [CATransaction commit];
  CGPathRelease(path);
  [g_snap_preview orderFrontRegardless];
}

static bool snapTargetAtPoint(NSPoint point, NSRect* target, bool* needsDwell, int* zoneId) {
  for (NSScreen* screen in NSScreen.screens) {
    NSRect frame = screen.frame;
    if (point.x < NSMinX(frame) || point.x > NSMaxX(frame) ||
        point.y < NSMinY(frame) || point.y > NSMaxY(frame)) continue;
    NSRect visible = screen.visibleFrame;
    const double gap = 8.0;
    double halfW = std::round((visible.size.width - gap * 3.0) * 0.5);
    double halfH = std::round((visible.size.height - gap * 3.0) * 0.5);
    double fullW = visible.size.width - gap * 2.0;
    double fullH = visible.size.height - gap * 2.0;

    bool inLeftCornerX = point.x <= NSMinX(visible) + 48.0;
    bool inRightCornerX = point.x >= NSMaxX(visible) - 48.0;
    bool inTopCornerY = point.y >= NSMaxY(visible) - 44.0;
    bool inBottomCornerY = point.y <= NSMinY(visible) + 44.0;

    bool nearLeft = point.x <= NSMinX(visible) + 30.0;
    bool nearRight = point.x >= NSMaxX(visible) - 30.0;
    bool nearTop = point.y >= NSMaxY(visible) - 28.0;
    bool nearBottom = point.y <= NSMinY(visible) + 32.0;

    if ((inLeftCornerX || inRightCornerX) && (inTopCornerY || inBottomCornerY)) {
      *needsDwell = false;
      *zoneId = (inRightCornerX ? 2 : 1) + (inTopCornerY ? 0 : 2);
      *target = NSMakeRect(
        visible.origin.x + (inRightCornerX ? gap * 2.0 + halfW : gap),
        visible.origin.y + (inTopCornerY ? gap * 2.0 + halfH : gap),
        halfW,
        halfH
      );
      return true;
    }
    if (nearLeft || nearRight) {
      *needsDwell = false;
      *zoneId = nearRight ? 6 : 5;
      *target = NSMakeRect(
        visible.origin.x + (nearRight ? gap * 2.0 + halfW : gap),
        visible.origin.y + gap,
        halfW,
        fullH
      );
      return true;
    }
    if (nearTop) {
      double rx = (point.x - NSMinX(visible)) / std::max(1.0, (double)visible.size.width);
      if (rx >= 0.32 && rx <= 0.68) {
        *needsDwell = true;
        *zoneId = 10;
        *target = NSMakeRect(visible.origin.x + gap, visible.origin.y + gap, fullW, fullH);
        return true;
      }
      return false;
    }
    if (nearBottom) {
      *needsDwell = true;
      double rx = std::clamp((point.x - NSMinX(visible)) / std::max(1.0, (double)visible.size.width), 0.0, 1.0);
      double thirdW = std::round((visible.size.width - gap * 4.0) / 3.0);
      double twoThirdW = thirdW * 2.0 + gap;
      if (rx < 0.28) {
        *zoneId = 20;
        *target = NSMakeRect(visible.origin.x + gap, visible.origin.y + gap, thirdW, fullH);
      } else if (rx < 0.39) {
        *zoneId = 21;
        *target = NSMakeRect(visible.origin.x + gap, visible.origin.y + gap, twoThirdW, fullH);
      } else if (rx <= 0.61) {
        *zoneId = 22;
        *target = NSMakeRect(visible.origin.x + gap * 2.0 + thirdW, visible.origin.y + gap, thirdW, fullH);
      } else if (rx <= 0.72) {
        *zoneId = 23;
        *target = NSMakeRect(NSMaxX(visible) - gap - twoThirdW, visible.origin.y + gap, twoThirdW, fullH);
      } else {
        *zoneId = 24;
        *target = NSMakeRect(NSMaxX(visible) - gap - thirdW, visible.origin.y + gap, thirdW, fullH);
      }
      return true;
    }
    return false;
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
  NSRect candidate = NSZeroRect;
  bool needsDwell = false;
  int zoneId = 0;
  if (!snapTargetAtPoint(point, &candidate, &needsDwell, &zoneId)) {
    cancelSnapDwell();
    g_drag_snap.dwellZone = 0;
    g_drag_snap.dwellArmed = false;
    g_drag_snap.hasTarget = false;
    [g_snap_preview orderOut:nil];
    return;
  }
  if (!needsDwell) {
    cancelSnapDwell();
    g_drag_snap.dwellZone = zoneId;
    g_drag_snap.dwellArmed = true;
    g_drag_snap.target = candidate;
    g_drag_snap.hasTarget = true;
    showSnapPreview(g_drag_snap.target);
    return;
  }
  g_drag_snap.pendingTarget = candidate;
  if (g_drag_snap.dwellZone == zoneId) {
    if (g_drag_snap.dwellArmed) {
      g_drag_snap.target = candidate;
      g_drag_snap.hasTarget = true;
      showSnapPreview(g_drag_snap.target);
    }
    return;
  }
  cancelSnapDwell();
  g_drag_snap.dwellZone = zoneId;
  g_drag_snap.dwellArmed = false;
  g_drag_snap.hasTarget = false;
  [g_snap_preview orderOut:nil];
  int expectedZone = zoneId;
  int dwellMs = std::clamp(g_snap_dwell_ms, 80, 1200);
  g_snap_dwell_timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(g_snap_dwell_timer, dispatch_time(DISPATCH_TIME_NOW, (int64_t)dwellMs * NSEC_PER_MSEC), DISPATCH_TIME_FOREVER, 0);
  dispatch_source_set_event_handler(g_snap_dwell_timer, ^{
    cancelSnapDwell();
    if (!g_drag_snap.window || !g_drag_snap.active || g_drag_snap.dwellZone != expectedZone) return;
    g_drag_snap.dwellArmed = true;
    g_drag_snap.target = g_drag_snap.pendingTarget;
    g_drag_snap.hasTarget = true;
    showSnapPreview(g_drag_snap.target);
  });
  dispatch_resume(g_snap_dwell_timer);
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
  size_t n = 2;
  napi_value args[2];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  bool enabled = false;
  if (n < 1 || napi_get_value_bool(e, args[0], &enabled) != napi_ok) {
    napi_throw_type_error(e, nullptr, "drag snap enabled boolean required");
    return nullptr;
  }
  if (n >= 2) {
    int32_t dwellMs = 250;
    if (napi_get_value_int32(e, args[1], &dwellMs) == napi_ok) {
      g_snap_dwell_ms = std::clamp((int)dwellMs, 80, 1200);
    }
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
        if (g_finder_middle_enabled) emitFinderTrigger(point, false);
      } else if (event.type == NSEventTypeRightMouseDragged) {
        if (std::hypot(point.x - g_finder_down.x, point.y - g_finder_down.y) > 6.0) cancelFinderHold();
      } else if (event.type == NSEventTypeRightMouseDown) {
        cancelFinderHold();
        if (!g_finder_right_hold_enabled) return;
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

static napi_value setFinderTriggerOptions(napi_env e, napi_callback_info info) {
  size_t n = 2;
  napi_value args[2];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  if (n >= 1) napi_get_value_bool(e, args[0], &g_finder_middle_enabled);
  if (n >= 2) napi_get_value_bool(e, args[1], &g_finder_right_hold_enabled);
  if (!g_finder_right_hold_enabled) onMain(^{ cancelFinderHold(); });
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
static NSStatusItem* g_island_blocker_item = nil;
static NSString* g_blocker_current_key = nil;
static id g_blocker_move_obs = nil;
static id g_blocker_resize_obs = nil;
static napi_threadsafe_function g_island_anchor_tsfn = nullptr;
static NSRect g_blocker_screen_frame = {};
static double g_last_good_pref_pos = 0.0;
static double g_last_good_screen_w = 0.0;
static double g_blocker_slot_anchor_x = 0.0;
static bool g_has_blocker_slot_anchor = false;
static int g_blocker_seq = 0;
static int g_blocker_calib_gen = 0;

static void callIslandAnchorJS(napi_env env, napi_value cb, void*, void*) {
  if (env && cb) {
    napi_value recv;
    napi_get_undefined(env, &recv);
    napi_call_function(env, recv, cb, 0, nullptr, nullptr);
  }
}

static void notifyIslandAnchorChanged() {
  if (g_island_anchor_tsfn) {
    napi_call_threadsafe_function(g_island_anchor_tsfn, nullptr, napi_tsfn_nonblocking);
  }
}

static void detachBlockerWindowObservers() {
  NSNotificationCenter* nc = [NSNotificationCenter defaultCenter];
  if (g_blocker_move_obs) {
    [nc removeObserver:g_blocker_move_obs];
    g_blocker_move_obs = nil;
  }
  if (g_blocker_resize_obs) {
    [nc removeObserver:g_blocker_resize_obs];
    g_blocker_resize_obs = nil;
  }
}

static void hideBlockerWindow() {
  NSWindow* win = g_island_blocker_item.button.window;
  if (win && !win.ignoresMouseEvents) win.ignoresMouseEvents = YES;
  if (win && win.alphaValue != 0.0) win.alphaValue = 0.0;
}

static void clearBlockerDefaults() {
  NSUserDefaults* defs = [NSUserDefaults standardUserDefaults];
  NSDictionary<NSString*, id>* dict = [defs dictionaryRepresentation];
  for (NSString* key in [dict allKeys]) {
    if ([key hasPrefix:@"NSStatusItem Preferred Position LassoNotch"]) {
      [defs removeObjectForKey:key];
    }
  }
  g_blocker_current_key = nil;
}

static void removeBlockerItemOnMain() {
  detachBlockerWindowObservers();
  if (g_island_blocker_item) {
    [[NSStatusBar systemStatusBar] removeStatusItem:g_island_blocker_item];
    g_island_blocker_item = nil;
  }
  if (g_blocker_current_key) {
    [[NSUserDefaults standardUserDefaults] removeObjectForKey:g_blocker_current_key];
    g_blocker_current_key = nil;
  }
}

static void resetBlockerSlotOnMain() {
  g_blocker_calib_gen++;
  g_has_blocker_slot_anchor = false;
  g_blocker_screen_frame = NSZeroRect;
  removeBlockerItemOnMain();
  clearBlockerDefaults();
}

static void stopIslandBlocker() {
  onMain(^{
    resetBlockerSlotOnMain();
    if (g_island_anchor_tsfn) {
      napi_release_threadsafe_function(g_island_anchor_tsfn, napi_tsfn_abort);
      g_island_anchor_tsfn = nullptr;
    }
  });
}

static void createBlockerItemAtPos(double prefPos, double width) {
  removeBlockerItemOnMain();
  NSString* autosave = [NSString stringWithFormat:@"LassoNotchSlot_%d", ++g_blocker_seq];
  NSString* prefKey = [NSString stringWithFormat:@"NSStatusItem Preferred Position %@", autosave];
  g_blocker_current_key = prefKey;
  [[NSUserDefaults standardUserDefaults] setDouble:prefPos forKey:prefKey];
  g_island_blocker_item = [[NSStatusBar systemStatusBar] statusItemWithLength:width];
  g_island_blocker_item.autosaveName = autosave;
  NSStatusBarButton* btn = g_island_blocker_item.button;
  btn.title = @"";
  btn.image = nil;
  btn.enabled = NO;
  btn.appearsDisabled = NO;
  btn.target = nil;
  btn.action = nil;
  btn.hidden = YES;
  if ([btn.cell isKindOfClass:[NSButtonCell class]]) {
    ((NSButtonCell*)btn.cell).highlightsBy = NSNoCellMask;
  }
  hideBlockerWindow();
}

static bool validBlockerWindowFrame(double screenOriginX, double screenTopY, double screenWidth, NSRect* outRect) {
  if (!g_island_blocker_item || !g_island_blocker_item.button || !g_island_blocker_item.button.window) return false;
  NSRect bf = g_island_blocker_item.button.window.frame;
  if (bf.size.height <= 0.0 ||
      bf.origin.y < screenTopY - 45.0 ||
      bf.origin.x <= screenOriginX + 120.0 ||
      NSMaxX(bf) > screenOriginX + screenWidth + 4.0) {
    return false;
  }
  if (outRect) *outRect = bf;
  return true;
}

static void pollBlockerFrame(int gen, double screenOriginX, double screenTopY, double screenWidth,
                             double expectedWidth, double maxExpectedRight, int attempt, void (^done)(NSRect bf, bool valid)) {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 45 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
    if (gen != g_blocker_calib_gen) return;
    hideBlockerWindow();
    NSRect bf = NSZeroRect;
    bool ok = validBlockerWindowFrame(screenOriginX, screenTopY, screenWidth, &bf);
    if (ok && expectedWidth > 0.0 && std::abs(bf.size.width - expectedWidth) > 6.0) {
      ok = false;
    }
    if (ok && maxExpectedRight > 0.0 && NSMaxX(bf) > maxExpectedRight) {
      ok = false;
    }
    if (ok) {
      done(bf, true);
    } else if (attempt < 9) {
      pollBlockerFrame(gen, screenOriginX, screenTopY, screenWidth, expectedWidth, maxExpectedRight, attempt + 1, done);
    } else {
      bool fallbackOk = validBlockerWindowFrame(screenOriginX, screenTopY, screenWidth, &bf);
      done(fallbackOk ? bf : NSZeroRect, fallbackOk);
    }
  });
}

static void attachBlockerWindowObservers(int gen, double screenOriginX, double screenTopY,
                                         double screenWidth, double capsuleW) {
  detachBlockerWindowObservers();
  if (!g_island_blocker_item || !g_island_blocker_item.button || !g_island_blocker_item.button.window) return;
  NSWindow* win = g_island_blocker_item.button.window;
  // Menu bar relayouts also result from our own slot changes. Only read the
  // settled window here so its notifications cannot trigger another search.
  auto onWindowGeometry = ^(NSNotification*) {
    if (gen != g_blocker_calib_gen) return;
    NSRect bf = NSZeroRect;
    if (!validBlockerWindowFrame(screenOriginX, screenTopY, screenWidth, &bf) ||
        bf.size.width < capsuleW - 8.0) return;
    double nextAnchor = NSMidX(bf) - screenOriginX;
    if (std::abs(nextAnchor - g_blocker_slot_anchor_x) >= 0.5) {
      g_blocker_slot_anchor_x = nextAnchor;
      notifyIslandAnchorChanged();
    }
  };
  NSNotificationCenter* nc = [NSNotificationCenter defaultCenter];
  g_blocker_move_obs = [nc addObserverForName:NSWindowDidMoveNotification object:win queue:[NSOperationQueue mainQueue] usingBlock:onWindowGeometry];
  g_blocker_resize_obs = [nc addObserverForName:NSWindowDidResizeNotification object:win queue:[NSOperationQueue mainQueue] usingBlock:onWindowGeometry];
}

static void commitSettledBlocker(int gen, double prefPos, double screenOriginX, double screenTopY,
                                 double screenWidth, double capsuleW, NSRect settledBf, bool settledValid) {
  if (gen != g_blocker_calib_gen) return;
  if (settledValid && settledBf.size.width >= capsuleW - 8.0) {
    g_blocker_slot_anchor_x = NSMidX(settledBf) - screenOriginX;
    g_has_blocker_slot_anchor = true;
    g_last_good_pref_pos = prefPos;
    g_last_good_screen_w = screenWidth;
    attachBlockerWindowObservers(gen, screenOriginX, screenTopY, screenWidth, capsuleW);
  } else {
    removeBlockerItemOnMain();
    g_has_blocker_slot_anchor = false;
  }
  notifyIslandAnchorChanged();
}

static void finalizeBlockerWidth(int gen, double prefPos, double screenOriginX, double screenTopY,
                                 double screenWidth, double capsuleLeft, double capsuleRight, double probeWidth,
                                 bool sawLeftOfRightEdge, NSRect bf) {
  if (gen != g_blocker_calib_gen) return;
  double rightEdge = NSMaxX(bf);
  double capsuleW = capsuleRight - capsuleLeft;

  // If every status item already sits to the right of the capsule even when the probe is pushed
  // all the way left, no menu bar icon overlaps the capsule — remove the blocker to avoid empty padding.
  if (!sawLeftOfRightEdge && rightEdge >= capsuleRight + 2.0) {
    g_last_good_pref_pos = 0.0;
    commitSettledBlocker(gen, prefPos, screenOriginX, screenTopY, screenWidth, capsuleW, NSZeroRect, false);
    return;
  }

  // Measure the actual NSStatusBarWindow padding (e.g. 16pt on macOS 27) so the reserved window frame
  // matches capsuleW 1:1 with zero exposed gap and zero neighbor overlap.
  double pad = std::clamp((double)bf.size.width - probeWidth, 0.0, 32.0);
  double targetLen = std::max(8.0, std::round(capsuleW - pad));
  if (g_island_blocker_item && g_island_blocker_item.length != targetLen) {
    g_island_blocker_item.length = targetLen;
  }

  pollBlockerFrame(gen, screenOriginX, screenTopY, screenWidth, capsuleW, rightEdge + 16.0, 0, ^(NSRect settledBf, bool settledValid) {
    if (gen != g_blocker_calib_gen) return;
    if (settledValid && g_island_blocker_item && std::abs(settledBf.size.width - capsuleW) >= 2.0) {
      double adjusted = std::clamp(std::round(g_island_blocker_item.length + (capsuleW - settledBf.size.width)), 8.0, capsuleW);
      if (std::abs(adjusted - g_island_blocker_item.length) >= 1.0) {
        g_island_blocker_item.length = adjusted;
        pollBlockerFrame(gen, screenOriginX, screenTopY, screenWidth, capsuleW, rightEdge + 16.0, 4, ^(NSRect finalBf, bool finalValid) {
          commitSettledBlocker(gen, prefPos, screenOriginX, screenTopY, screenWidth, capsuleW, finalBf, finalValid);
        });
        return;
      }
    }
    commitSettledBlocker(gen, prefPos, screenOriginX, screenTopY, screenWidth, capsuleW, settledBf, settledValid);
  });
}

static void runBlockerCalibStep(int gen, int step, double lo, double hi, double bestPos, double bestScore,
                                bool sawLeftOfRightEdge, double screenOriginX, double screenTopY,
                                double screenWidth, double capsuleLeft, double capsuleRight,
                                double leftMenuRightX, double probeWidth) {
  if (gen != g_blocker_calib_gen) return;
  double mid = std::round((lo + hi) * 0.5);
  double screenCenterX = (capsuleLeft + capsuleRight) * 0.5;
  double capsuleW = capsuleRight - capsuleLeft;
  createBlockerItemAtPos(mid, probeWidth);
  pollBlockerFrame(gen, screenOriginX, screenTopY, screenWidth, 0.0, 0.0, 0, ^(NSRect bf, bool valid) {
    if (gen != g_blocker_calib_gen) return;
    if (!valid) {
      if (step < 8 && (hi - lo) >= 2.0) {
        // Probe was likely pushed off-bar to the left; back off rightwards.
        runBlockerCalibStep(gen, step + 1, lo, mid, bestPos, bestScore, true,
                            screenOriginX, screenTopY, screenWidth, capsuleLeft, capsuleRight, leftMenuRightX, probeWidth);
        return;
      }
      if (bestScore < 1e8) {
        createBlockerItemAtPos(bestPos, probeWidth);
        pollBlockerFrame(gen, screenOriginX, screenTopY, screenWidth, 0.0, 0.0, 0, ^(NSRect finalBf, bool finalValid) {
          if (gen != g_blocker_calib_gen) return;
          if (finalValid) {
            finalizeBlockerWidth(gen, bestPos, screenOriginX, screenTopY, screenWidth, capsuleLeft, capsuleRight, probeWidth, true, finalBf);
          } else {
            commitSettledBlocker(gen, bestPos, screenOriginX, screenTopY, screenWidth, capsuleW, NSZeroRect, false);
          }
        });
      } else {
        commitSettledBlocker(gen, mid, screenOriginX, screenTopY, screenWidth, capsuleW, NSZeroRect, false);
      }
      return;
    }

    double rightEdge = NSMaxX(bf);
    double overshoot = rightEdge - capsuleRight;
    bool nextSawLeft = sawLeftOfRightEdge || (overshoot < -2.0);
    // Expanding the probe leftward to capsuleW places its center at (rightEdge - capsuleW/2).
    // Minimize distance to screenCenterX while keeping the expanded left edge clear of app menus.
    double estimatedCenter = rightEdge - capsuleW * 0.5;
    double distFromCenter = std::abs(estimatedCenter - screenCenterX);
    double estimatedLeft = rightEdge - capsuleW;
    double leftPenalty = (estimatedLeft < leftMenuRightX + 8.0) ? (500.0 + (leftMenuRightX + 8.0 - estimatedLeft) * 4.0) : 0.0;
    double score = distFromCenter + leftPenalty;
    double nextBestScore = bestScore;
    double nextBestPos = bestPos;
    if (score < nextBestScore - 0.5 || (std::abs(score - nextBestScore) <= 0.5 && mid < nextBestPos)) {
      nextBestScore = score;
      nextBestPos = mid;
    }

    if ((distFromCenter <= 6.0 && leftPenalty == 0.0) || step >= 8 || (hi - lo) < 2.0) {
      if (std::abs(mid - nextBestPos) >= 1.0) {
        createBlockerItemAtPos(nextBestPos, probeWidth);
        pollBlockerFrame(gen, screenOriginX, screenTopY, screenWidth, 0.0, 0.0, 0, ^(NSRect finalBf, bool finalValid) {
          if (gen != g_blocker_calib_gen) return;
          if (finalValid) {
            finalizeBlockerWidth(gen, nextBestPos, screenOriginX, screenTopY, screenWidth, capsuleLeft, capsuleRight, probeWidth, nextSawLeft, finalBf);
          } else {
            commitSettledBlocker(gen, nextBestPos, screenOriginX, screenTopY, screenWidth, capsuleW, NSZeroRect, false);
          }
        });
      } else {
        finalizeBlockerWidth(gen, mid, screenOriginX, screenTopY, screenWidth, capsuleLeft, capsuleRight, probeWidth, nextSawLeft, bf);
      }
      return;
    }
    // Larger Preferred Position pushes the NSStatusItem further left (smaller X); smaller pushes it right.
    bool pushLeft = (overshoot > 0.0) && (leftPenalty == 0.0);
    double nextLo = pushLeft ? mid : lo;
    double nextHi = pushLeft ? hi : mid;
    runBlockerCalibStep(gen, step + 1, nextLo, nextHi, nextBestPos, nextBestScore, nextSawLeft,
                        screenOriginX, screenTopY, screenWidth, capsuleLeft, capsuleRight, leftMenuRightX, probeWidth);
  });
}

static void startBlockerCalibration(double screenOriginX, double screenTopY, double screenWidth,
                                    double screenCenterX, double capsuleW, double leftMenuRightX) {
  onMain(^{
    int gen = ++g_blocker_calib_gen;
    clearBlockerDefaults();
    const double probeWidth = 16.0;
    double capsuleLeft = screenCenterX - capsuleW * 0.5;
    double capsuleRight = screenCenterX + capsuleW * 0.5;
    double lo = 20.0;
    double hi = std::max(lo + 200.0, screenWidth * 0.88);

    // Fast path: reuse the last verified Preferred Position for this screen width when still near center
    // (e.g., returning from fullscreen) so menu bar icons do not shuffle unnecessarily.
    if (g_last_good_pref_pos >= lo && g_last_good_pref_pos <= hi &&
        std::abs(g_last_good_screen_w - screenWidth) < 1.0) {
      double cachedPos = g_last_good_pref_pos;
      createBlockerItemAtPos(cachedPos, probeWidth);
      pollBlockerFrame(gen, screenOriginX, screenTopY, screenWidth, 0.0, 0.0, 0, ^(NSRect bf, bool valid) {
        if (gen != g_blocker_calib_gen) return;
        if (valid) {
          double rightEdge = NSMaxX(bf);
          double estCenter = rightEdge - capsuleW * 0.5;
          double estLeft = rightEdge - capsuleW;
          if (std::abs(estCenter - screenCenterX) <= 24.0 && estLeft >= leftMenuRightX + 8.0) {
            finalizeBlockerWidth(gen, cachedPos, screenOriginX, screenTopY, screenWidth, capsuleLeft, capsuleRight, probeWidth, true, bf);
            return;
          }
        }
        runBlockerCalibStep(gen, 1, lo, hi, screenWidth * 0.5, 1e9, false,
                            screenOriginX, screenTopY, screenWidth, capsuleLeft, capsuleRight, leftMenuRightX, probeWidth);
      });
      return;
    }

    runBlockerCalibStep(gen, 1, lo, hi, screenWidth * 0.5, 1e9, false,
                        screenOriginX, screenTopY, screenWidth, capsuleLeft, capsuleRight, leftMenuRightX, probeWidth);
  });
}

static napi_value startIslandAnchorWatch(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value args[1];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  napi_valuetype type;
  if (n != 1 || napi_typeof(e, args[0], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(e, nullptr, "island anchor watch callback required");
    return nullptr;
  }
  if (g_island_anchor_tsfn) {
    napi_release_threadsafe_function(g_island_anchor_tsfn, napi_tsfn_abort);
    g_island_anchor_tsfn = nullptr;
  }
  napi_value name;
  napi_create_string_utf8(e, "lasso-island-anchor-watch", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(e, args[0], nullptr, name, 1, 1, nullptr, nullptr, nullptr,
                                      callIslandAnchorJS, &g_island_anchor_tsfn) == napi_ok) {
    napi_unref_threadsafe_function(e, g_island_anchor_tsfn);
  }
  napi_value undefined;
  napi_get_undefined(e, &undefined);
  return undefined;
}

static napi_value stopIslandAnchorWatch(napi_env e, napi_callback_info) {
  stopIslandBlocker();
  napi_value undefined;
  napi_get_undefined(e, &undefined);
  return undefined;
}

static napi_value notchGeometry(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value args[1];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  bool wantBlocker = true;
  if (n >= 1) {
    bool flag = true;
    if (napi_get_value_bool(e, args[0], &flag) == napi_ok) wantBlocker = flag;
  }
  napi_value obj;
  napi_create_object(e, &obj);
  bool hasNotch = false;
  double notchWidth = 156.0;
  double notchHeight = 28.0;
  double menuBarHeight = 28.0;
  double leftSafeWidth = 132.0;
  double rightSafeWidth = 56.0;
  double anchorX = 0.0;
  @autoreleasepool {
    NSScreen* screen = NSScreen.screens.firstObject ?: [NSScreen mainScreen];
    if (screen) {
      NSRect frame = screen.frame;
      NSRect visible = screen.visibleFrame;
      menuBarHeight = std::max(24.0, (double)(NSMaxY(frame) - NSMaxY(visible)));
      double screenWidth = frame.size.width;
      double screenCenterX = frame.origin.x + screenWidth / 2.0;
      // anchorX is relative to the primary display's left edge (frame.origin.x).
      anchorX = screenWidth / 2.0;

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
      double leftMenuRightX = frame.origin.x + std::min(310.0, screenWidth * 0.22);

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
      }

      if ((physicalNotch || !wantBlocker) && !NSIsEmptyRect(g_blocker_screen_frame)) {
        onMain(^{ resetBlockerSlotOnMain(); });
      }
      if (physicalNotch) {
        // Approach 1 (Hardware Notch Display with active cutout): lock to physical notch center, expand left wing only (0px on right).
        hasNotch = true;
        double leftFree = (notchLeftX - 6.0) - (leftMenuRightX + 12.0);
        leftSafeWidth = std::clamp(leftFree, 140.0, 216.0);
        rightSafeWidth = 0.0;
        anchorX = ((notchLeftX + notchRightX) / 2.0) - frame.origin.x;
      } else {
        // Approach 2 (Continuous Menu Bar without active cutout — external monitor or 16:10 scaled mode):
        // Compact centered capsule (132 + 56 = 188pt). Calibrate the NSStatusItem blocker's right edge tightly
        // to capsuleRight and size its length in-place to match capsuleLeft so neither side wastes menu bar space.
        hasNotch = false;
        leftSafeWidth = 132.0;
        rightSafeWidth = 56.0;
        const double capsuleW = leftSafeWidth + rightSafeWidth;

        if (wantBlocker && !NSEqualRects(frame, g_blocker_screen_frame)) {
          g_blocker_screen_frame = frame;
          g_has_blocker_slot_anchor = false;
          startBlockerCalibration(frame.origin.x, NSMaxY(frame), screenWidth, screenCenterX, capsuleW, leftMenuRightX);
        }

        anchorX = (wantBlocker && g_has_blocker_slot_anchor) ? g_blocker_slot_anchor_x : (screenWidth / 2.0);
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

static bool isPrimaryDisplayFullscreen() {
  @autoreleasepool {
    NSScreen* primary = NSScreen.screens.firstObject ?: [NSScreen mainScreen];
    if (!primary) return false;
    NSRect frame = primary.frame;
    double screenW = frame.size.width;
    double screenH = frame.size.height;
    if (screenW <= 0.0 || screenH <= 0.0) return false;

    double notchTop = 0.0;
    if (@available(macOS 12.0, *)) {
      notchTop = std::max(0.0, (double)primary.safeAreaInsets.top);
    }

    pid_t selfPid = getpid();
    NSRunningApplication* front = NSWorkspace.sharedWorkspace.frontmostApplication;
    pid_t frontPid = front ? front.processIdentifier : 0;

    if (frontPid > 0 && frontPid != selfPid && AXIsProcessTrusted()) {
      AXUIElementRef appRef = AXUIElementCreateApplication(frontPid);
      AXUIElementSetMessagingTimeout(appRef, 0.12f);
      CFTypeRef winRef = nullptr;
      if (AXUIElementCopyAttributeValue(appRef, kAXFocusedWindowAttribute, &winRef) == kAXErrorSuccess && winRef) {
        CFTypeRef fsRef = nullptr;
        bool axFullscreen = false;
        if (AXUIElementCopyAttributeValue((AXUIElementRef)winRef, CFSTR("AXFullScreen"), &fsRef) == kAXErrorSuccess && fsRef) {
          axFullscreen = CFGetTypeID(fsRef) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)fsRef);
          CFRelease(fsRef);
        }
        if (axFullscreen) {
          CFTypeRef posRef = nullptr, sizeRef = nullptr;
          CGPoint p = CGPointZero;
          CGSize s = CGSizeZero;
          bool hasBounds = false;
          if (AXUIElementCopyAttributeValue((AXUIElementRef)winRef, kAXPositionAttribute, &posRef) == kAXErrorSuccess && posRef) {
            hasBounds = AXValueGetValue((AXValueRef)posRef, kAXValueTypeCGPoint, &p);
            CFRelease(posRef);
          }
          if (hasBounds && AXUIElementCopyAttributeValue((AXUIElementRef)winRef, kAXSizeAttribute, &sizeRef) == kAXErrorSuccess && sizeRef) {
            hasBounds = AXValueGetValue((AXValueRef)sizeRef, kAXValueTypeCGSize, &s);
            CFRelease(sizeRef);
          }
          if (hasBounds) {
            double cx = p.x + s.width * 0.5;
            double cy = p.y + s.height * 0.5;
            if (cx >= 0.0 && cx <= screenW && cy >= 0.0 && cy <= screenH) {
              CFRelease(winRef);
              CFRelease(appRef);
              return true;
            }
          }
        }
        CFRelease(winRef);
      }
      CFRelease(appRef);
    }

    double menuBarInset = (double)(NSMaxY(frame) - NSMaxY(primary.visibleFrame));
    bool menuBarHidden = menuBarInset < 18.0;

    NSArray* list = CFBridgingRelease(CGWindowListCopyWindowInfo(
      kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID
    ));
    for (NSDictionary* w in list) {
      pid_t pid = [w[(id)kCGWindowOwnerPID] intValue];
      if (pid <= 0 || pid == selfPid) continue;
      int layer = [w[(id)kCGWindowLayer] intValue];
      if (layer < 0) continue;
      // Ignore normal-layer background windows; only a frontmost window with hidden menu bar
      // or a menu-bar-level+ fullscreen overlay (layer >= 24) truly covers the screen in fullscreen.
      if (layer < 24 && (pid != frontPid || !menuBarHidden)) continue;
      NSString* owner = w[(id)kCGWindowOwnerName];
      if (!owner ||
          [owner isEqualToString:@"Dock"] ||
          [owner isEqualToString:@"Window Server"] ||
          [owner isEqualToString:@"SystemUIServer"] ||
          [owner isEqualToString:@"Control Center"] ||
          [owner isEqualToString:@"ControlCenter"] ||
          [owner isEqualToString:@"Notification Center"] ||
          [owner isEqualToString:@"NotificationCenter"] ||
          [owner isEqualToString:@"Wallpaper"] ||
          [owner isEqualToString:@"Spotlight"] ||
          [owner isEqualToString:@"Finder"]) {
        continue;
      }
      NSNumber* alphaNum = w[(id)kCGWindowAlpha];
      if (alphaNum && [alphaNum doubleValue] <= 0.01) continue;

      CGRect r = CGRectZero;
      if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(id)kCGWindowBounds], &r)) continue;
      if (r.origin.x > 2.0 || (r.origin.x + r.size.width) < screenW - 2.0) continue;

      bool coversFullHeight = (r.origin.y <= 2.0 && (r.origin.y + r.size.height) >= screenH - 2.0);
      bool coversBelowNotch = (notchTop > 0.0 && r.origin.y <= notchTop + 2.0 && (r.origin.y + r.size.height) >= screenH - 2.0);
      if (coversFullHeight || (layer >= 24 && coversBelowNotch)) return true;
    }
    return false;
  }
}

static void callFullscreenJS(napi_env env, napi_value cb, void*, void* data) {
  auto* state = (bool*)data;
  if (env && cb && state) {
    napi_value recv, val;
    napi_get_undefined(env, &recv);
    napi_get_boolean(env, *state, &val);
    napi_call_function(env, recv, cb, 1, &val, nullptr);
  }
  delete state;
}

static void checkFullscreenState(bool immediateExit = false) {
  if (!g_fullscreen_tsfn) return;
  int current = isPrimaryDisplayFullscreen() ? 1 : 0;
  if (current == 1) {
    g_fullscreen_exit_streak = 0;
  } else if (g_last_fullscreen_state == 1 && !immediateExit) {
    // Require 2 consecutive non-fullscreen polls to avoid flickering during video decode / brief OSD.
    if (++g_fullscreen_exit_streak < 2) return;
  } else {
    g_fullscreen_exit_streak = 0;
  }
  if (current == g_last_fullscreen_state) return;
  g_last_fullscreen_state = current;
  auto* payload = new bool(current == 1);
  if (napi_call_threadsafe_function(g_fullscreen_tsfn, payload, napi_tsfn_nonblocking) != napi_ok) {
    delete payload;
  }
}

static void stopFullscreenMonitoring() {
  onMain(^{
    NSNotificationCenter* wsCenter = [NSWorkspace sharedWorkspace].notificationCenter;
    if (g_fullscreen_space_obs) [wsCenter removeObserver:g_fullscreen_space_obs];
    if (g_fullscreen_app_obs) [wsCenter removeObserver:g_fullscreen_app_obs];
    if (g_fullscreen_screen_obs) [[NSNotificationCenter defaultCenter] removeObserver:g_fullscreen_screen_obs];
    g_fullscreen_space_obs = g_fullscreen_app_obs = g_fullscreen_screen_obs = nil;
    if (g_fullscreen_timer) {
      dispatch_source_cancel(g_fullscreen_timer);
      g_fullscreen_timer = nil;
    }
    g_last_fullscreen_state = -1;
    g_fullscreen_exit_streak = 0;
    if (g_fullscreen_tsfn) {
      napi_release_threadsafe_function(g_fullscreen_tsfn, napi_tsfn_abort);
      g_fullscreen_tsfn = nullptr;
    }
  });
}

static napi_value startFullscreenWatch(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value args[1];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  napi_valuetype type;
  if (n != 1 || napi_typeof(e, args[0], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(e, nullptr, "fullscreen watch callback required");
    return nullptr;
  }
  stopFullscreenMonitoring();
  napi_value name;
  napi_create_string_utf8(e, "lasso-fullscreen-watch", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(e, args[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr,
                                      callFullscreenJS, &g_fullscreen_tsfn) != napi_ok) {
    napi_throw_error(e, nullptr, "Could not create fullscreen watch callback");
    return nullptr;
  }
  napi_unref_threadsafe_function(e, g_fullscreen_tsfn);

  onMain(^{
    NSNotificationCenter* wsCenter = [NSWorkspace sharedWorkspace].notificationCenter;
    auto handler = ^(NSNotification*) {
      checkFullscreenState(true);
    };
    g_fullscreen_space_obs = [wsCenter addObserverForName:NSWorkspaceActiveSpaceDidChangeNotification object:nil queue:[NSOperationQueue mainQueue] usingBlock:handler];
    g_fullscreen_app_obs = [wsCenter addObserverForName:NSWorkspaceDidActivateApplicationNotification object:nil queue:[NSOperationQueue mainQueue] usingBlock:handler];
    g_fullscreen_screen_obs = [[NSNotificationCenter defaultCenter] addObserverForName:NSApplicationDidChangeScreenParametersNotification object:nil queue:[NSOperationQueue mainQueue] usingBlock:handler];

    g_fullscreen_timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
    dispatch_source_set_timer(g_fullscreen_timer, dispatch_time(DISPATCH_TIME_NOW, 1000 * NSEC_PER_MSEC), 1000 * NSEC_PER_MSEC, 250 * NSEC_PER_MSEC);
    dispatch_source_set_event_handler(g_fullscreen_timer, ^{
      checkFullscreenState(false);
    });
    dispatch_resume(g_fullscreen_timer);

    checkFullscreenState(true);
  });

  napi_value undefined;
  napi_get_undefined(e, &undefined);
  return undefined;
}

static napi_value stopFullscreenWatch(napi_env e, napi_callback_info) {
  stopFullscreenMonitoring();
  napi_value undefined;
  napi_get_undefined(e, &undefined);
  return undefined;
}

/** Keeps the window in place during Mission Control and out of Cmd-` cycling; Electron exposes neither behavior. */
static napi_value setStationaryWindow(napi_env e, napi_callback_info info) {
  size_t n = 2;
  napi_value args[2];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  bool visibleOnFullScreen = false;
  if (n >= 2) {
    bool flag = false;
    if (napi_get_value_bool(e, args[1], &flag) == napi_ok) visibleOnFullScreen = flag;
  }
  void* bytes = nullptr;
  size_t length = 0;
  if (n >= 1 && napi_get_buffer_info(e, args[0], &bytes, &length) == napi_ok && length >= sizeof(void*)) {
    @autoreleasepool {
      NSWindow* win = ((__bridge NSView*)(*(void**)bytes)).window;
      // AppKit allows one behavior per group, and Chromium marks every top-level window Managed.
      NSWindowCollectionBehavior behavior = win.collectionBehavior & ~(NSWindowCollectionBehaviorManaged |
                                                                       NSWindowCollectionBehaviorTransient |
                                                                       NSWindowCollectionBehaviorParticipatesInCycle |
                                                                       NSWindowCollectionBehaviorFullScreenAuxiliary);
      if (visibleOnFullScreen) behavior |= NSWindowCollectionBehaviorFullScreenAuxiliary;
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
    {"pasteboardRich",nullptr,pasteboardRich,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"activateProcess",nullptr,activateProcess,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"pasteToProcess",nullptr,pasteToProcess,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"copySelectionToProcess",nullptr,copySelectionToProcess,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"startCopyWatch",nullptr,startCopyWatch,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"stopCopyWatch",nullptr,stopCopyWatch,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setWindowDragSnapEnabled",nullptr,setWindowDragSnapEnabled,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"startBridge",nullptr,startBridge,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"stopBridge",nullptr,stopBridge,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"postBridge",nullptr,postBridge,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"snapWindow",nullptr,snapWindow,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"focusedWindowFrame",nullptr,focusedWindowFrame,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"startFinderTrigger",nullptr,startFinderTrigger,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"stopFinderTrigger",nullptr,stopFinderTrigger,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setFinderTriggerOptions",nullptr,setFinderTriggerOptions,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"tileTwoWindows",nullptr,tileTwoWindows,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"frontmostApp",nullptr,frontmostApp,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"notchGeometry",nullptr,notchGeometry,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"startIslandAnchorWatch",nullptr,startIslandAnchorWatch,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"stopIslandAnchorWatch",nullptr,stopIslandAnchorWatch,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"startFullscreenWatch",nullptr,startFullscreenWatch,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"stopFullscreenWatch",nullptr,stopFullscreenWatch,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setStationaryWindow",nullptr,setStationaryWindow,nullptr,nullptr,nullptr,napi_default,nullptr}
  };
  napi_define_properties(e,exports,sizeof(d)/sizeof(d[0]),d);
  napi_add_env_cleanup_hook(e, [](void*) {
    stopBridgeMonitoring();
    stopFinderMonitoring();
    stopCopyMonitoring();
    stopDragSnapMonitoring();
    stopIslandBlocker();
    stopFullscreenMonitoring();
  }, nullptr);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
