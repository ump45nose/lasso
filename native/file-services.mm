#include <node_api.h>
#import <Cocoa/Cocoa.h>
#include <string>

static napi_threadsafe_function callback = nullptr;
@interface LassoFileServices : NSObject
- (void)generateImage:(NSPasteboard *)pasteboard userData:(NSString *)userData error:(NSString **)error;
@end
static LassoFileServices *provider = nil;
@implementation LassoFileServices
- (void)generateImage:(NSPasteboard *)pasteboard userData:(NSString *)userData error:(NSString **)error {
  NSArray<NSURL *> *urls = [pasteboard readObjectsForClasses:@[[NSURL class]] options:@{NSPasteboardURLReadingFileURLsOnlyKey:@YES}];
  NSMutableArray<NSString *> *paths = [NSMutableArray array];
  for (NSURL *url in urls) if (url.fileURL) [paths addObject:url.path];
  if (!paths.count) {
    id files = [pasteboard propertyListForType:NSFilenamesPboardType];
    if ([files isKindOfClass:[NSArray class]]) for (id file in files) if ([file isKindOfClass:[NSString class]]) [paths addObject:file];
  }
  if (paths.count != 1 || ![@[@"png", @"jpg", @"jpeg"] containsObject:paths.firstObject.pathExtension.lowercaseString]) {
    if (error) *error = @"请一次选择一张 PNG 或 JPEG 图片。";
    return;
  }
  auto *path = new std::string(paths.firstObject.UTF8String);
  if (!callback || napi_call_threadsafe_function(callback, path, napi_tsfn_nonblocking) != napi_ok) {
    delete path; if (error) *error = @"Lasso 正忙，请稍后重试。";
  }
}
@end
static void invoke(napi_env env, napi_value fn, void *, void *data) {
  auto *path = static_cast<std::string *>(data);
  if (env && fn) {
    napi_value value, global, result;
    napi_create_string_utf8(env, path->c_str(), path->size(), &value);
    napi_get_global(env, &global); napi_call_function(env, global, fn, 1, &value, &result);
  }
  delete path;
}
static void stop(void *) {
  if (provider && NSApp.servicesProvider == provider) NSApp.servicesProvider = nil;
  provider = nil;
  if (callback) { napi_release_threadsafe_function(callback, napi_tsfn_abort); callback = nullptr; }
}
static napi_value start(napi_env env, napi_callback_info info) {
  size_t count = 1; napi_value args[1], name; napi_valuetype type;
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (count != 1 || napi_typeof(env, args[0], &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "file service callback required"); return nullptr;
  }
  stop(nullptr); napi_create_string_utf8(env, "lasso-file-service", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, args[0], nullptr, name, 8, 1, nullptr, nullptr, nullptr, invoke, &callback) != napi_ok) {
    napi_throw_error(env, nullptr, "Unable to register file service"); return nullptr;
  }
  napi_unref_threadsafe_function(env, callback);
  provider = [[LassoFileServices alloc] init]; NSApp.servicesProvider = provider; NSUpdateDynamicServices();
  return nullptr;
}
static napi_value shutdown(napi_env, napi_callback_info) { stop(nullptr); return nullptr; }
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {{"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, nullptr}, {"stop", nullptr, shutdown, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, 2, methods); napi_add_env_cleanup_hook(env, stop, nullptr); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
