#include <node_api.h>
#import <Cocoa/Cocoa.h>
#import <Vision/Vision.h>
#import <ImageIO/ImageIO.h>
#import <CoreImage/CoreImage.h>
#include <vector>
#include <string>
#include <mutex>
#include <atomic>
#include <unordered_map>
#include <algorithm>
#include <cmath>
#include <cstring>

struct Glyph { std::string text; double x,y,w,h; };
struct TextLine { std::string text; double x,y,w,h,confidence; std::vector<Glyph> glyphs; };
struct OCRWork {
  napi_async_work work; napi_deferred deferred; int32_t token=0;
  std::vector<std::string> languages; std::vector<unsigned char> bytes; std::vector<TextLine> lines; std::string error,mode;
  bool enhance=false; std::atomic<bool> canceled{false};
  std::mutex requestMutex; VNRecognizeTextRequest* __strong request=nil;
};
static std::mutex jobsMutex;
static std::unordered_map<int32_t,OCRWork*> jobs;
struct ImageOwner { CGImageRef image=nullptr; ~ImageOwner(){if(image)CGImageRelease(image);} };
static napi_value number(napi_env e,double n){napi_value v;napi_create_double(e,n,&v);return v;}
static void prop(napi_env e,napi_value o,const char*k,double n){napi_set_named_property(e,o,k,number(e,n));}
static void text(napi_env e,napi_value o,const char*k,const std::string&s){napi_value v;napi_create_string_utf8(e,s.data(),s.size(),&v);napi_set_named_property(e,o,k,v);}
static napi_value rect(napi_env e,double x,double y,double w,double h){napi_value o;napi_create_object(e,&o);prop(e,o,"x",x);prop(e,o,"y",y);prop(e,o,"width",w);prop(e,o,"height",h);return o;}

