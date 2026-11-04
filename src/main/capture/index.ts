import type { RecordingMode, RecordingSessionState } from '../../shared/recording';
import { RegionStore } from './region-store';
import { regionPixels,regionPoints,validPixelRegion } from '../../shared/region-geometry';
import { validateRegionPreset,type RegionPreset,type CustomCaptureRequest } from '../../shared/capture-regions';
import { assertPng, decorateScreenshot, copyFile, copyImage, copyPath, copyPng, decodeFrameImage, encodeScreenshot, flattenBackground, formatScreenshotName, runAfterSaveAction, saveAutomaticScreenshot } from './output';
import { screenshotOutputFormats, validateAnnotationMemory, type AnnotationStyleMemory, type ScreenshotSettings, type ScreenshotOutputFormat, type ScreenshotExportContentMode } from '../../shared/screenshot-settings';
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, screen, shell, systemPreferences } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron';
import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { CaptureFrame, CaptureMode, CaptureRect, EditorCheckpoint, ExportAction, OCRRequest, OCRResult, RegionCandidate, ScreenshotState, ScrollCaptureAction } from '../../shared/capture';
import { pixelRect } from '../../shared/capture';
import { updateNativeAppearance, loadNativeCapture, excludedCaptureWindows, type NativeCapture, type NativeFrame, type NativeCaptureEvent } from './native';
import { clip, contains, rank } from './candidates';
import { OCRService, type VisionOCR } from './ocr';
import { imageDocument, normalizeRegionAnnotations, validateAnnotations, type PinnedDocument } from './document';
import { CaptureHistoryStore } from './history-store';
import { PinManager } from './pins';
import { ScrollSession, type ScrollReply } from './scroll-session';
import { defaultLocalImageCopyPath, saveLocalImageCopy, type LocalImageSource } from './local-images';
import { CaptureEfficiencyControl, CaptureReselectRequiredError, sameCaptureDisplay } from './efficiency-control';
import type { Settings } from '../../shared/contracts';
import type { CaptureDisplayBinding, SuccessfulCaptureArea } from '../../shared/capture-efficiency';
import { setWindowPresence } from '../window-presence';
import { applicationBundleIds, frontmostApplicationId, ignoresApplication } from '../selection';
import { IdleSleep } from '../idle-sleep';
import { memoryDefaults, type MemorySettings } from '../../shared/memory';
import { exportTableXlsx, renderFormula, type IntelligenceService } from './intelligence';
import { webURL } from '../../shared/intelligence';
type AnalyzeRequest = Parameters<import('../../shared/capture').ScreenshotAPI['analyze']>[0];
type WindowRect = CaptureRect & { pid: number; id: number };
const bindDisplay=(display:Electron.Display):CaptureDisplayBinding=>({id:display.id,bounds:{...display.bounds},scaleFactor:display.scaleFactor,rotation:display.rotation});
type AX = { windows(): WindowRect[]; query(pid:number,x:number,y:number):Promise<{rects:CaptureRect[];error:number}>; requestScreen(): Promise<boolean> };
export class CaptureManager {
  private recordingSource:{display:CaptureDisplayBinding;windowId?:number}|null=null;
  private recordingSelect:((event:NativeCaptureEvent)=>void)|null=null;
  private recordingPreparing=false;
  private recordingEpoch=0;
  private recordingReleased=true;
  private regionsStore:RegionStore;
  private customRequest:CustomCaptureRequest|undefined;
  private scrollPreparing=false;
  private scrollRequested=false;
  private sourceApp='';
  private pendingCopy=false;
  private win: BrowserWindow | null=null;
  private cachedWindow: BrowserWindow | null=null;
  private windowReady: Promise<BrowserWindow> | null=null;
  private presented=false;
  private restoreWindow=false;
  private idle: IdleSleep;
  private sleepJob: Promise<void> | null=null;
  private waking=false;
  private checkpointReply: ((value:EditorCheckpoint|null)=>void) | null=null;
  private suspended: {directory:string;bounds:Electron.Rectangle;sources:{key:string;file:string;rect?:CaptureRect}[]} | null=null;
  private sleepDirectory=join(app.getPath('userData'),'capture-sleep');
  private worker: Worker | null=null;
  private state: ScreenshotState | null=null;
  private image: NativeImage | null=null;
  private imageTask: Promise<NativeImage>|null=null;
  private imageLoader: (()=>Promise<NativeImage>)|null=null;
  private native: NativeCapture;
  private screenFrame: NativeFrame | null=null;
  private ownedFrames=new Set<string>();
  private pixelSources=new Map<string,{frame:NativeFrame;rect?:CaptureRect}>();
  private detectionStarting=false;
  private handoff: (()=>Promise<void>) | null=null;
  private appearanceKey='';
  private startedAt=0;
  private selectedAt=0;
  private timing: Record<string,number>={};
  private screenPermission=false;
  private preferences!: ScreenshotSettings;
  private automaticReady: (() => void) | null=null;
  private completedEdit: string | null=null;
  private automaticCompleted=false;
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
  readonly history: CaptureHistoryStore;
  private historyId?: string;
  private historyOCR?: { id: string; revision: number; text: string };
  readonly efficiency=new CaptureEfficiencyControl({
    displays:()=>screen.getAllDisplays().map(bindDisplay),
    capture:async request=>{
      const acquired=await this.start(request.mode==='repeat'?'area':request.mode,request);
      return request.signal.aborted||!acquired?null:{};
    }
  },undefined,area=>{this.regionsStore?.remember(area);if(this.customRequest?.presetId)this.regionsStore?.place(this.customRequest.presetId,area);});
  private displayAdded=()=>{this.native.invalidate();};
  private displayRemoved=(_event:Electron.Event,display:Electron.Display)=>{if(display.id===this.displayId)this.displayChanged();else this.native.invalidate();};
  private displayMetrics=(_event:Electron.Event,display:Electron.Display,metrics:string[])=>{if(metrics.some(metric=>['bounds','scaleFactor','rotation'].includes(metric))){if(display.id===this.displayId)this.displayChanged();else this.native.invalidate();}};
  private displayChanged(){
    this.native.invalidate();
    if(this.state?.phase==='selecting'){this.cancel();return;}
    if(this.state?.phase==='scrolling'){const session=this.scroll;void this.finishScroll('显示配置已变化，采集已结束；已匹配结果保留。').catch(error=>{if(this.scroll!==session)return;if(!session?.metadata.segments)this.cancel(true);else this.scrollError(error);});return;}
    if(this.state?.presentation==='inline'){this.cancel();return;}
    if(this.win&&!this.win.isDestroyed()){const display=screen.getDisplayMatching(this.win.getBounds());this.displayId=display.id;this.win.setBounds(display.workArea);}
  }
  private vision: VisionOCR | null=null;
  private ocr=new OCRService(()=>this.vision??=require(join(__dirname,'native/capture-vision.node')), (id,revision)=>this.state?.phase==='result'&&this.state.editId===id&&this.editRevision===revision);
  constructor(private receive: (image: NativeImage)=>Promise<void>, private before:()=>boolean, private after:(restore?:boolean)=>void, private receiveText:(text:string)=>Promise<void>, private changed:()=>void, private receiveMedia: ((image:NativeImage)=>Promise<void>) | undefined, private settings:()=>ScreenshotSettings, private notice:(message:string)=>void,private appearance?:()=>Pick<Settings,'fonts'|'importedFonts'|'editorShortcuts'|'ignoredApps'|'toolbarTools'|'mouseActions'>,private memory:()=>MemorySettings=memoryDefaults,private savePreferences?:(settings:ScreenshotSettings)=>void,private intelligence?:()=>IntelligenceService) {
    rmSync(this.sleepDirectory,{recursive:true,force:true});
    this.idle=new IdleSleep(memory,async()=>{if(!this.sleepJob){this.sleepJob=this.suspendEditor();try{await this.sleepJob;}finally{this.sleepJob=null;}}});
    this.regionsStore=new RegionStore(join(app.getPath('userData'),'capture-regions.json'),()=>this.settings().rememberRegionAcrossLaunches);
    if(this.regionsStore.last)this.efficiency.restoreArea(this.regionsStore.last);
    this.ax=require(join(__dirname,'native/capture-ax.node')) as AX;
    this.native=loadNativeCapture(event=>this.nativeEvent(event));
    this.screenPermission=systemPreferences.getMediaAccessStatus('screen')==='granted';
    this.configureNativeAppearance();
    this.history=new CaptureHistoryStore(join(app.getPath('userData'),'capture-history'),()=>this.settings().history);
    this.pins=new PinManager({image:receive,media:image=>this.receiveMedia?.(image)??Promise.reject(Error('图片生成尚未接入')),text:receiveText,suppress:()=>this.after(),changed,languages:()=>this.settings().languages,preferences:()=>this.settings(),editorShortcuts:()=>this.appearance?.().editorShortcuts,generalSettings:()=>this.appearance?.(),saveAnnotationMemory:memory=>this.saveAnnotationMemory(memory),canEdit:()=>!this.active,intelligence:()=>this.intelligenceService(),saveWorkspaceSettings:pinWorkspace=>this.savePreferences?.({...this.settings(),pinWorkspace}),recordHistory:async(document,id)=>{await this.history.add(document,{id,captureKind:'pin'});}});
    const owns=(e:IpcMainEvent|IpcMainInvokeEvent)=>Boolean(this.cachedWindow&&e.sender===this.cachedWindow.webContents&&e.senderFrame===this.cachedWindow.webContents.mainFrame);
    const assert=(e:IpcMainEvent|IpcMainInvokeEvent)=>{if(!owns(e))throw new Error('截图操作只允许截图窗口调用');};
    ipcMain.handle('screenshot:checkpoint',(e,editId:string,checkpoint:EditorCheckpoint|null)=>{assert(e);if(this.state?.editId===editId)this.checkpointReply?.(checkpoint);});
    ipcMain.handle('screenshot:state',e=>{assert(e);return this.editorState();});
    ipcMain.handle('screenshot:save-annotation-memory',(e,memory:AnnotationStyleMemory)=>{if(owns(e))this.saveAnnotationMemory(memory);else this.pins.saveAnnotationMemory(e,memory);});
    ipcMain.handle('screenshot:region',(e,r:{id:string;revision:number;crop:CaptureRect})=>{assert(e);this.acceptVersion(r.id,r.revision);const context=this.state!.editableRegion;if(!context||!validPixelRegion(r.crop,context.sourceSize))throw Error('无效的截图区域');this.assertCaptureDisplay();if(['x','y','width','height'].every(k=>context.currentCrop[k as keyof CaptureRect]===r.crop[k as keyof CaptureRect]))return;context.currentCrop={...r.crop};this.efficiency.rememberSuccessfulArea({display:context.display,rect:regionPoints(r.crop,context.display.bounds,context.sourceSize),kind:this.state!.captureKind==='rect'?'rect':'area'});});
    ipcMain.handle('screenshot:last-region',e=>{assert(e);const area=this.efficiency.rememberedArea,context=this.state?.editableRegion;return area&&context&&sameCaptureDisplay(area.display,context.display)?regionPixels(area.rect,context.display.bounds,context.sourceSize):null;});
    ipcMain.handle('screenshot:clear-region',e=>{assert(e);this.clearRegion();});
    ipcMain.handle('screenshot:start-scroll',async(e,crop:CaptureRect)=>{assert(e);try{const c=this.state?.editableRegion;if(!c||!validPixelRegion(crop,c.sourceSize))throw Error('无效的滚动选区');await this.startScroll(regionPoints(crop,c.display.bounds,c.sourceSize));return {error:null};}catch(error){return {error:(error as Error).message};}});
    ipcMain.handle('screenshot:regions',e=>{assert(e);return this.regionConfiguration();});
    ipcMain.handle('screenshot:save-region-preset',(e,p:RegionPreset)=>{assert(e);this.saveRegionPreset(p);const c=this.state?.editableRegion;if(c)this.regionsStore.place(p.id,{display:c.display,rect:regionPoints(c.currentCrop,c.display.bounds,c.sourceSize),kind:'rect'});});

    ipcMain.on('screenshot:ready',(e,id:string,editId:string)=>{
      if(!owns(e)||!this.win||this.state?.id!==id||this.state.editId!==editId)return;
      if(this.pendingCopy){this.pendingCopy=false;this.state.copyIntent=(this.state.copyIntent??0)+1;this.publish();}
      if(!this.presented){this.presented=true;this.win.show();app.focus({steal:true});this.win.focus();this.native.hide();this.handoff=null;this.timing.editorReady=performance.now()-this.startedAt;this.timing.handoff=this.selectedAt?performance.now()-this.selectedAt:0;console.info('[capture-timing]',JSON.stringify(this.timing));const automatic=this.automaticReady;this.automaticReady=null;if(automatic)setImmediate(automatic);}
    });
    ipcMain.handle('screenshot:pixels',async(e,request:{sessionId:string;frameId:string})=>{
      assert(e);const state=this.state;
      if(!state||state.id!==request?.sessionId||![state.imageFrame,state.backdropFrame].includes(request.frameId))throw Error('截图图片已失效');
      const source=this.pixelSources.get(request.frameId);if(!source)throw Error('截图图片已释放');
      const pixels=await this.native.pixels(source.frame.id,{format:'rgba',rect:source.rect});
      if(this.state!==state||state.id!==request.sessionId)throw Error('截图会话已结束');
      this.timing.pixelsReady=performance.now()-this.startedAt;return pixels;
    });
    ipcMain.handle('screenshot:action',async(e,a:string)=>{assert(e);try{await this.action(a);return {error:null};}catch(error){return {error:(error as Error).message};}});
    ipcMain.handle('screenshot:scroll-action',async(e,a:ScrollCaptureAction)=>{assert(e);try{await this.scrollAction(a);return {error:null};}catch(error){return {error:(error as Error).message};}});
    ipcMain.on('screenshot:load-error',(e,id:string)=>{if(!owns(e)||this.state?.editId!==id)return;if(this.native.snapshot().visible)this.native.update({session:this.state.id,message:'编辑器未能准备好，请重试或取消'});else{this.win?.show();app.focus({steal:true});this.win?.focus();}});
    ipcMain.handle('screenshot:recognize',(e,frame:OCRRequest)=>{assert(e);return this.recognize(frame);});
    ipcMain.handle('screenshot:analyze',async(e,request:AnalyzeRequest)=>{assert(e);try{this.frameImage({id:request?.id,revision:request?.revision,crop:request?.crop,png:request?.png});const result=await this.intelligenceService().analyze(request);if(this.state?.editId!==request.id||this.editRevision!==request.revision)throw Error('图片已变化，请重试');this.assertVersion(request.id,request.revision);return {result,error:null};}catch(error){return {result:null,error:(error as Error).message};}});
    ipcMain.handle('screenshot:vision-language',e=>{assert(e);this.assertResult();return this.intelligenceService().connection().targetLanguage;});
    ipcMain.handle('screenshot:preview-formula',(e,r:{id:string;revision:number;latex:string})=>{assert(e);try{this.assertVersion(r?.id,r?.revision);return {svg:renderFormula(r.latex),error:null};}catch(error){return {svg:null,error:(error as Error).message};}});
    ipcMain.handle('screenshot:open-url',async(e,r:{id:string;revision:number;url:string})=>{assert(e);try{this.assertVersion(r?.id,r?.revision);const url=typeof r.url==='string'&&webURL(r.url);if(!url)throw Error('只能打开 HTTP 或 HTTPS 链接');await shell.openExternal(url);return {error:null};}catch(error){return {error:(error as Error).message};}});
    ipcMain.handle('screenshot:export-table',(e,rows:string[][])=>{assert(e);this.assertResult();return exportTableXlsx(rows,this.settings().directory);});
    ipcMain.handle('screenshot:pin-formula',async(e,latex:string)=>{assert(e);try{this.assertResult();const id=this.state!.editId,revision=this.editRevision;await this.intelligenceService().pinFormula(latex,()=>owns(e)&&this.state?.phase==='result'&&this.state.editId===id&&this.editRevision===revision);return {error:null};}catch(error){return {error:(error as Error).message};}});
    ipcMain.on('screenshot:invalidate-ocr',(e,request:{id:string;revision:number})=>{if(!owns(e)||!request||this.state?.phase!=='result'||request.id!==this.state.editId||!Number.isSafeInteger(request.revision)||request.revision<this.editRevision)return;this.editRevision=request.revision;this.ocr.invalidate(request.id,request.revision);});
    ipcMain.handle('screenshot:export',async(e,frame:CaptureFrame,action:ExportAction,format:ScreenshotOutputFormat,contentMode?:ScreenshotExportContentMode)=>{assert(e);try{await this.exportFrame(frame,action,format,contentMode);return {error:null};}catch(error){return {error:(error as Error).message};}});
    ipcMain.handle('screenshot:copy-text',async(e,request:{id:string;revision:number;text:string})=>{assert(e);this.acceptVersion(request?.id,request?.revision);if(typeof request.text!=='string'||!request.text.trim()||request.text.length>100000)throw Error('没有可复制的文字');this.after();await clipboard.writeText(request.text);});
    ipcMain.handle('screenshot:send-text',async(e,request:{id:string;revision:number;text:string})=>{assert(e);try{this.acceptVersion(request?.id,request?.revision);if(typeof request.text!=='string'||!request.text.trim()||request.text.length>100000)throw Error('请先选择图中文字');await this.receiveText(request.text);if(this.state?.editId===request.id)this.cancel();return {error:null};}catch(error){return {error:(error as Error).message};}});
    screen.on('display-added',this.displayAdded);
    screen.on('display-removed',this.displayRemoved);
    screen.on('display-metrics-changed',this.displayMetrics);
    app.on('did-resign-active',this.appVisibility);
    app.on('did-become-active',this.appVisibility);
    this.native.invalidate();
  }
  /** Keep the recent editor warm; idle sleep can release its renderer independently of capture. */
  private prepareWindow():Promise<BrowserWindow>{
    if(this.sleepJob)return this.sleepJob.then(()=>this.prepareWindow());
    if(this.windowReady)return this.windowReady.then(win=>{win.webContents.setBackgroundThrottling(false);return win;});
    const win=new BrowserWindow({width:760,height:500,frame:false,show:false,backgroundColor:'#242320',resizable:false,movable:false,fullscreenable:false,hasShadow:false,enableLargerThanScreen:true,webPreferences:{preload:join(__dirname,'capture-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
    this.cachedWindow=win;
    win.on('show',this.appVisibility);win.on('hide',this.appVisibility);win.on('minimize',this.appVisibility);win.on('restore',this.appVisibility);win.on('blur',this.appVisibility);
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());
    // The application menu binds Cmd+W to the launcher. Close this session instead,
    // including when an annotation text field has keyboard focus.
    win.webContents.on('before-input-event',(event,input)=>{
      if(input.type==='keyDown'&&input.meta&&!input.control&&!input.alt&&!input.shift&&input.key.toLowerCase()==='w'){
        event.preventDefault();win.close();
      }
    });
    win.on('close',event=>{if(!this.disposed){event.preventDefault();this.cancel(this.state?.origin==='clipboard');}});
    win.on('closed',()=>{if(this.win===win)this.release();if(this.cachedWindow===win){this.cachedWindow=null;this.windowReady=null;}});
    this.updateIdle();
    this.windowReady=win.loadFile(join(__dirname,'renderer/index.html'),{query:{surface:'screenshot'}}).then(()=>win).catch(error=>{win.destroy();throw error;});
    return this.windowReady;
  }
  /** Preparing the reusable renderer does not give an ended capture ownership of that window. */
  private claimWindow(win: BrowserWindow, state: ScreenshotState, epoch: number): boolean {
    if (this.disposed || this.state !== state || this.epoch !== epoch) return false;
    this.win = win;
    return true;
  }
  get active(){return this.recordingPreparing||Boolean(this.recordingSource)||this.busy||Boolean(this.state)||Boolean(this.win)||this.efficiency.state.phase!=='idle';}
  ownsRecording(event:IpcMainInvokeEvent){return !!this.cachedWindow&&!this.cachedWindow.isDestroyed()&&event.sender===this.cachedWindow.webContents&&event.senderFrame===this.cachedWindow.webContents.mainFrame;}
  publishRecording(state:RecordingSessionState|null){if(this.cachedWindow&&!this.cachedWindow.isDestroyed())this.cachedWindow.webContents.send('shell:recording-changed',state);this.pins.publishRecording(state);}
  cancelRecordingSelection(){if(this.recordingPreparing)this.releaseRecording();}
  releaseRecording(restore=false){if(this.recordingReleased)return;this.recordingReleased=true;this.recordingEpoch++;const select=this.recordingSelect;this.recordingSelect=null;select?.({session:'',type:'cancel'});this.recordingSource=null;this.after(restore);}
  async prepareRecording(mode:RecordingMode,bounds?:CaptureRect):Promise<{bounds:CaptureRect;displayId:number}>{
    if(this.active)throw Error('请先完成当前截图或录制');
    this.recordingPreparing=true;this.recordingReleased=false;const epoch=++this.recordingEpoch;let restore=false;
    const current=()=>{if(epoch!==this.recordingEpoch||this.disposed)throw Error('已取消录制选区');};
    try{
      if(systemPreferences.getMediaAccessStatus('screen')!=='granted'){const granted=await this.ax.requestScreen();current();if(!granted)throw Error('请在系统设置允许 Lasso 录制屏幕');}
      restore=this.before();
      this.configureNativeAppearance();
      const display=bounds?screen.getDisplayMatching(bounds):screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),binding=bindDisplay(display);
      let chosen=bounds,windowId:number|undefined;
      const windows=mode==='window'?this.candidateWindows():[];
      if(mode==='screen')chosen={...display.bounds};
      else if(mode==='window'&&bounds){const window=windows.find(w=>contains(w,bounds.x+bounds.width/2,bounds.y+bounds.height/2));if(!window)throw Error('选中的窗口已关闭');chosen=window;windowId=window.id;}
      if(!chosen){
        const frame=await this.native.capture({displayId:display.id,bounds:display.bounds,includeCursor:this.settings().includeCursor,exclude:excludedCaptureWindows(this.native)}),session=randomUUID();
        try{
          current();
          const selection=await new Promise<{bounds:CaptureRect;windowId?:number}>((resolve,reject)=>{
            this.recordingSelect=event=>{
              if(event.type==='cancel'){reject(Error('已取消录制选区'));return;}
              if(event.session!==session)return;
              if(mode==='window'&&event.type==='window'){const window=windows.find(w=>w.id===event.id);if(window)resolve({bounds:window,windowId:window.id});}
              if(mode==='rect'&&event.type==='select'&&event.rect)resolve({bounds:{...event.rect,x:event.rect.x+display.bounds.x,y:event.rect.y+display.bounds.y}});
            };
            this.native.show({frameId:frame.id,session,mode:mode==='window'?'window':'rect',windows:windows.map(w=>({...w,x:w.x-display.bounds.x,y:w.y-display.bounds.y})),candidates:[]});
          });
          current();chosen=selection.bounds;windowId=selection.windowId;
        }finally{this.recordingSelect=null;this.native.hide();this.native.release(frame.id);}
      }
      if(![chosen.x,chosen.y,chosen.width,chosen.height].every(Number.isFinite)||chosen.width<2||chosen.height<2||chosen.x<display.bounds.x||chosen.y<display.bounds.y||chosen.x+chosen.width>display.bounds.x+display.bounds.width||chosen.y+chosen.height>display.bounds.y+display.bounds.height)throw Error('录制范围需位于同一显示器内');
      current();this.recordingSource={display:binding,windowId};return {bounds:{x:chosen.x,y:chosen.y,width:chosen.width,height:chosen.height},displayId:display.id};
    }catch(error){this.releaseRecording(restore);throw error;}finally{this.recordingPreparing=false;}
  }
  async captureRecordingFrame(mode:RecordingMode,bounds:CaptureRect):Promise<{image:NativeImage;hostTimeMs:number}>{
    const source=this.recordingSource;if(!source||!screen.getAllDisplays().some(display=>sameCaptureDisplay(source.display,bindDisplay(display))))throw Error('录制显示器已变化，请停止后重新录制');
    if(mode==='window'&&!this.ax.windows().some(window=>window.id===source.windowId))throw Error('录制窗口已关闭');
    const frame=await this.native.capture({displayId:source.display.id,bounds,windowId:source.windowId,shadow:false,includeCursor:this.settings().includeCursor,exclude:excludedCaptureWindows(this.native)});
    try{const pixels=await this.native.pixels(frame.id,{format:'bgra'});return {image:nativeImage.createFromBitmap(Buffer.from(pixels.data),{width:pixels.width,height:pixels.height,scaleFactor:1}),hostTimeMs:frame.hostTimeMs};}
    finally{this.native.release(frame.id);}
  }
  get sleeping(){return Boolean(this.suspended);}
  focus(){if(this.state?.phase==='selecting'){this.native.focus();return;}if(this.suspended||this.sleepJob){void this.resumeEditor().catch(error=>this.notice('编辑器恢复失败：'+error.message));return;}if(this.presented&&this.win&&!this.win.isDestroyed()){if(this.win.isMinimized())this.win.restore();this.win.show();app.focus({steal:true});this.win.focus();}}
  memoryChanged(){this.idle.refresh();}
  private appVisibility=()=>{setImmediate(()=>this.updateIdle());};
  private updateIdle(){
    const w=this.cachedWindow,visible=Boolean(w&&!w.isDestroyed()&&w.isVisible()&&!w.isMinimized()&&!app.isHidden());
    if(w&&!w.isDestroyed())w.webContents.setBackgroundThrottling(!visible&&(this.presented||!this.state));
    this.idle.active(!w||visible);
  }
  private async suspendEditor(){
    const win=this.cachedWindow,s=this.state,epoch=this.epoch;
    const hidden=()=>this.idle.due&&this.cachedWindow===win&&!!win&&!win.isDestroyed()&&(!win.isVisible()||win.isMinimized()||app.isHidden())&&!this.waking;
    if(!hidden()||this.busy||this.grabbing||this.exporting||this.ocr.busy||this.automaticReady||s&&s.phase!=='result')return;
    if(!s){this.cachedWindow=null;this.windowReady=null;win!.destroy();this.idle.active(true);return;}
    const checkpoint=await new Promise<EditorCheckpoint|null>(resolve=>{
      const timeout=setTimeout(()=>done(null),5000);
      const done=(value:EditorCheckpoint|null)=>{clearTimeout(timeout);this.checkpointReply=null;resolve(value);};
      this.checkpointReply=done;win!.webContents.send('screenshot:suspend',s.editId);
    });
    if(!checkpoint||!hidden()||epoch!==this.epoch)return;
    const directory=join(this.sleepDirectory,s.id),sources:{key:string;file:string;rect?:CaptureRect}[]=[],files=new Map<string,string>();
    await mkdir(directory,{recursive:true,mode:0o700});
    try{
      for(const [key,source] of this.pixelSources){
        let file=files.get(source.frame.id);
        if(!file){file=source.frame.id+'.png';const p=await this.native.pixels(source.frame.id,{format:'bgra'});const image=nativeImage.createFromBitmap(Buffer.from(p.data.buffer,p.data.byteOffset,p.data.byteLength),{width:p.width,height:p.height});await writeFile(join(directory,file),image.toPNG(),{mode:0o600});files.set(source.frame.id,file);}
        sources.push({key,file,rect:source.rect});
      }
      await writeFile(join(directory,'editor.json'),JSON.stringify(checkpoint),{mode:0o600});
      if(!hidden()||epoch!==this.epoch)return;
      this.suspended={directory,bounds:win!.getBounds(),sources};
      this.win=null;this.cachedWindow=null;this.windowReady=null;this.presented=false;
      win!.destroy();this.native.hide();for(const id of this.ownedFrames)this.native.release(id);
      this.ownedFrames.clear();this.pixelSources.clear();this.screenFrame=null;this.image=null;this.imageTask=null;this.imageLoader=null;this.ocr.reset();
      delete s.checkpoint;this.idle.active(true);
      console.info('[memory] editor sleeping',s.id);
      this.changed();
    }finally{if(this.suspended?.directory!==directory)await rm(directory,{recursive:true,force:true});}
  }
  private async resumeEditor(){
    if(this.waking)return;this.waking=true;this.idle.active(true);
    const restored=new Map<string,NativeFrame>();
    try{
      await this.sleepJob;const saved=this.suspended,s=this.state,epoch=this.epoch;
      if(!saved||!s){this.focus();return;}
      this.startedAt=performance.now();this.selectedAt=0;this.timing={};
      const checkpoint=JSON.parse(await readFile(join(saved.directory,'editor.json'),'utf8')) as EditorCheckpoint;
      for(const source of saved.sources){
        let frame=restored.get(source.file);
        if(!frame){const bytes=await readFile(join(saved.directory,source.file));if(epoch!==this.epoch)return;const image=nativeImage.createFromBuffer(bytes);if(image.isEmpty())throw Error('休眠图片无法读取');frame=this.importFrame(image,s.editableRegion?.display.bounds);restored.set(source.file,frame);}
        this.pixelSources.set(source.key,{frame,rect:source.rect});
      }
      if(epoch!==this.epoch)return;
      s.checkpoint=checkpoint;this.editRevision=checkpoint.revision;
      const source=this.pixelSources.get(s.imageFrame!);if(!source)throw Error('休眠图片已失效');
      if(s.editableRegion)this.screenFrame=source.frame;
      this.imageLoader=async()=>{const pixels=await this.native.pixels(source.frame.id,{format:'bgra',rect:s.imageCrop??source.rect});return nativeImage.createFromBitmap(Buffer.from(pixels.data.buffer,pixels.data.byteOffset,pixels.data.byteLength),{width:pixels.width,height:pixels.height});};
      const win=await this.prepareWindow();if(!this.claimWindow(win,s,epoch))return;
      this.configureResult();if(s.presentation==='window')win.setBounds(saved.bounds);
      this.suspended=null;await rm(saved.directory,{recursive:true,force:true});this.publish();
      console.info('[memory] editor waking',s.id);
      this.changed();
    }catch(error){
      if(this.suspended){for(const frame of restored.values()){this.native.release(frame.id);this.ownedFrames.delete(frame.id);}this.pixelSources.clear();this.screenFrame=null;}
      throw error;
    }finally{this.waking=false;this.updateIdle();}
  }
  closeFocused(){if(this.native.snapshot().focused){this.cancel();return true;}if(this.pins.closeFocused())return true;if(this.win&&BrowserWindow.getFocusedWindow()===this.win){this.win.close();return true;}return false;}
  supportedLanguages(): string[] { return (this.vision??=require(join(__dirname,'native/capture-vision.node')) as VisionOCR).supportedLanguages(); }
  private configureNativeAppearance(){const settings=this.appearance?.(),{includeCursor,showCrosshair,loupeMagnification,loupeColorFormat}=this.settings(),screenshot={includeCursor,showCrosshair,loupeMagnification,loupeColorFormat};const key=JSON.stringify({fonts:settings?.fonts,importedFonts:settings?.importedFonts,...screenshot});if(key!==this.appearanceKey){this.appearanceKey=key;updateNativeAppearance(this.native,settings,screenshot);}}
  private assertCaptureDisplay(){if(!this.captureDisplay||!screen.getAllDisplays().some(display=>sameCaptureDisplay(this.captureDisplay!,bindDisplay(display))))throw new CaptureReselectRequiredError();}
  async start(mode:CaptureMode='area',request?:{area?:SuccessfulCaptureArea;signal:AbortSignal;custom?:CustomCaptureRequest}) {
    if(this.recordingPreparing||this.recordingSource)throw Error('请先停止当前录制');
    if(this.disposed||request?.signal.aborted)return false;
    if(this.state){this.focus();return true;}
    if(this.busy)return false;
    this.automaticCompleted=false;
    this.customRequest=request?.custom;
    this.busy=true;this.startedAt=performance.now();this.selectedAt=0;this.timing={};
    const epoch=++this.epoch;
    const abort=()=>{if(epoch===this.epoch)this.cancel(true);};
    request?.signal.addEventListener('abort',abort,{once:true});
    try {
      // ScreenCaptureKit enforces revocation; avoid a synchronous TCC query on every shortcut.
      if(!this.screenPermission&&systemPreferences.getMediaAccessStatus('screen')!=='granted') {
        if(!await this.ax.requestScreen()) {
          if(request?.signal.aborted||epoch!==this.epoch)return false;
          const {response}=await dialog.showMessageBox({type:'info',message:'允许 Lasso 录制屏幕以截图',detail:'开启屏幕录制权限后，再从菜单栏选择「截图」。剪贴板图片和划词仍可使用。',buttons:['打开系统设置','取消'],cancelId:1});
          if(response===0)await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
          return false;
        }
      }
      this.screenPermission=true;
      if(request?.signal.aborted||epoch!==this.epoch)return false;
      this.timing.permissionChecked=performance.now()-this.startedAt;
      this.preferences=structuredClone(this.settings());
      this.sourceApp=this.preferences.fileNameTemplate.includes('{app}')?frontmostApplicationId():'';
      this.configureNativeAppearance();
      const front=mode==='front'?this.candidateWindows(true)[0]:undefined;
      if(mode==='front'&&!front)throw Error('没有可截图的前台窗口');
      const custom=request?.custom;
      const placement=custom?.presetId?this.regionsStore.placements[custom.presetId]:undefined;
      const customDisplay=custom?screen.getAllDisplays().find(d=>d.id===custom.displayId):undefined;
      const bound=placement&&customDisplay&&sameCaptureDisplay(placement.display,bindDisplay(customDisplay))&&Math.round(placement.rect.width*customDisplay.scaleFactor)===custom!.width&&Math.round(placement.rect.height*customDisplay.scaleFactor)===custom!.height?placement:undefined;
      const display=custom?customDisplay:front?screen.getDisplayMatching(front):request?.area?screen.getAllDisplays().find(display=>display.id===request.area!.display.id):screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      if(!display||(request?.area&&!sameCaptureDisplay(request.area.display,bindDisplay(display))))throw new CaptureReselectRequiredError();
      this.captureDisplay=bindDisplay(display);
      this.displayId=display.id;
      this.restoreWindow=this.before();this.timing.hidden=performance.now()-this.startedAt;
      this.bounds=display.bounds;
      const id=randomUUID();
      if(this.disposed||epoch!==this.epoch)return false;
      this.state={id,editId:randomUUID(),width:this.bounds.width,height:this.bounds.height,pixelWidth:0,pixelHeight:0,candidates:[],windows:[],mode:mode==='rect'?'rect':mode==='window'?'window':'area',captureKind:request?.area?.kind??mode,saveFormat:this.preferences.format,phase:'selecting',selection:null,status:'',origin:'screen'};
      if(front){this.windows=[front];this.state.windows=[{...front,x:front.x-this.bounds.x,y:front.y-this.bounds.y}];await this.captureWindow(front.id,this.preferences.shadow);return Boolean(this.state?.imageFrame);}
      const exclude=excludedCaptureWindows(this.native);this.timing.queued=performance.now()-this.startedAt;
      const frame=await this.native.capture({displayId:display.id,bounds:this.bounds,includeCursor:this.settings().includeCursor,exclude});
      if(this.disposed||epoch!==this.epoch){this.native.release(frame.id);return false;}
      this.ownedFrames.add(frame.id);this.assertCaptureDisplay();this.screenFrame=frame;
      this.timing.captured=performance.now()-this.startedAt;this.timing.capture=frame.captureMs;this.timing.nativeQueue=frame.queueMs;this.timing.nativeCompletion=frame.completionMs;this.timing.nativeWork=frame.workMs;
      this.windows=mode==='rect'||mode==='screen'||request?.area?[]:this.candidateWindows();
      const local=(r:CaptureRect):CaptureRect=>({x:r.x-this.bounds.x,y:r.y-this.bounds.y,width:r.width,height:r.height});
      this.fixed=this.windows.map(r=>clip(local(r),{x:0,y:0,width:this.bounds.width,height:this.bounds.height})).filter((r):r is CaptureRect=>Boolean(r)).map(r=>({...r,source:'window'}));
      if(mode!=='rect')this.fixed.push({x:0,y:0,width:this.bounds.width,height:this.bounds.height,source:'screen'});
      this.elements=[];this.edges=[];this.colors=[];this.hoverPoint={x:-100,y:-100};
      const windows=this.windows.map(w=>({id:w.id,...local(w)})).filter(w=>clip(w,{x:0,y:0,width:this.bounds.width,height:this.bounds.height}));
      Object.assign(this.state,{pixelWidth:frame.width,pixelHeight:frame.height,candidates:this.fixed,windows});
      if(custom){if(custom.width>frame.width||custom.height>frame.height)throw Error('预设尺寸超过此显示器，请换显示器或编辑尺寸');if(bound){await this.select(bound.rect);return true;}this.native.show({frameId:frame.id,session:id,mode:'rect',windows:[],candidates:[],fixedSize:{width:custom.width*this.bounds.width/frame.width,height:custom.height*this.bounds.height/frame.height}});return true;}
      if(request?.area){await this.select(request.area.rect);return true;}
      if(mode==='screen'){this.state.captureKind='screen';await this.select({x:0,y:0,width:this.bounds.width,height:this.bounds.height},false);return true;}
      this.native.show({frameId:frame.id,session:id,mode:this.state.mode!,windows,candidates:this.fixed});return true;
    } catch(error){if(this.disposed||epoch!==this.epoch)return false;this.screenPermission=systemPreferences.getMediaAccessStatus('screen')==='granted';this.cancel(true);throw error;}
    finally{request?.signal.removeEventListener('abort',abort);this.busy=false;}
  }
  private async startDetection(){
      const id=this.state?.id,frame=this.screenFrame;
      if(!id||this.state?.phase!=='selecting'||(this.state.mode==='rect'||this.state.mode==='window')||!frame||this.worker||this.detectionStarting)return;
      this.detectionStarting=true;
      let reduced;
      try{reduced=await this.native.pixels(frame.id,{format:'rgba',maxWidth:1440});}
      finally{if(this.state?.id===id)this.detectionStarting=false;}
      if(this.state?.id!==id||this.state.phase!=='selecting')return;
      const size={width:reduced.width,height:reduced.height},bitmap=new Uint8Array(reduced.data);
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
  }
  private detectScale={x:1,y:1};
  /** State notifications carry metadata; immutable pixels are read once by frame reference. */
  private editorState(){
    if(this.state)Object.assign(this.state,{annotationMemory:this.settings().annotationMemory,editorShortcuts:this.appearance?.().editorShortcuts,screenshotSettings:this.settings(),toolbarTools:this.appearance?.().toolbarTools,mouseActions:this.appearance?.().mouseActions});
    return this.state;
  }
  private publish(_includeImage=false){if(this.state&&this.win&&!this.win.isDestroyed())this.win.webContents.send('screenshot:changed',this.editorState());}
  private saveAnnotationMemory(memory:AnnotationStyleMemory){
    validateAnnotationMemory(memory);
    this.savePreferences?.({...this.settings(),annotationMemory:memory});
    if(this.preferences)this.preferences.annotationMemory=memory;
  }
  private candidateWindows(frontOnly=false){
    const all=this.ax.windows(),windows=frontOnly?all.slice(0,1):all,rules=this.appearance?.().ignoredApps??[];
    if(!rules.some(rule=>rule.enabled&&rule.scopes.includes('capture-candidates')))return windows;
    const ids=applicationBundleIds();
    return windows.filter(window=>!ignoresApplication(rules,ids[window.pid]??'','capture-candidates'));
  }
  async startScrollCapture(){
    this.scrollRequested=true;
    try{const result=await this.efficiency.start('area');if('error' in result)this.scrollRequested=false;return result;}
    catch(error){this.scrollRequested=false;throw error;}
  }
  private stopDetection(){this.seq++;this.pending=null;this.fixed=[];this.windows=[];this.elements=[];this.edges=[];this.colors=[];this.colorBusy=false;this.axBusy=false;if(this.hoverTimer)clearTimeout(this.hoverTimer);this.hoverTimer=null;void this.worker?.terminate();this.worker=null;}
  private keepFrame(frame:NativeFrame,rect?:CaptureRect){this.ownedFrames.add(frame.id);const id=randomUUID();this.pixelSources.set(id,{frame,rect});return id;}
  private importFrame(image:NativeImage,bounds?:CaptureRect){const size=image.getSize(),frame=this.native.createFrame({...size,data:image.toBitmap(),...(bounds?{logicalX:bounds.x,logicalY:bounds.y,logicalWidth:bounds.width,logicalHeight:bounds.height}:{})});this.ownedFrames.add(frame.id);return frame;}
  syncRegionPreferences(){this.regionsStore.save();}
  async preferencesChanged(){this.configureNativeAppearance();this.syncRegionPreferences();await this.history.prune();await this.pins.saveWorkspace(this.settings().pinWorkspace);}
  async actCaptureHistory(id:string,action:'edit'|'pin'|'copy'|'delete'){
    if(typeof id!=='string'||!['edit','pin','copy','delete'].includes(action))throw Error('无效的历史操作');
    if(action==='delete'){await this.history.delete(id);return;}
    const document=await this.history.load(id);
    if(action==='copy'){this.after();await copyImage(document.image);}
    else if(action==='pin')await this.pins.put(document);
    else{await this.openImage(document.source,'clipboard',document,undefined,'history:'+id);this.historyId=id;}
  }
  regionConfiguration(){
    const displays=screen.getAllDisplays().map(d=>({...bindDisplay(d),label:d.label||`${d.bounds.width} × ${d.bounds.height}`}));
    const presets=this.settings().regionPresets;
    const presetDisplayIds=Object.fromEntries(Object.entries(this.regionsStore.placements)
      .filter(([id,area])=>presets.some(p=>p.id===id)&&displays.some(d=>sameCaptureDisplay(area.display,d)))
      .map(([id,area])=>[id,area.display.id]));
    return {presets,displays,presetDisplayIds};
  }
  saveRegionPreset(p:RegionPreset){validateRegionPreset(p);const presets=this.settings().regionPresets.filter(v=>v.id!==p.id);if(presets.length>=100)throw Error('最多保存 100 个区域预设');this.savePreferences?.({...this.settings(),regionPresets:[...presets,{...p,name:p.name.trim()}]});}
  deleteRegionPreset(id:string){this.savePreferences?.({...this.settings(),regionPresets:this.settings().regionPresets.filter(p=>p.id!==id)});delete this.regionsStore.placements[id];this.regionsStore.save();}
  async customCapture(r:CustomCaptureRequest){if(this.active)throw Error('请先完成或关闭当前截图');validateRegionPreset({id:r.presetId??'custom',name:'自定义',width:r.width,height:r.height,ratio:r.ratio,delay:r.delay});return this.efficiency.start('rect',r.delay,r);}
  private clearRegion(){
    const s=this.state,frame=this.screenFrame;if(!s?.editableRegion||!frame)throw Error('当前图片不能重新选区');this.assertCaptureDisplay();
    this.win?.hide();this.presented=false;this.ocr.reset();this.image=null;this.imageTask=null;this.imageLoader=null;this.automaticReady=null;this.handoff=null;
    for(const id of new Set([s.imageFrame,s.backdropFrame]))if(id)this.dropSource(id);
    this.pendingCopy=false;
    Object.assign(s,{phase:'selecting',backdropFrame:undefined,checkpoint:undefined,copyIntent:undefined,outputError:undefined,outputStatus:undefined,editableRegion:undefined,annotations:undefined,width:this.bounds.width,height:this.bounds.height,pixelWidth:frame.width,pixelHeight:frame.height,selection:null,imageFrame:undefined,placement:undefined,mode:s.captureKind==='rect'?'rect':'area'});
    this.publish();this.native.show({frameId:frame.id,session:s.id,mode:s.mode!,windows:[],candidates:[]});
  }
  private refreshPixelReferences(){
    const s=this.state;if(!s)return;
    const replacements=new Map<string,string>();
    for(const key of ['imageFrame','backdropFrame'] as const){const id=s[key];if(!id)continue;
      const source=this.pixelSources.get(id);if(!source)continue;
      if(!replacements.has(id))replacements.set(id,this.keepFrame(source.frame,source.rect));
      s[key]=replacements.get(id);
    }
    for(const id of replacements.keys())this.dropSource(id);
  }
  private async select(r:CaptureRect,remember=true){
    if(!r||![r.x,r.y,r.width,r.height].every(Number.isFinite))throw Error('无效的选区');
    const s=this.state,frame=this.screenFrame;if(s?.phase!=='selecting'||!frame)return;
    const rect=clip(r,{x:0,y:0,width:s.width,height:s.height});if(!rect)return;
    this.assertCaptureDisplay();const display=this.captureDisplay!,pixels=regionPixels(rect,this.bounds,frame),epoch=this.epoch;
    this.selectedAt=performance.now();
    const handoff=async()=>{
      if(this.state!==s||epoch!==this.epoch)return;
      const win=await this.prepareWindow();if(!this.claimWindow(win,s,epoch))return;
      if(s.captureKind==='rect'||s.captureKind==='area')s.backdropFrame??=this.keepFrame(frame);
      if(s.captureKind==='rect'||s.captureKind==='area')s.editableRegion={display,sourceSize:{width:frame.width,height:frame.height},initialCrop:{...pixels},currentCrop:{...pixels},ratio:this.customRequest?.ratio??null};
      this.edit(null,regionPoints(pixels,this.bounds,frame),frame,pixels);
    };
    this.handoff=handoff;await handoff();
    if(remember&&this.state===s)this.efficiency.rememberSuccessfulArea({display,rect,kind:s.captureKind==='rect'?'rect':'area'});
  }
  private nativeEvent(event:NativeCaptureEvent){
    if(this.recordingSelect){this.recordingSelect(event);return;}
    if(this.state?.id!==event.session)return;
    const s=this.state;
    if(event.type==='copy'){this.pendingCopy=true;if(s.phase==='result'&&this.presented){this.pendingCopy=false;s.copyIntent=(s.copyIntent??0)+1;this.publish();}return;}
    if(event.type==='last'){const area=this.efficiency.rememberedArea;if(area&&this.captureDisplay&&sameCaptureDisplay(area.display,this.captureDisplay))void this.select(area.rect).catch(error=>this.native.update({session:s.id,message:error.message}));else this.native.update({session:s.id,message:'上次区域不在当前显示器，请重新选择'});return;}
    if(event.type==='shown'){
      this.timing.nativeReady=performance.now()-this.startedAt;console.info('[capture-timing]',JSON.stringify(this.timing));
      // Native selection is already interactive. Prepare the editor in a later main-loop turn.
      setImmediate(()=>{if(this.state===s&&Object.values(this.preferences.actions).some(action=>action.show))void this.prepareWindow().catch(error=>console.warn('[memory] editor preparation',error.message));});
      void this.startDetection().catch(error=>console.warn('[capture-detection]',error));return;
    }
    if(event.type==='hover'){this.hover(event.x!,event.y!);return;}
    if(event.type==='mode'){s.mode=event.mode;if(event.mode!=='window')void this.startDetection().catch(error=>console.warn('[capture-detection]',error));return;}
    if(event.type==='cancel'){this.cancel();return;}
    const operation=async()=>{
      if(event.type==='retry'){this.refreshPixelReferences();if(this.handoff){this.win?.hide();this.presented=false;await this.handoff();}else this.native.update({session:s.id,resume:true});return;}
      if(event.type==='select'){if(this.scrollRequested)await this.startScroll(event.rect!);else{s.captureKind=event.kind;await this.select(event.rect!);}}
      else if(event.type==='screen'){s.captureKind='screen';await this.select({x:0,y:0,width:s.width,height:s.height},false);}
      else if(event.type==='window')await this.captureWindow(event.id!,event.shadow===true);
      else if(event.type==='scroll')await this.startScroll(event.rect!);
    };
    void operation().catch(error=>{if(this.state===s)this.native.update({session:s.id,message:(error as Error).message});});
  }
  /** Keep the entire control window outside the capture, so the selected region has no overlay to intercept input. */
  private scrollControlBounds(r:CaptureRect):CaptureRect {
    const b=this.bounds,h=144,w=Math.min(700,b.width),gap=8;
    const x=Math.round(Math.max(0,Math.min(b.width-w,r.x+(r.width-w)/2)));
    if(r.y>=h+gap)return {x:b.x+x,y:b.y+Math.round(r.y-h-gap),width:w,height:h};
    if(b.height-r.y-r.height>=h+gap)return {x:b.x+x,y:b.y+Math.ceil(r.y+r.height+gap),width:w,height:h};
    if(r.x>=w+gap)return {x:b.x+Math.floor(r.x-w-gap),y:b.y+Math.max(0,Math.min(b.height-h,Math.round(r.y))),width:w,height:h};
    if(b.width-r.x-r.width>=w+gap)return {x:b.x+Math.ceil(r.x+r.width+gap),y:b.y+Math.max(0,Math.min(b.height-h,Math.round(r.y))),width:w,height:h};
    throw Error('请缩小选区，在上方或下方留出 152 像素放置控制条；控制条不会进入截图。');
  }
  private async startScroll(r:CaptureRect){
    const s=this.state,frame=this.screenFrame;
    if(!s||!['selecting','result'].includes(s.phase)||!frame||this.scroll||this.scrollPreparing)throw Error('请先选择滚动区域');
    if(!r||![r.x,r.y,r.width,r.height].every(Number.isFinite))throw Error('无效的滚动选区');
    const rect=clip(r,{x:0,y:0,width:this.bounds.width,height:this.bounds.height});
    if(!rect||rect.width<64||rect.height<96)throw Error('滚动选区至少需要 64 × 96 点');
    const pixels=regionPixels(rect,this.bounds,frame);
    if(pixels.width*pixels.height>20_000_000)throw Error('选区超过 2000 万像素，请缩小选区');
    const controls=this.scrollControlBounds(rect),displayId=this.displayId!,epoch=this.epoch,binding=this.captureDisplay!;
    this.assertCaptureDisplay();this.scrollPreparing=true;
    let candidate:ScrollSession|null=null,committed=false;
    try{
      const win=await this.prepareWindow();if(!this.claimWindow(win,s,epoch))return;
      const unchanged=()=>screen.getAllDisplays().some(d=>sameCaptureDisplay(binding,bindDisplay(d)));
      const session=new ScrollSession(async()=>{
        if(!unchanged())throw Error('屏幕配置已变化');
        const f=await this.native.capture({displayId,bounds:{x:this.bounds.x+rect.x,y:this.bounds.y+rect.y,width:rect.width,height:rect.height},includeCursor:this.settings().includeCursor,exclude:excludedCaptureWindows(this.native)});
        try{
          if(epoch!==this.epoch||this.state!==s)throw Error('滚动截图会话已取消');
          if(!unchanged())throw Error('屏幕配置已变化');
          const data=await this.native.pixels(f.id,{format:'bgra'});
          if(data.width!==pixels.width||data.height!==pixels.height)throw Error('屏幕像素尺寸已变化');
          return {...data,data:new Uint8Array(data.data)};
        }finally{this.native.release(f.id);}
      },()=>{
        if(!committed||this.scroll!==session||this.state!==s||s.phase!=='scrolling')return;
        const m=session.metadata;s.scroll={status:session.status==='running'?'running':'paused',width:m.width||pixels.width,height:m.height,segments:m.segments,seams:m.seams,direction:m.direction,segmentSizes:m.segmentSizes,reversedTrimmed:m.reversedTrimmed,message:session.message};this.publish();
      },()=>{if(committed&&this.scroll===session)void this.finishScroll(session.message).catch(error=>this.scrollError(error));},this.preferences.scrollMaxHeight);
      candidate=session;await session.start();
      // start resolves after tick even when tick caught a capture/worker failure.
      if(session.metadata.segments<1||!session.metadata.width||!session.metadata.height||session.status==='paused')throw Error(session.message||'首帧采集失败');
      if(epoch!==this.epoch||this.state!==s||!unchanged())throw Error('截图会话或显示器已变化');
      await session.pause();
      if(epoch!==this.epoch||this.state!==s||!unchanged())throw Error('截图会话或显示器已变化');
      this.native.hide();win.hide();this.stopDetection();this.ocr.reset();this.image=null;this.imageTask=null;this.imageLoader=null;
      this.scroll=session;committed=true;this.scrollRequested=false;
      const m=session.metadata;
      Object.assign(s,{captureKind:'scroll',editableRegion:undefined,annotations:undefined,pixelScale:{x:frame.width/this.bounds.width,y:frame.height/this.bounds.height},phase:'scrolling',placement:undefined,candidates:[],windows:[],selection:null,scroll:{status:'paused',width:m.width,height:m.height,segments:m.segments,seams:m.seams,direction:m.direction,segmentSizes:m.segmentSizes,reversedTrimmed:m.reversedTrimmed,message:session.message}});
      setWindowPresence(win,false);win.setMinimumSize(0,0);win.setResizable(false);win.setMovable(false);win.setAlwaysOnTop(true,'screen-saver');win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});win.setFocusable(false);win.setBounds(controls);win.setBackgroundColor('#141413');this.publish();win.showInactive();
      for(const id of new Set([s.imageFrame,s.backdropFrame]))if(id)this.dropSource(id);s.imageFrame=undefined;s.backdropFrame=undefined;s.imageCrop=undefined;
      this.native.release(frame.id);this.ownedFrames.delete(frame.id);this.screenFrame=null;
      this.publish();
      if(session.metadata.status==='limit')void this.finishScroll('已达到尺寸上限，结果已保留').catch(error=>this.scrollError(error));else session.resume();
    }finally{if(!committed)candidate?.dispose();this.scrollPreparing=false;}
  }
  private scrollError(error:unknown){
    if(this.state?.scroll){this.state.scroll.message=(error as Error).message;this.state.scroll.status='paused';this.publish();}
  }
  private setScrollPreview(reply:ScrollReply,message:string){
    if(!reply.data||!reply.width||!reply.height)throw Error('尚无已匹配画面，可继续采集或取消');
    const image=nativeImage.createFromBitmap(Buffer.from(reply.data),{width:reply.width,height:reply.height,scaleFactor:1});
    if(image.isEmpty())throw Error('滚动图片合成失败，已匹配结果仍保留');
    this.image=image;
    const s=this.state!;
    if(s.imageFrame)this.dropSource(s.imageFrame);
    const imageFrame=this.keepFrame(this.importFrame(image));
    Object.assign(s,{phase:'review',imageFrame,backdropFrame:undefined,scroll:{status:'review',width:reply.width,height:reply.height,segments:reply.segments,seams:reply.seams,direction:reply.direction,segmentSizes:reply.segmentSizes,reversedTrimmed:reply.reversedTrimmed,message}});
    this.publish(true);
  }
  private async finishScroll(message='已结束采集。检查接缝后进入编辑；可撤回末段。'){
    const session=this.scroll,s=this.state;if(!session||s?.phase!=='scrolling'||this.scrollFinishing)return;
    this.scrollFinishing=true;
    try{
      const reply=await session.finish();if(this.scroll!==session||this.state!==s)return;
      this.setScrollPreview(reply,message);
      const win=this.win!;win.hide();win.setFocusable(true);win.setResizable(true);win.setMovable(true);win.setHasShadow(true);win.setMinimumSize(760,500);
      setWindowPresence(win,true);
      const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      win.setBounds(area);win.setBackgroundColor('#E9E6DD');win.setAlwaysOnTop(true,'floating');win.show();app.focus({steal:true});win.focus();
    }catch(error){if(this.scroll===session){session.status='paused';this.scrollError(error);}throw error;}
    finally{if(this.scroll===session)this.scrollFinishing=false;}
  }
  private async scrollAction(action:ScrollCaptureAction){
    const type=typeof action==='string'?action:action?.type;
    if(type==='cancel'){this.cancel(true);return;}
    const session=this.scroll,s=this.state;if(!session||!s?.scroll)throw Error('滚动截图已结束');
    if(this.scrollFinishing||this.scrollEditing)throw Error('正在处理滚动结果');
    if(type==='pause'&&s.phase==='scrolling'){await session.pause();return;}
    if(type==='resume'&&s.phase==='scrolling'){session.resume();return;}
    if(type==='finish'&&s.phase==='scrolling'){await this.finishScroll();return;}
    if(typeof action==='object'&&action.type==='direction'&&s.phase==='scrolling'){await session.setDirection(action.direction);return;}
    if((type==='undo'||typeof action==='object'&&(action?.type==='remove-segment'||action?.type==='adjust-seam'))&&s.phase==='review'){
      this.scrollFinishing=true;
      try{const reply=typeof action==='object'&&action.type==='remove-segment'?await session.removeSegment(action.index):typeof action==='object'&&action.type==='adjust-seam'?await session.adjustSeam(action.index,action.delta):await session.undo();if(this.scroll===session&&this.state===s)this.setScrollPreview(reply,'已更新拼接结果，请重新检查接缝。');}
      finally{if(this.scroll===session)this.scrollFinishing=false;}return;
    }
    if(type==='edit'&&s.phase==='review'&&this.image){
      this.scrollEditing=true;
      try{
        const size=this.image.getSize();session.dispose();this.scroll=null;this.editRevision=0;this.ocr.reset();
        Object.assign(s,{phase:'result',editId:randomUUID(),backdropFrame:undefined,placement:undefined,width:size.width,height:size.height,pixelWidth:size.width,pixelHeight:size.height,selection:{x:0,y:0,...size},scroll:undefined,presentation:'window',saveFormat:this.preferences.format});this.completeResult();
      }finally{this.scrollEditing=false;}return;
    }
    throw Error('当前状态不支持此滚动操作');
  }
  private async captureWindow(id:number,shadow:boolean){
    const s=this.state;if(s?.phase!=='selecting'||this.grabbing)return;
    const target=s.windows?.find(w=>w.id===id);if(!target)throw Error('窗口已关闭，请重新选择');
    this.grabbing=true;this.selectedAt=performance.now();const epoch=this.epoch;
    let retained:NativeFrame|null=null;
    const handoff=async()=>{
      const frame=retained??await this.native.capture({displayId:this.displayId!,bounds:this.bounds,windowId:id,shadow:shadow||this.preferences.shadow,includeCursor:this.settings().includeCursor,exclude:[]});
      if(epoch!==this.epoch||this.state!==s){if(!retained)this.native.release(frame.id);return;}
      retained=frame;this.ownedFrames.add(frame.id);this.timing.capture=frame.captureMs;this.timing.nativeQueue=frame.queueMs;this.timing.nativeCompletion=frame.completionMs;this.timing.nativeWork=frame.workMs;
      const win=await this.prepareWindow();if(!this.claimWindow(win,s,epoch))return;
      s.captureKind=s.captureKind==='front'?'front':'window';
      const placement={...frame.bounds,x:frame.bounds.x-this.bounds.x,y:frame.bounds.y-this.bounds.y};
      if(this.preferences.background==='solid'){
        const data=await this.native.pixels(frame.id,{format:'bgra'});if(epoch!==this.epoch||this.state!==s)return;
        const image=nativeImage.createFromBitmap(Buffer.from(data.data.buffer,data.data.byteOffset,data.data.byteLength),{width:data.width,height:data.height});
        this.edit(flattenBackground(image,this.preferences.backgroundColor),placement);
      }else this.edit(null,placement,frame);
    };
    this.handoff=handoff;try{await handoff();}finally{if(epoch===this.epoch)this.grabbing=false;}
  }
  /** Record source geometry before choosing how to present the result. */
  private edit(image:NativeImage|null,placement:CaptureRect,source?:NativeFrame,sourceRect?:CaptureRect){
    const s=this.state!;this.image=image;this.imageTask=null;
    const epoch=this.epoch;
    this.imageLoader=source?async()=>{
      const pixels=await this.native.pixels(source.id,{format:'bgra',rect:sourceRect});
      if(epoch!==this.epoch)throw Error('截图会话已结束');
      return nativeImage.createFromBitmap(Buffer.from(pixels.data.buffer,pixels.data.byteOffset,pixels.data.byteLength),{width:pixels.width,height:pixels.height});
    }:null;
    const size=image?image.getSize():{width:sourceRect?.width??source!.width,height:sourceRect?.height??source!.height};this.stopDetection();this.ocr.reset();this.editRevision=0;
    const inline=s.captureKind==='rect'||s.captureKind==='area';
    Object.assign(s,{editId:randomUUID(),imageFrame:inline&&s.backdropFrame?s.backdropFrame:this.keepFrame(source??this.importFrame(image!),sourceRect),imageCrop:inline?sourceRect:undefined,width:size.width,height:size.height,pixelWidth:size.width,pixelHeight:size.height,pixelScale:{x:size.width/placement.width,y:size.height/placement.height},saveFormat:this.preferences.format,candidates:[],windows:[],selection:{x:0,y:0,...size},placement:inline?placement:undefined,backdropFrame:inline?s.backdropFrame:undefined,presentation:inline?'inline':'window',phase:'result'});
    this.completeResult();
  }
  private configureOverlay(){
    const win=this.win!;win.hide();setWindowPresence(win,false);this.presented=false;
    win.setResizable(false);win.setMovable(false);win.setMinimumSize(0,0);win.setFocusable(true);win.setHasShadow(false);win.setBackgroundColor('#242320');
    win.setAlwaysOnTop(true,'screen-saver');win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});win.setBounds(this.bounds);
  }
  private configureResult(){
    const win=this.win!,s=this.state!;win.hide();this.presented=false;
    if(s.presentation==='inline'){this.configureOverlay();return;}
    setWindowPresence(win,true);
    const display=screen.getAllDisplays().find(d=>d.id===this.displayId)??screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),area=display.workArea;
    const width=Math.min(area.width,Math.max(760,Math.min(1100,s.width/(s.pixelScale?.x||1)+120))),height=Math.min(area.height,Math.max(500,Math.min(850,s.height/(s.pixelScale?.y||1)+200)));
    win.setAlwaysOnTop(true,'floating');win.setVisibleOnAllWorkspaces(false);win.setFocusable(true);win.setHasShadow(true);win.setResizable(true);win.setMovable(true);win.setMinimumSize(Math.min(760,area.width),Math.min(500,area.height));win.setBackgroundColor('#E9E6DD');win.setTitle('Lasso 图片编辑');
    win.setBounds({x:Math.round(area.x+(area.width-width)/2),y:Math.round(area.y+(area.height-height)/2),width:Math.round(width),height:Math.round(height)});
  }
  private completeResult(){
    const s=this.state;if(!s||!s.captureKind||this.completedEdit===s.editId)return;
    this.completedEdit=s.editId;
    const preferences=structuredClone(this.preferences),actions={...preferences.actions[s.captureKind]},pixelScale=s.pixelScale?{...s.pixelScale}:undefined,editId=s.editId;
    const shouldOutput=!this.automaticCompleted&&(actions.copy||actions.save);
    if(shouldOutput)this.automaticCompleted=true;
    // Start reading the bound source now; later selection/scroll transitions may replace the loader.
    const original=shouldOutput||preferences.history.enabled?this.originalImage():null;
    original?.catch(()=>{});
    if(preferences.history.enabled){
      const meta={id:s.id,captureKind:s.captureKind,region:s.editableRegion?{...s.editableRegion.currentCrop}:s.selection?{...s.selection}:undefined,displayId:this.displayId??undefined};
      void original!.then(image=>this.history.add({...imageDocument(image),pixelScale},meta)).catch(error=>this.notice('截图历史保存失败：'+(error as Error).message));
    }
    const execute=()=>{if(!original||!shouldOutput)return;void original.then(image=>this.automaticResult(s,image,preferences,actions,pixelScale,editId)).catch(error=>{if(this.state===s&&s.editId===editId){s.outputError=(error as Error).message;this.publish();}else this.notice((error as Error).message);});};
    if(actions.show){this.configureResult();this.automaticReady=execute;this.publish(true);}
    else{this.win?.hide();this.presented=false;execute();}
  }
  private async originalImage(){
    if(this.image)return this.image;
    if(!this.imageLoader)throw Error('原始截图已释放');
    const epoch=this.epoch,loader=this.imageLoader;this.imageTask??=loader();const image=await this.imageTask;
    if(epoch!==this.epoch)throw Error('截图会话已结束');if(this.imageLoader===loader)this.image=image;return image;
  }
  private async automaticResult(s:ScreenshotState,image:NativeImage,preferences:ScreenshotSettings,actions:{show:boolean;copy:boolean;save:boolean},pixelScale:{x:number;y:number}|undefined,editId:string){
    if(this.state!==s)return;
    const success:string[]=[],errors:string[]=[],mode=preferences.exportContentMode;
    const output=this.contentImage(image,mode,pixelScale),encoding={...preferences,resizeTo1x:mode==='display'?false:preferences.resizeTo1x};
    let saved:string|undefined;
    const save=async()=>saved??=await saveAutomaticScreenshot(encodeScreenshot(output,encoding,preferences.format,pixelScale),preferences.directory,preferences.format,preferences.fileNameTemplate,{app:this.sourceApp,...output.getSize()});
    if(actions.save){try{const path=await save();success.push('已保存到 '+path);}catch(error){errors.push('保存失败：'+(error as Error).message);}}
    if(actions.copy){try{if(preferences.copyMode==='image')await copyImage(decorateScreenshot(output,preferences));else{const path=await save();if(preferences.copyMode==='file')await copyFile(path);else await copyPath(path);}success.push('已复制');}catch(error){errors.push('复制失败：'+(error as Error).message);}}
    if(actions.save&&saved){try{await runAfterSaveAction(saved,preferences.afterSaveAction);}catch(error){errors.push('保存后操作失败：'+(error as Error).message);}}
    if(this.state!==s||s.editId!==editId||s.phase!=='result'){if(errors.length)this.notice([...success,...errors].join('；'));return;}
    s.outputStatus=success.join('；');s.outputError=errors.join('；');
    if(errors.length){if(!actions.show){s.presentation='window';s.editableRegion=undefined;s.placement=undefined;s.backdropFrame=undefined;s.imageCrop=undefined;s.imageFrame=this.keepFrame(this.importFrame(image));this.configureResult();}this.publish(true);}
    else if(!actions.show){this.notice(success.join('；'));this.cancel();}
    else this.publish();
  }
  async openImage(image:NativeImage,origin:'clipboard'|'pin'='clipboard',document?:PinnedDocument,pinId?:string,inputId?:string,context?:{file:LocalImageSource}){
    if(this.disposed)throw Error('截图功能已关闭');
    const key=pinId?'pin:'+pinId:inputId?'image:'+inputId:context?'file:'+context.file.dev+':'+context.file.ino:null;
    if(this.active){this.focus();if(key&&key===this.editorKey)return;throw Error('请先完成或关闭当前图片编辑');}
    const size=image.getSize();if(image.isEmpty()||size.width*size.height>40_000_000)throw Error('图片为空或尺寸过大');
    this.busy=true;const epoch=++this.epoch;
    try{
      this.preferences=structuredClone(this.settings());this.sourceApp='';this.startedAt=performance.now();this.selectedAt=0;this.timing={};this.restoreWindow=this.before();this.editorKey=key;this.localSource=context?.file??null;this.image=image;
      const display=screen.getDisplayNearestPoint(screen.getCursorScreenPoint());this.bounds=display.bounds;this.displayId=display.id;
      this.editRevision=0;this.state={presentation:'window',pixelScale:document?.pixelScale,saveFormat:this.preferences.format,id:randomUUID(),editId:randomUUID(),imageFrame:this.keepFrame(this.importFrame(image)),width:size.width,height:size.height,pixelWidth:size.width,pixelHeight:size.height,candidates:[],phase:'result',selection:{x:0,y:0,...size},status:'',origin,pinId,annotations:document?.annotations};
      const state=this.state,win=await this.prepareWindow();if(!this.claimWindow(win,state,epoch))return;
      this.configureResult();this.publish(true);
    }catch(error){if(epoch===this.epoch)this.cancel();throw error;}finally{this.busy=false;}
  }
  private updateCandidates(){if(!this.state)return;this.state.candidates=rank([...this.fixed,...this.elements,...this.edges,...this.colors],this.hoverPoint.x,this.hoverPoint.y);if(this.state.phase==='selecting')this.native.update({session:this.state.id,candidates:this.state.candidates});}
  private hover(x:number,y:number){
    if(!this.state||this.state.phase!=='selecting'||this.state.mode==='rect')return;
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
  private assertVersion(id:string,revision:number){
    if(!this.state?.selection||this.state.phase!=='result'||id!==this.state.editId)throw Error('截图编辑会话已结束');
    if(!Number.isSafeInteger(revision)||revision<0||revision<this.editRevision)throw Error('图片已变化，请重试');
  }
  private assertResult(){if(this.state?.phase!=='result'||!this.state.selection)throw Error('截图编辑会话已结束');}
  private intelligenceService(){if(!this.intelligence)throw Error('智能识别尚未接入');return this.intelligence();}
  private acceptVersion(id:string,revision:number){this.assertVersion(id,revision);this.editRevision=revision;}
  private assertCrop(frame:CaptureFrame){
    this.assertVersion(frame?.id,frame?.revision);
    const r=frame.crop,s=this.state!,base=s.editableRegion?.sourceSize??pixelRect(s.selection!,s.width,s.height,s.pixelWidth,s.pixelHeight);
    if(!r||![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<(s.editableRegion?2:1)||r.height<(s.editableRegion?2:1)||r.x+r.width>base.width||r.y+r.height>base.height)throw Error('无效的裁剪范围');
    return r;
  }
  private frameImage(frame:CaptureFrame){
    this.assertCrop(frame);
    const image=decodeFrameImage(frame);
    this.acceptVersion(frame.id,frame.revision);
    return image;
  }
  private recognize(frame:OCRRequest):Promise<OCRResult>{
    if(!frame||!['text','code'].includes(frame.mode)||typeof frame.enhance!=='boolean'||(frame.force!==undefined&&typeof frame.force!=='boolean')||!(frame.png instanceof Uint8Array))throw Error('无效的识别选项');
    this.frameImage(frame);
    return this.ocr.recognize({id:frame.id,revision:frame.revision,png:Buffer.from(frame.png),mode:frame.mode,enhance:frame.enhance,force:frame.force,languages:this.settings().languages}).then(result=>{if(this.state?.editId===result.id&&this.editRevision===result.revision)this.historyOCR={id:result.id,revision:result.revision,text:result.lines.map(line=>line.text).join('\n')};return result;});
  }
  /** Display export uses screen logical dimensions; result keeps the composed pixels. */
  private contentImage(image:NativeImage,mode:ScreenshotExportContentMode,scale?:{x:number;y:number}){
    if(mode!=='display'||!scale)return image;
    const size=image.getSize();
    return image.resize({width:Math.max(1,Math.round(size.width/scale.x)),height:Math.max(1,Math.round(size.height/scale.y)),quality:'best'});
  }
  private async frameDocument(frame:CaptureFrame,image:NativeImage):Promise<PinnedDocument>{
    const s=this.state!,context=s.editableRegion;
    if(context&&this.screenFrame){
      const snapshot=validateAnnotations(frame.annotations,{getSize:()=>context.sourceSize},frame.crop);
      const data=await this.native.pixels(this.screenFrame.id,{format:'bgra',rect:frame.crop});
      const annotations=normalizeRegionAnnotations(snapshot,frame.crop);
      if(snapshot.cropPolygons)annotations.cropPolygons=snapshot.cropPolygons.map(polygon=>polygon.map(point=>({x:point.x-frame.crop.x,y:point.y-frame.crop.y})));
      return {source:nativeImage.createFromBitmap(Buffer.from(data.data),{width:data.width,height:data.height}),image,annotations,pixelScale:{x:context.sourceSize.width/context.display.bounds.width,y:context.sourceSize.height/context.display.bounds.height}};
    }
    const source=await this.originalImage();
    return {source,image,annotations:validateAnnotations(frame.annotations,source,frame.crop),pixelScale:s.pixelScale};
  }
  private async exportFrame(frame:CaptureFrame,action:ExportAction,format:ScreenshotOutputFormat,contentMode?:ScreenshotExportContentMode){
    if(this.exporting)throw Error('正在输出图片');
    const preferences=this.preferences,requestedMode=contentMode??preferences.exportContentMode,mode=action==='pin'?'result':requestedMode;
    if(!['copy','save','quick-save','copy-file','copy-path','image','pin','media'].includes(action)||!screenshotOutputFormats.includes(format)||!['original','result','display'].includes(requestedMode))throw Error('不支持的输出操作');
    if(action==='copy'&&preferences.copyMode==='image'&&mode==='result'&&frame.png instanceof Uint8Array&&!frame.annotations&&!frame.outputSize&&!preferences.cornerRadius&&!preferences.borderWidth){const r=this.assertCrop(frame),png=assertPng(frame.png,r.width,r.height);this.acceptVersion(frame.id,frame.revision);this.exporting=true;try{await copyPng(png);if(this.state?.editId===frame.id)this.cancel();}finally{this.exporting=false;}return;}
    const crop=this.assertCrop(frame),id=frame.id;this.acceptVersion(id,frame.revision);this.exporting=true;
    let pinnedId:string|undefined;
    try{
      const result=action==='pin'||frame.annotations?await this.frameDocument(frame,decodeFrameImage(frame)):undefined;
      this.acceptVersion(id,frame.revision);
      let image:NativeImage;
      if(mode==='original'){
        if(this.state?.editableRegion&&this.screenFrame){const data=await this.native.pixels(this.screenFrame.id,{format:'bgra',rect:crop});image=nativeImage.createFromBitmap(Buffer.from(data.data),{width:data.width,height:data.height});}
        else image=(await this.originalImage()).crop(crop);
      }else image=this.contentImage(result?.image??decodeFrameImage(frame),mode,this.state?.pixelScale);
      const encoding={...preferences,resizeTo1x:mode==='display'?false:preferences.resizeTo1x};
      const copy=action==='copy'?preferences.copyMode:action==='copy-file'?'file':action==='copy-path'?'path':null;
      if(copy==='image')await copyImage(decorateScreenshot(image,preferences));
      else if(copy||action==='quick-save'){
        const path=await saveAutomaticScreenshot(encodeScreenshot(image,encoding,format,this.state?.pixelScale),preferences.quickSaveDirectory,format,preferences.fileNameTemplate,{app:this.sourceApp,...image.getSize()});
        if(copy==='file')await copyFile(path);else if(copy==='path')await copyPath(path);else await runAfterSaveAction(path,preferences.afterSaveAction);
      }
      else if(action==='image')await this.receive(image);
      else if(action==='media'){if(!this.receiveMedia)throw Error('图片生成尚未接入');await this.receiveMedia(image);}
      else if(action==='pin'){
        if(this.state?.pinId&&!this.pins.contains(this.state.pinId)){
          this.state.pinId=undefined;this.editorKey=null;this.publish();
          throw Error('原贴图已关闭，当前编辑已保留；点击「贴图」可重新创建。');
        }
        this.acceptVersion(id,frame.revision);
        pinnedId=await this.pins.put(result!,this.state?.pinId);
      }
      else{
        const source=this.localSource,name=formatScreenshotName(preferences.fileNameTemplate,format,{app:this.sourceApp,...image.getSize()});
        const defaultPath=source?defaultLocalImageCopyPath(source,format==='jpeg'?'jpeg':'png').replace(/\.[^.]+$/,'.'+name.ext):join(preferences.directory,name.subDir,name.fileName);
        const {filePath,canceled}=await dialog.showSaveDialog(this.win!,{title:source?'另存图片副本':'保存图片',defaultPath,filters:[{name:format.toUpperCase()+' 图片',extensions:[name.ext]}]});
        if(canceled||!filePath)return;
        this.acceptVersion(id,frame.revision);
        const bytes=encodeScreenshot(image,encoding,format,this.state?.pixelScale);
        if(source)await saveLocalImageCopy(source,filePath,bytes);else{await mkdir(dirname(filePath),{recursive:true});await writeFile(filePath,bytes);}
        await runAfterSaveAction(filePath,preferences.afterSaveAction);
      }
      if(result&&this.state?.editId===id){
        const s=this.state,ocr=this.historyOCR;
        try{await this.history.add(result,{id:this.historyId??s.id,captureKind:s.captureKind??'image',region:s.editableRegion?.currentCrop,displayId:this.displayId??undefined,ocrSnippet:ocr?.id===id&&ocr.revision===frame.revision?ocr.text:''});}
        catch(error){this.notice('截图历史保存失败：'+(error as Error).message);}
      }
      if(this.state?.editId===id)this.cancel();
      if(pinnedId)this.pins.focus(pinnedId);
    }finally{this.exporting=false;}
  }
  private async action(a:string){
    if(a==='retry'){this.refreshPixelReferences();if(this.handoff){this.win?.hide();this.presented=false;await this.handoff();}else if(this.state){this.state.editId=randomUUID();this.publish();}return;}
    if(a==='cancel'){this.cancel(this.state?.origin==='clipboard');return;}
    if(!this.state)throw Error('截图已结束');
    if(a==='screen'){if(this.state.phase==='selecting'){this.state.captureKind='screen';await this.select({x:0,y:0,width:this.state.width,height:this.state.height},false);}return;}
    if(a==='reselect'){const mode=this.state?.mode==='rect'?'rect':'area';this.cancel();try{await this.start(mode);}catch(error){dialog.showErrorBox('重新截图未能启动',(error as Error).message);}return;}
    throw Error('不支持的截图操作');
  }
  private dropSource(id:string){const source=this.pixelSources.get(id);this.pixelSources.delete(id);if(source&&!Array.from(this.pixelSources.values()).some(value=>value.frame.id===source.frame.id)&&this.screenFrame?.id!==source.frame.id){this.native.release(source.frame.id);this.ownedFrames.delete(source.frame.id);}}
  private release(restore=false){this.historyId=undefined;this.historyOCR=undefined;this.scrollRequested=false;this.sourceApp='';this.pendingCopy=false;this.customRequest=undefined;const restoreWindow=restore&&this.restoreWindow;this.restoreWindow=false;this.checkpointReply?.(null);this.checkpointReply=null;if(this.suspended){void rm(this.suspended.directory,{recursive:true,force:true});this.suspended=null;}this.native.hide();this.handoff=null;this.grabbing=false;this.imageTask=null;this.imageLoader=null;for(const id of this.ownedFrames)this.native.release(id);this.ownedFrames.clear();this.pixelSources.clear();this.screenFrame=null;this.detectionStarting=false;this.automaticReady=null;this.completedEdit=null;this.scroll?.dispose();this.scroll=null;this.scrollFinishing=false;this.scrollEditing=false;this.epoch++;this.stopDetection();this.ocr.reset();this.state=null;this.image=null;this.editorKey=null;this.localSource=null;this.captureDisplay=null;this.displayId=null;this.win=null;this.presented=false;if(this.cachedWindow&&!this.cachedWindow.isDestroyed()){setWindowPresence(this.cachedWindow,false);this.cachedWindow.hide();this.cachedWindow.webContents.send('screenshot:changed',null);}this.updateIdle();this.after(restoreWindow);}
  cancel(restore=false){this.release(restore);}
  dispose(){this.releaseRecording();this.disposed=true;this.idle.dispose();app.off('did-resign-active',this.appVisibility);app.off('did-become-active',this.appVisibility);this.efficiency.dispose();this.cancel();this.cachedWindow?.destroy();this.pins.dispose();screen.removeListener('display-added',this.displayAdded);screen.removeListener('display-removed',this.displayRemoved);screen.removeListener('display-metrics-changed',this.displayMetrics);for(const name of ['screenshot:region','screenshot:last-region','screenshot:clear-region','screenshot:start-scroll','screenshot:regions','screenshot:save-region-preset','screenshot:checkpoint','screenshot:save-annotation-memory','screenshot:pixels','screenshot:state','screenshot:action','screenshot:recognize','screenshot:analyze','screenshot:vision-language','screenshot:preview-formula','screenshot:open-url','screenshot:export-table','screenshot:pin-formula','screenshot:export','screenshot:copy-text','screenshot:send-text','screenshot:scroll-action'])ipcMain.removeHandler(name);for(const name of ['screenshot:load-error','screenshot:invalidate-ocr','screenshot:ready'])ipcMain.removeAllListeners(name);}
}
