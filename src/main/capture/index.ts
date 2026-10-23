import { BrowserWindow, clipboard, ClipboardItem, desktopCapturer, dialog, ipcMain, nativeImage, screen, shell, systemPreferences } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { CaptureRect, RegionCandidate, ScreenshotState } from '../../shared/capture';
import { clip, contains, rank } from './candidates';
type WindowRect = CaptureRect & { pid: number };
type AX = { windows(): WindowRect[]; query(pid:number,x:number,y:number):Promise<{rects:CaptureRect[];error:number}>; requestScreen(): Promise<boolean> };
export class CaptureManager {
  private win: BrowserWindow | null=null;
  private worker: Worker | null=null;
  private state: ScreenshotState | null=null;
  private image: NativeImage | null=null;
  private bounds: CaptureRect={x:0,y:0,width:1,height:1};
  private displayId: number | null=null;
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
  private hoverPoint={x:-100,y:-100};
  private disposed=false;
  private epoch=0;
  constructor(private receive: (image: NativeImage)=>Promise<void>, private before:()=>void, private after:()=>void) {
    this.ax=require(join(__dirname,'native/capture-ax.node')) as AX;
    const assert=(e:IpcMainEvent|IpcMainInvokeEvent)=>{if(!this.win||e.sender!==this.win.webContents||e.senderFrame!==this.win.webContents.mainFrame)throw new Error('截图操作只允许截图窗口调用');};
    ipcMain.handle('screenshot:state',e=>{assert(e);return this.state;});
    ipcMain.on('screenshot:hover',(e,x:number,y:number)=>{assert(e);if(Number.isFinite(x)&&Number.isFinite(y))this.hover(x,y);});
    ipcMain.handle('screenshot:select',(e,r:CaptureRect)=>{assert(e);if(!r||![r.x,r.y,r.width,r.height].every(Number.isFinite))throw Error('无效的选区');const rect=clip(r,{x:0,y:0,width:this.bounds.width,height:this.bounds.height});if(rect&&this.state){this.state.selection=rect;this.state.phase='result';this.publish();}});
    ipcMain.handle('screenshot:action',async(e,a:string)=>{assert(e);try{await this.action(a);return {error:null};}catch(error){return {error:(error as Error).message};}});
    screen.on('display-removed',(_event,display)=>{if(display.id===this.displayId)this.cancel();});
    screen.on('display-metrics-changed',(_event,display,metrics)=>{
      // Showing a capture window can change Dock/menu-bar workArea without
      // changing captured pixels. Only invalidate the active display's geometry.
      if(display.id===this.displayId&&metrics.some(metric=>metric==='bounds'||metric==='scaleFactor'||metric==='rotation'))this.cancel();
    });
  }
  get active(){return this.busy||Boolean(this.win);}
  async start() {
    if(this.disposed)return;
    if(this.win){this.win.show();this.win.focus();return;}
    if(this.busy)return;
    this.busy=true;
    const epoch=++this.epoch;
    try {
      if(systemPreferences.getMediaAccessStatus('screen')!=='granted') {
        if(!await this.ax.requestScreen()) {
          const {response}=await dialog.showMessageBox({type:'info',message:'允许 Lasso 录制屏幕以截图',detail:'开启屏幕录制权限后，再从菜单栏选择「截图」。剪贴板图片和划词仍可使用。',buttons:['打开系统设置','取消'],cancelId:1});
          if(response===0)await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
          return;
        }
      }
      const display=screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      this.displayId=display.id;
      this.before();
      await new Promise<void>(resolve=>setTimeout(resolve,90));
      if(this.disposed||epoch!==this.epoch)return;
      const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:Math.round(display.bounds.width*display.scaleFactor),height:Math.round(display.bounds.height*display.scaleFactor)},fetchWindowIcons:false});
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
      this.state={id,image:this.image.toDataURL(),width:this.bounds.width,height:this.bounds.height,candidates:this.fixed,phase:'selecting',selection:null,status:'悬停识别区域 · 拖动自由框选 · 滚轮切换层级 · F 全屏 · Esc 取消'};
      const win=new BrowserWindow({...display.bounds,frame:false,show:false,transparent:false,backgroundColor:'#242320',resizable:false,movable:false,fullscreenable:false,hasShadow:false,enableLargerThanScreen:true,webPreferences:{preload:join(__dirname,'capture-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
      this.win=win;win.setAlwaysOnTop(true,'screen-saver');win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
      win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());
      win.on('closed',()=>{if(this.win===win)this.release();});
      await win.loadFile(join(__dirname,'renderer/index.html'),{query:{surface:'screenshot'}});
      if(this.win!==win||this.disposed)return;
      win.setBounds(display.bounds);win.show();win.focus();
      // Downsample only the detection image. The exported crop keeps source pixels.
      const reduced=this.image.resize({width:Math.min(1440,this.image.getSize().width)});
      const size=reduced.getSize();const bitmap=reduced.toBitmap();
      // Electron bitmaps are BGRA on macOS; edge_det consumes RGBA.
      for(let i=0;i<bitmap.length;i+=4){const r=bitmap[i+2];bitmap[i+2]=bitmap[i];bitmap[i]=r;}
      const sx=this.bounds.width/size.width,sy=this.bounds.height/size.height;
      const worker=new Worker(join(__dirname,'regions-worker.cjs'));this.worker=worker;
      worker.on('message',m=>{if(this.state?.id!==id)return;
        const mapped=m.regions.map((r:RegionCandidate)=>({...r,x:r.x*sx,y:r.y*sy,width:r.width*sx,height:r.height*sy}));
        if(m.type==='edges')this.edges=mapped;
        if(m.type==='color'){this.colorBusy=false;if(m.seq===this.seq)this.colors=mapped;}
        this.updateCandidates();if(this.pending)this.scheduleHover();
      });
      worker.on('error',error=>{console.warn('[screenshot] region worker',error.message);this.colorBusy=false;});
      worker.postMessage({type:'init',bytes:bitmap,width:size.width,height:size.height});
      this.detectScale={x:1/sx,y:1/sy};
    } catch(error){const canceled=this.disposed||epoch!==this.epoch;this.cancel();if(!canceled)throw error;}
    finally{this.busy=false;}
  }
  private detectScale={x:1,y:1};
  private publish(){if(this.state&&this.win&&!this.win.isDestroyed()){const {image,...rest}=this.state;this.win.webContents.send('screenshot:changed',rest);}}
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
  private async queryHover(){
    if(!this.pending||!this.state||this.state.phase!=='selecting')return;
    if(this.colorBusy||this.axBusy){this.scheduleHover();return;}
    const {x,y}=this.pending;this.pending=null;const seq=this.seq,id=this.state.id;
    const global={x:x+this.bounds.x,y:y+this.bounds.y};
    const owner=this.windows.find(w=>contains(w,global.x,global.y));
    const localBounds=owner?clip({x:owner.x-this.bounds.x,y:owner.y-this.bounds.y,width:owner.width,height:owner.height},{x:0,y:0,width:this.bounds.width,height:this.bounds.height}):{x:0,y:0,width:this.bounds.width,height:this.bounds.height};
    if(this.worker&&localBounds){this.colorBusy=true;this.worker.postMessage({type:'color',seq,x:Math.round(x*this.detectScale.x),y:Math.round(y*this.detectScale.y),bounds:{x:localBounds.x*this.detectScale.x,y:localBounds.y*this.detectScale.y,width:localBounds.width*this.detectScale.x,height:localBounds.height*this.detectScale.y}});}
    if(owner&&systemPreferences.isTrustedAccessibilityClient(false)){
      this.axBusy=true;
      try { const result=await this.ax.query(owner.pid,global.x,global.y);
        if(this.state?.id===id&&seq===this.seq){this.elements=result.rects.map(r=>clip({x:r.x-this.bounds.x,y:r.y-this.bounds.y,width:r.width,height:r.height},{x:0,y:0,width:this.bounds.width,height:this.bounds.height})).filter((r):r is CaptureRect=>Boolean(r)).map(r=>({...r,source:'element'}));this.updateCandidates();}
      }catch(error){console.warn('[screenshot] AX query',String(error));}finally{if(this.state?.id===id){this.axBusy=false;if(this.pending)this.scheduleHover();}}
    }
  }
  private crop(){
    if(!this.image||!this.state?.selection)throw Error('请先选择截图范围。');
    const r=this.state.selection,size=this.image.getSize();
    return this.image.crop({x:Math.round(r.x*size.width/this.bounds.width),y:Math.round(r.y*size.height/this.bounds.height),width:Math.max(1,Math.min(size.width-Math.round(r.x*size.width/this.bounds.width),Math.round(r.width*size.width/this.bounds.width))),height:Math.max(1,Math.min(size.height-Math.round(r.y*size.height/this.bounds.height),Math.round(r.height*size.height/this.bounds.height)))});
  }
  private async action(a:string){
    if(a==='cancel'){this.cancel();return;}
    if(!this.state)throw Error('截图已结束');
    if(a==='screen'){this.state.selection={x:0,y:0,width:this.bounds.width,height:this.bounds.height};this.state.phase='result';this.publish();return;}
    if(a==='reselect'){this.state.phase='selecting';this.state.selection=null;this.publish();return;}
    const image=this.crop();
    if(a==='copy'){await clipboard.write([new ClipboardItem({'image/png':new Blob([new Uint8Array(image.toPNG())],{type:'image/png'})})]);this.cancel();}
    else if(a==='save') {const {filePath,canceled}=await dialog.showSaveDialog(this.win!,{defaultPath:'Lasso-'+new Date().toISOString().replaceAll(':','-')+'.png',filters:[{name:'PNG 图片',extensions:['png']}]});if(!canceled&&filePath){await writeFile(filePath,image.toPNG());this.cancel();}}
    else if(a==='image'){await this.receive(image);this.cancel();}
    else throw Error('不支持的截图操作');
  }
  private release(){this.epoch++;this.seq++;this.state=null;this.image=null;this.displayId=null;this.fixed=[];this.windows=[];this.colors=[];this.edges=[];this.elements=[];this.pending=null;this.colorBusy=false;this.axBusy=false;if(this.hoverTimer)clearTimeout(this.hoverTimer);this.hoverTimer=null;void this.worker?.terminate();this.worker=null;this.win=null;this.after();}
  cancel(){const win=this.win;this.release();if(win&&!win.isDestroyed())win.destroy();}
  dispose(){this.disposed=true;this.cancel();for(const name of ['screenshot:state','screenshot:select','screenshot:action'])ipcMain.removeHandler(name);ipcMain.removeAllListeners('screenshot:hover');}
}
