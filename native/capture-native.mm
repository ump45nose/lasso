#import <Cocoa/Cocoa.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <QuartzCore/QuartzCore.h>
#import <CoreText/CoreText.h>
#include <node_api.h>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>
#include <string>
#include <cmath>
#include <chrono>

// All AppKit and frame-store mutations run on Electron's AppKit thread. Expensive
// capture/color conversion runs on workers; no JS callback participates in dragging.
static napi_threadsafe_function events=nullptr;
static SCShareableContent *content=nil;
static NSString *contentFailure=nil;
static std::mutex contentMutex;
static std::unordered_map<std::string,std::shared_ptr<struct Frame>> frames;
static double now(){return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();}
struct Frame{CGImageRef image=nullptr;CGRect bounds;double scale=1;~Frame(){if(image)CGImageRelease(image);}};
static NSString* text(napi_env e,napi_value v){size_t n=0;napi_get_value_string_utf8(e,v,nullptr,0,&n);std::string s(n+1,'\0');napi_get_value_string_utf8(e,v,s.data(),s.size(),&n);return [NSString stringWithUTF8String:s.c_str()];}
static napi_value js(napi_env e,NSString*s){napi_value v;napi_create_string_utf8(e,s.UTF8String,NAPI_AUTO_LENGTH,&v);return v;}
static double num(napi_env e,napi_value o,const char*k,double fallback=0){napi_value v;double n;return napi_get_named_property(e,o,k,&v)==napi_ok&&napi_get_value_double(e,v,&n)==napi_ok?n:fallback;}
static bool flag(napi_env e,napi_value o,const char*k){napi_value v;bool b=false;napi_get_named_property(e,o,k,&v);napi_get_value_bool(e,v,&b);return b;}
static NSString* str(napi_env e,napi_value o,const char*k){napi_value v;napi_valuetype t;napi_get_named_property(e,o,k,&v);napi_typeof(e,v,&t);return t==napi_string?text(e,v):@"";}
static NSDictionary* json(napi_env e,napi_value value){napi_value global,J,fn,s;napi_get_global(e,&global);napi_get_named_property(e,global,"JSON",&J);napi_get_named_property(e,J,"stringify",&fn);napi_call_function(e,J,fn,1,&value,&s);NSData*d=[text(e,s) dataUsingEncoding:NSUTF8StringEncoding];return [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];}
static void set(napi_env e,napi_value o,const char*k,double n){napi_value v;napi_create_double(e,n,&v);napi_set_named_property(e,o,k,v);}
static napi_value rectJS(napi_env e,CGRect r){napi_value o;napi_create_object(e,&o);set(e,o,"x",r.origin.x);set(e,o,"y",r.origin.y);set(e,o,"width",r.size.width);set(e,o,"height",r.size.height);return o;}
static CGRect rect(NSDictionary*d){return CGRectMake([d[@"x"] doubleValue],[d[@"y"] doubleValue],[d[@"width"] doubleValue],[d[@"height"] doubleValue]);}
static NSDictionary* dictRect(CGRect r){return @{@"x":@(r.origin.x),@"y":@(r.origin.y),@"width":@(r.size.width),@"height":@(r.size.height)};}
static void emit(NSDictionary*d){if(!events)return;auto*p=new CFTypeRef((__bridge_retained CFTypeRef)d);if(napi_call_threadsafe_function(events,p,napi_tsfn_nonblocking)!=napi_ok){CFRelease(*p);delete p;}}
static void deliver(napi_env e,napi_value fn,void*,void*data){auto*p=(CFTypeRef*)data;NSDictionary*d=CFBridgingRelease(*p);delete p;if(!e)return;NSData*bytes=[NSJSONSerialization dataWithJSONObject:d options:0 error:nil];napi_value global,J,parse,s,out;napi_get_global(e,&global);napi_get_named_property(e,global,"JSON",&J);napi_get_named_property(e,J,"parse",&parse);s=js(e,[[NSString alloc]initWithData:bytes encoding:NSUTF8StringEncoding]);napi_call_function(e,J,parse,1,&s,&out);napi_call_function(e,global,fn,1,&out,nullptr);}
static SCShareableContent* getContent(bool refresh){std::lock_guard<std::mutex> lock(contentMutex);if(content&&!refresh&&content.displays.count)return content;dispatch_semaphore_t done=dispatch_semaphore_create(0);__block SCShareableContent* result=nil;[SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO completionHandler:^(SCShareableContent*c,NSError*error){contentFailure=error.localizedDescription;result=c;dispatch_semaphore_signal(done);}];dispatch_semaphore_wait(done,DISPATCH_TIME_FOREVER);if(result)content=result;return result;}
static NSColor* color(NSString*s,CGFloat alpha=1){unsigned n=0;[[NSScanner scannerWithString:[s stringByReplacingOccurrencesOfString:@"#" withString:@""]] scanHexInt:&n];return [NSColor colorWithSRGBRed:((n>>16)&255)/255.0 green:((n>>8)&255)/255.0 blue:(n&255)/255.0 alpha:alpha];}
static NSFont* font(NSDictionary*theme,NSString*role,CGFloat size){for(NSString*name in theme[role]){NSFont*f=[NSFont fontWithName:name size:size];if(f)return f;}return [NSFont systemFontOfSize:size];}
static CATextLayer* label(NSString*s,CGRect r,NSColor*c,NSFont*f){CATextLayer*l=[CATextLayer layer];l.frame=r;l.contentsScale=NSScreen.mainScreen.backingScaleFactor;l.string=[[NSAttributedString alloc]initWithString:s attributes:@{NSFontAttributeName:f,NSForegroundColorAttributeName:c}];return l;}
static bool hit(CGRect r,CGPoint p){return CGRectContainsPoint(r,p);}
static bool same(CGRect a,CGRect b){return fabs(a.origin.x-b.origin.x)<3&&fabs(a.origin.y-b.origin.y)<3&&fabs(a.size.width-b.size.width)<5&&fabs(a.size.height-b.size.height)<5;}

