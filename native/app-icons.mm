#include <node_api.h>
#include <string>
#import <Cocoa/Cocoa.h>

static napi_value icon(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t count = 1, length = 0; napi_value args[1], result;
    napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
    if (count != 1 || napi_get_value_string_utf8(env, args[0], nullptr, 0, &length) != napi_ok || length > 256) {
      napi_throw_type_error(env, nullptr, "bundle ID required"); return nullptr;
    }
    std::string id(length + 1, '\0');
    napi_get_value_string_utf8(env, args[0], id.data(), id.size(), &length);
    NSURL *url = [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:[NSString stringWithUTF8String:id.c_str()]];
    if (!url) { napi_get_null(env, &result); return result; }
    NSImage *image = [NSWorkspace.sharedWorkspace iconForFile:url.path];
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nullptr pixelsWide:64 pixelsHigh:64 bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:[NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap]];
    [image drawInRect:NSMakeRect(0, 0, 64, 64) fromRect:NSZeroRect operation:NSCompositingOperationCopy fraction:1.0];
    [NSGraphicsContext restoreGraphicsState];
    NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    NSString *data = [@"data:image/png;base64," stringByAppendingString:[png base64EncodedStringWithOptions:0]];
    napi_create_string_utf8(env, data.UTF8String, NAPI_AUTO_LENGTH, &result); return result;
  }
}
static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {{"icon", nullptr, icon, nullptr, nullptr, nullptr, napi_default, nullptr}};
  napi_define_properties(env, exports, 1, methods); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
