import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent, type NativeImage, type Rectangle } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pinOpacities, type CaptureFrame, type ExportAction, type OCRRequest, type PinAction, type PinState } from '../../shared/capture';
import { screenshotOutputFormats, type AnnotationStyleMemory, type ScreenshotSettings, type ScreenshotOutputFormat, type ScreenshotExportContentMode } from '../../shared/screenshot-settings';
import type { EditorShortcutMap } from '../../shared/shortcuts';
import { validateAnnotations, type PinnedDocument } from './document';
import { OCRService, type VisionOCR } from './ocr';
import { assertPng, copyFile, copyImage, copyPath, copyPng, decodeFrameImage, encodeScreenshot, formatScreenshotName, runAfterSaveAction, saveAutomaticScreenshot } from './output';
import { fitToWorkArea } from '../position';

type Pin = {win:BrowserWindow;state:PinState;document:PinnedDocument;ocr:OCRService;bytes:number;restBounds?:Rectangle;drag?:{cursor:{x:number;y:number};bounds:Rectangle};editorRevision:number};
type PinOptions = {
  image:(image:NativeImage)=>Promise<void>;
  media:(image:NativeImage)=>Promise<void>;
  text:(text:string)=>Promise<void>;
  suppress:()=>void;
  changed:()=>void;
  languages:()=>string[];
  preferences:()=>ScreenshotSettings;
  editorShortcuts:()=>EditorShortcutMap|undefined;
  saveAnnotationMemory:(memory:AnnotationStyleMemory)=>void;
  canEdit:()=>boolean;
};

/** Logical window size for a pin. Keeping size uses the on-screen capture; otherwise it fits a smaller desk. */
export function pinWindowSize(pixels:{width:number;height:number},pixelScale:{x:number;y:number}|undefined,area:{width:number;height:number},keepsSize:boolean){
  const sx=pixelScale&&pixelScale.x>0?pixelScale.x:1,sy=pixelScale&&pixelScale.y>0?pixelScale.y:1;
  let width=Math.max(1,Math.round(pixels.width/sx)),height=Math.max(1,Math.round(pixels.height/sy));
  if(!keepsSize){
    const scale=Math.min(1,Math.min(600,Math.max(1,area.width-40))/width,Math.min(500,Math.max(1,area.height-100))/height);
    width=Math.max(1,Math.round(width*scale));height=Math.max(1,Math.round(height*scale));
  }
  const limit=Math.min(1,Math.max(1,area.width-16)/width,Math.max(1,area.height-16)/height);
  width=Math.max(1,Math.round(width*limit));height=Math.max(1,Math.round(height*limit));
  if(!keepsSize){
    width=Math.min(area.width,Math.max(Math.min(220,area.width),width));
    height=Math.min(area.height,Math.max(Math.min(100,area.height),height));
  }
  return {width,height};
}