@interface CapturePanel:NSPanel
@end
@implementation CapturePanel
-(BOOL)canBecomeKeyWindow{return YES;}
-(BOOL)canBecomeMainWindow{return NO;}
-(BOOL)performKeyEquivalent:(NSEvent*)e{if((e.modifierFlags&NSEventModifierFlagCommand)&&[e.charactersIgnoringModifiers.lowercaseString isEqual:@"w"]){[self cancelOperation:nil];return YES;}return [super performKeyEquivalent:e];}
-(void)cancelOperation:(id)sender{emit(@{@"type":@"cancel",@"session":[self.contentView valueForKey:@"session"]?:@""});}
@end
@interface CaptureView:NSView
@property(nonatomic,strong) NSString*session;
@property(nonatomic,strong) NSString*mode;
@property(nonatomic,strong) NSDictionary*theme;
@property(nonatomic,strong) NSArray<NSDictionary*>*windows;
@property(nonatomic,strong) NSArray<NSDictionary*>*candidates;
@property(nonatomic,strong) NSArray<NSDictionary*>*options;
@property(nonatomic,strong) NSDictionary*chosen;
@property(nonatomic,strong) NSDictionary*target;
@property(nonatomic,strong) NSString*message;
@property(nonatomic,strong) NSView*guide;
@property(nonatomic,strong) CALayer*backdrop;
@property(nonatomic,strong) CAShapeLayer*shade;
@property(nonatomic,strong) CAShapeLayer*outline;
@property(nonatomic,strong) CALayer*loupe;
@property(nonatomic,strong) CATextLayer*sizeLabel;
@property(nonatomic,strong) NSButton*retry;
@property(nonatomic) std::shared_ptr<Frame> imageFrame;
@property(nonatomic) CGPoint point;
@property(nonatomic) CGPoint down;
@property(nonatomic) CGPoint choicePoint;
@property(nonatomic) CGPoint lastHover;
@property(nonatomic) CGRect selected;
@property(nonatomic) CGSize fixedSize;
@property(nonatomic) BOOL dragging;
@property(nonatomic) BOOL pressed;
@property(nonatomic) BOOL frozen;
@property(nonatomic) BOOL firstDraw;
@property(nonatomic) double started;
-(void)update;
-(void)buildGuide;
@end
static CapturePanel* panel=nil;
static CaptureView* view=nil;
@implementation CaptureView
-(BOOL)isFlipped{return YES;}
-(BOOL)acceptsFirstResponder{return YES;}
-(void)updateTrackingAreas{[super updateTrackingAreas];for(NSTrackingArea*a in self.trackingAreas)[self removeTrackingArea:a];[self addTrackingArea:[[NSTrackingArea alloc]initWithRect:self.bounds options:NSTrackingMouseMoved|NSTrackingMouseEnteredAndExited|NSTrackingActiveAlways|NSTrackingInVisibleRect owner:self userInfo:nil]];}
-(void)drawRect:(NSRect)dirty{if(self.imageFrame&&self.session&&!self.firstDraw){self.firstDraw=YES;emit(@{@"type":@"shown",@"session":self.session,@"nativeReadyMs":@(now()-self.started)});}}
-(void)resetCursorRects{[self addCursorRect:self.bounds cursor:[self.mode isEqual:@"window"]?NSCursor.arrowCursor:NSCursor.crosshairCursor];}
-(void)button:(NSButton*)b{NSString*a=b.identifier;if(self.frozen&&![a isEqual:@"cancel"]&&![a isEqual:@"retry"])return;if([a isEqual:@"cancel"]){emit(@{@"type":@"cancel",@"session":self.session});return;}if([a isEqual:@"retry"]){emit(@{@"type":@"retry",@"session":self.session});return;}if([a isEqual:@"screen"]){self.frozen=YES;self.selected=self.bounds;[self buildGuide];[self update];emit(@{@"type":@"screen",@"session":self.session});return;}self.mode=a;self.chosen=nil;self.dragging=NO;self.pressed=NO;self.selected=CGRectZero;[self buildGuide];[self update];[self.window invalidateCursorRectsForView:self];emit(@{@"type":@"mode",@"session":self.session,@"mode":a});}
-(NSButton*)makeButton:(NSString*)title action:(NSString*)action x:(CGFloat)x width:(CGFloat)w{
 NSButton*b=[[NSButton alloc]initWithFrame:NSMakeRect(x,5,w,28)];b.title=title;b.identifier=action;b.bordered=NO;b.target=self;b.action=@selector(button:);b.font=font(self.theme,@"uiFonts",12.5);b.contentTintColor=color(self.theme[@"on-ink"]);b.wantsLayer=YES;b.layer.cornerRadius=10;b.layer.backgroundColor=([self.mode isEqual:action]?color(self.theme[@"clay"]):color(self.theme[@"on-ink"],.08)).CGColor;
 NSString*icon=self.theme[@"icons"][action];if(icon){b.image=[[NSImage alloc]initWithContentsOfFile:icon];b.image.size=NSMakeSize(14,14);[b.image setTemplate:YES];b.imagePosition=NSImageLeft;b.imageScaling=NSImageScaleProportionallyDown;}
 [b setAccessibilityLabel:title];[self.guide addSubview:b];return b;
}
-(void)buildGuide{
 [self.guide removeFromSuperview];self.guide=[[NSView alloc]initWithFrame:NSMakeRect(0,0,1,38)];self.guide.wantsLayer=YES;self.guide.layer.backgroundColor=color(self.theme[@"ink"],.94).CGColor;self.guide.layer.cornerRadius=13;
 CGFloat x=5;BOOL manual=[self.mode isEqual:@"rect"];
 if(!self.frozen){if(!manual){NSArray*items=@[@[@"区域",@"area"],@[@"窗口",@"window"],@[@"滚动",@"scroll"]];for(NSArray*a in items){[self makeButton:a[0] action:a[1] x:x width:68];x+=72;}}
 NSString*help=self.frozen?@"":self.fixedSize.width>0?@"移动定位 · 点击放置":manual?@"拖动框选 · R 上次区域": [self.mode isEqual:@"window"]?@"点击窗口 · ⌥ 阴影 · ↩ 确认": [self.mode isEqual:@"scroll"]?@"框选后手动滚动":@"悬停识别 · 滚轮选层 · 拖动框选";
 CATextLayer*l=label(help,CGRectMake(x+8,11,manual?220:260,22),color(self.theme[@"on-ink"]),font(self.theme,@"uiFonts",12.5));[self.guide.layer addSublayer:l];x+=manual?236:276;[self makeButton:@"F 全屏" action:@"screen" x:x width:72];x+=76;
 }else if(self.message.length){CATextLayer*l=label(self.message,CGRectMake(x+8,11,380,22),color(self.theme[@"on-ink"]),font(self.theme,@"uiFonts",12));[self.guide.layer addSublayer:l];x+=396;[self makeButton:@"重试" action:@"retry" x:x width:64];x+=68;}
 [self makeButton:@"Esc 取消" action:@"cancel" x:x width:86];x+=91;CGFloat w=MIN(x,self.bounds.size.width-16);self.guide.frame=NSMakeRect((self.bounds.size.width-w)/2,self.bounds.size.height-64,w,38);[self addSubview:self.guide];
}
-(void)update{
 if(!self.imageFrame)return;[CATransaction begin];[CATransaction setDisableActions:YES];CGFloat W=self.bounds.size.width,H=self.bounds.size.height;
 if(!self.frozen&&self.fixedSize.width>0){self.selected=CGRectMake(MAX(0,MIN(W-self.fixedSize.width,self.point.x-self.fixedSize.width/2)),MAX(0,MIN(H-self.fixedSize.height,self.point.y-self.fixedSize.height/2)),self.fixedSize.width,self.fixedSize.height);}
 else if(!self.frozen&&!self.dragging){self.target=nil;for(NSDictionary*w in self.windows)if(hit(rect(w),self.point)){self.target=w;break;}
 if([self.mode isEqual:@"window"])self.selected=self.target?rect(self.target):CGRectZero;
 else if([self.mode isEqual:@"rect"])self.selected=CGRectZero;
 else {NSMutableArray*list=[NSMutableArray array];for(NSDictionary*c in self.candidates)if(hit(rect(c),self.point))[list addObject:c];self.options=list;if(self.chosen&&hit(rect(self.chosen),self.point))self.selected=rect(self.chosen);else{self.chosen=nil;self.selected=list.count?rect(list[0]):CGRectZero;}}}
 CGMutablePathRef path=CGPathCreateMutable();CGPathAddRect(path,nullptr,self.bounds);BOOL has=self.selected.size.width>0&&self.selected.size.height>0;if(has)CGPathAddRect(path,nullptr,self.selected);self.shade.path=path;self.shade.fillRule=kCAFillRuleEvenOdd;CGPathRelease(path);
 CGPathRef border=has?CGPathCreateWithRect(self.selected,nullptr):nullptr;self.outline.path=border;if(border)CGPathRelease(border);
 [self.sizeLabel removeFromSuperlayer];if(has){NSString*s=[NSString stringWithFormat:@"%.0f × %.0f%@",self.selected.size.width*CGImageGetWidth(self.imageFrame->image)/W,self.selected.size.height*CGImageGetHeight(self.imageFrame->image)/H, self.frozen?@"":[self.mode isEqual:@"window"]?@"  窗口":@""];CGFloat y=self.selected.origin.y>=33?self.selected.origin.y-30:self.selected.origin.y+6;self.sizeLabel=label(s,CGRectMake(MAX(8,MIN(W-180,self.selected.origin.x)),y,180,26),color(self.theme[@"on-ink"]),font(self.theme,@"monoFonts",12));self.sizeLabel.backgroundColor=color(self.theme[@"ink"]).CGColor;self.sizeLabel.cornerRadius=6;[self.layer addSublayer:self.sizeLabel];}
 self.loupe.hidden=self.frozen||hit(self.guide.frame,self.point);if(!self.loupe.hidden){CGFloat sx=CGImageGetWidth(self.imageFrame->image)/W,sy=CGImageGetHeight(self.imageFrame->image)/H;size_t px=MIN(CGImageGetWidth(self.imageFrame->image)-1,MAX(0,floor(self.point.x*sx))),py=MIN(CGImageGetHeight(self.imageFrame->image)-1,MAX(0,floor(self.point.y*sy)));
 CGFloat left=self.point.x+24+160<=W-8?self.point.x+24:self.point.x-184,top=self.point.y+24+200<=H-8?self.point.y+24:self.point.y-224;self.loupe.frame=CGRectMake(MAX(8,MIN(W-168,left)),MAX(8,MIN(H-208,top)),160,200);
 // Crop first; color conversion touches at most 17×17 pixels, never the full frame.
 unsigned char tile[17*17*4]={0};CGColorSpaceRef space=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);CGContextRef ctx=CGBitmapContextCreate(tile,17,17,8,17*4,space,kCGImageAlphaPremultipliedLast|kCGBitmapByteOrder32Big);
 int x0=MAX(0,(int)px-8),y0=MAX(0,(int)py-8),x1=MIN((int)CGImageGetWidth(self.imageFrame->image),(int)px+9),y1=MIN((int)CGImageGetHeight(self.imageFrame->image),(int)py+9);CGImageRef crop=CGImageCreateWithImageInRect(self.imageFrame->image,CGRectMake(x0,y0,x1-x0,y1-y0));
 CGContextDrawImage(ctx,CGRectMake(x0-(int)px+8,17-(y0-(int)py+8)-(y1-y0),x1-x0,y1-y0),crop);CGImageRelease(crop);CGImageRef zoom=CGBitmapContextCreateImage(ctx);CALayer*picture=self.loupe.sublayers[0];picture.contents=(__bridge id)zoom;CGImageRelease(zoom);CGContextRelease(ctx);CGColorSpaceRelease(space);
 size_t i=(8*17+8)*4;unsigned a=tile[i+3];unsigned r=a?MIN(255,tile[i]*255/a):0,g=a?MIN(255,tile[i+1]*255/a):0,b=a?MIN(255,tile[i+2]*255/a):0;NSString*hex=[NSString stringWithFormat:@"#%02X%02X%02X",r,g,b];CALayer*chip=self.loupe.sublayers[2];chip.backgroundColor=color(hex).CGColor;
 CATextLayer*value=(CATextLayer*)self.loupe.sublayers[3];value.string=[[NSAttributedString alloc]initWithString:hex attributes:@{NSFontAttributeName:font(self.theme,@"monoFonts",11),NSForegroundColorAttributeName:color(self.theme[@"on-ink"])}];CATextLayer*position=(CATextLayer*)self.loupe.sublayers[4];position.string=[[NSAttributedString alloc]initWithString:[NSString stringWithFormat:@"X %zu · Y %zu px",px,py] attributes:@{NSFontAttributeName:font(self.theme,@"monoFonts",11),NSForegroundColorAttributeName:color(self.theme[@"oat"])}];}
 [CATransaction commit];
}
-(void)mouseMoved:(NSEvent*)e{if(self.frozen)return;self.point=[self convertPoint:e.locationInWindow fromView:nil];if(self.chosen&&(hypot(self.point.x-self.choicePoint.x,self.point.y-self.choicePoint.y)>=5||!hit(rect(self.chosen),self.point)))self.chosen=nil;[self update];if(![self.mode isEqual:@"rect"]&&![self.mode isEqual:@"window"]&&hypot(self.point.x-self.lastHover.x,self.point.y-self.lastHover.y)>=5){self.lastHover=self.point;emit(@{@"type":@"hover",@"session":self.session,@"x":@(self.point.x),@"y":@(self.point.y)});}}
-(void)mouseDown:(NSEvent*)e{if(!self.imageFrame)return;if(self.frozen){if(e.clickCount==2&&![self.mode isEqual:@"scroll"]&&hit(self.selected,[self convertPoint:e.locationInWindow fromView:nil]))emit(@{@"type":@"copy",@"session":self.session});return;}[self mouseMoved:e];if([self.mode isEqual:@"window"]){if(self.target){self.frozen=YES;[self buildGuide];[self update];emit(@{@"type":@"window",@"session":self.session,@"id":self.target[@"id"],@"shadow":@((e.modifierFlags&NSEventModifierFlagOption)!=0)});}return;}self.down=self.point;self.pressed=YES;}
-(void)updateDrag:(BOOL)square{
 if(!self.dragging)return;
 CGFloat dx=self.point.x-self.down.x,dy=self.point.y-self.down.y;
 if(square){CGFloat d=MIN(MAX(fabs(dx),fabs(dy)),MIN(dx<0?self.down.x:self.bounds.size.width-self.down.x,dy<0?self.down.y:self.bounds.size.height-self.down.y));dx=dx<0?-d:d;dy=dy<0?-d:d;}
 self.selected=CGRectMake(MIN(self.down.x+dx,self.down.x),MIN(self.down.y+dy,self.down.y),fabs(dx),fabs(dy));[self update];
}
-(void)mouseDragged:(NSEvent*)e{
 if(self.frozen||!self.pressed||self.fixedSize.width>0)return;
 self.point=[self convertPoint:e.locationInWindow fromView:nil];self.point=CGPointMake(MAX(0,MIN(self.bounds.size.width,self.point.x)),MAX(0,MIN(self.bounds.size.height,self.point.y)));
 if(hypot(self.point.x-self.down.x,self.point.y-self.down.y)>3)self.dragging=YES;
 [self updateDrag:(e.modifierFlags&NSEventModifierFlagShift)!=0];
}
-(void)flagsChanged:(NSEvent*)e{if(!self.frozen&&self.pressed&&self.fixedSize.width==0)[self updateDrag:(e.modifierFlags&NSEventModifierFlagShift)!=0];}
-(void)mouseUp:(NSEvent*)e{if(self.frozen||!self.pressed||!self.imageFrame)return;self.pressed=NO;CGRect r=self.selected;if(r.size.width*CGImageGetWidth(self.imageFrame->image)/self.bounds.size.width<2||r.size.height*CGImageGetHeight(self.imageFrame->image)/self.bounds.size.height<2)return;self.frozen=YES;self.dragging=NO;[self buildGuide];[self update];emit(@{@"type":[self.mode isEqual:@"scroll"]?@"scroll":@"select",@"session":self.session,@"rect":dictRect(r),@"kind":[self.mode isEqual:@"rect"]?@"rect":@"area"});}
-(void)rightMouseDown:(NSEvent*)e{if(self.pressed){self.pressed=NO;self.dragging=NO;self.selected=CGRectZero;[self update];}else emit(@{@"type":@"cancel",@"session":self.session});}
-(void)scrollWheel:(NSEvent*)e{if(self.frozen||[self.mode isEqual:@"window"]||[self.mode isEqual:@"rect"]||!self.options.count)return;NSInteger index=0;for(NSUInteger i=0;i<self.options.count;i++)if(same(rect(self.options[i]),self.selected)){index=i;break;}index=(index+(e.scrollingDeltaY<0?1:-1)+(NSInteger)self.options.count)%self.options.count;self.chosen=self.options[index];self.choicePoint=self.point;[self update];}
-(void)keyDown:(NSEvent*)e{if(!self.imageFrame)return;NSString*k=e.charactersIgnoringModifiers.lowercaseString;if(e.keyCode==53&&self.pressed){self.pressed=NO;self.dragging=NO;self.selected=CGRectZero;[self update];return;}if(e.keyCode==53||((e.modifierFlags&NSEventModifierFlagCommand)&&[k isEqual:@"w"])) {[self button:({NSButton*b=[NSButton new];b.identifier=@"cancel";b;})];return;}if(self.frozen)return;if([k isEqual:@"r"]&&!(e.modifierFlags&(NSEventModifierFlagCommand|NSEventModifierFlagControl|NSEventModifierFlagOption|NSEventModifierFlagShift))){emit(@{@"type":@"last",@"session":self.session});return;}if(e.keyCode==36&&![self.mode isEqual:@"window"]&&self.selected.size.width>0){self.pressed=YES;[self mouseUp:e];emit(@{@"type":@"copy",@"session":self.session});return;}if([k isEqual:@"f"]&&!(e.modifierFlags&(NSEventModifierFlagCommand|NSEventModifierFlagControl))){NSButton*b=[NSButton new];b.identifier=@"screen";[self button:b];}else if([k isEqual:@" "]&&![self.mode isEqual:@"rect"]){NSButton*b=[NSButton new];b.identifier=[self.mode isEqual:@"area"]?@"window":@"area";[self button:b];}else if(e.keyCode==36&&[self.mode isEqual:@"window"]&&self.target){self.frozen=YES;[self buildGuide];[self update];emit(@{@"type":@"window",@"session":self.session,@"id":self.target[@"id"],@"shadow":@((e.modifierFlags&NSEventModifierFlagOption)!=0)});}}
@end

