import { app, BrowserWindow, clipboard, ClipboardItem, desktopCapturer, dialog, ipcMain, nativeImage, screen, shell, systemPreferences } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import type { CaptureFrame, CaptureMode, CaptureRect, ExportAction, OCRRequest, OCRResult, RegionCandidate, ScreenshotState, ScrollCaptureAction } from '../../shared/capture';
import { pixelRect } from '../../shared/capture';
import { clip, contains, rank } from './candidates';
import { OCRService, type VisionOCR } from './ocr';
import { validateAnnotations, type PinnedDocument } from './document';
import { PinManager } from './pins';
import { ScrollSession, type ScrollReply } from './scroll-session';
import { defaultLocalImageCopyPath, saveLocalImageCopy, type LocalImageSource } from './local-images';
import { CaptureEfficiencyControl, CaptureReselectRequiredError, sameCaptureDisplay } from './efficiency-control';
import type { CaptureDisplayBinding, SuccessfulCaptureArea } from '../../shared/capture-efficiency';
type WindowRect = CaptureRect & { pid: number; id: number };
const bindDisplay=(display:Electron.Display):CaptureDisplayBinding=>({id:display.id,bounds:{...display.bounds},scaleFactor:display.scaleFactor,rotation:display.rotation});
const run=promisify(execFile);
/** Shadow margins of a `screencapture -l` image, read from where the window's opaque pixels begin on its middle row and column. */
function opaqueInset(image:NativeImage){
  const {width,height}=image.getSize(),bitmap=image.toBitmap(),solid=(x:number,y:number)=>bitmap[(y*width+x)*4+3]>=250,row=height>>1,col=width>>1;
  let left=0,right=0,top=0,bottom=0;
  while(left<width-1&&!solid(left,row))left++;while(right<width-1&&!solid(width-1-right,row))right++;
  while(top<height-1&&!solid(col,top))top++;while(bottom<height-1&&!solid(col,height-1-bottom))bottom++;
  return {left,top,right,bottom};
}
type AX = { windows(): WindowRect[]; query(pid:number,x:number,y:number):Promise<{rects:CaptureRect[];error:number}>; requestScreen(): Promise<boolean> };
export class CaptureManager {
  private win: BrowserWindow | null=null;
  private worker: Worker | null=null;
  private state: ScreenshotState | null=null;
  private image: NativeImage | null=null;
  private bounds: CaptureRect={x:0,y:0,width:1,height:1};
  private displayId: number | null=null;
  private captureDisplay: CaptureDisplayBinding | null=null;
  private windows: WindowRect[]=[];
  private fixed: RegionCandidate[]=[];
  private elements: RegionCandidate[]=[];
  private colors: RegionCandidate[]=[];
  private edges: RegionCandidate[]=[];
  private ax: AX;
  private seq=0;
  private busy=false;
  private pending: {x:number;y:number}|null=null;
  private hoverTimer: ReturnType<typeof setTimeout>|null=null;
  private colorBusy=false;
  private axBusy=false;
  private colorSeq=-1;
  private axSeq=-1;
  private hoverPoint={x:-100,y:-100};
  private disposed=false;
  private epoch=0;
  private editRevision=0;
  private exporting=false;
  private grabbing=false;
  private editorKey: string | null=null;
  private localSource: LocalImageSource | null=null;
  private scroll: ScrollSession | null=null;
  private scrollFinishing=false;
  private scrollEditing=false;
  readonly pins: PinManager;
  readonly efficiency=new CaptureEfficiencyControl({
    displays:()=>screen.getAllDisplays().map(bindDisplay),
    capture:async request=>{
      await this.start(request.mode==='repeat'?'area':request.mode,request);
      return request.signal.aborted||!this.win?null:{};
    }
  });
  private displayRemoved=(_event:Electron.Event,display:Electron.Display)=>{if(display.id===this.displayId)this.displayChanged();};
  private displayMetrics=(_event:Electron.Event,display:Electron.Display,metrics:string[])=>{if(display.id===this.displayId&&metrics.some(metric=>['bounds','scaleFactor','rotation'].includes(metric)))this.displayChanged();};
  private displayChanged(){
    if(this.state?.phase==='selecting'){this.cancel();return;}
    if(this.state?.phase==='scrolling'){const session=this.scroll;void this.finishScroll('显示配置已变化，采集已结束；已匹配结果保留。').catch(error=>{if(this.scroll!==session)return;if(!session?.metadata.segments)this.cancel(true);else this.scrollError(error);});return;}
    if(this.win&&!this.win.isDestroyed()){const display=screen.getDisplayMatching(this.win.getBounds());this.displayId=display.id;this.win.setBounds(display.workArea);}
  }
  private vision: VisionOCR | null=null;
  private ocr=new OCRService(()=>this.vision??=require(join(__dirname,'native/capture-vision.node')), (id,revision)=>this.state?.phase==='result'&&this.state.editId===id&&this.editRevision===revision);
  constructor(private receive: (image: NativeImage)=>Promise<void>, private before:()=>void, private after:(restore?:boolean)=>void, private receiveText:(text:string)=>Promise<void>, changed:()=>void, private receiveMedia?: (image:NativeImage)=>Promise<void>) {
    this.ax=require(join(__dirname,'native/capture-ax.node')) as AX;
    this.pins=new PinManager((doc,id)=>this.openImage(doc.source,'pin',doc,id),receive,receiveText,after,changed);
    const owns=(e:IpcMainEvent|IpcMainInvokeEvent)=>Boolean(this.win&&e.sender===this.win.webContents&&e.senderFrame===this.win.webContents.mainFrame);
    const assert=(e:IpcMainEvent|IpcMainInvokeEvent)=>{if(!owns(e))throw new Error('截图操作只允许截图窗口调用');};
    ipcMain.handle('screenshot:state',e=>{assert(e);return this.state;});
    // Pointer events may already be queued when the screenshot window closes.
    // A send-style IPC has no rejection channel; discard stale or foreign frames.
    ipcMain.on('screenshot:hover',(e,x:number,y:number)=>{if(owns(e)&&Number.isFinite(x)&&Number.isFinite(y))this.hover(x,y);});
    ipcMain.handle('screenshot:select',(e,r:CaptureRect)=>{assert(e);this.select(r);});
    ipcMain.handle('screenshot:window',async(e,id:number,shadow:boolean)=>{assert(e);try{await this.captureWindow(id,shadow===true);return {error:null};}catch(error){return {error:(error as Error).message};}});
    ipcMain.handle('screenshot:action',async(e,a:string)=>{assert(e);try{await this.action(a);return {error:null};}catch(error){return {error:(error as Error).message};}});
    ipcMain.handle('screenshot:scroll-start',async(e,r:CaptureRect)=>{assert(e);try{await this.startScroll(r);return {error:null};}catch(error){return {error:(error as Error).message};}});
    ipcMain.handle('screenshot:scroll-action',async(e,a:ScrollCaptureAction)=>{assert(e);try{await this.scrollAction(a);return {error:null};}catch(error){return {error:(error as Error).message};}});
    ipcMain.handle('screenshot:recognize',(e,frame:OCRRequest)=>{assert(e);return this.recognize(frame);});
    ipcMain.on('screenshot:invalidate-ocr',(e,request:{id:string;revision:number})=>{if(!owns(e)||!request||this.state?.phase!=='result'||request.id!==this.state.editId||!Number.isSafeInteger(request.revision)||request.revision<this.editRevision)return;this.editRevision=request.revision;this.ocr.invalidate(request.id,request.revision);});
    ipcMain.handle('screenshot:export',async(e,frame:CaptureFrame,action:ExportAction,format:'png'|'jpeg')=>{assert(e);try{await this.exportFrame(frame,action,format);return {error:null};}catch(error){return {error:(error as Error).message};}});
    ipcMain.handle('screenshot:copy-text',async(e,request:{id:string;revision:number;text:string})=>{assert(e);this.acceptVersion(request?.id,request?.revision);if(typeof request.text!=='string'||!request.text.trim()||request.text.length>100000)throw Error('没有可复制的文字');this.after();await clipboard.writeText(request.text);});
    ipcMain.handle('screenshot:send-text',async(e,request:{id:string;revision:number;text:string})=>{assert(e);try{this.acceptVersion(request?.id,request?.revision);if(typeof request.text!=='string'||!request.text.trim()||request.text.length>100000)throw Error('请先选择图中文字');await this.receiveText(request.text);if(this.state?.editId===request.id)this.cancel();return {error:null};}catch(error){return {error:(error as Error).message};}});
    screen.on('display-removed',this.displayRemoved);
    screen.on('display-metrics-changed',this.displayMetrics);
  }
  get active(){return this.busy||Boolean(this.win)||this.efficiency.state.phase!=='idle';}
  focus(){if(this.win&&!this.win.isDestroyed()){this.win.show();this.win.focus();}}
  private assertCaptureDisplay(){if(!this.captureDisplay||!screen.getAllDisplays().some(display=>sameCaptureDisplay(this.captureDisplay!,bindDisplay(display))))throw new CaptureReselectRequiredError();}
  async start(mode:CaptureMode='area',request?:{area?:SuccessfulCaptureArea;signal:AbortSignal}) {
    if(this.disposed||request?.signal.aborted)return;
    if(this.win){this.win.show();this.win.focus();return;}
    if(this.busy)return;
    this.busy=true;
    const epoch=++this.epoch;
    const abort=()=>{if(epoch===this.epoch)this.cancel(true);};
    request?.signal.addEventListener('abort',abort,{once:true});
    try {
      if(systemPreferences.getMediaAccessStatus('screen')!=='granted') {
        if(!await this.ax.requestScreen()) {
          if(request?.signal.aborted||epoch!==this.epoch)return;
          const {response}=await dialog.showMessageBox({type:'info',message:'允许 Lasso 录制屏幕以截图',detail:'开启屏幕录制权限后，再从菜单栏选择「截图」。剪贴板图片和划词仍可使用。',buttons:['打开系统设置','取消'],cancelId:1});
          if(response===0)await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
          return;
        }
      }
      if(request?.signal.aborted||epoch!==this.epoch)return;
      const display=request?.area?screen.getAllDisplays().find(display=>display.id===request.area!.display.id):screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      if(!display||(request?.area&&!sameCaptureDisplay(request.area.display,bindDisplay(display))))throw new CaptureReselectRequiredError();
      this.captureDisplay=bindDisplay(display);
      this.displayId=display.id;
      this.before();
      await new Promise<void>(resolve=>setTimeout(resolve,90));
      if(this.disposed||epoch!==this.epoch)return;
      const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(display.bounds.width*display.scaleFactor),height:Math.round(display.bounds.height*display.scaleFactor)},fetchWindowIcons:false});
      if(this.disposed||epoch!==this.epoch)return;
      this.assertCaptureDisplay();
      const source=sources.find(s=>s.display_id===String(display.id)||s.id.startsWith('screen:'+display.id+':'));
      if(!source||source.thumbnail.isEmpty())console.warn('[screenshot] sources',JSON.stringify({display:display.id,sources:sources.map(s=>({id:s.id,display:s.display_id,size:s.thumbnail.getSize(),empty:s.thumbnail.isEmpty()}))}));
      if(!source||source.thumbnail.isEmpty())throw Error('当前屏幕暂时无法截图，请确认桌面已解锁后重试。');
      if(this.disposed||epoch!==this.epoch)return;
      this.image=nativeImage.createFromBuffer(source.thumbnail.toPNG());
      this.bounds=display.bounds;
      this.windows=this.ax.windows();
      const local=(r:CaptureRect):CaptureRect=>({x:r.x-this.bounds.x,y:r.y-this.bounds.y,width:r.width,height:r.height});
      this.fixed=this.windows.map(r=>clip(local(r),{x:0,y:0,width:display.bounds.width,height:display.bounds.height})).filter((r):r is CaptureRect=>Boolean(r)).map(r=>({...r,source:'window'}));
      this.fixed.push({x:0,y:0,width:this.bounds.width,height:this.bounds.height,source:'screen'});
      this.elements=[];this.edges=[];this.colors=[];this.hoverPoint={x:-100,y:-100};
      const id=randomUUID();
      const pixels=this.image.getSize();
      const windows=this.windows.map(w=>({id:w.id,x:w.x-this.bounds.x,y:w.y-this.bounds.y,width:w.width,height:w.height})).filter(w=>clip(w,{x:0,y:0,width:this.bounds.width,height:this.bounds.height}));
      // The frozen screen is a display-only backdrop; the editing session receives only the pixels it captures.
      this.state={id,editId:randomUUID(),image:'',backdrop:this.image.toDataURL(),width:this.bounds.width,height:this.bounds.height,pixelWidth:pixels.width,pixelHeight:pixels.height,candidates:this.fixed,windows,mode:mode==='window'?'window':'area',phase:'selecting',selection:null,status:'',origin:'screen'};
      if(request?.area)this.select(request.area.rect);
      else if(mode==='screen')this.select({x:0,y:0,width:this.bounds.width,height:this.bounds.height},false);
      else if(mode==='front'){if(windows[0])await this.captureWindow(windows[0].id,false);else this.state.mode='window';}
      if(this.disposed||epoch!==this.epoch)return;
      const win=new BrowserWindow({...display.bounds,frame:false,show:false,transparent:false,backgroundColor:'#242320',resizable:false,movable:false,fullscreenable:false,hasShadow:false,enableLargerThanScreen:true,webPreferences:{preload:join(__dirname,'capture-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
      this.win=win;win.setAlwaysOnTop(true,'screen-saver');win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
      win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());
      win.on('closed',()=>{if(this.win===win)this.release();});
      await win.loadFile(join(__dirname,'renderer/index.html'),{query:{surface:'screenshot'}});
      if(this.win!==win||this.disposed||epoch!==this.epoch)return;
      this.assertCaptureDisplay();
      win.setBounds(display.bounds);win.show();win.focus();
      if(this.state?.phase!=='selecting')return;
      // Downsample only the detection image. The exported crop keeps source pixels.
      const reduced=this.image.resize({width:Math.min(1440,this.image.getSize().width)});
      const size=reduced.getSize();const bitmap=reduced.toBitmap();
      // Electron bitmaps are BGRA on macOS; edge_det consumes RGBA.
      for(let i=0;i<bitmap.length;i+=4){const r=bitmap[i+2];bitmap[i+2]=bitmap[i];bitmap[i]=r;}
      const sx=this.bounds.width/size.width,sy=this.bounds.height/size.height;
      const worker=new Worker(join(__dirname,'regions-worker.cjs'));this.worker=worker;
      worker.on('message',m=>{if(this.worker!==worker||this.state?.id!==id)return;
        const mapped=m.regions.map((r:RegionCandidate)=>({...r,x:r.x*sx,y:r.y*sy,width:r.width*sx,height:r.height*sy}));
        if(m.type==='edges')this.edges=mapped;
        if(m.type==='color'){this.colorBusy=false;if(m.seq===this.seq)this.colors=mapped;}
        this.updateCandidates();if(this.pending)this.scheduleHover();
      });
      const workerStopped=()=>{if(this.worker!==worker)return;this.worker=null;this.colorBusy=false;if(this.pending)this.scheduleHover();};
      worker.on('error',error=>{console.warn('[screenshot] region worker',error.message);workerStopped();});
      worker.on('exit',workerStopped);
      worker.postMessage({type:'init',bytes:bitmap,width:size.width,height:size.height});
      this.detectScale={x:1/sx,y:1/sy};
    } catch(error){if(this.disposed||epoch!==this.epoch)return;this.cancel(true);throw error;}
    finally{request?.signal.removeEventListener('abort',abort);this.busy=false;}
  }
  private detectScale={x:1,y:1};
  /** The backdrop is sent once with the initial state; the edit image only when it changes. */
  private publish(includeImage=false){if(this.state&&this.win&&!this.win.isDestroyed()){const {image,backdrop,...rest}=this.state;this.win.webContents.send('screenshot:changed',includeImage?{...rest,image,backdrop}:rest);}}
  private stopDetection(){this.seq++;this.pending=null;this.fixed=[];this.windows=[];this.elements=[];this.edges=[];this.colors=[];this.colorBusy=false;this.axBusy=false;if(this.hoverTimer)clearTimeout(this.hoverTimer);this.hoverTimer=null;void this.worker?.terminate();this.worker=null;}
  private select(r:CaptureRect,remember=true){
    if(!r||![r.x,r.y,r.width,r.height].every(Number.isFinite))throw Error('无效的选区');
    if(this.state?.phase!=='selecting'||!this.image)return;
    const s=this.state,rect=clip(r,{x:0,y:0,width:s.width,height:s.height});if(!rect)return;
    this.assertCaptureDisplay();
    const display=this.captureDisplay!;
    const pixels=pixelRect(rect,s.width,s.height,s.pixelWidth,s.pixelHeight);
    // The editing session owns only the chosen pixels, never the full desktop.
    this.edit(nativeImage.createFromBuffer(this.image.crop(pixels).toPNG()),rect);
    if(remember)this.efficiency.rememberSuccessfulArea({display,rect});
  }
  /** Keep the entire control window outside the capture, so the selected region has no overlay to intercept input. */
  private scrollControlBounds(r:CaptureRect):CaptureRect {
    const b=this.bounds,h=118,w=Math.min(700,b.width),gap=8;
    const x=Math.round(Math.max(0,Math.min(b.width-w,r.x+(r.width-w)/2)));
    if(r.y>=h+gap)return {x:b.x+x,y:b.y+Math.round(r.y-h-gap),width:w,height:h};
    if(b.height-r.y-r.height>=h+gap)return {x:b.x+x,y:b.y+Math.ceil(r.y+r.height+gap),width:w,height:h};
    if(r.x>=w+gap)return {x:b.x+Math.floor(r.x-w-gap),y:b.y+Math.max(0,Math.min(b.height-h,Math.round(r.y))),width:w,height:h};
    if(b.width-r.x-r.width>=w+gap)return {x:b.x+Math.ceil(r.x+r.width+gap),y:b.y+Math.max(0,Math.min(b.height-h,Math.round(r.y))),width:w,height:h};
    throw Error('请缩小选区，在上方或下方留出 126 像素放置控制条；控制条不会进入截图。');
  }
  private async startScroll(r:CaptureRect){
    const s=this.state,win=this.win;
    if(s?.phase!=='selecting'||!this.image||!win||this.scroll)throw Error('请先选择滚动区域');
    if(!r||![r.x,r.y,r.width,r.height].every(Number.isFinite))throw Error('无效的滚动选区');
    const rect=clip(r,{x:0,y:0,width:s.width,height:s.height});
    if(!rect||rect.width<64||rect.height<96)throw Error('滚动选区至少需要 64 × 96 像素');
    const pixels=pixelRect(rect,s.width,s.height,s.pixelWidth,s.pixelHeight);
    if(pixels.height>16384||pixels.width*pixels.height>20_000_000)throw Error('选区超过 16384 像素高度或 2000 万像素，请缩小选区');
    const controls=this.scrollControlBounds(rect),displayId=this.displayId,epoch=this.epoch;
    const displayConfig=screen.getAllDisplays().find(display=>display.id===displayId);
    if(!displayConfig)throw Error('屏幕已断开，请重新截图');
    const {scaleFactor,rotation}=displayConfig;
    const unchanged=()=>{const display=screen.getAllDisplays().find(display=>display.id===displayId);return display&&display.bounds.x===this.bounds.x&&display.bounds.y===this.bounds.y&&display.bounds.width===s.width&&display.bounds.height===s.height&&display.scaleFactor===scaleFactor&&display.rotation===rotation;};
    this.stopDetection();this.ocr.reset();this.image=null;
    Object.assign(s,{phase:'scrolling',image:'',backdrop:undefined,placement:undefined,candidates:[],windows:[],selection:null,scroll:{status:'running',width:pixels.width,height:0,segments:0,seams:[],message:'正在采集首帧…'}});
    // Hiding the focused overlay returns focus to the underlying app. The controls never take focus back.
    win.hide();win.setFocusable(false);win.setBounds(controls);win.setBackgroundColor('#141413');this.publish(true);win.showInactive();
    const session=new ScrollSession(async()=>{
      if(!unchanged())throw Error('屏幕配置已变化');
      const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:s.pixelWidth,height:s.pixelHeight},fetchWindowIcons:false});
      if(this.scroll!==session||epoch!==this.epoch)throw Error('滚动截图会话已取消');
      if(!unchanged())throw Error('屏幕配置已变化，已匹配结果保留');
      const source=sources.find(source=>source.display_id===String(displayId)||source.id.startsWith('screen:'+displayId+':'));
      if(!source||source.thumbnail.isEmpty())throw Error('屏幕采集失败，请暂停后重试');
      const size=source.thumbnail.getSize();if(size.width!==s.pixelWidth||size.height!==s.pixelHeight)throw Error('屏幕像素尺寸已变化');
      const image=nativeImage.createFromBuffer(source.thumbnail.toPNG()).crop(pixels);
      return {width:pixels.width,height:pixels.height,data:new Uint8Array(image.toBitmap())};
    },()=>{
      if(this.scroll!==session||this.state!==s||s.phase!=='scrolling')return;
      const m=session.metadata;s.scroll={status:session.status==='running'?'running':'paused',width:m.width||pixels.width,height:m.height,segments:m.segments,seams:m.seams,message:session.message};this.publish();
    },()=>{if(this.scroll===session)void this.finishScroll(session.message).catch(error=>this.scrollError(error));});
    this.scroll=session;
    await new Promise<void>(resolve=>setTimeout(resolve,180));
    if(this.scroll===session&&epoch===this.epoch)await session.start();
  }
  private scrollError(error:unknown){
    if(this.state?.scroll){this.state.scroll.message=(error as Error).message;this.state.scroll.status='paused';this.publish();}
  }
  private setScrollPreview(reply:ScrollReply,message:string){
    if(!reply.data||!reply.width||!reply.height)throw Error('尚无已匹配画面，可继续采集或取消');
    const image=nativeImage.createFromBitmap(Buffer.from(reply.data),{width:reply.width,height:reply.height,scaleFactor:1});
    if(image.isEmpty())throw Error('滚动图片合成失败，已匹配结果仍保留');
    this.image=image;
    // Review uses full pixels within the existing file budget; an oversized file remains recoverable through undo.
    const png=image.toPNG(),tooLarge=png.byteLength>64*1024*1024,s=this.state!;
    const preview=tooLarge?image.resize({width:Math.min(1000,reply.width)}).toDataURL():'data:image/png;base64,'+png.toString('base64');
    if(tooLarge)message='合成 PNG 超过 64 MiB，当前仅显示预览；'+(reply.segments>1?'请撤回末段后进入编辑。':'请取消后缩小选区重试。')+'原图未缩小。';
    Object.assign(s,{phase:'review',backdrop:undefined,image:preview,scroll:{status:'review',width:reply.width,height:reply.height,segments:reply.segments,seams:reply.seams,message}});
    this.publish(true);
  }
  private async finishScroll(message='已结束采集。检查接缝后进入编辑；可撤回末段。'){
    const session=this.scroll,s=this.state;if(!session||s?.phase!=='scrolling'||this.scrollFinishing)return;
    this.scrollFinishing=true;
    try{
      const reply=await session.finish();if(this.scroll!==session||this.state!==s)return;
      this.setScrollPreview(reply,message);
      const win=this.win!;win.hide();win.setFocusable(true);win.setResizable(true);win.setMinimumSize(760,500);
      const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      win.setBounds(area);win.setBackgroundColor('#E9E6DD');win.setAlwaysOnTop(true,'floating');win.show();win.focus();
    }catch(error){if(this.scroll===session){session.status='paused';this.scrollError(error);}throw error;}
    finally{if(this.scroll===session)this.scrollFinishing=false;}
  }
  private async scrollAction(action:ScrollCaptureAction){
    if(action==='cancel'){this.cancel(true);return;}
    const session=this.scroll,s=this.state;if(!session||!s?.scroll)throw Error('滚动截图已结束');
    if(this.scrollFinishing||this.scrollEditing)throw Error('正在处理滚动结果');
    if(action==='pause'&&s.phase==='scrolling'){await session.pause();return;}
    if(action==='resume'&&s.phase==='scrolling'){session.resume();return;}
    if(action==='finish'&&s.phase==='scrolling'){await this.finishScroll();return;}
    if(action==='undo'&&s.phase==='review'){
      this.scrollFinishing=true;try{const reply=await session.undo();if(this.scroll===session)this.setScrollPreview(reply,'已撤回末段，请重新检查接缝。');}finally{if(this.scroll===session)this.scrollFinishing=false;}return;
    }
    if(action==='edit'&&s.phase==='review'&&this.image){
      this.scrollEditing=true;
      try{
        const png=this.image.toPNG();if(png.byteLength>64*1024*1024)throw Error('合成 PNG 超过 64 MiB，'+(s.scroll.segments>1?'请撤回末段后再进入编辑。':'请取消后缩小选区重试。')+'图片未缩小。');
        const size=this.image.getSize();session.dispose();this.scroll=null;this.editRevision=0;this.ocr.reset();
        Object.assign(s,{phase:'result',editId:randomUUID(),image:this.image.toDataURL(),backdrop:undefined,placement:undefined,width:size.width,height:size.height,pixelWidth:size.width,pixelHeight:size.height,selection:{x:0,y:0,...size},scroll:undefined,origin:'clipboard'});this.publish(true);
      }finally{this.scrollEditing=false;}return;
    }
    throw Error('当前状态不支持此滚动操作');
  }
  /** Captures the whole window, including parts covered by other windows; with a shadow, the placement grows by its margins. */
  private async captureWindow(id:number,shadow:boolean){
    const s=this.state;
    if(s?.phase!=='selecting'||this.grabbing)return;
    const target=s.windows?.find(w=>w.id===id);if(!target)throw Error('窗口已关闭，请重新选择');
    const epoch=this.epoch,file=join(app.getPath('temp'),'lasso-window-'+randomUUID()+'.png');
    this.grabbing=true;let png:Buffer;
    try{await run('/usr/sbin/screencapture',['-x',...(shadow?[]:['-o']),'-l'+id,file]);png=await readFile(file);}
    catch{throw Error('窗口截图失败，请确认窗口仍在当前屏幕上');}
    finally{this.grabbing=false;void rm(file,{force:true});}
    if(epoch!==this.epoch||this.state!==s||s.phase!=='selecting')return;
    const image=nativeImage.createFromBuffer(png);if(image.isEmpty())throw Error('窗口截图失败，请确认窗口仍在当前屏幕上');
    const size=image.getSize(),inset=shadow?opaqueInset(image):{left:0,top:0,right:0,bottom:0},scale=(size.width-inset.left-inset.right)/target.width;
    this.edit(image,{x:target.x-inset.left/scale,y:target.y-inset.top/scale,width:size.width/scale,height:size.height/scale});
  }
  /** Hands captured pixels to the in-place editor at their on-screen placement. */
  private edit(image:NativeImage,placement:CaptureRect){
    const s=this.state!;this.image=image;
    const size=image.getSize();this.stopDetection();this.ocr.reset();this.editRevision=0;
    Object.assign(s,{editId:randomUUID(),image:image.toDataURL(),width:size.width,height:size.height,pixelWidth:size.width,pixelHeight:size.height,candidates:[],windows:[],selection:{x:0,y:0,...size},placement,phase:'result'});
    this.publish(true);
  }
  async openImage(image:NativeImage,origin:'clipboard'|'pin'='clipboard',document?:PinnedDocument,pinId?:string,inputId?:string,context?:{file:LocalImageSource}){
    if(this.disposed)throw Error('截图功能已关闭');
    const key=pinId?'pin:'+pinId:inputId?'image:'+inputId:context?'file:'+context.file.dev+':'+context.file.ino:null;
    if(this.active){this.win?.show();this.win?.focus();if(key&&key===this.editorKey)return;throw Error('请先完成或关闭当前图片编辑');}
    const size=image.getSize();if(image.isEmpty()||size.width*size.height>40_000_000)throw Error('图片为空或尺寸过大');
    this.busy=true;const epoch=++this.epoch;
    try{
      this.before();this.editorKey=key;this.localSource=context?.file??null;this.image=nativeImage.createFromBuffer(image.toPNG());
      const display=screen.getDisplayNearestPoint(screen.getCursorScreenPoint());this.bounds=display.bounds;this.displayId=display.id;
      this.editRevision=0;this.state={id:randomUUID(),editId:randomUUID(),image:this.image.toDataURL(),width:size.width,height:size.height,pixelWidth:size.width,pixelHeight:size.height,candidates:[],phase:'result',selection:{x:0,y:0,...size},status:'',origin,pinId,annotations:document?.annotations};
      const win=new BrowserWindow({...display.workArea,frame:false,show:false,backgroundColor:'#E9E6DD',resizable:true,minWidth:760,minHeight:500,fullscreenable:false,title:'Lasso 图片编辑',webPreferences:{preload:join(__dirname,'capture-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
      this.win=win;win.setAlwaysOnTop(true,'floating');win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());win.on('closed',()=>{if(this.win===win)this.release(origin==='clipboard');});
      await win.loadFile(join(__dirname,'renderer/index.html'),{query:{surface:'screenshot'}});if(epoch!==this.epoch||win.isDestroyed())return;win.show();win.focus();
    }catch(error){if(epoch===this.epoch)this.cancel();throw error;}finally{this.busy=false;}
  }
  private updateCandidates(){if(!this.state)return;this.state.candidates=rank([...this.fixed,...this.elements,...this.edges,...this.colors],this.hoverPoint.x,this.hoverPoint.y);this.publish();}
  private hover(x:number,y:number){
    if(!this.state||this.state.phase!=='selecting')return;
    if(Math.hypot(x-this.hoverPoint.x,y-this.hoverPoint.y)<5)return;
    this.hoverPoint={x,y};this.pending={x,y};this.seq++;
    // Keep still-hit regions until their replacement is ready, rather than
    // briefly flashing the whole window on every hover query.
    this.colors=this.colors.filter(r=>contains(r,x,y));this.elements=this.elements.filter(r=>contains(r,x,y));this.updateCandidates();
    this.scheduleHover();
  }
  private scheduleHover(){if(this.hoverTimer)return;this.hoverTimer=setTimeout(()=>{this.hoverTimer=null;void this.queryHover();},110);}
  private queryHover(){
    if(!this.pending||!this.state||this.state.phase!=='selecting')return;
    const {x,y}=this.pending;const seq=this.seq,id=this.state.id;
    const global={x:x+this.bounds.x,y:y+this.bounds.y};
    const owner=this.windows.find(w=>contains(w,global.x,global.y));
    const localBounds=owner?clip({x:owner.x-this.bounds.x,y:owner.y-this.bounds.y,width:owner.width,height:owner.height},{x:0,y:0,width:this.bounds.width,height:this.bounds.height}):{x:0,y:0,width:this.bounds.width,height:this.bounds.height};
    // AX and visual queries have independent queues: a slow app must not hold
    // back color candidates at a new pointer position (or vice versa).
    let waiting=false;
    if(this.worker&&localBounds&&this.colorSeq!==seq){
      if(this.colorBusy)waiting=true;
      else {this.colorBusy=true;this.colorSeq=seq;this.worker.postMessage({type:'color',seq,x:Math.round(x*this.detectScale.x),y:Math.round(y*this.detectScale.y),bounds:{x:localBounds.x*this.detectScale.x,y:localBounds.y*this.detectScale.y,width:localBounds.width*this.detectScale.x,height:localBounds.height*this.detectScale.y}});}
    }
    if(owner&&systemPreferences.isTrustedAccessibilityClient(false)&&this.axSeq!==seq){
      if(this.axBusy)waiting=true;
      else {this.axBusy=true;this.axSeq=seq;void this.ax.query(owner.pid,global.x,global.y).then(result=>{
        if(this.state?.id===id&&seq===this.seq){this.elements=result.rects.map(r=>clip({x:r.x-this.bounds.x,y:r.y-this.bounds.y,width:r.width,height:r.height},{x:0,y:0,width:this.bounds.width,height:this.bounds.height})).filter((r):r is CaptureRect=>Boolean(r)).map(r=>({...r,source:'element'}));this.updateCandidates();}
      }).catch(error=>{console.warn('[screenshot] AX query',String(error));}).finally(()=>{if(this.state?.id===id){this.axBusy=false;if(this.pending)this.scheduleHover();}});}
    }
    if(waiting)this.scheduleHover();else this.pending=null;
  }
  private acceptVersion(id:string,revision:number){
    if(!this.state?.selection||this.state.phase!=='result'||id!==this.state.editId)throw Error('截图编辑会话已结束');
    if(!Number.isSafeInteger(revision)||revision<0||revision<this.editRevision)throw Error('图片已变化，请重试');
    this.editRevision=revision;
  }
  private frameImage(frame:CaptureFrame){
    this.acceptVersion(frame?.id,frame?.revision);
    const r=frame.crop,s=this.state!,base=pixelRect(s.selection!,s.width,s.height,s.pixelWidth,s.pixelHeight);
    if(!r||![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>base.width||r.y+r.height>base.height)throw Error('无效的裁剪范围');
    if(!(frame.png instanceof Uint8Array)||frame.png.byteLength<24||frame.png.byteLength>64*1024*1024)throw Error('无效的合成图片');
    const png=Buffer.from(frame.png);
    if(!png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||png.readUInt32BE(16)!==r.width||png.readUInt32BE(20)!==r.height)throw Error('合成图片尺寸与裁剪范围不符');
    const image=nativeImage.createFromBuffer(png),size=image.getSize();
    if(image.isEmpty()||size.width!==r.width||size.height!==r.height)throw Error('图片合成失败');
    return image;
  }
  private recognize(frame:OCRRequest):Promise<OCRResult>{
    if(!frame||!['text','code'].includes(frame.mode)||typeof frame.enhance!=='boolean'||(frame.force!==undefined&&typeof frame.force!=='boolean'))throw Error('无效的识别选项');
    const image=this.frameImage(frame);
    return this.ocr.recognize({id:frame.id,revision:frame.revision,png:image.toPNG(),mode:frame.mode,enhance:frame.enhance,force:frame.force});
  }
  private async exportFrame(frame:CaptureFrame,action:ExportAction,format:'png'|'jpeg'){
    if(this.exporting)throw Error('正在输出图片');
    if(!['copy','save','image','pin','media'].includes(action)||!['png','jpeg'].includes(format))throw Error('不支持的输出操作');
    const image=this.frameImage(frame),id=frame.id;this.exporting=true;
    try{
      // All destinations use the same flattened pixels; no raw-image fallback.
      if(action==='copy'){await clipboard.write([new ClipboardItem({'image/png':new Blob([new Uint8Array(image.toPNG())],{type:'image/png'})})]);}
      else if(action==='image')await this.receive(image);
      else if(action==='media') { if(!this.receiveMedia)throw Error('图片生成尚未接入');await this.receiveMedia(image); }
      else if(action==='pin'){
        const source=this.image!;const annotations=validateAnnotations(frame.annotations,source,frame.crop);
        if(this.state?.pinId&&!this.pins.contains(this.state.pinId)){
          this.state.pinId=undefined;this.editorKey=null;this.publish();
          throw Error('原贴图已关闭，当前编辑已保留；点击「贴图」可重新创建。');
        }
        await this.pins.put({source,image,annotations},this.state?.pinId);
      }
      else{
        const ext=format==='jpeg'?'jpg':'png';
        const source=this.localSource;
        const {filePath,canceled}=await dialog.showSaveDialog(this.win!,{title:source?'另存图片副本':'保存图片',defaultPath:source?defaultLocalImageCopyPath(source,format):'Lasso-'+new Date().toISOString().replaceAll(':','-')+'.'+ext,filters:[{name:format==='jpeg'?'JPEG 图片':'PNG 图片',extensions:[ext]}]});
        if(canceled||!filePath)return;
        this.acceptVersion(id,frame.revision);
        const bytes=format==='jpeg'?image.toJPEG(92):image.toPNG();
        if(source)await saveLocalImageCopy(source,filePath,bytes);else await writeFile(filePath,bytes);
      }
      if(this.state?.editId===id)this.cancel();
    }finally{this.exporting=false;}
  }
  private async action(a:string){
    if(a==='cancel'){this.cancel(this.state?.origin==='clipboard');return;}
    if(!this.state)throw Error('截图已结束');
    if(a==='screen'){if(this.state.phase==='selecting')this.select({x:0,y:0,width:this.state.width,height:this.state.height},false);return;}
    if(a==='reselect'){this.cancel();try{await this.start();}catch(error){dialog.showErrorBox('重新截图未能启动',(error as Error).message);}return;}
    throw Error('不支持的截图操作');
  }
  private release(restore=false){this.scroll?.dispose();this.scroll=null;this.scrollFinishing=false;this.scrollEditing=false;this.epoch++;this.stopDetection();this.ocr.reset();this.state=null;this.image=null;this.editorKey=null;this.localSource=null;this.captureDisplay=null;this.displayId=null;this.win=null;this.after(restore);}
  cancel(restore=false){const win=this.win;this.release(restore);if(win&&!win.isDestroyed())win.destroy();}
  dispose(){this.disposed=true;this.efficiency.dispose();this.cancel();this.pins.dispose();screen.removeListener('display-removed',this.displayRemoved);screen.removeListener('display-metrics-changed',this.displayMetrics);for(const name of ['screenshot:state','screenshot:select','screenshot:action','screenshot:recognize','screenshot:export','screenshot:copy-text','screenshot:send-text','screenshot:window','screenshot:scroll-start','screenshot:scroll-action'])ipcMain.removeHandler(name);for(const name of ['screenshot:hover','screenshot:invalidate-ocr'])ipcMain.removeAllListeners(name);}
}
