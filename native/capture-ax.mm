#include <node_api.h>
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#import <QuartzCore/QuartzCore.h>
#include <vector>
#include <string>

struct CaptureBounds { double x,y,w,h; };
struct Query { napi_async_work work; napi_deferred deferred; int pid; double x,y; std::vector<CaptureBounds> rects; int error=0; bool permission=false; bool granted=false; };
struct BridgeEvent { std::string name; std::string payload; };

static napi_threadsafe_function g_bridge_tsfn = nullptr;
static id g_present_obs = nil;
static id g_dismiss_obs = nil;
static NSMutableArray<NSPanel*>* g_glow_panels = nil;

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

static napi_value windows(napi_env e,napi_callback_info){@autoreleasepool {napi_value arr;napi_create_array(e,&arr);NSArray* list=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID));uint32_t idx=0;for(NSDictionary*w in list){if([w[(id)kCGWindowOwnerPID] intValue]==getpid()||[w[(id)kCGWindowLayer] intValue]!=0)continue;CGRect r;CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(id)kCGWindowBounds],&r);if(r.size.width<40||r.size.height<30)continue;napi_value o;napi_create_object(e,&o);prop(e,o,"x",r.origin.x);prop(e,o,"y",r.origin.y);prop(e,o,"width",r.size.width);prop(e,o,"height",r.size.height);prop(e,o,"pid",[w[(id)kCGWindowOwnerPID] intValue]);prop(e,o,"id",[w[(id)kCGWindowNumber] intValue]);napi_set_element(e,arr,idx++,o);}return arr;}}

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

static napi_value startBridge(napi_env e, napi_callback_info info) {
  size_t n = 1;
  napi_value args[1];
  napi_get_cb_info(e, info, &n, args, nullptr, nullptr);
  if (n < 1) return nullptr;
  if (g_bridge_tsfn) {
    napi_release_threadsafe_function(g_bridge_tsfn, napi_tsfn_abort);
    g_bridge_tsfn = nullptr;
  }
  napi_value name;
  napi_create_string_utf8(e, "lasso-nook-bridge", NAPI_AUTO_LENGTH, &name);
  napi_create_threadsafe_function(e, args[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr, callBridgeJS, &g_bridge_tsfn);
  napi_unref_threadsafe_function(e, g_bridge_tsfn);

  @autoreleasepool {
    NSDistributedNotificationCenter* center = [NSDistributedNotificationCenter defaultCenter];
    if (g_present_obs) [center removeObserver:g_present_obs];
    if (g_dismiss_obs) [center removeObserver:g_dismiss_obs];
    auto handler = ^(NSNotification* note) {
      if (!g_bridge_tsfn) return;
      NSString* json = note.userInfo[@"payload"] ?: (([note.object isKindOfClass:[NSString class]]) ? (NSString*)note.object : @"{}");
      auto* ev = new BridgeEvent{ std::string(note.name.UTF8String), std::string(json.UTF8String) };
      napi_call_threadsafe_function(g_bridge_tsfn, ev, napi_tsfn_nonblocking);
    };
    g_present_obs = [center addObserverForName:@"com.lasso.island.present" object:nil queue:[NSOperationQueue mainQueue] usingBlock:handler];
    g_dismiss_obs = [center addObserverForName:@"com.lasso.island.dismiss" object:nil queue:[NSOperationQueue mainQueue] usingBlock:handler];
  }
  napi_value undefined;
  napi_get_undefined(e, &undefined);
  return undefined;
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
      NSRunningApplication* app = [[NSWorkspace sharedWorkspace] frontmostApplication];
      if (app && app.processIdentifier > 0) {
        AXUIElementRef appRef = AXUIElementCreateApplication(app.processIdentifier);
        CFTypeRef winRef = nullptr;
        if (AXUIElementCopyAttributeValue(appRef, kAXFocusedWindowAttribute, &winRef) == kAXErrorSuccess && winRef) {
          ok = setAxWindowRect((AXUIElementRef)winRef, x, y, w, h);
          CFRelease(winRef);
        }
        CFRelease(appRef);
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

static napi_value notchGeometry(napi_env e, napi_callback_info) {
  napi_value obj;
  napi_create_object(e, &obj);
  bool hasNotch = false;
  double notchWidth = 156.0;
  double notchHeight = 28.0;
  double menuBarHeight = 28.0;
  @autoreleasepool {
    NSScreen* screen = NSScreen.screens.firstObject ?: [NSScreen mainScreen];
    if (screen) {
      NSRect frame = screen.frame;
      NSRect visible = screen.visibleFrame;
      menuBarHeight = std::max(24.0, (double)(NSMaxY(frame) - NSMaxY(visible)));
      if (@available(macOS 12.0, *)) {
        NSEdgeInsets insets = screen.safeAreaInsets;
        NSRect leftAux = screen.auxiliaryTopLeftArea;
        NSRect rightAux = screen.auxiliaryTopRightArea;
        if (insets.top > 0.0 && leftAux.size.width > 0.0 && rightAux.size.width > 0.0) {
          hasNotch = true;
          notchWidth = std::max(120.0, (double)(rightAux.origin.x - NSMaxX(leftAux)));
          notchHeight = (double)insets.top;
          menuBarHeight = std::max(menuBarHeight, notchHeight);
        }
      }
    }
  }
  napi_value vHas;
  napi_get_boolean(e, hasNotch, &vHas);
  napi_set_named_property(e, obj, "hasNotch", vHas);
  prop(e, obj, "width", notchWidth);
  prop(e, obj, "height", notchHeight);
  prop(e, obj, "menuBarHeight", menuBarHeight);
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
    {"requestScreen",nullptr,requestScreen,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"paste",nullptr,paste,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setGlow",nullptr,setGlow,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"startBridge",nullptr,startBridge,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"postBridge",nullptr,postBridge,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"snapWindow",nullptr,snapWindow,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"tileTwoWindows",nullptr,tileTwoWindows,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"frontmostApp",nullptr,frontmostApp,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"notchGeometry",nullptr,notchGeometry,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setStationaryWindow",nullptr,setStationaryWindow,nullptr,nullptr,nullptr,napi_default,nullptr}
  };
  napi_define_properties(e,exports,sizeof(d)/sizeof(d[0]),d);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