static void ensurePanel(NSDictionary*theme){if(panel){view.theme=theme;return;}panel=[[CapturePanel alloc]initWithContentRect:NSMakeRect(0,0,760,500) styleMask:NSWindowStyleMaskBorderless|NSWindowStyleMaskNonactivatingPanel backing:NSBackingStoreBuffered defer:NO];panel.releasedWhenClosed=NO;panel.excludedFromWindowsMenu=YES;panel.level=CGWindowLevelForKey(kCGScreenSaverWindowLevelKey);panel.collectionBehavior=NSWindowCollectionBehaviorCanJoinAllSpaces|NSWindowCollectionBehaviorFullScreenAuxiliary|NSWindowCollectionBehaviorStationary|NSWindowCollectionBehaviorIgnoresCycle;panel.hidesOnDeactivate=NO;panel.opaque=YES;panel.hasShadow=NO;panel.acceptsMouseMovedEvents=YES;panel.animationBehavior=NSWindowAnimationBehaviorNone;panel.title=@"Lasso 截图选择";view=[[CaptureView alloc]initWithFrame:panel.contentView.bounds];view.theme=theme;view.wantsLayer=YES;view.layer.geometryFlipped=YES;panel.contentView=view;
 view.backdrop=[CALayer layer];view.backdrop.contentsGravity=kCAGravityResize;[view.layer addSublayer:view.backdrop];view.shade=[CAShapeLayer layer];view.shade.fillColor=color(theme[@"ink"],.52).CGColor;[view.layer addSublayer:view.shade];view.outline=[CAShapeLayer layer];view.outline.fillColor=NSColor.clearColor.CGColor;view.outline.strokeColor=color(theme[@"clay"]).CGColor;view.outline.lineWidth=1.5;[view.layer addSublayer:view.outline];
 view.loupe=[CALayer layer];view.loupe.backgroundColor=color(theme[@"ink"]).CGColor;view.loupe.cornerRadius=10;view.loupe.masksToBounds=YES;[view.layer addSublayer:view.loupe];CALayer*picture=[CALayer layer];picture.frame=CGRectMake(12,12,136,136);picture.magnificationFilter=kCAFilterNearest;picture.minificationFilter=kCAFilterNearest;[view.loupe addSublayer:picture];CALayer*center=[CALayer layer];center.frame=CGRectMake(76,76,8,8);center.borderWidth=1;center.borderColor=color(theme[@"on-ink"]).CGColor;center.shadowColor=color(theme[@"ink"]).CGColor;center.shadowOpacity=1;center.shadowRadius=0;center.shadowOffset=CGSizeMake(1,1);[view.loupe addSublayer:center];CALayer*swatch=[CALayer layer];swatch.frame=CGRectMake(12,154,12,12);swatch.cornerRadius=3;[view.loupe addSublayer:swatch];[view.loupe addSublayer:label(@"",CGRectMake(32,151,116,20),color(theme[@"on-ink"]),font(theme,@"monoFonts",11))];[view.loupe addSublayer:label(@"",CGRectMake(12,173,148,20),color(theme[@"oat"]),font(theme,@"monoFonts",11))];}
