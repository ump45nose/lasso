#include <node_api.h>
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>
#include <vector>
struct CaptureBounds { double x,y,w,h; };
struct Query { napi_async_work work; napi_deferred deferred; int pid; double x,y; std::vector<CaptureBounds> rects; int error=0; bool permission=false; bool granted=false; };
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
static napi_value windows(napi_env e,napi_callback_info){@autoreleasepool {napi_value arr;napi_create_array(e,&arr);NSArray* list=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly|kCGWindowListExcludeDesktopElements,kCGNullWindowID));uint32_t idx=0;for(NSDictionary*w in list){if([w[(id)kCGWindowOwnerPID] intValue]==getpid()||[w[(id)kCGWindowLayer] intValue]!=0)continue;CGRect r;CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(id)kCGWindowBounds],&r);if(r.size.width<40||r.size.height<30)continue;napi_value o;napi_create_object(e,&o);prop(e,o,"x",r.origin.x);prop(e,o,"y",r.origin.y);prop(e,o,"width",r.size.width);prop(e,o,"height",r.size.height);prop(e,o,"pid",[w[(id)kCGWindowOwnerPID] intValue]);napi_set_element(e,arr,idx++,o);}return arr;}}
static napi_value requestScreen(napi_env e,napi_callback_info){auto*q=new Query();q->permission=true;napi_value promise,name;napi_create_promise(e,&q->deferred,&promise);napi_create_string_utf8(e,"capture-permission",NAPI_AUTO_LENGTH,&name);napi_create_async_work(e,nullptr,name,execute,complete,q,&q->work);napi_queue_async_work(e,q->work);return promise;}
static napi_value init(napi_env e,napi_value exports){napi_property_descriptor d[]={{"query",nullptr,query,nullptr,nullptr,nullptr,napi_default,nullptr},{"windows",nullptr,windows,nullptr,nullptr,nullptr,napi_default,nullptr},{"requestScreen",nullptr,requestScreen,nullptr,nullptr,nullptr,napi_default,nullptr}};napi_define_properties(e,exports,3,d);return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
