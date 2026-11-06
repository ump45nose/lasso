import type { RecordingSessionState } from '../../shared/recording';
import { encodeRecordingGif, type RecordingOutput } from './recording';
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, screen, type IpcMainEvent, type IpcMainInvokeEvent, type NativeImage, type Rectangle } from 'electron';
import { randomUUID } from 'node:crypto';
import { constants, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { copyFile as copyDiskFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinOpacities, type CaptureFrame, type ExportAction, type PinAction, type PinState } from '../../shared/capture';
import type { AnnotationStyleMemory, ScreenshotSettings, ScreenshotOutputFormat, ScreenshotExportContentMode } from '../../shared/screenshot-settings';
import { pinWorkspaceDefaults, validatePinWorkspaceSettings, type PinArrangeMode, type PinContentPayload, type PinKind, type PinWorkspaceSettings, type PinWorkspaceState } from '../../shared/history-sync';
import { deserializePinnedDocument, imageDocument, serializePinnedDocument, validateAnnotations, type PinnedDocument, type SerializedPinnedDocument } from './document';
import { FloatingPinBar } from './floating-bar';
import { OCRService } from './ocr';
import { assertPng, contentImage, decorateScreenshot, copyFile, copyImage, copyPath, copyPng, decodeFrameImage, deliverImage, encodeScreenshot, exportMode, formatScreenshotName, runAfterSaveAction, saveRecordingOutput } from './output';
import { fitToWorkArea } from '../position';
import { writeFileAtomic } from '../files';
import { fromMainFrame, result, sealLocal } from '../ipc';
import type { IntelligenceService } from './intelligence';
import { editorSettings, handleEditorServices, validCrop, type EditorSession } from './editor-services';

type SavedPin = {id:string;document:SerializedPinnedDocument;payload:PinContentPayload;title:string;groupId:string;locked:boolean;thumbnail:boolean;topmost:boolean;visible:boolean;opacity:number;zoomPercent:number;bounds:Rectangle;normalBounds?:Rectangle;updatedAt:number};
type DiskPin=Omit<SavedPin,'document'>&{documentFile:string};
type Pin = {win:BrowserWindow;state:PinState;document:PinnedDocument;storedDocument:SerializedPinnedDocument;ocr:OCRService;bytes:number;visible:boolean;updatedAt:number;normalBounds?:Rectangle;restBounds?:Rectangle;drag?:{cursor:{x:number;y:number};bounds:Rectangle};editorRevision:number};
type PinInput = {kind:PinKind;text?:string;color?:string;filePath?:string;groupId?:string};
type PinOptions = {
  image:(image:NativeImage)=>Promise<void>;
  media:(image:NativeImage)=>Promise<void>;
  text:(text:string)=>Promise<void>;
  suppress:()=>void;
  changed:()=>void;
  preferences:()=>ScreenshotSettings;
  generalSettings:()=>Pick<import('../../shared/contracts').Settings,'editorShortcuts'|'toolbarTools'|'mouseActions'>|undefined;
  saveAnnotationMemory:(memory:AnnotationStyleMemory)=>void;
  canEdit:()=>boolean;
  intelligence:()=>IntelligenceService;
  saveWorkspaceSettings?:(settings:PinWorkspaceSettings)=>void;
  recordHistory?:(document:PinnedDocument,id?:string)=>Promise<void>;
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
function thumbnailBounds(bounds:Rectangle,area:Rectangle){return fitToWorkArea({...bounds,width:160,height:96},area);}

export class PinManager {
  private pins=new Map<string,Pin>();
  private serial=0;
  private closed:SavedPin[]=[];
  private settings:PinWorkspaceSettings;
  private storage=join(app.getPath('userData'),'pins-workspace','workspace.json');
  private savedDocuments=new Map<string,SerializedPinnedDocument>();
  private persistTimer?:ReturnType<typeof setTimeout>;
  private disposed=false;
  private loading=true;
  private floating=new FloatingPinBar();
  private stopEditorServices:()=>void;
  readonly ready:Promise<void>;
  constructor(private options:PinOptions){
    this.settings=structuredClone(options.preferences().pinWorkspace??pinWorkspaceDefaults());
    ipcMain.handle('pin:state',e=>this.owner(e).state);
    ipcMain.handle('pin:action',(e,action:PinAction)=>{const pin=this.owner(e);return result(()=>this.action(pin,action));});
    for(const [channel,apply] of Object.entries({
      'pin:set-opacity':(pin:Pin,value:unknown)=>this.setOpacity(pin,value),
      'pin:set-zoom':(pin:Pin,value:unknown)=>this.setZoom(pin,value),
      'pin:set-group':(pin:Pin,value:unknown)=>this.setGroup(pin,value),
      'pin:update-text':(pin:Pin,value:unknown)=>this.updateText(pin,value)
    }))ipcMain.handle(channel,(e,value:unknown)=>{const pin=this.owner(e);return result(()=>apply(pin,value));});
    ipcMain.handle('pin:text',(e,text:string,send:boolean,revision:number)=>{const pin=this.owner(e);return result(async()=>{
      if(revision!==pin.state.revision)throw Error('贴图已更新，请重新选字');
      if(typeof send!=='boolean'||typeof text!=='string'||!text.trim()||text.length>100000)throw Error('没有可输出的贴图文字');
      const kind=pin.state.kind??'image',payload=pin.state.payload;
      if(kind==='image'){
        const recognized=pin.state.lines.map(line=>line.glyphs.map(glyph=>glyph.text).join('')).filter(Boolean).join('\n');
        if(!recognized.includes(text))throw Error('请先选择图中文字');
      }else if(kind==='text'){
        if(text!==payload?.text)throw Error('贴图文字已变化，请重新操作');
      }else if(kind==='color'){
        if(send||(text!==payload?.colorHex&&text!==payload?.colorRgb))throw Error('颜色贴图仅支持复制当前 HEX 或 RGB 色值');
      }else throw Error('文件贴图不支持文字输出');
      this.options.suppress();if(send)await this.options.text(text);else await clipboard.writeText(text);
    });});
    ipcMain.handle('pin:source',e=>{
      const pin=this.owner(e);
      if(!pin.state.editing||!pin.state.editId)throw Error('贴图未在编辑');
      const size=pin.document.source.getSize(),data=pin.document.source.toBitmap();
      if(data.byteLength!==size.width*size.height*4)throw Error('图片像素不完整');
      const settings=this.options.preferences();
      return {editId:pin.state.editId,width:size.width,height:size.height,bgra:data,annotations:pin.document.annotations,pixelScale:pin.document.pixelScale,saveFormat:settings.format,...editorSettings(settings,this.options.generalSettings())};
    });
    ipcMain.handle('pin:editor-export',(e,frame:CaptureFrame,action:ExportAction,format:ScreenshotOutputFormat,contentMode?:ScreenshotExportContentMode)=>{const pin=this.owner(e);return result(()=>this.exportEdit(pin,frame,action,format,contentMode));});
    const session=(e:IpcMainEvent|IpcMainInvokeEvent):EditorSession=>{const pin=this.owner(e);return {
      edit:()=>{if(!pin.state.editing)throw Error('贴图编辑已结束');return {id:pin.state.editId!,revision:pin.editorRevision};},
      check:(id,revision)=>this.assertEditor(pin,id,revision),
      accept:(id,revision)=>{this.assertEditor(pin,id,revision);pin.editorRevision=revision;},
      frame:frame=>this.editorFrame(pin,frame),
      current:(id,revision)=>this.pinFrom(e)===pin&&pin.state.editing===true&&pin.state.editId===id&&pin.editorRevision===revision,
      ocr:pin.ocr,
      textSent:id=>{if(pin.state.editing&&pin.state.editId===id)this.showPin(pin);}
    };};
    this.stopEditorServices=handleEditorServices({recognize:'pin:editor-recognize',analyze:'pin:editor-analyze',visionLanguage:'pin:editor-vision-language',previewFormula:'pin:editor-preview-formula',openURL:'pin:editor-open-url',exportTable:'pin:editor-export-table',pinFormula:'pin:editor-pin-formula',copyText:'pin:editor-copy-text',sendText:'pin:editor-send',invalidateOCR:'pin:editor-invalidate'},session,{settings:this.options.preferences,intelligence:this.options.intelligence,suppress:this.options.suppress,text:this.options.text});
    ipcMain.handle('pin:editor-action',(e,action:string)=>{const pin=this.owner(e);return result(()=>{
      if(!pin.state.editing)throw Error('贴图未在编辑');
      if(action==='cancel')this.showPin(pin);
      else if(action==='retry'){pin.editorRevision=0;pin.ocr.reset();pin.state.editId=randomUUID();this.publish(pin);}
      else throw Error('不支持的贴图编辑操作');
    });});
    ipcMain.on('pin:drag-start',this.startDrag);
    ipcMain.on('pin:drag-move',this.moveDrag);
    ipcMain.on('pin:drag-end',this.endDrag);
    screen.on('display-removed',this.fit);
    screen.on('display-metrics-changed',this.fit);
    this.ready=this.restoreWorkspace();
  }
  state():PinWorkspaceState {return {settings:structuredClone(this.settings),closedCount:this.closed.length,pins:[...this.pins.values()].map(pin=>({id:pin.state.id,title:pin.state.title||'贴图',kind:pin.state.kind||'image',groupId:pin.state.groupId||this.settings.activeGroupId,locked:!!pin.state.locked,thumbnail:!!pin.state.thumbnail,topmost:pin.state.topmost,visible:pin.win.isVisible(),opacity:pin.state.opacity,width:pin.state.width,height:pin.state.height,preview:pin.state.kind==='image'?pin.document.image.resize({width:160}).toDataURL():(pin.state.payload?.text||pin.state.payload?.colorHex||pin.state.payload?.fileName||''),updatedAt:pin.updatedAt}))};}
  async saveWorkspace(settings:PinWorkspaceSettings){
    await this.ready;validatePinWorkspaceSettings(settings);
    const next=structuredClone(settings);this.options.saveWorkspaceSettings?.(next);this.settings=next;
    for(const pin of this.pins.values()){
      if(!next.groups.some(group=>group.id===pin.state.groupId))pin.state.groupId=next.activeGroupId;
      pin.state.groups=structuredClone(next.groups);pin.state.wheelAction=next.wheelAction;this.applyVisibility(pin);this.publish(pin);
    }
    for(const pin of this.closed)if(!next.groups.some(group=>group.id===pin.groupId))pin.groupId=next.activeGroupId;
    this.floating.setEnabled(next.floatingToolbar);this.changed();this.persist();
  }
  private changed(pin?:Pin){
    if(pin)pin.updatedAt=Date.now();
    if(this.loading||this.disposed)return;
    this.options.changed();this.floating.publish(this.state());
    if(this.persistTimer)clearTimeout(this.persistTimer);
    this.persistTimer=setTimeout(()=>{this.persistTimer=undefined;try{this.persist();}catch(error){console.error('[pins] 保存工作空间失败',error);}},150);this.persistTimer.unref();
  }
  private snapshot(pin:Pin):SavedPin{return {id:pin.state.id,document:pin.storedDocument,payload:pin.state.payload??{kind:'image'},title:pin.state.title||'贴图',groupId:pin.state.groupId||this.settings.activeGroupId,locked:!!pin.state.locked,thumbnail:!!pin.state.thumbnail,topmost:pin.state.topmost,visible:pin.visible,opacity:pin.state.opacity,zoomPercent:pin.state.zoomPercent??100,bounds:pin.restBounds??pin.win.getBounds(),normalBounds:pin.normalBounds,updatedAt:pin.updatedAt};}
  private persist(){
    if(this.loading||this.disposed)return;
    mkdirSync(dirname(this.storage),{recursive:true,mode:0o700});
    const directory=dirname(this.storage),records=[...this.pins.values()].map(pin=>this.snapshot(pin)),kept=new Set([...records,...this.closed].map(pin=>pin.id));
    const store=(pin:SavedPin):DiskPin=>{
      const {document,...metadata}=pin,documentFile=pin.id+'.document.json';
      if(this.savedDocuments.get(pin.id)!==document){writeFileAtomic(join(directory,documentFile),JSON.stringify(document));this.savedDocuments.set(pin.id,document);}
      return {...metadata,documentFile};
    };
    writeFileAtomic(this.storage,JSON.stringify({schemaVersion:1,active:records.map(store),closed:this.closed.map(store)}));
    for(const id of this.savedDocuments.keys())if(!kept.has(id)){rmSync(join(directory,id+'.document.json'),{force:true});this.savedDocuments.delete(id);}
    for(const file of readdirSync(directory)){const match=file.match(/^([\da-f-]{36})\.document\.json$/i);if(match&&!kept.has(match[1]))rmSync(join(directory,file),{force:true});}
  }
  private async restoreWorkspace(){
    try{
      let saved:{schemaVersion:number;active:DiskPin[];closed:DiskPin[]};
      try{saved=JSON.parse(readFileSync(this.storage,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
      if(saved.schemaVersion!==1||!Array.isArray(saved.active)||!Array.isArray(saved.closed))throw Error('贴图工作空间格式无效');
      const load=(pin:DiskPin):SavedPin=>{
        if(!/^[\da-f-]{36}$/i.test(pin.id)||pin.documentFile!==pin.id+'.document.json')throw Error('贴图工作空间路径无效');
        const {documentFile,...metadata}=pin,document=JSON.parse(readFileSync(join(dirname(this.storage),documentFile),'utf8')) as SerializedPinnedDocument;
        this.savedDocuments.set(pin.id,document);return {...metadata,document};
      };
      for(const pin of saved.closed.slice(-10))try{this.closed.push(load(pin));}catch(error){console.error('[pins] 无法读取最近关闭贴图',error);}
      if(this.settings.restoreOnLaunch)for(const pin of saved.active.slice(0,16)){
        try{const record=load(pin);await this.open(deserializePinnedDocument(record.document),record);}catch(error){console.error('[pins] 无法恢复贴图',pin.id,error);}
      }
    }catch(error){console.error('[pins] 无法读取工作空间',error);}
    finally{this.loading=false;if(!this.disposed){this.floating.setEnabled(this.settings.floatingToolbar);this.changed();}}
  }
  private group(id:unknown){if(typeof id!=='string'||!this.settings.groups.some(group=>group.id===id))throw Error('贴图分组不存在');return id;}
  private applyVisibility(pin:Pin){if(pin.visible&&this.settings.groups.find(group=>group.id===pin.state.groupId)?.visible)pin.win.showInactive();else pin.win.hide();}
  private setGroup(pin:Pin,value:unknown){pin.state.groupId=this.group(value);this.applyVisibility(pin);this.publish(pin);this.changed(pin);}
  private setOpacity(pin:Pin,value:unknown){if(typeof value!=='number'||!Number.isFinite(value)||value<0.1||value>1)throw Error('透明度须在 10%–100% 之间');if(pin.state.editing)throw Error('请先完成贴图编辑');pin.state.opacity=value;pin.win.setOpacity(value);this.publish(pin);this.changed(pin);}
  private setZoom(pin:Pin,value:unknown){
    if(typeof value!=='number'||!Number.isFinite(value)||value<0.1||value>5)throw Error('缩放须在 10%–500% 之间');
    if(pin.state.locked||pin.state.editing)throw Error('请先解锁或完成贴图编辑');
    const bounds=pin.state.thumbnail?pin.normalBounds!:pin.win.getBounds(),area=screen.getDisplayMatching(bounds).workArea,base=pinWindowSize(pin.document.image.getSize(),pin.document.pixelScale,area,this.keepsSize());
    const next=fitToWorkArea({...bounds,width:Math.max(1,Math.round(base.width*value)),height:Math.max(1,Math.round(base.height*value))},area);
    if(pin.state.thumbnail)pin.normalBounds=next;else{pin.win.setMinimumSize(1,1);pin.win.setBounds(next);}
    pin.state.zoomPercent=Math.round(next.width/base.width*100);this.publish(pin);this.changed(pin);
  }
  private setLocked(pin:Pin,locked:boolean){if(pin.state.editing)throw Error('请先完成贴图编辑');pin.state.locked=locked;pin.drag=undefined;pin.win.setMovable(!locked);pin.win.setResizable(!locked&&!pin.state.thumbnail&&!this.keepsSize());this.publish(pin);this.changed(pin);}
  private setThumbnail(pin:Pin,thumbnail:boolean){
    if(pin.state.editing||pin.state.locked)throw Error('请先解锁或完成贴图编辑');
    if(thumbnail===!!pin.state.thumbnail)return;
    const bounds=pin.win.getBounds(),area=screen.getDisplayMatching(bounds).workArea;
    pin.state.thumbnail=thumbnail;
    if(thumbnail){pin.normalBounds=bounds;pin.win.setMinimumSize(1,1);pin.win.setBounds(thumbnailBounds(bounds,area));}
    else{pin.win.setBounds(fitToWorkArea(pin.normalBounds??bounds,area));pin.normalBounds=undefined;}
    pin.win.setResizable(!thumbnail&&!this.keepsSize());this.publish(pin);this.changed(pin);
  }
  private updateText(pin:Pin,value:unknown){
    if(pin.state.kind!=='text')throw Error('只有文字贴图可修改文字');
    if(typeof value!=='string'||!value.trim()||value.length>100000)throw Error('贴图文字须为 1–100000 个字');
    pin.state.payload={kind:'text',text:value};pin.state.revision++;this.publish(pin);this.changed(pin);
  }
  async create(input:PinInput){
    await this.ready;
    if(!input||!['image','text','color','file'].includes(input.kind))throw Error('不支持的贴图类型');
    const groupId=this.group(input.groupId??this.settings.activeGroupId);let image:NativeImage,payload:PinContentPayload={kind:input.kind};
    if(input.kind==='image'||input.kind==='file'){
      if(typeof input.filePath!=='string'||!isAbsolute(input.filePath))throw Error('请选择本地文件');
      const info=await stat(input.filePath);if(!info.isFile())throw Error('请选择文件');
      if(input.kind==='image'){image=nativeImage.createFromPath(input.filePath);imageDocument(image);}
      else{payload={kind:'file',filePath:input.filePath,fileName:basename(input.filePath),fileSize:info.size};image=nativeImage.createFromBitmap(Buffer.alloc(240*160*4,255),{width:240,height:160,scaleFactor:1});}
    }else if(input.kind==='color'){
      const color=this.color(input.color);payload={kind:'color',colorHex:color.hex,colorRgb:color.rgb};
      const data=Buffer.alloc(240*160*4);for(let i=0;i<data.length;i+=4){data[i]=color.b;data[i+1]=color.g;data[i+2]=color.r;data[i+3]=255;}image=nativeImage.createFromBitmap(data,{width:240,height:160,scaleFactor:1});
    }else{
      if(typeof input.text!=='string'||!input.text.trim()||input.text.length>100000)throw Error('贴图文字须为 1–100000 个字');
      payload={kind:'text',text:input.text};image=nativeImage.createFromBitmap(Buffer.alloc(320*160*4,255),{width:320,height:160,scaleFactor:1});
    }
    const id=await this.open(imageDocument(image),undefined,payload,groupId);this.persist();return id;
  }
  private color(value:unknown){
    if(typeof value!=='string')throw Error('颜色格式无效');
    let rgb:number[];const hex=value.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i),decimal=value.trim().match(/^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i);
    if(hex){const text=hex[1].length===3?[...hex[1]].map(char=>char+char).join(''):hex[1];rgb=[0,2,4].map(index=>parseInt(text.slice(index,index+2),16));}
    else if(decimal)rgb=decimal.slice(1).map(Number);else throw Error('颜色须为 HEX 或 RGB');
    if(rgb.some(value=>value>255))throw Error('RGB 须在 0–255 之间');
    const [r,g,b]=rgb;return {r,g,b,hex:'#'+rgb.map(value=>value.toString(16).padStart(2,'0')).join('').toUpperCase(),rgb:`rgb(${r}, ${g}, ${b})`};
  }
  async pinClipboard(){
    await this.ready;
    const items=await clipboard.read();
    for(const item of items){
      if(item.types.includes('text/uri-list')){const blob=await item.getType('text/uri-list'),uri=(await blob.text()).split(/\r?\n/).find(line=>line.startsWith('file:'));if(uri)return this.create({kind:'file',filePath:fileURLToPath(uri)});}
      const mime=(['image/png','image/jpeg','image/tiff'] as const).find(type=>item.types.includes(type));
      if(mime){const blob=await item.getType(mime),image=nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));return this.put(imageDocument(image));}
    }
    const text=await clipboard.readText();if(!text.trim())throw Error('剪贴板没有可贴内容');
    if(/^(#[\da-f]{3}|#[\da-f]{6}|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i.test(text.trim()))return this.create({kind:'color',color:text.trim()});
    return this.create({kind:'text',text});
  }
  async reopenClosedPin(){await this.ready;const saved=this.closed.at(-1);if(!saved)throw Error('没有最近关闭的贴图');const id=await this.open(deserializePinnedDocument(saved.document),saved);this.closed.pop();this.changed();this.persist();return id;}
  async actPin(id:string,action:'focus'|'toggle-visible'|'toggle-lock'|'toggle-thumbnail'|'close',groupId?:string){
    if(!['focus','toggle-visible','toggle-lock','toggle-thumbnail','close'].includes(action))throw Error('不支持的贴图操作');
    const pin=this.pins.get(id);if(!pin)throw Error('贴图已关闭');
    if(groupId!==undefined)this.setGroup(pin,groupId);
    if(action==='focus')this.focus(id);
    else if(action==='toggle-visible'){pin.visible=!pin.visible;this.applyVisibility(pin);this.changed(pin);}
    else if(action==='toggle-lock')this.setLocked(pin,!pin.state.locked);
    else if(action==='toggle-thumbnail')this.setThumbnail(pin,!pin.state.thumbnail);
    else if(action==='close')await this.closePin(pin);else throw Error('不支持的贴图操作');
  }
  private closePin(pin:Pin){return new Promise<void>(resolve=>{pin.win.once('closed',resolve);pin.win.close();});}
  arrange(mode:PinArrangeMode,groupId?:string){
    if(!['grid','horizontal','vertical','align-left','align-top'].includes(mode))throw Error('不支持的排列方式');
    if(groupId!==undefined)this.group(groupId);
    const pins=[...this.pins.values()].filter(pin=>(!groupId||pin.state.groupId===groupId)&&!pin.state.locked&&!pin.state.editing&&pin.win.isVisible());if(!pins.length)return;
    const area=screen.getDisplayMatching(pins[0].win.getBounds()).workArea,columns=mode==='vertical'?1:mode==='horizontal'?pins.length:Math.ceil(Math.sqrt(pins.length)),rows=Math.ceil(pins.length/columns),gap=12;
    const left=Math.min(...pins.map(pin=>pin.win.getBounds().x)),top=Math.min(...pins.map(pin=>pin.win.getBounds().y));
    pins.forEach((pin,index)=>{const b=pin.win.getBounds();let next:Rectangle;
      if(mode==='align-left'||mode==='align-top')next={...b,x:mode==='align-left'?left:b.x,y:mode==='align-top'?top:b.y};
      else{const cellW=Math.max(1,(area.width-gap*(columns+1))/columns),cellH=Math.max(1,(area.height-gap*(rows+1))/rows),scale=Math.min(1,cellW/b.width,cellH/b.height);next={x:Math.round(area.x+gap+(index%columns)*(cellW+gap)),y:Math.round(area.y+gap+Math.floor(index/columns)*(cellH+gap)),width:Math.max(1,Math.round(b.width*scale)),height:Math.max(1,Math.round(b.height*scale))};pin.win.setMinimumSize(1,1);}
      pin.win.setBounds(pin.state.thumbnail?thumbnailBounds(next,area):fitToWorkArea(next,area));this.changed(pin);
    });
  }
  saveAnnotationMemory(event:IpcMainInvokeEvent,memory:AnnotationStyleMemory){const pin=this.owner(event);if(!pin.state.editing)throw Error('贴图未在编辑');this.options.saveAnnotationMemory(memory);}
  get size(){return this.pins.size;}
  contains(id:string){return this.pins.has(id);}
  owns(event:IpcMainEvent|IpcMainInvokeEvent){return !!this.pinFrom(event)||this.floating.owns(event);}
  focus(id:string){const pin=this.pins.get(id);if(!pin||pin.win.isDestroyed()||!this.settings.groups.find(group=>group.id===pin.state.groupId)?.visible)return;pin.visible=true;pin.win.show();app.focus({steal:true});pin.win.focus();pin.win.webContents.focus();this.changed(pin);}
  closeFocused(){const focused=BrowserWindow.getFocusedWindow(),pin=[...this.pins.values()].find(item=>!item.win.isDestroyed()&&(item.win===focused||item.win.isFocused()));if(!pin)return false;pin.win.close();return true;}
  private keepsSize(){return this.options.preferences().pinKeepsSize;}
  private pinFrom(event:IpcMainEvent|IpcMainInvokeEvent){return [...this.pins.values()].find(pin=>fromMainFrame(event,pin.win));}
  private owner(event:IpcMainEvent|IpcMainInvokeEvent){const pin=this.pinFrom(event);if(!pin)throw Error('贴图操作只允许对应贴图窗口调用');return pin;}
  private startDrag=(event:IpcMainEvent)=>{const pin=this.pinFrom(event);if(!pin||pin.state.locked||pin.state.editing||pin.win.isDestroyed())return;app.focus({steal:true});pin.win.focus();pin.drag={cursor:screen.getCursorScreenPoint(),bounds:pin.win.getBounds()};};
  private moveDrag=(event:IpcMainEvent)=>{const pin=this.pinFrom(event);if(!pin?.drag||pin.state.locked||pin.state.editing||pin.win.isDestroyed())return;const cursor=screen.getCursorScreenPoint();pin.win.setPosition(pin.drag.bounds.x+cursor.x-pin.drag.cursor.x,pin.drag.bounds.y+cursor.y-pin.drag.cursor.y,false);};
  private endDrag=(event:IpcMainEvent)=>{const pin=this.pinFrom(event);if(pin){pin.drag=undefined;this.changed(pin);}};
  private assertEditor(pin:Pin,id:string,revision:number){
    if(!pin.state.editing||id!==pin.state.editId)throw Error('贴图编辑已结束');
    if(!Number.isSafeInteger(revision)||revision<0||revision<pin.editorRevision)throw Error('图片已变化，请重试');
  }
  private editorFrame(pin:Pin,frame:CaptureFrame){
    this.assertEditor(pin,frame?.id,frame?.revision);
    validCrop(frame.crop,pin.document.source.getSize());
    decodeFrameImage(frame);pin.editorRevision=frame.revision;
  }
  private fit=()=>{for(const pin of this.pins.values()){
    if(pin.state.editing||(pin.state.locked&&!pin.state.thumbnail))continue;
    const bounds=pin.win.getBounds(),area=screen.getDisplayMatching(bounds).workArea;
    if(pin.normalBounds)pin.normalBounds=fitToWorkArea(pin.normalBounds,area);
    pin.win.setBounds(pin.state.thumbnail?thumbnailBounds(bounds,area):fitToWorkArea(bounds,area));this.changed(pin);
  }};
  private publish(pin:Pin){if(!pin.win.isDestroyed())pin.win.webContents.send('pin:changed',pin.state);}
  private animationWeight(payload:PinContentPayload,size:{width:number;height:number}){
    if(!payload.frames)return 0;
    if(payload.kind!=='image'||!payload.frames.length||!Number.isFinite(payload.frameDelayMs)||payload.frameDelayMs!<1||payload.loop!==true)throw Error('动态贴图帧参数无效');
    const bytes=payload.frames.reduce((sum,frame)=>sum+(typeof frame==='string'?frame.length*2:Infinity),0);
    if(bytes>256*1024*1024)throw Error('动态贴图占用较多，请缩短录制后重试');
    for(const frame of payload.frames){const image=nativeImage.createFromDataURL(frame),dimensions=image.getSize();if(!frame.startsWith('data:image/png;base64,')||image.isEmpty()||dimensions.width!==size.width||dimensions.height!==size.height)throw Error('动态贴图帧尺寸无效');}
    return bytes;
  }
  private weight(doc:PinnedDocument){const a=doc.source.getSize(),b=doc.image.getSize();return (a.width*a.height+b.width*b.height)*4+JSON.stringify(doc.annotations).length*2;}
  private restoreImageSize(pin:Pin,origin:Rectangle){
    const area=screen.getDisplayMatching(origin).workArea,base=pinWindowSize(pin.document.image.getSize(),pin.document.pixelScale,area,this.keepsSize()),zoom=(pin.state.zoomPercent??100)/100;
    const bounds=fitToWorkArea({...origin,width:Math.max(1,Math.round(base.width*zoom)),height:Math.max(1,Math.round(base.height*zoom))},area);
    if(pin.state.thumbnail)pin.normalBounds=bounds;
    pin.win.setMinimumSize(1,1);pin.win.setBounds(pin.state.thumbnail?thumbnailBounds(pin.win.getBounds(),area):bounds);
  }
  publishRecording(state:RecordingSessionState|null){for(const pin of this.pins.values())if(!pin.win.isDestroyed())pin.win.webContents.send('shell:recording-changed',state);this.floating.publishRecording(state);}
  async putAnimated(output:Pick<RecordingOutput,'frames'|'frameDelayMs'|'loop'>){
    await this.ready;
    const image=nativeImage.createFromDataURL(output.frames[0]??'');
    if(image.isEmpty())throw Error('动态贴图没有有效帧');
    const id=await this.open(imageDocument(image),undefined,{kind:'image',frames:output.frames,frameDelayMs:output.frameDelayMs,loop:output.loop});
    this.persist();return id;
  }
  async put(document:PinnedDocument,id?:string){
    await this.ready;
    const existing=id?this.pins.get(id):undefined;
    if(id&&!existing)throw Error('原贴图已关闭，请重新贴图');
    const bytes=this.weight(document),used=[...this.pins.values()].reduce((n,p)=>n+p.bytes,0)-(existing?.bytes||0);
    if((!existing&&this.pins.size>=16)||used+bytes>256*1024*1024)throw Error('贴图占用较多，请先关闭部分贴图后重试。');
    if(existing){const origin=existing.restBounds??existing.normalBounds??existing.win.getBounds();existing.document=document;existing.storedDocument=serializePinnedDocument(document);existing.bytes=bytes;existing.state.revision++;existing.state.image=document.image.toDataURL();existing.state.editing=false;existing.state.editId=undefined;existing.restBounds=undefined;Object.assign(existing.state,document.image.getSize(),{lines:[],barcodes:[],status:'正在识别文字…'});this.restoreImageSize(existing,origin);this.publish(existing);this.focus(existing.state.id);this.recognize(existing);this.changed(existing);this.persist();return existing.state.id;}
    return this.open(document);
  }
  async pinFormula(latex:string,svg:string,current?:()=>boolean){
    await this.ready;
    const root=svg.match(/<svg\b[^>]*>/)?.[0],bounds={width:Number(root?.match(/\swidth="(\d+)px"/)?.[1])+32,height:Number(root?.match(/\sheight="(\d+)px"/)?.[1])+32};
    if(!Number.isSafeInteger(bounds.width)||!Number.isSafeInteger(bounds.height)||bounds.width<33||bounds.height<33||bounds.width*bounds.height>40_000_000||Math.max(bounds.width,bounds.height)>8192)throw Error('公式预览尺寸无效或过大');
    const preview=new BrowserWindow({...bounds,show:false,frame:false,enableLargerThanScreen:true,webPreferences:{offscreen:{useSharedTexture:false,deviceScaleFactor:1},contextIsolation:true,nodeIntegration:false,sandbox:true}});
    preview.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    try{
      const html=`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;padding:16px;background:white;color:black;font-size:24px;width:max-content}svg{display:block}</style>${svg}`;
      await preview.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
      // Offscreen frames arrive through paint; capturePage's Viz copy is not the OSR bitmap.
      const image=await new Promise<NativeImage>((resolve,reject)=>{
        const finish=(error?:Error,frame?:NativeImage)=>{clearTimeout(timer);preview.webContents.removeListener('paint',paint);preview.removeListener('closed',closed);if(error)reject(error);else resolve(frame!);};
        // invalidate can emit the empty backing before the renderer's first frame arrives.
        const paint=(_event:Electron.Event,_dirty:Rectangle,frame:NativeImage)=>{if(frame.isEmpty())return;const size=frame.getSize();finish(size.width===bounds.width&&size.height===bounds.height?undefined:Error('公式预览像素尺寸不符'),frame);};
        const closed=()=>finish(Error('公式预览窗口已关闭')),timer=setTimeout(()=>finish(Error('公式预览绘制超时')),5000);
        preview.once('closed',closed);preview.webContents.on('paint',paint);preview.webContents.invalidate();
      });
      if(image.isEmpty())throw Error('公式预览未能生成');
      if(current&&!current())throw Error('图片已变化，请重试');
      await this.open(imageDocument(image),undefined,{kind:'image',text:latex});
    }finally{if(!preview.isDestroyed())preview.destroy();}
  }
  private async open(document:PinnedDocument,saved?:SavedPin,payload:PinContentPayload={kind:'image'},groupId=this.settings.activeGroupId){
    if(saved)payload=saved.payload;
    const bytes=this.weight(document)+this.animationWeight(payload,document.image.getSize());
    if(this.disposed)throw Error('贴图工作空间已关闭');
    if(this.pins.size>=16||[...this.pins.values()].reduce((sum,pin)=>sum+pin.bytes,bytes)>256*1024*1024)throw Error('贴图占用较多，请先关闭部分贴图后重试。');
    if(saved){
      if(typeof saved.id!=='string'||this.pins.has(saved.id)||!saved.payload||!['image','text','color','file'].includes(saved.payload.kind)||!saved.bounds||![saved.bounds.x,saved.bounds.y,saved.bounds.width,saved.bounds.height,saved.opacity,saved.zoomPercent].every(Number.isFinite)||saved.bounds.width<1||saved.bounds.height<1||saved.opacity<0.1||saved.opacity>1)throw Error('贴图工作空间记录无效');
      if(saved.normalBounds&&(![saved.normalBounds.x,saved.normalBounds.y,saved.normalBounds.width,saved.normalBounds.height].every(Number.isFinite)||saved.normalBounds.width<1||saved.normalBounds.height<1))throw Error('贴图展开尺寸无效');
      payload=saved.payload;groupId=this.settings.groups.some(group=>group.id===saved.groupId)?saved.groupId:this.settings.activeGroupId;
    }
    const pinId=saved?.id??randomUUID(),size=document.image.getSize(),area=saved?screen.getDisplayMatching(saved.bounds).workArea:screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const keeps=this.keepsSize(),placed=pinWindowSize(size,document.pixelScale,area,keeps);
    const initialBounds=saved?.bounds??{x:Math.round(area.x+(area.width-placed.width)/2+(this.serial%5)*18),y:Math.round(area.y+(area.height-placed.height)/2+(this.serial%5)*18),width:placed.width,height:placed.height};
    const bounds=saved?.thumbnail?thumbnailBounds(initialBounds,area):fitToWorkArea(initialBounds,area),zoom=(saved?.zoomPercent??100)/100;
    const normalBounds=saved?.thumbnail?fitToWorkArea(saved.normalBounds??{...initialBounds,width:Math.max(1,Math.round(placed.width*zoom)),height:Math.max(1,Math.round(placed.height*zoom))},area):undefined;
    this.serial++;
    const title=saved?.title??(payload.kind==='text'?payload.text!.slice(0,30):payload.kind==='color'?payload.colorHex!:payload.kind==='file'?payload.fileName!:`Lasso 贴图 ${this.serial}`);
    const win=new BrowserWindow({...bounds,minWidth:1,minHeight:1,resizable:!keeps&&!saved?.locked&&!saved?.thumbnail,frame:false,show:false,backgroundColor:'#FFFFFF',title,fullscreenable:false,webPreferences:{preload:join(__dirname,'pin-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    win.setAlwaysOnTop(saved?.topmost??true,'floating');win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});win.setOpacity(saved?.opacity??1);win.setMovable(!saved?.locked);
    win.on('focus',()=>app.focus({steal:true}));
    win.on('page-title-updated',event=>event.preventDefault());
    sealLocal(win.webContents);
    win.webContents.on('before-input-event',(event,input)=>{
      if(input.type==='keyDown'&&input.meta&&!input.control&&!input.alt&&!input.shift&&input.key.toLowerCase()==='w'){event.preventDefault();win.close();}
    });
    const pin:Pin={win,document,storedDocument:saved?.document??serializePinnedDocument(document),bytes,visible:saved?.visible??true,updatedAt:saved?.updatedAt??Date.now(),normalBounds,state:{id:pinId,kind:payload.kind,payload,title,groupId,locked:saved?.locked??false,thumbnail:saved?.thumbnail??false,zoomPercent:saved?.zoomPercent??100,wheelAction:this.settings.wheelAction,groups:structuredClone(this.settings.groups),revision:0,image:document.image.toDataURL(),...size,lines:[],status:payload.kind==='image'?'正在识别文字…':'',topmost:saved?.topmost??true,opacity:saved?.opacity??1,passthrough:false,editing:false},ocr:undefined!,editorRevision:0};
    pin.ocr=new OCRService((ocrId,revision)=>pin.state.editing?pin.state.editId===ocrId&&pin.editorRevision===revision:this.pins.get(ocrId)===pin&&pin.state.revision===revision);
    this.pins.set(pinId,pin);
    let closing:SavedPin|undefined;
    win.on('close',()=>{if(!this.disposed)closing=this.snapshot(pin);});
    win.on('closed',()=>{pin.ocr.reset();this.pins.delete(pinId);if(closing&&!this.disposed){this.closed.push(closing);this.closed=this.closed.slice(-10);}this.changed();});
    win.on('moved',()=>{if(pin.state.thumbnail&&pin.normalBounds){const {x,y}=win.getBounds();pin.normalBounds={...pin.normalBounds,x,y};}this.changed(pin);});win.on('resized',()=>{if(!pin.state.editing&&!pin.state.thumbnail){const base=pinWindowSize(pin.document.image.getSize(),pin.document.pixelScale,screen.getDisplayMatching(win.getBounds()).workArea,this.keepsSize());pin.state.zoomPercent=Math.round(win.getBounds().width/base.width*100);this.publish(pin);}this.changed(pin);});
    try{await win.loadFile(join(__dirname,'renderer/index.html'),{query:{surface:'pin'}});if(!win.isDestroyed()){if(saved)this.applyVisibility(pin);else this.focus(pinId);this.recognize(pin);this.changed(pin);}return pinId;}
    catch(error){closing=undefined;if(!win.isDestroyed())win.destroy();throw error;}
  }
  private recognize(pin:Pin){
    if(pin.state.kind!=='image')return;
    pin.ocr.reset();const {id,revision}=pin.state;
    void pin.ocr.recognize({id,revision,png:pin.document.image.toPNG(),mode:'text',enhance:false,languages:this.options.preferences().languages}).then(result=>{
      if(this.pins.get(id)!==pin||pin.state.revision!==revision||pin.state.editing)return;
      const crop=pin.document.annotations.crop;
      const effects=pin.document.annotations.effects;
      const project=(x:number,y:number)=>{
        x-=crop.x;y-=crop.y;
        if(effects?.flipX)x=crop.width-x;if(effects?.flipY)y=crop.height-y;
        switch(effects?.turns){case 1:return {x:crop.height-y,y:x};case 2:return {x:crop.width-x,y:crop.height-y};case 3:return {x:y,y:crop.width-x};default:return {x,y};}
      };
      const masks=pin.document.annotations.privacy.map(r=>{
        const points=[project(r.x,r.y),project(r.x+r.width,r.y),project(r.x,r.y+r.height),project(r.x+r.width,r.y+r.height)];
        const xs=points.map(p=>p.x),ys=points.map(p=>p.y),x=Math.min(...xs),y=Math.min(...ys);
        return {x,y,width:Math.max(...xs)-x,height:Math.max(...ys)-y};
      });
      pin.state.lines=result.lines.filter(l=>!masks.some(r=>l.x<r.x+r.width&&l.x+l.width>r.x&&l.y<r.y+r.height&&l.y+l.height>r.y));
      pin.state.barcodes=result.barcodes?.filter(l=>!masks.some(r=>l.x<r.x+r.width&&l.x+l.width>r.x&&l.y<r.y+r.height&&l.y+l.height>r.y));
      pin.state.status=pin.state.lines.length?'拖动贴图 · 点选字图标选择文字':'未识别到文字';this.publish(pin);
    }).catch(()=>{if(this.pins.get(id)===pin&&pin.state.revision===revision&&!pin.state.editing){pin.state.status='识字未完成，仍可拖动或编辑';this.publish(pin);}});
  }
  private resize(pin:Pin,factor:number){this.setZoom(pin,Math.max(0.1,Math.min(5,(pin.state.zoomPercent??100)/100*factor)));}
  private beginEdit(pin:Pin){
    if(pin.state.payload?.frames)throw Error('动态贴图请在录制预览中裁剪');
    if(pin.state.kind!=='image')throw Error('此贴图类型不支持图片编辑');
    if(pin.state.locked)throw Error('请先解锁贴图');
    if(!this.options.canEdit())throw Error('请先完成或关闭当前图片编辑');
    if(pin.state.editing)return;
    if(pin.state.thumbnail)this.setThumbnail(pin,false);
    this.options.suppress();
    pin.drag=undefined;pin.restBounds=pin.win.getBounds();pin.editorRevision=0;pin.ocr.reset();
    pin.state.editing=true;pin.state.editId=randomUUID();pin.state.lines=[];pin.state.barcodes=[];
    const area=screen.getDisplayMatching(pin.restBounds).workArea,px=pin.document.source.getSize(),scale=pin.document.pixelScale;
    const width=Math.min(area.width,Math.max(Math.min(760,area.width),Math.min(1100,Math.round(px.width/(scale?.x||1)+120))));
    const height=Math.min(area.height,Math.max(Math.min(500,area.height),Math.min(850,Math.round(px.height/(scale?.y||1)+200))));
    pin.win.setMinimumSize(Math.min(760,area.width),Math.min(500,area.height));pin.win.setResizable(true);pin.win.setBackgroundColor('#E9E6DD');
    pin.win.setBounds(fitToWorkArea({x:pin.restBounds.x,y:pin.restBounds.y,width,height},area));
    this.publish(pin);
  }
  private showPin(pin:Pin){
    const origin=pin.restBounds??pin.win.getBounds();pin.drag=undefined;pin.restBounds=undefined;pin.editorRevision=0;pin.ocr.reset();
    pin.state.editing=false;pin.state.editId=undefined;pin.state.lines=[];pin.state.barcodes=[];pin.state.status='正在识别文字…';
    if(!pin.win.isDestroyed()){
      const keeps=this.keepsSize();
      pin.win.setResizable(!keeps&&!pin.state.locked);pin.win.setMinimumSize(1,1);pin.win.setBackgroundColor('#FFFFFF');
      this.restoreImageSize(pin,origin);
      this.focus(pin.state.id);
    }
    this.publish(pin);this.recognize(pin);this.changed(pin);
  }
  private async exportEdit(pin:Pin,frame:CaptureFrame,action:ExportAction,format:ScreenshotOutputFormat,contentMode?:ScreenshotExportContentMode){
    const preferences=this.options.preferences(),mode=exportMode(action,format,contentMode??preferences.exportContentMode);
    this.assertEditor(pin,frame?.id,frame?.revision);
    const crop=validCrop(frame.crop,pin.document.source.getSize());
    const historyDocument=frame.annotations?{...pin.document,image:decodeFrameImage(frame),annotations:validateAnnotations(frame.annotations,pin.document.source,crop)}:undefined;
    pin.editorRevision=frame.revision;this.options.suppress();
    if(action==='copy'&&preferences.copyMode==='image'&&mode==='result'&&frame.png instanceof Uint8Array&&!preferences.cornerRadius&&!preferences.borderWidth){await copyPng(assertPng(frame.png,frame.outputSize?.width??crop.width,frame.outputSize?.height??crop.height));if(historyDocument)await this.options.recordHistory?.(historyDocument,pin.state.id);this.showPin(pin);return;}
    const image=mode==='original'?pin.document.source.crop(crop):contentImage(historyDocument?.image??decodeFrameImage(frame),mode,pin.document.pixelScale);
    if(action==='image')await this.options.image(image);
    else if(action==='media')await this.options.media(image);
    else if(action==='pin'){
      const annotations=validateAnnotations(frame.annotations,pin.document.source,frame.crop);
      const next={...pin.document,image,annotations},bytes=this.weight(next);
      const used=[...this.pins.values()].reduce((n,item)=>n+item.bytes,0)-pin.bytes;
      if(used+bytes>256*1024*1024)throw Error('贴图占用较多，请先关闭部分贴图后重试。');
      pin.document=next;pin.storedDocument=serializePinnedDocument(next);pin.bytes=bytes;const nextSize=image.getSize();pin.state.revision++;pin.state.image=image.toDataURL();pin.state.width=nextSize.width;pin.state.height=nextSize.height;pin.state.lines=[];
    }
    else if(!await deliverImage(image,action,{preferences,format,mode,pixelScale:pin.document.pixelScale,owner:pin.win}))return;
    if(historyDocument)await this.options.recordHistory?.(historyDocument,pin.state.id);
    this.showPin(pin);this.persist();
  }
  private async exportPin(pin:Pin,action:'save'|'quick-save'|'copy-file'|'copy-path'){
    const settings=this.options.preferences(),payload=pin.state.payload??{kind:'image'};
    if(payload.frames){
      const images=payload.frames.map(frame=>nativeImage.createFromDataURL(frame)),size=images[0].getSize();
      await saveRecordingOutput({bytes:encodeRecordingGif(images,images.map(()=>payload.frameDelayMs!)),format:'gif',...size},action,settings,pin.win);return;
    }
    if(payload.kind==='file'&&(action==='copy-file'||action==='copy-path')){
      if(!payload.filePath)throw Error('原文件路径不存在');
      await stat(payload.filePath);if(action==='copy-file')await copyFile(payload.filePath);else await copyPath(payload.filePath);return;
    }
    const mode=settings.exportContentMode,image=mode==='original'?pin.document.source.crop(pin.document.annotations.crop):contentImage(pin.document.image,mode,pin.document.pixelScale);
    const name=formatScreenshotName(settings.fileNameTemplate,settings.format,image.getSize());
    const extension=payload.kind==='image'?name.ext:payload.kind==='file'?extname(payload.fileName||'').slice(1):'txt';
    const fileName=payload.kind==='file'?payload.fileName!:name.fileName.slice(0,-name.ext.length)+(extension||'txt');
    const bytes=payload.kind==='image'?encodeScreenshot(image,{...settings,resizeTo1x:mode==='display'?false:settings.resizeTo1x},settings.format,pin.document.pixelScale):Buffer.from(payload.kind==='text'?payload.text!:`${payload.colorHex}\n${payload.colorRgb}\n`);
    let path:string;
    const save=async(target:string,exclusive:boolean)=>{await mkdir(dirname(target),{recursive:true});if(payload.kind==='file')await copyDiskFile(payload.filePath!,target,exclusive?constants.COPYFILE_EXCL:0);else await writeFile(target,bytes,{flag:exclusive?'wx':'w'});};
    if(action==='save'){
      const result=await dialog.showSaveDialog(pin.win,{title:'保存贴图',defaultPath:join(settings.directory,name.subDir,fileName),filters:extension?[{name:extension.toUpperCase(),extensions:[extension]}]:[]});
      if(result.canceled||!result.filePath)return;path=result.filePath;await save(path,false);
    }else{
      for(let count=0;;count++){
        const suffix=extname(fileName),candidate=count?`${fileName.slice(0,fileName.length-suffix.length)}-${count}${suffix}`:fileName;
        path=join(settings.quickSaveDirectory,name.subDir,candidate);
        try{await save(path,true);break;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
      }
    }
    if(action==='copy-file')await copyFile(path);else if(action==='copy-path')await copyPath(path);else await runAfterSaveAction(path,settings.afterSaveAction);
    if(payload.kind==='image')await this.options.recordHistory?.(pin.document,pin.state.id);
  }
  private async action(pin:Pin,action:PinAction){
    if(action==='close'){await this.closePin(pin);return;}
    if(action==='hide'){pin.visible=false;pin.win.hide();this.changed(pin);return;}
    if(action==='topmost'){pin.state.topmost=!pin.state.topmost;pin.win.setAlwaysOnTop(pin.state.topmost,'floating');this.publish(pin);this.changed(pin);return;}
    if(action==='lock'){this.setLocked(pin,!pin.state.locked);return;}
    if(action==='thumbnail'){this.setThumbnail(pin,!pin.state.thumbnail);return;}
    if(action==='reset-zoom'){this.setZoom(pin,1);return;}
    if(action==='opacity'){this.setOpacity(pin,pinOpacities[(pinOpacities.indexOf(pin.state.opacity)+1)%pinOpacities.length]);return;}
    if(action==='zoom-in'||action==='zoom-out'){this.resize(pin,action==='zoom-in'?1.2:1/1.2);return;}
    if(action==='passthrough'){pin.state.passthrough=true;pin.win.setIgnoreMouseEvents(true,{forward:true});this.publish(pin);this.changed(pin);return;}
    this.options.suppress();
    if(['save','quick-save','copy-file','copy-path'].includes(action)){await this.exportPin(pin,action as 'save'|'quick-save'|'copy-file'|'copy-path');return;}
    if(action==='recognize'){if(pin.state.kind!=='image')throw Error('只有图片贴图支持识字');pin.state.revision++;pin.state.lines=[];pin.state.barcodes=[];pin.state.status='正在识别文字…';this.publish(pin);this.recognize(pin);return;}
    if(action==='edit'){this.beginEdit(pin);return;}
    if(action==='image'){await this.options.image(pin.document.image);return;}
    if(action==='copy'){
      const payload=pin.state.payload;
      if(payload?.frames){await this.exportPin(pin,'copy-file');return;}
      if(payload?.kind==='text')await clipboard.writeText(payload.text!);
      else if(payload?.kind==='color')await clipboard.writeText(payload.colorHex!);
      else if(payload?.kind==='file')await copyFile(payload.filePath!);
      else{await copyImage(decorateScreenshot(pin.document.image,this.options.preferences()));await this.options.recordHistory?.(pin.document,pin.state.id);}return;
    }
    throw Error('不支持的贴图操作');
  }
  private restore(pin:Pin){pin.state.passthrough=false;pin.win.setIgnoreMouseEvents(false);this.focus(pin.state.id);this.publish(pin);this.changed(pin);}
  trayItems():Electron.MenuItemConstructorOptions[]{return [
    {label:'恢复全部贴图 / 退出穿透',enabled:this.size>0,click:()=>{for(const pin of this.pins.values())this.restore(pin);}},
    {label:'隐藏全部贴图',enabled:this.size>0,click:()=>{for(const pin of this.pins.values()){pin.visible=false;pin.win.hide();}this.changed();}},
    ...[...this.pins.values()].map(pin=>({label:pin.win.getTitle()+(pin.state.passthrough?' · 穿透':!pin.win.isVisible()?' · 已隐藏':''),click:()=>this.restore(pin)}))
  ];}
  dispose(){if(this.disposed)return;if(this.persistTimer)clearTimeout(this.persistTimer);this.persist();this.disposed=true;this.floating.dispose();screen.removeListener('display-removed',this.fit);screen.removeListener('display-metrics-changed',this.fit);for(const channel of ['pin:drag-start','pin:drag-move','pin:drag-end'])ipcMain.removeAllListeners(channel);this.stopEditorServices();for(const pin of [...this.pins.values()]){pin.ocr.reset();pin.win.destroy();}for(const channel of ['pin:state','pin:action','pin:text','pin:source','pin:editor-export','pin:editor-action','pin:set-opacity','pin:set-zoom','pin:set-group','pin:update-text'])ipcMain.removeHandler(channel);}
}