export class PinManager {
  private pins=new Map<string,Pin>();
  private vision:VisionOCR|null=null;
  private serial=0;
  constructor(private options:PinOptions){
    ipcMain.handle('pin:state',e=>this.owner(e).state);
    ipcMain.handle('pin:action',async(e,action:PinAction)=>{const pin=this.owner(e);try{await this.action(pin,action);return {error:null};}catch(error){return {error:(error as Error).message};}});
    ipcMain.handle('pin:text',async(e,text:string,send:boolean,revision:number)=>{const pin=this.owner(e);try{
      if(revision!==pin.state.revision)throw Error('贴图已更新，请重新选字');
      if(typeof send!=='boolean'||typeof text!=='string'||!text.trim()||text.length>100000||!pin.state.lines.length)throw Error('请先选择图中文字');
      this.options.suppress();if(send)await this.options.text(text);else await clipboard.writeText(text);return {error:null};
    }catch(error){return {error:(error as Error).message};}});
    ipcMain.handle('pin:source',e=>{
      const pin=this.owner(e);
      if(!pin.state.editing||!pin.state.editId)throw Error('贴图未在编辑');
      const size=pin.document.source.getSize(),data=pin.document.source.toBitmap();
      if(data.byteLength!==size.width*size.height*4)throw Error('图片像素不完整');
      return {editId:pin.state.editId,width:size.width,height:size.height,bgra:data,annotations:pin.document.annotations,pixelScale:pin.document.pixelScale,saveFormat:this.options.preferences().format,annotationMemory:this.options.preferences().annotationMemory,editorShortcuts:this.options.editorShortcuts()};
    });
    ipcMain.handle('pin:editor-export',async(e,frame:CaptureFrame,action:ExportAction,format:ScreenshotOutputFormat,contentMode?:ScreenshotExportContentMode)=>{const pin=this.owner(e);try{await this.exportEdit(pin,frame,action,format,contentMode);return {error:null};}catch(error){return {error:(error as Error).message};}});
    ipcMain.handle('pin:editor-recognize',(e,frame:OCRRequest)=>{
      const pin=this.owner(e);this.assertEditor(pin,frame?.id,frame?.revision);
      if(!frame||!['text','code'].includes(frame.mode)||typeof frame.enhance!=='boolean'||(frame.force!==undefined&&typeof frame.force!=='boolean')||!(frame.png instanceof Uint8Array))throw Error('无效的识别选项');
      const size=pin.document.source.getSize(),crop=frame.crop;
      if(!crop||crop.x<0||crop.y<0||crop.width<1||crop.height<1||crop.x+crop.width>size.width||crop.y+crop.height>size.height)throw Error('无效的裁剪范围');
      decodeFrameImage(frame);pin.editorRevision=frame.revision;
      return pin.ocr.recognize({id:frame.id,revision:frame.revision,png:Buffer.from(frame.png),mode:frame.mode,enhance:frame.enhance,force:frame.force,languages:this.options.languages()});
    });
    ipcMain.handle('pin:editor-copy-text',async(e,request:{id:string;revision:number;text:string})=>{const pin=this.owner(e);this.assertEditor(pin,request?.id,request?.revision);if(typeof request.text!=='string'||!request.text.trim()||request.text.length>100000)throw Error('没有可复制的文字');pin.editorRevision=request.revision;this.options.suppress();await clipboard.writeText(request.text);});
    ipcMain.handle('pin:editor-send',async(e,request:{id:string;revision:number;text:string})=>{const pin=this.owner(e);try{this.assertEditor(pin,request?.id,request?.revision);if(typeof request.text!=='string'||!request.text.trim()||request.text.length>100000)throw Error('请先选择图中文字');pin.editorRevision=request.revision;this.options.suppress();await this.options.text(request.text);this.showPin(pin);return {error:null};}catch(error){return {error:(error as Error).message};}});
    ipcMain.handle('pin:editor-action',async(e,action:string)=>{const pin=this.owner(e);try{
      if(!pin.state.editing)throw Error('贴图未在编辑');
      if(action==='cancel')this.showPin(pin);
      else if(action==='retry'){pin.editorRevision=0;pin.ocr.reset();pin.state.editId=randomUUID();this.publish(pin);}
      else throw Error('不支持的贴图编辑操作');
      return {error:null};
    }catch(error){return {error:(error as Error).message};}});
    ipcMain.on('pin:editor-invalidate',this.invalidate);
    ipcMain.on('pin:drag-start',this.startDrag);
    ipcMain.on('pin:drag-move',this.moveDrag);
    ipcMain.on('pin:drag-end',this.endDrag);
    screen.on('display-removed',this.fit);
    screen.on('display-metrics-changed',this.fit);
  }
  saveAnnotationMemory(event:IpcMainInvokeEvent,memory:AnnotationStyleMemory){const pin=this.owner(event);if(!pin.state.editing)throw Error('贴图未在编辑');this.options.saveAnnotationMemory(memory);}
  get size(){return this.pins.size;}
  contains(id:string){return this.pins.has(id);}
  focus(id:string){const pin=this.pins.get(id);if(!pin||pin.win.isDestroyed())return;pin.win.show();app.focus({steal:true});pin.win.focus();pin.win.webContents.focus();}
  closeFocused(){const focused=BrowserWindow.getFocusedWindow(),pin=[...this.pins.values()].find(item=>!item.win.isDestroyed()&&(item.win===focused||item.win.isFocused()));if(!pin)return false;pin.win.close();return true;}
  private keepsSize(){return this.options.preferences().pinKeepsSize;}
  private pinFrom(event:IpcMainEvent|IpcMainInvokeEvent){return [...this.pins.values()].find(pin=>event.sender===pin.win.webContents&&event.senderFrame===pin.win.webContents.mainFrame);}
  private owner(event:IpcMainInvokeEvent){const pin=this.pinFrom(event);if(!pin)throw Error('贴图操作只允许对应贴图窗口调用');return pin;}
  private startDrag=(event:IpcMainEvent)=>{const pin=this.pinFrom(event);if(!pin||pin.state.editing||pin.win.isDestroyed())return;app.focus({steal:true});pin.win.focus();pin.drag={cursor:screen.getCursorScreenPoint(),bounds:pin.win.getBounds()};};
  private moveDrag=(event:IpcMainEvent)=>{const pin=this.pinFrom(event);if(!pin?.drag||pin.state.editing||pin.win.isDestroyed())return;const cursor=screen.getCursorScreenPoint();pin.win.setPosition(pin.drag.bounds.x+cursor.x-pin.drag.cursor.x,pin.drag.bounds.y+cursor.y-pin.drag.cursor.y,false);};
  private endDrag=(event:IpcMainEvent)=>{const pin=this.pinFrom(event);if(pin)pin.drag=undefined;};
  private invalidate=( (event:IpcMainEvent,request:{id:string;revision:number})=>{
    const pin=this.pinFrom(event);
    if(!pin?.state.editing||request?.id!==pin.state.editId||!Number.isSafeInteger(request.revision)||request.revision<pin.editorRevision)return;
    pin.editorRevision=request.revision;pin.ocr.invalidate(request.id,request.revision);
  });
  private assertEditor(pin:Pin,id:string,revision:number){
    if(!pin.state.editing||id!==pin.state.editId)throw Error('贴图编辑已结束');
    if(!Number.isSafeInteger(revision)||revision<0||revision<pin.editorRevision)throw Error('图片已变化，请重试');
  }
  private fit=()=>{for(const pin of this.pins.values()){if(pin.state.editing)continue;const area=screen.getDisplayMatching(pin.win.getBounds()).workArea;pin.win.setBounds(fitToWorkArea(pin.win.getBounds(),area));}};
  private publish(pin:Pin){if(!pin.win.isDestroyed())pin.win.webContents.send('pin:changed',pin.state);}
  private weight(doc:PinnedDocument){const a=doc.source.getSize(),b=doc.image.getSize();return (a.width*a.height+b.width*b.height)*4+JSON.stringify(doc.annotations).length*2;}
  async put(document:PinnedDocument,id?:string){
    const existing=id?this.pins.get(id):undefined;
    if(id&&!existing)throw Error('原贴图已关闭，请重新贴图');
    const bytes=this.weight(document),used=[...this.pins.values()].reduce((n,p)=>n+p.bytes,0)-(existing?.bytes||0);
    if((!existing&&this.pins.size>=16)||used+bytes>256*1024*1024)throw Error('贴图占用较多，请先关闭部分贴图后重试。');
    if(existing){existing.document=document;existing.bytes=bytes;existing.state.revision++;existing.state.image=document.image.toDataURL();existing.state.editing=false;existing.state.editId=undefined;Object.assign(existing.state,document.image.getSize(),{lines:[],status:'正在识别文字…'});this.publish(existing);this.resize(existing,1);this.focus(existing.state.id);this.recognize(existing);return existing.state.id;}
    const pinId=randomUUID(),size=document.image.getSize(),area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const keeps=this.keepsSize(),placed=pinWindowSize(size,document.pixelScale,area,keeps);
    const bounds=fitToWorkArea({x:Math.round(area.x+(area.width-placed.width)/2+(this.serial%5)*18),y:Math.round(area.y+(area.height-placed.height)/2+(this.serial%5)*18),width:placed.width,height:placed.height},area);
    this.serial++;
    const win=new BrowserWindow({...bounds,minWidth:keeps?1:Math.min(220,area.width),minHeight:keeps?1:Math.min(100,area.height),resizable:!keeps,frame:false,show:false,backgroundColor:'#FFFFFF',title:`Lasso 贴图 ${this.serial}`,fullscreenable:false,webPreferences:{preload:join(__dirname,'pin-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    win.setAlwaysOnTop(true,'floating');win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
    win.on('focus',()=>app.focus({steal:true}));
    win.on('page-title-updated',event=>event.preventDefault());
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
    win.webContents.on('before-input-event',(event,input)=>{
      if(input.type==='keyDown'&&input.meta&&!input.control&&!input.alt&&!input.shift&&input.key.toLowerCase()==='w'){event.preventDefault();win.close();}
    });
    const pin:Pin={win,document,bytes,state:{id:pinId,revision:0,image:document.image.toDataURL(),...size,lines:[],status:'正在识别文字…',topmost:true,opacity:1,passthrough:false,editing:false},ocr:undefined!,editorRevision:0};
    pin.ocr=new OCRService(()=>this.vision??=require(join(__dirname,'native/capture-vision.node')),(ocrId,revision)=>pin.state.editing?pin.state.editId===ocrId&&pin.editorRevision===revision:this.pins.get(ocrId)===pin&&pin.state.revision===revision);
    this.pins.set(pinId,pin);
    win.on('closed',()=>{pin.ocr.reset();this.pins.delete(pinId);this.options.changed();});
    try{await win.loadFile(join(__dirname,'renderer/index.html'),{query:{surface:'pin'}});if(!win.isDestroyed()){this.focus(pinId);this.recognize(pin);this.options.changed();}return pinId;}
    catch(error){if(!win.isDestroyed())win.destroy();throw error;}
  }
  private recognize(pin:Pin){
    pin.ocr.reset();const {id,revision}=pin.state;
    void pin.ocr.recognize({id,revision,png:pin.document.image.toPNG(),mode:'text',enhance:false,languages:this.options.languages()}).then(result=>{
      if(this.pins.get(id)!==pin||pin.state.revision!==revision||pin.state.editing)return;
      const crop=pin.document.annotations.crop;
      const masks=pin.document.annotations.privacy.map(r=>({...r,x:r.x-crop.x,y:r.y-crop.y}));
      pin.state.lines=result.lines.filter(l=>!masks.some(r=>l.x<r.x+r.width&&l.x+l.width>r.x&&l.y<r.y+r.height&&l.y+l.height>r.y));
      pin.state.status=pin.state.lines.length?'拖动贴图 · 点选字图标选择文字':'未识别到文字';this.publish(pin);
    }).catch(()=>{if(this.pins.get(id)===pin&&pin.state.revision===revision&&!pin.state.editing){pin.state.status='识字未完成，仍可拖动或编辑';this.publish(pin);}});
  }
  private resize(pin:Pin,factor:number){const b=pin.win.getBounds(),area=screen.getDisplayMatching(b).workArea,minW=this.keepsSize()?1:220,minH=this.keepsSize()?1:100;pin.win.setBounds(fitToWorkArea({...b,width:Math.max(minW,Math.round(b.width*factor)),height:Math.max(minH,Math.round(b.height*factor))},area));}
  private beginEdit(pin:Pin){
    if(!this.options.canEdit())throw Error('请先完成或关闭当前图片编辑');
    if(pin.state.editing)return;
    this.options.suppress();
    pin.drag=undefined;pin.restBounds=pin.win.getBounds();pin.editorRevision=0;pin.ocr.reset();
    pin.state.editing=true;pin.state.editId=randomUUID();pin.state.lines=[];
    const area=screen.getDisplayMatching(pin.restBounds).workArea,px=pin.document.source.getSize(),scale=pin.document.pixelScale;
    const width=Math.min(area.width,Math.max(Math.min(760,area.width),Math.min(1100,Math.round(px.width/(scale?.x||1)+120))));
    const height=Math.min(area.height,Math.max(Math.min(500,area.height),Math.min(850,Math.round(px.height/(scale?.y||1)+200))));
    pin.win.setMinimumSize(Math.min(760,area.width),Math.min(500,area.height));pin.win.setResizable(true);pin.win.setBackgroundColor('#E9E6DD');
    pin.win.setBounds(fitToWorkArea({x:pin.restBounds.x,y:pin.restBounds.y,width,height},area));
    this.publish(pin);
  }
  private showPin(pin:Pin){
    const origin=pin.restBounds??pin.win.getBounds();pin.drag=undefined;pin.restBounds=undefined;pin.editorRevision=0;pin.ocr.reset();
    pin.state.editing=false;pin.state.editId=undefined;pin.state.lines=[];pin.state.status='正在识别文字…';
    if(!pin.win.isDestroyed()){
      const area=screen.getDisplayMatching(origin).workArea,keeps=this.keepsSize(),size=pinWindowSize(pin.document.image.getSize(),pin.document.pixelScale,area,keeps);
      pin.win.setResizable(!keeps);pin.win.setMinimumSize(keeps?1:Math.min(220,area.width),keeps?1:Math.min(100,area.height));pin.win.setBackgroundColor('#FFFFFF');
      pin.win.setBounds(fitToWorkArea({x:origin.x,y:origin.y,width:size.width,height:size.height},area));
      this.focus(pin.state.id);
    }
    this.publish(pin);this.recognize(pin);
  }
  private async exportEdit(pin:Pin,frame:CaptureFrame,action:ExportAction,format:ScreenshotOutputFormat,contentMode?:ScreenshotExportContentMode){
    const preferences=this.options.preferences(),requestedMode=contentMode??preferences.exportContentMode,mode=action==='pin'?'result':requestedMode;
    if(!['copy','save','quick-save','copy-file','copy-path','image','pin','media'].includes(action)||!screenshotOutputFormats.includes(format)||!['original','result','display'].includes(requestedMode))throw Error('不支持的输出操作');
    this.assertEditor(pin,frame?.id,frame?.revision);
    const size=pin.document.source.getSize(),crop=frame?.crop;
    if(!crop||![crop.x,crop.y,crop.width,crop.height].every(Number.isSafeInteger)||crop.x<0||crop.y<0||crop.width<1||crop.height<1||crop.x+crop.width>size.width||crop.y+crop.height>size.height)throw Error('无效的裁剪范围');
    pin.editorRevision=frame.revision;this.options.suppress();
    if(action==='copy'&&preferences.copyMode==='image'&&mode==='result'&&frame.png instanceof Uint8Array){await copyPng(assertPng(frame.png,crop.width,crop.height));this.showPin(pin);return;}
    let image=mode==='original'?pin.document.source.crop(crop):decodeFrameImage(frame);
    if(mode==='display'&&pin.document.pixelScale){const scale=pin.document.pixelScale,px=image.getSize();image=image.resize({width:Math.max(1,Math.round(px.width/scale.x)),height:Math.max(1,Math.round(px.height/scale.y)),quality:'best'});}
    const encoding={...preferences,resizeTo1x:mode==='display'?false:preferences.resizeTo1x};
    const copy=action==='copy'?preferences.copyMode:action==='copy-file'?'file':action==='copy-path'?'path':null;
    if(copy==='image')await copyImage(image);
    else if(copy||action==='quick-save'){
      const path=await saveAutomaticScreenshot(encodeScreenshot(image,encoding,format,pin.document.pixelScale),preferences.quickSaveDirectory,format,preferences.fileNameTemplate,image.getSize());
      if(copy==='file')await copyFile(path);else if(copy==='path')await copyPath(path);else await runAfterSaveAction(path,preferences.afterSaveAction);
    }else if(action==='save'){
      const name=formatScreenshotName(preferences.fileNameTemplate,format,image.getSize());
      const {filePath,canceled}=await dialog.showSaveDialog(pin.win,{title:'保存图片',defaultPath:join(preferences.directory,name.subDir,name.fileName),filters:[{name:format.toUpperCase()+' 图片',extensions:[name.ext]}]});
      if(canceled||!filePath)return;
      await mkdir(dirname(filePath),{recursive:true});
      await writeFile(filePath,encodeScreenshot(image,encoding,format,pin.document.pixelScale));
      await runAfterSaveAction(filePath,preferences.afterSaveAction);
    }else if(action==='image')await this.options.image(image);
    else if(action==='media')await this.options.media(image);
    else{
      const annotations=validateAnnotations(frame.annotations,pin.document.source,frame.crop);
      const next={...pin.document,image,annotations},bytes=this.weight(next);
      const used=[...this.pins.values()].reduce((n,item)=>n+item.bytes,0)-pin.bytes;
      if(used+bytes>256*1024*1024)throw Error('贴图占用较多，请先关闭部分贴图后重试。');
      pin.document=next;pin.bytes=bytes;const nextSize=image.getSize();pin.state.revision++;pin.state.image=image.toDataURL();pin.state.width=nextSize.width;pin.state.height=nextSize.height;pin.state.lines=[];
    }
    this.showPin(pin);
  }
  private async action(pin:Pin,action:PinAction){
    if(action==='close'){pin.win.close();return;}
    if(action==='hide'){pin.win.hide();this.options.changed();return;}
    if(action==='topmost'){pin.state.topmost=!pin.state.topmost;pin.win.setAlwaysOnTop(pin.state.topmost,'floating');this.publish(pin);return;}
    if(action==='opacity'){pin.state.opacity=pinOpacities[(pinOpacities.indexOf(pin.state.opacity)+1)%pinOpacities.length];pin.win.setOpacity(pin.state.opacity);this.publish(pin);return;}
    if(action==='zoom-in'||action==='zoom-out'){this.resize(pin,action==='zoom-in'?1.2:1/1.2);return;}
    if(action==='passthrough'){pin.state.passthrough=true;pin.win.setIgnoreMouseEvents(true,{forward:true});this.publish(pin);this.options.changed();return;}
    this.options.suppress();
    if(action==='recognize'){pin.state.revision++;pin.state.lines=[];pin.state.status='正在识别文字…';this.publish(pin);this.recognize(pin);return;}
    if(action==='edit'){this.beginEdit(pin);return;}
    if(action==='image'){await this.options.image(pin.document.image);return;}
    if(action==='copy'){await copyImage(pin.document.image);return;}
    throw Error('不支持的贴图操作');
  }
  private restore(pin:Pin){pin.state.passthrough=false;pin.win.setIgnoreMouseEvents(false);this.focus(pin.state.id);this.publish(pin);this.options.changed();}
  trayItems():Electron.MenuItemConstructorOptions[]{return [
    {label:'恢复全部贴图 / 退出穿透',enabled:this.size>0,click:()=>{for(const pin of this.pins.values())this.restore(pin);}},
    {label:'隐藏全部贴图',enabled:this.size>0,click:()=>{for(const pin of this.pins.values())pin.win.hide();this.options.changed();}},
    ...[...this.pins.values()].map(pin=>({label:pin.win.getTitle()+(pin.state.passthrough?' · 穿透':!pin.win.isVisible()?' · 已隐藏':''),click:()=>this.restore(pin)}))
  ];}
  dispose(){screen.removeListener('display-removed',this.fit);screen.removeListener('display-metrics-changed',this.fit);for(const channel of ['pin:editor-invalidate','pin:drag-start','pin:drag-move','pin:drag-end'])ipcMain.removeAllListeners(channel);for(const pin of [...this.pins.values()]){pin.ocr.reset();pin.win.destroy();}for(const channel of ['pin:state','pin:action','pin:text','pin:source','pin:editor-export','pin:editor-recognize','pin:editor-copy-text','pin:editor-send','pin:editor-action'])ipcMain.removeHandler(channel);}
}