// Window ordering animation and Core Animation layer actions are independent.
// Reused panels must publish the new screen geometry and image in one nonanimated transaction.
static void withoutCaptureAnimation(void (^updates)(void)) {
 [NSAnimationContext beginGrouping];
 NSAnimationContext.currentContext.duration=0;
 NSAnimationContext.currentContext.allowsImplicitAnimation=NO;
 [CATransaction begin];
 [CATransaction setDisableActions:YES];
 updates();
 [CATransaction commit];
 [NSAnimationContext endGrouping];
}
static napi_value warmup(napi_env e,napi_callback_info info){size_t n=2;napi_value args[2];napi_get_cb_info(e,info,&n,args,nullptr,nullptr);NSDictionary*theme=json(e,args[0]);for(NSString*file in theme[@"fontFiles"]){CTFontManagerRegisterFontsForURL((__bridge CFURLRef)[NSURL fileURLWithPath:file],kCTFontManagerScopeProcess,nullptr);}ensurePanel(theme);if(!view.imageFrame)withoutCaptureAnimation(^{NSRect target=NSScreen.screens.firstObject.frame;[panel setFrame:target display:NO];[view setFrameSize:target.size];view.mode=@"rect";[view buildGuide];});if(n>1&&!events){napi_value name=js(e,@"capture-events");napi_create_threadsafe_function(e,args[1],nullptr,name,0,1,nullptr,nullptr,nullptr,deliver,&events);napi_unref_threadsafe_function(e,events);}if(CGPreflightScreenCaptureAccess())dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{getContent(false);});return nullptr;}
struct CaptureJob{napi_async_work work;napi_deferred promise;uint32_t display=0,window=0;CGRect bounds=CGRectZero;bool shadow=false;std::vector<uint32_t> exclude;std::shared_ptr<Frame> frame;std::string error;double elapsed=0,queuedAt=0,queueMs=0,workMs=0;};
static void captureRun(napi_env,void*data){@autoreleasepool{auto*j=(CaptureJob*)data;double start=now();j->queueMs=start-j->queuedAt;SCShareableContent*c=getContent(j->window!=0);if(!c||!c.displays.count){j->error=(contentFailure?:@"屏幕暂时无法截图，请先解锁桌面后重试").UTF8String;return;}SCDisplay*d=nil;SCWindow*w=nil;for(int pass=0;pass<2;pass++){for(SCDisplay*x in c.displays)if(x.displayID==j->display)d=x;for(SCWindow*x in c.windows)if(x.windowID==j->window)w=x;if((j->window&&w)||(!j->window&&d))break;c=getContent(true);}
 if((j->window&&!w)||(!j->window&&!d)){j->error=j->window?"窗口已关闭，请重新选择":"屏幕已断开，请重新截图";return;}
 SCContentFilter*filter;if(w)filter=[[SCContentFilter alloc]initWithDesktopIndependentWindow:w];else{NSMutableArray*excluded=[NSMutableArray array];for(SCWindow*x in c.windows)for(uint32_t id:j->exclude)if(x.windowID==id)[excluded addObject:x];filter=[[SCContentFilter alloc]initWithDisplay:d excludingWindows:excluded];filter.includeMenuBar=YES;}
 SCStreamConfiguration*config=[SCStreamConfiguration new];config.showsCursor=NO;config.shouldBeOpaque=NO;config.captureResolution=SCCaptureResolutionBest;config.colorSpaceName=kCGColorSpaceSRGB;config.ignoreShadowsSingleWindow=!j->shadow;config.includeChildWindows=YES;config.ignoreGlobalClipSingleWindow=YES;config.scalesToFit=NO;
 CGFloat scale=filter.pointPixelScale;CGRect source=w?w.frame:j->bounds;CGFloat margin=w&&j->shadow?32:0;if(w){j->bounds=CGRectInset(source,-margin,-margin);}else{config.sourceRect=CGRectMake(j->bounds.origin.x-d.frame.origin.x,j->bounds.origin.y-d.frame.origin.y,j->bounds.size.width,j->bounds.size.height);}
 config.width=llround(j->bounds.size.width*scale);config.height=llround(j->bounds.size.height*scale);
 dispatch_semaphore_t done=dispatch_semaphore_create(0);__block CGImageRef image=nullptr;__block NSString*error=nil;
 [SCScreenshotManager captureImageWithFilter:filter configuration:config completionHandler:^(CGImageRef result,NSError*failure){if(result)image=CGImageRetain(result);error=failure.localizedDescription;dispatch_semaphore_signal(done);}];dispatch_semaphore_wait(done,DISPATCH_TIME_FOREVER);
 if(!image){j->error=(error?:@"屏幕捕获失败，请确认桌面已解锁").UTF8String;return;}j->frame=std::make_shared<Frame>();j->frame->image=image;j->frame->bounds=j->bounds;j->frame->scale=scale;j->elapsed=now()-start;
}((CaptureJob*)data)->workMs=now()-((CaptureJob*)data)->queuedAt;}
static void captureDone(napi_env e,napi_status status,void*data){auto*j=(CaptureJob*)data;if(status!=napi_ok||!j->error.empty()){napi_value message=js(e,[NSString stringWithUTF8String:j->error.c_str()]),error;napi_create_error(e,nullptr,message,&error);napi_reject_deferred(e,j->promise,error);}else{NSString*id=NSUUID.UUID.UUIDString;frames[id.UTF8String]=j->frame;napi_value result;napi_create_object(e,&result);napi_set_named_property(e,result,"id",js(e,id));set(e,result,"width",CGImageGetWidth(j->frame->image));set(e,result,"height",CGImageGetHeight(j->frame->image));set(e,result,"scale",j->frame->scale);set(e,result,"captureMs",j->elapsed);set(e,result,"queueMs",j->queueMs);set(e,result,"completionMs",now()-j->queuedAt);set(e,result,"workMs",j->workMs);napi_set_named_property(e,result,"bounds",rectJS(e,j->frame->bounds));napi_resolve_deferred(e,j->promise,result);}napi_delete_async_work(e,j->work);delete j;}
static napi_value capture(napi_env e,napi_callback_info info){size_t n=1;napi_value args[1];napi_get_cb_info(e,info,&n,args,nullptr,nullptr);auto*j=new CaptureJob();j->queuedAt=now();NSDictionary*d=json(e,args[0]);j->display=[d[@"displayId"] unsignedIntValue];j->window=[d[@"windowId"] unsignedIntValue];j->bounds=rect(d[@"bounds"]);j->shadow=[d[@"shadow"] boolValue];for(NSNumber*x in d[@"exclude"])j->exclude.push_back(x.unsignedIntValue);if(panel)j->exclude.push_back((uint32_t)panel.windowNumber);napi_value p,name=js(e,@"capture-native");napi_create_promise(e,&j->promise,&p);napi_create_async_work(e,nullptr,name,captureRun,captureDone,j,&j->work);napi_queue_async_work(e,j->work);return p;}
struct PixelJob{napi_async_work work;napi_deferred promise;std::shared_ptr<Frame> frame;CGRect crop;size_t width=0,height=0,maxWidth=0;bool rgba=false;std::vector<unsigned char> bytes;};
static void pixelsRun(napi_env,void*data){@autoreleasepool{auto*j=(PixelJob*)data;CGImageRef image=CGImageCreateWithImageInRect(j->frame->image,j->crop);j->width=CGImageGetWidth(image);j->height=CGImageGetHeight(image);if(j->maxWidth&&j->width>j->maxWidth){j->height=MAX(1,llround(j->height*(double)j->maxWidth/j->width));j->width=j->maxWidth;}j->bytes.resize(j->width*j->height*4);CGColorSpaceRef space=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);CGContextRef ctx=CGBitmapContextCreate(j->bytes.data(),j->width,j->height,8,j->width*4,space,kCGBitmapByteOrder32Little|kCGImageAlphaPremultipliedFirst);CGContextDrawImage(ctx,CGRectMake(0,0,j->width,j->height),image);CGContextRelease(ctx);CGColorSpaceRelease(space);CGImageRelease(image);if(j->rgba)for(size_t i=0;i<j->bytes.size();i+=4){unsigned a=j->bytes[i+3],b=j->bytes[i],r=j->bytes[i+2];j->bytes[i]=a?MIN(255,r*255/a):0;j->bytes[i+1]=a?MIN(255,j->bytes[i+1]*255/a):0;j->bytes[i+2]=a?MIN(255,b*255/a):0;}}}
static void pixelsDone(napi_env e,napi_status status,void*data){auto*j=(PixelJob*)data;napi_value out;napi_create_object(e,&out);set(e,out,"width",j->width);set(e,out,"height",j->height);napi_value buffer;napi_create_buffer_copy(e,j->bytes.size(),j->bytes.data(),nullptr,&buffer);napi_set_named_property(e,out,"data",buffer);napi_resolve_deferred(e,j->promise,out);napi_delete_async_work(e,j->work);delete j;}
static napi_value pixels(napi_env e,napi_callback_info info){size_t n=3;napi_value a[3];napi_get_cb_info(e,info,&n,a,nullptr,nullptr);auto f=frames.find(text(e,a[0]).UTF8String);if(f==frames.end()){napi_throw_error(e,nullptr,"截图会话已结束");return nullptr;}auto*j=new PixelJob();j->frame=f->second;NSDictionary*options=json(e,a[1]);j->rgba=[options[@"format"] isEqual:@"rgba"];j->maxWidth=[options[@"maxWidth"] unsignedLongValue];j->crop=options[@"rect"]?rect(options[@"rect"]):CGRectMake(0,0,CGImageGetWidth(j->frame->image),CGImageGetHeight(j->frame->image));CGRect clipped=CGRectIntersection(j->crop,CGRectMake(0,0,CGImageGetWidth(j->frame->image),CGImageGetHeight(j->frame->image)));if(CGRectIsEmpty(clipped)){delete j;napi_throw_error(e,nullptr,"无效的图片范围");return nullptr;}j->crop=clipped;napi_value p,name=js(e,@"capture-pixels");napi_create_promise(e,&j->promise,&p);napi_create_async_work(e,nullptr,name,pixelsRun,pixelsDone,j,&j->work);napi_queue_async_work(e,j->work);return p;}
static napi_value show(napi_env e,napi_callback_info info) {
 size_t n=1;napi_value a[1];napi_get_cb_info(e,info,&n,a,nullptr,nullptr);
 NSDictionary*d=json(e,a[0]);auto f=frames.find([d[@"frameId"] UTF8String]);
 if(f==frames.end()){napi_throw_error(e,nullptr,"截图会话已结束");return nullptr;}
 view.imageFrame=f->second;view.session=d[@"session"];view.mode=d[@"mode"];
 view.windows=d[@"windows"]?:@[];view.candidates=d[@"candidates"]?:@[];
 view.fixedSize=CGSizeMake([d[@"fixedSize"][@"width"] doubleValue],[d[@"fixedSize"][@"height"] doubleValue]);
 view.chosen=nil;view.options=@[];view.frozen=NO;view.message=@"";
 view.dragging=NO;view.pressed=NO;view.firstDraw=NO;view.started=now();
 view.lastHover=CGPointMake(-100,-100);
 CGRect b=f->second->bounds;CGFloat desktopTop=NSScreen.screens[0].frame.size.height;
 NSRect placement=NSMakeRect(b.origin.x,desktopTop-b.origin.y-b.size.height,b.size.width,b.size.height);
 withoutCaptureAnimation(^{
   if(!NSEqualRects(panel.frame,placement)){
     if(panel.isVisible)[panel orderOut:nil];
     [panel setFrame:placement display:NO];
   }
   [view setFrameSize:b.size];
   view.backdrop.frame=view.bounds;view.backdrop.contents=(__bridge id)f->second->image;
   view.backdrop.contentsScale=f->second->scale;view.shade.frame=view.bounds;view.outline.frame=view.bounds;
   NSPoint mouse=[view convertPoint:[panel convertPointFromScreen:NSEvent.mouseLocation] fromView:nil];
   view.point=d[@"pointer"]?CGPointMake([d[@"pointer"][@"x"] doubleValue],[d[@"pointer"][@"y"] doubleValue]):mouse;
   view.selected=CGRectZero;[view buildGuide];[view update];[view layoutSubtreeIfNeeded];
   [panel makeKeyAndOrderFront:nil];[panel makeFirstResponder:view];
   [view setNeedsDisplay:YES];[view displayIfNeeded];
 });
 [CATransaction flush];return nullptr;
}
static napi_value update(napi_env e,napi_callback_info info){size_t n=1;napi_value a[1];napi_get_cb_info(e,info,&n,a,nullptr,nullptr);NSDictionary*d=json(e,a[0]);if(![view.session isEqual:d[@"session"]])return nullptr;if(d[@"candidates"])view.candidates=d[@"candidates"];if(d[@"message"]){view.message=d[@"message"];view.frozen=YES;[view buildGuide];}if(d[@"resume"]){view.frozen=NO;view.message=@"";[view buildGuide];}[view update];return nullptr;}
static napi_value hide(napi_env,napi_callback_info){[CATransaction begin];[CATransaction setDisableActions:YES];[panel orderOut:nil];view.pressed=NO;view.dragging=NO;view.frozen=YES;view.imageFrame=nullptr;view.windows=@[];view.candidates=@[];view.options=@[];view.chosen=nil;view.backdrop.contents=nil;if(view.loupe.sublayers.count)view.loupe.sublayers[0].contents=nil;[CATransaction commit];[CATransaction flush];return nullptr;}
static napi_value focus(napi_env,napi_callback_info){if(view.imageFrame){[panel makeKeyAndOrderFront:nil];[panel makeFirstResponder:view];}return nullptr;}
static napi_value releaseFrame(napi_env e,napi_callback_info info){size_t n=1;napi_value a[1];napi_get_cb_info(e,info,&n,a,nullptr,nullptr);frames.erase(text(e,a[0]).UTF8String);return nullptr;}
static napi_value invalidate(napi_env,napi_callback_info){dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED,0),^{getContent(true);});return nullptr;}
static napi_value windowID(napi_env e,napi_callback_info info){size_t n=1;napi_value a[1];napi_get_cb_info(e,info,&n,a,nullptr,nullptr);void*bytes;size_t length;napi_get_buffer_info(e,a[0],&bytes,&length);NSView*windowView=(__bridge NSView*)(*(void**)bytes);napi_value value;napi_create_uint32(e,(uint32_t)windowView.window.windowNumber,&value);return value;}
static void freeImage(void*info,const void*,size_t){delete (std::vector<unsigned char>*)info;}
static napi_value createFrame(napi_env e,napi_callback_info info){size_t n=1;napi_value a[1],data;napi_get_cb_info(e,info,&n,a,nullptr,nullptr);size_t width=num(e,a[0],"width"),height=num(e,a[0],"height");napi_get_named_property(e,a[0],"data",&data);void*bytes;size_t length;if(napi_get_buffer_info(e,data,&bytes,&length)!=napi_ok||!width||!height||length!=width*height*4){napi_throw_error(e,nullptr,"无效的图片像素");return nullptr;}auto*storage=new std::vector<unsigned char>((unsigned char*)bytes,(unsigned char*)bytes+length);CGDataProviderRef provider=CGDataProviderCreateWithData(storage,storage->data(),length,freeImage);CGColorSpaceRef space=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);auto frame=std::make_shared<Frame>();frame->image=CGImageCreate(width,height,8,32,width*4,space,kCGBitmapByteOrder32Little|kCGImageAlphaPremultipliedFirst,provider,nullptr,false,kCGRenderingIntentDefault);CGDataProviderRelease(provider);CGColorSpaceRelease(space);frame->bounds=CGRectMake(num(e,a[0],"logicalX",0),num(e,a[0],"logicalY",0),num(e,a[0],"logicalWidth",width),num(e,a[0],"logicalHeight",height));frame->scale=width/frame->bounds.size.width;NSString*id=NSUUID.UUID.UUIDString;frames[id.UTF8String]=frame;napi_value out;napi_create_object(e,&out);napi_set_named_property(e,out,"id",js(e,id));set(e,out,"width",width);set(e,out,"height",height);set(e,out,"scale",frame->scale);napi_set_named_property(e,out,"bounds",rectJS(e,frame->bounds));return out;}
static napi_value render(napi_env e,napi_callback_info){[view displayIfNeeded];size_t width=llround(view.bounds.size.width*2),height=llround(view.bounds.size.height*2);std::vector<unsigned char>bytes(width*height*4);CGColorSpaceRef space=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);CGContextRef ctx=CGBitmapContextCreate(bytes.data(),width,height,8,width*4,space,kCGBitmapByteOrder32Little|kCGImageAlphaPremultipliedFirst);CGContextTranslateCTM(ctx,0,height);CGContextScaleCTM(ctx,2,-2);[view.layer renderInContext:ctx];CGContextRelease(ctx);CGColorSpaceRelease(space);napi_value out,data;napi_create_object(e,&out);set(e,out,"width",width);set(e,out,"height",height);napi_create_buffer_copy(e,bytes.size(),bytes.data(),nullptr,&data);napi_set_named_property(e,out,"data",data);return out;}
static napi_value snapshot(napi_env e,napi_callback_info){napi_value o;napi_create_object(e,&o);set(e,o,"visible",panel.isVisible);set(e,o,"focused",panel.isKeyWindow);set(e,o,"frameCount",frames.size());set(e,o,"windowId",panel.windowNumber);napi_set_named_property(e,o,"session",js(e,view.session?:@""));napi_set_named_property(e,o,"mode",js(e,view.mode?:@""));napi_set_named_property(e,o,"selection",rectJS(e,view.selected));napi_set_named_property(e,o,"bounds",rectJS(e,view.bounds));if(view.loupe.sublayers.count>4){NSAttributedString*value=((CATextLayer*)view.loupe.sublayers[3]).string;NSAttributedString*position=((CATextLayer*)view.loupe.sublayers[4]).string;napi_set_named_property(e,o,"color",js(e,value.string?:@""));napi_set_named_property(e,o,"position",js(e,position.string?:@""));napi_set_named_property(e,o,"loupe",rectJS(e,view.loupe.frame));}return o;}
static void cleanup(void*){[panel orderOut:nil];view.imageFrame=nullptr;frames.clear();view=nil;panel=nil;if(events){napi_release_threadsafe_function(events,napi_tsfn_abort);events=nullptr;}content=nil;}
static napi_value init(napi_env e,napi_value exports){napi_property_descriptor defs[]={
 {"createFrame",nullptr,createFrame,nullptr,nullptr,nullptr,napi_default,nullptr},{"render",nullptr,render,nullptr,nullptr,nullptr,napi_default,nullptr},{"warmup",nullptr,warmup,nullptr,nullptr,nullptr,napi_default,nullptr},{"capture",nullptr,capture,nullptr,nullptr,nullptr,napi_default,nullptr},{"pixels",nullptr,pixels,nullptr,nullptr,nullptr,napi_default,nullptr},{"show",nullptr,show,nullptr,nullptr,nullptr,napi_default,nullptr},{"update",nullptr,update,nullptr,nullptr,nullptr,napi_default,nullptr},{"hide",nullptr,hide,nullptr,nullptr,nullptr,napi_default,nullptr},{"focus",nullptr,focus,nullptr,nullptr,nullptr,napi_default,nullptr},{"release",nullptr,releaseFrame,nullptr,nullptr,nullptr,napi_default,nullptr},{"invalidate",nullptr,invalidate,nullptr,nullptr,nullptr,napi_default,nullptr},{"windowID",nullptr,windowID,nullptr,nullptr,nullptr,napi_default,nullptr},{"snapshot",nullptr,snapshot,nullptr,nullptr,nullptr,napi_default,nullptr}};napi_define_properties(e,exports,sizeof(defs)/sizeof(defs[0]),defs);napi_add_env_cleanup_hook(e,cleanup,nullptr);return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)