// Preserve Vision's individual boxes. Only shared word boxes need a fallback.
static void splitWord(std::vector<Glyph>&glyphs,size_t begin,size_t end){
  const auto box=glyphs[begin];if(box.w<=0||box.h<=0)return;
  std::vector<double>weights;double total=0;
  for(size_t k=begin;k<end;k++){NSString*s=[NSString stringWithUTF8String:glyphs[k].text.c_str()];double w=MAX(1,[s sizeWithAttributes:@{NSFontAttributeName:[NSFont systemFontOfSize:20]}].width);weights.push_back(w);total+=w;}
  double x=box.x;for(size_t k=begin;k<end;k++){auto&g=glyphs[k];g.x=x;g.w=box.w*weights[k-begin]/total;x+=g.w;}
}
static void placeWhitespace(TextLine&line){
  for(size_t i=0;i<line.glyphs.size();i++){
    auto&g=line.glyphs[i];NSString*s=[NSString stringWithUTF8String:g.text.c_str()];
    if([s stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]].length|| (g.w>0&&g.h>0))continue;
    // Vision often returns CGRectZero for spaces. Keep them between their
    // neighbors instead of placing an invisible hit target at image origin.
    double left=i?line.glyphs[i-1].x+line.glyphs[i-1].w:line.x;
    double right=line.x+line.w;
    for(size_t j=i+1;j<line.glyphs.size();j++)if(line.glyphs[j].w>0&&line.glyphs[j].h>0){right=line.glyphs[j].x;break;}
    g.x=std::clamp(std::min(left,right),line.x,line.x+line.w);g.w=std::max(.5,right-left);g.w=std::min(g.w,std::max(.5,line.x+line.w-g.x));g.y=line.y;g.h=line.h;
  }
}
static bool sharedBox(const Glyph&a,const Glyph&b){return fabs(a.x-b.x)<.5&&fabs(a.y-b.y)<.5&&fabs(a.w-b.w)<.5;}
static bool hasSharedBoxes(const TextLine&line){for(size_t i=1;i<line.glyphs.size();i++)if(line.glyphs[i].w>0&&sharedBox(line.glyphs[i-1],line.glyphs[i]))return true;return false;}
static bool perform(OCRWork*q,VNRecognizeTextRequest*request,CGImageRef image,NSError**error){
  {std::lock_guard<std::mutex>lock(q->requestMutex);if(q->canceled)return false;q->request=request;}
  @try{VNImageRequestHandler*handler=[[VNImageRequestHandler alloc] initWithCGImage:image options:@{}];return [handler performRequests:@[request] error:error];}
  @finally{std::lock_guard<std::mutex>lock(q->requestMutex);q->request=nil;}
}
static bool refineWord(TextLine&line,size_t begin,size_t end,NSArray<VNRecognizedTextObservation*>*observations,double width,double height){
  std::string joined;for(size_t k=begin;k<end;k++)joined+=line.glyphs[k].text;
  NSString*needle=[NSString stringWithUTF8String:joined.c_str()];if(!needle.length)return false;
  const auto box=line.glyphs[begin];CGRect expected=CGRectMake(box.x,box.y,box.w,box.h);for(size_t k=begin+1;k<end;k++){const auto&g=line.glyphs[k];expected=CGRectUnion(expected,CGRectMake(g.x,g.y,g.w,g.h));}
  for(VNRecognizedTextObservation*observation in observations)for(VNRecognizedText*candidate in [observation topCandidates:3]){
    NSRange search=NSMakeRange(0,candidate.string.length);
    while(search.length){
      NSRange match=[candidate.string rangeOfString:needle options:NSCaseInsensitiveSearch range:search];if(match.location==NSNotFound)break;
      search=NSMakeRange(NSMaxRange(match),candidate.string.length-NSMaxRange(match));if(match.length!=needle.length)continue;
      VNRectangleObservation*whole=[candidate boundingBoxForRange:match error:nil];if(!whole)continue;
      CGRect b=whole.boundingBox,actual=CGRectMake(b.origin.x*width,(1-CGRectGetMaxY(b))*height,b.size.width*width,b.size.height*height),overlap=CGRectIntersection(expected,actual);
      double intersection=CGRectIsNull(overlap)?0:overlap.size.width*overlap.size.height,area=expected.size.width*expected.size.height+actual.size.width*actual.size.height-intersection;
      if(area<=0||intersection/area<.35)continue;
      __block std::vector<Glyph> precise;
      [needle enumerateSubstringsInRange:NSMakeRange(0,needle.length) options:NSStringEnumerationByComposedCharacterSequences usingBlock:^(NSString*substring,NSRange range,NSRange,BOOL*){
        VNRectangleObservation*character=[candidate boundingBoxForRange:NSMakeRange(match.location+range.location,range.length) error:nil];CGRect r=character?character.boundingBox:CGRectZero;
        precise.push_back({substring.UTF8String,r.origin.x*width,(1-CGRectGetMaxY(r))*height,r.size.width*width,r.size.height*height});
      }];
      if(precise.size()!=end-begin||std::any_of(precise.begin(),precise.end(),[](const Glyph&g){return g.w<=0||g.h<=0;}))continue;
      bool distinct=true;for(size_t k=1;k<precise.size();k++)if(sharedBox(precise[k-1],precise[k]))distinct=false;
      if(!distinct)continue;
      for(size_t k=begin;k<end;k++){const auto&g=precise[k-begin];line.glyphs[k].x=g.x;line.glyphs[k].y=g.y;line.glyphs[k].w=g.w;line.glyphs[k].h=g.h;}return true;
    }
  }
  return false;
}
static void refineGroup(TextLine&line,size_t begin,size_t end,NSArray<VNRecognizedTextObservation*>*geometry,double width,double height){
  splitWord(line.glyphs,begin,end);
  if(refineWord(line,begin,end,geometry,width,height))return;
  std::vector<bool>precise(end-begin,false);
  const double left=line.glyphs[begin].x,right=line.glyphs[end-1].x+line.glyphs[end-1].w;
  auto letter=[](const Glyph&g){NSString*s=[NSString stringWithUTF8String:g.text.c_str()];return [s rangeOfCharacterFromSet:[NSCharacterSet alphanumericCharacterSet]].location!=NSNotFound;};
  for(size_t i=begin;i<end;){if(!letter(line.glyphs[i])){i++;continue;}size_t j=i+1;while(j<end&&letter(line.glyphs[j]))j++;if(j-i>=2&&refineWord(line,i,j,geometry,width,height))for(size_t k=i;k<j;k++)precise[k-begin]=true;i=j;}
  // Keep punctuation in the gaps between the independently matched tokens.
  for(size_t i=begin;i<end;){if(precise[i-begin]){i++;continue;}size_t j=i+1;while(j<end&&!precise[j-begin])j++;
    double start=i==begin?left:line.glyphs[i-1].x+line.glyphs[i-1].w,finish=j==end?right:line.glyphs[j].x,total=0;
    if(finish>start){for(size_t k=i;k<j;k++)total+=line.glyphs[k].w;double x=start;for(size_t k=i;k<j;k++){auto&g=line.glyphs[k];g.x=x;g.w=(finish-start)*g.w/total;x+=g.w;}}i=j;
  }
}
static CGImageRef enhanceImage(CGImageRef original){
  double width=CGImageGetWidth(original),height=CGImageGetHeight(original),factor=std::min(2.0,sqrt(16000000.0/(width*height)));
  if(factor<=1.05)return nullptr;
  CIImage*input=[CIImage imageWithCGImage:original];
  CIFilter*scale=[CIFilter filterWithName:@"CILanczosScaleTransform" withInputParameters:@{kCIInputImageKey:input,kCIInputScaleKey:@(factor),kCIInputAspectRatioKey:@1.0}];
  CIFilter*contrast=[CIFilter filterWithName:@"CIColorControls" withInputParameters:@{kCIInputImageKey:scale.outputImage,kCIInputContrastKey:@1.1}];
  static CIContext*context=[CIContext contextWithOptions:@{}];
  return [context createCGImage:contrast.outputImage fromRect:CGRectMake(0,0,ceil(width*factor),ceil(height*factor))];
}
static void execute(napi_env,void*data){@autoreleasepool {@try{
  auto*q=(OCRWork*)data;if(q->canceled)return;
  NSData*bytes=[NSData dataWithBytes:q->bytes.data() length:q->bytes.size()];
  CGImageSourceRef source=CGImageSourceCreateWithData((__bridge CFDataRef)bytes,nullptr);
  ImageOwner original{source?CGImageSourceCreateImageAtIndex(source,0,nullptr):nullptr};if(source)CFRelease(source);
  if(!original.image){q->error="无法读取用于识别的图片";return;}
  ImageOwner enhanced{q->enhance?enhanceImage(original.image):nullptr};if(q->canceled)return;
  CGImageRef image=enhanced.image?:original.image;
  const double width=CGImageGetWidth(original.image),height=CGImageGetHeight(original.image);
  VNRecognizeTextRequest*request=[[VNRecognizeTextRequest alloc] init];
  request.recognitionLevel=VNRequestTextRecognitionLevelAccurate;
  NSMutableArray*preferred=[NSMutableArray array]; if(q->mode=="code")[preferred addObject:@"en-US"]; for(const auto&language:q->languages){NSString*value=[NSString stringWithUTF8String:language.c_str()];if(![preferred containsObject:value])[preferred addObject:value];}
  NSArray*supported=[request supportedRecognitionLanguagesAndReturnError:nil];NSMutableArray*languages=[NSMutableArray array];for(NSString*language in preferred)if([supported containsObject:language])[languages addObject:language];
  if(!languages.count){q->error="没有本机支持的 OCR 语言，请修改截图设置";return;} request.recognitionLanguages=languages;
  request.usesLanguageCorrection=q->mode!="code";
  if(request.usesLanguageCorrection)request.customWords=@[@"Lasso",@"Codex",@"ChatGPT",@"Gemini",@"GitHub",@"TypeScript",@"JavaScript",@"SwiftUI"];
  NSError*error=nil;BOOL ok=perform(q,request,image,&error);
  if(q->canceled)return;
  if(!ok){q->error=error.localizedDescription.UTF8String?:"文字识别失败";return;}
  for(VNRecognizedTextObservation*observation in request.results){
    if(q->canceled)return;VNRecognizedText*candidate=[observation topCandidates:1].firstObject;if(!candidate)continue;
    NSString*string=candidate.string;CGRect bounds=observation.boundingBox;
    __block TextLine line={string.UTF8String,bounds.origin.x*width,(1-CGRectGetMaxY(bounds))*height,bounds.size.width*width,bounds.size.height*height,candidate.confidence,{}};
    [string enumerateSubstringsInRange:NSMakeRange(0,string.length) options:NSStringEnumerationByComposedCharacterSequences usingBlock:^(NSString*substring,NSRange range,NSRange,BOOL*){
      VNRectangleObservation*character=[candidate boundingBoxForRange:range error:nil];CGRect r=character?character.boundingBox:bounds;
      line.glyphs.push_back({substring.UTF8String,r.origin.x*width,(1-CGRectGetMaxY(r))*height,r.size.width*width,r.size.height*height});
    }];
    q->lines.push_back(std::move(line));
  }
  NSArray<VNRecognizedTextObservation*>*geometry=@[];
  if(std::any_of(q->lines.begin(),q->lines.end(),hasSharedBoxes)){
    VNRecognizeTextRequest*fast=[[VNRecognizeTextRequest alloc] init];fast.recognitionLevel=VNRequestTextRecognitionLevelFast;fast.usesLanguageCorrection=NO;
    NSArray*fastLanguages=[fast supportedRecognitionLanguagesAndReturnError:nil]; for(NSString*language in languages)if(![fastLanguages containsObject:language]){fast.recognitionLevel=VNRequestTextRecognitionLevelAccurate;break;} fast.recognitionLanguages=languages;
    if(perform(q,fast,image,nil))geometry=fast.results?:@[];
  }
  for(auto&line:q->lines){
    if(q->canceled)return;
    for(size_t i=0;i<line.glyphs.size();){size_t j=i+1;const auto first=line.glyphs[i];while(j<line.glyphs.size()&&sharedBox(first,line.glyphs[j]))j++;if(j-i>1&&first.w>0)refineGroup(line,i,j,geometry,width,height);i=j;}
    placeWhitespace(line);
  }
}@catch(NSException*exception){((OCRWork*)data)->error=exception.reason.UTF8String?:"文字识别失败";}}}
static void complete(napi_env e,napi_status status,void*data){
  auto*q=(OCRWork*)data;{std::lock_guard<std::mutex>lock(jobsMutex);jobs.erase(q->token);}
  if(!q->canceled&&(status!=napi_ok||!q->error.empty())){napi_value message,error;napi_create_string_utf8(e,q->error.empty()?"文字识别已取消":q->error.c_str(),NAPI_AUTO_LENGTH,&message);napi_create_error(e,nullptr,message,&error);napi_reject_deferred(e,q->deferred,error);}
  else{napi_value lines;napi_create_array_with_length(e,q->canceled?0:q->lines.size(),&lines);if(!q->canceled)for(size_t i=0;i<q->lines.size();i++){const auto&l=q->lines[i];napi_value o=rect(e,l.x,l.y,l.w,l.h),glyphs;napi_create_array_with_length(e,l.glyphs.size(),&glyphs);text(e,o,"text",l.text);prop(e,o,"confidence",l.confidence);for(size_t j=0;j<l.glyphs.size();j++){const auto&g=l.glyphs[j];napi_value glyph=rect(e,g.x,g.y,g.w,g.h);text(e,glyph,"text",g.text);napi_set_element(e,glyphs,j,glyph);}napi_set_named_property(e,o,"glyphs",glyphs);napi_set_element(e,lines,i,o);}napi_resolve_deferred(e,q->deferred,lines);}
  napi_delete_async_work(e,q->work);delete q;
}
static napi_value recognize(napi_env e,napi_callback_info info){
  size_t n=5;napi_value args[5];napi_get_cb_info(e,info,&n,args,nullptr,nullptr);void*bytes=nullptr;size_t size=0;bool buffer=false,enhance=false;int32_t token=0;char mode[16]={};size_t length=0;
  if(n!=5||napi_is_buffer(e,args[0],&buffer)!=napi_ok||!buffer||napi_get_buffer_info(e,args[0],&bytes,&size)!=napi_ok||size==0||size>64*1024*1024||napi_get_value_int32(e,args[1],&token)!=napi_ok||token<=0||napi_get_value_string_utf8(e,args[2],mode,sizeof(mode),&length)!=napi_ok||napi_get_value_bool(e,args[3],&enhance)!=napi_ok||(strcmp(mode,"text")&&strcmp(mode,"code"))){napi_throw_type_error(e,nullptr,"需要有效的 PNG 和识别选项");return nullptr;}
  auto*q=new OCRWork();q->token=token;q->mode=mode;q->enhance=enhance;q->bytes.assign((unsigned char*)bytes,(unsigned char*)bytes+size);napi_value promise,name;
  bool array=false;uint32_t count=0;napi_is_array(e,args[4],&array);if(array)napi_get_array_length(e,args[4],&count);
  if(!array||count==0||count>100){delete q;napi_throw_type_error(e,nullptr,"需要 OCR 语言列表");return nullptr;}
  for(uint32_t i=0;i<count;i++){napi_value item;char language[80]={};size_t len=0;napi_get_element(e,args[4],i,&item);if(napi_get_value_string_utf8(e,item,language,sizeof(language),&len)!=napi_ok||!len||len>=sizeof(language)-1){delete q;napi_throw_type_error(e,nullptr,"OCR 语言无效");return nullptr;}q->languages.emplace_back(language);}
  napi_create_promise(e,&q->deferred,&promise);napi_create_string_utf8(e,"capture-vision",NAPI_AUTO_LENGTH,&name);napi_create_async_work(e,nullptr,name,execute,complete,q,&q->work);{std::lock_guard<std::mutex>lock(jobsMutex);jobs[token]=q;}napi_queue_async_work(e,q->work);return promise;
}
static napi_value cancel(napi_env e,napi_callback_info info){
  size_t n=1;napi_value arg,undefined;napi_get_cb_info(e,info,&n,&arg,nullptr,nullptr);int32_t token=0;VNRecognizeTextRequest*request=nil;
  if(n==1&&napi_get_value_int32(e,arg,&token)==napi_ok){std::lock_guard<std::mutex>lock(jobsMutex);auto found=jobs.find(token);if(found!=jobs.end()){auto*q=found->second;q->canceled=true;std::lock_guard<std::mutex>requestLock(q->requestMutex);request=q->request;}}
  [request cancel];napi_get_undefined(e,&undefined);return undefined;
}
static napi_value supportedLanguages(napi_env e,napi_callback_info){@autoreleasepool {
  VNRecognizeTextRequest*request=[[VNRecognizeTextRequest alloc] init];request.recognitionLevel=VNRequestTextRecognitionLevelAccurate;
  NSError*error=nil;NSArray*languages=[request supportedRecognitionLanguagesAndReturnError:&error];
  if(!languages){napi_throw_error(e,nullptr,error.localizedDescription.UTF8String?:"无法读取 OCR 语言");return nullptr;}
  napi_value result;napi_create_array_with_length(e,languages.count,&result);for(NSUInteger i=0;i<languages.count;i++){napi_value value;napi_create_string_utf8(e,[languages[i] UTF8String],NAPI_AUTO_LENGTH,&value);napi_set_element(e,result,i,value);}return result;
}}
static napi_value init(napi_env e,napi_value exports){napi_property_descriptor d[]={{"recognize",nullptr,recognize,nullptr,nullptr,nullptr,napi_default,nullptr},{"cancel",nullptr,cancel,nullptr,nullptr,nullptr,napi_default,nullptr},{"supportedLanguages",nullptr,supportedLanguages,nullptr,nullptr,nullptr,napi_default,nullptr}};napi_define_properties(e,exports,3,d);return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
