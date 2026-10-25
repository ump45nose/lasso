import { BrowserWindow, clipboard, ClipboardItem, ipcMain, Menu, screen } from 'electron';
import type { IpcMainInvokeEvent, NativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PinAction, PinState } from '../../shared/capture';
import type { PinnedDocument } from './document';
import { OCRService, type VisionOCR } from './ocr';
import { fitToWorkArea } from '../position';

type Pin = {win:BrowserWindow;state:PinState;document:PinnedDocument;ocr:OCRService;bytes:number};
export class PinManager {
  private pins=new Map<string,Pin>();
  private vision:VisionOCR|null=null;
  private serial=0;
  constructor(private edit:(doc:PinnedDocument,id:string)=>Promise<void>,private image:(image:NativeImage)=>Promise<void>,private text:(text:string)=>Promise<void>,private suppress:()=>void,private changed:()=>void){
    const owner=(event:IpcMainInvokeEvent)=>{
      const pin=[...this.pins.values()].find(p=>event.sender===p.win.webContents&&event.senderFrame===p.win.webContents.mainFrame);
      if(!pin)throw Error('贴图操作只允许对应贴图窗口调用');return pin;
    };
    ipcMain.handle('pin:state',e=>owner(e).state);
    ipcMain.handle('pin:action',async(e,action:PinAction)=>{const pin=owner(e);try{await this.action(pin,action);return {error:null};}catch(error){return {error:(error as Error).message};}});
    ipcMain.handle('pin:text',async(e,text:string,send:boolean,revision:number)=>{const pin=owner(e);try{
      if(revision!==pin.state.revision)throw Error('贴图已更新，请重新选字');
      if(typeof send!=='boolean'||typeof text!=='string'||!text.trim()||text.length>100000||!pin.state.lines.length)throw Error('请先选择图中文字');
      this.suppress();if(send)await this.text(text);else await clipboard.writeText(text);return {error:null};
    }catch(error){return {error:(error as Error).message};}});
    screen.on('display-removed',this.fit);
    screen.on('display-metrics-changed',this.fit);
  }
  get size(){return this.pins.size;}
  contains(id:string){return this.pins.has(id);}
  private fit=()=>{for(const pin of this.pins.values()){const area=screen.getDisplayMatching(pin.win.getBounds()).workArea;pin.win.setBounds(fitToWorkArea(pin.win.getBounds(),area));}};
  private publish(pin:Pin){if(!pin.win.isDestroyed())pin.win.webContents.send('pin:changed',pin.state);}
  private weight(doc:PinnedDocument){const a=doc.source.getSize(),b=doc.image.getSize();return (a.width*a.height+b.width*b.height)*4+JSON.stringify(doc.annotations).length*2;}
  async put(document:PinnedDocument,id?:string){
    const existing=id?this.pins.get(id):undefined;
    if(id&&!existing)throw Error('原贴图已关闭，请重新贴图');
    const bytes=this.weight(document),used=[...this.pins.values()].reduce((n,p)=>n+p.bytes,0)-(existing?.bytes||0);
    if((!existing&&this.pins.size>=16)||used+bytes>256*1024*1024)throw Error('贴图占用较多，请先关闭部分贴图后重试。');
    if(existing){existing.document=document;existing.bytes=bytes;existing.state.revision++;existing.state.image=document.image.toDataURL();Object.assign(existing.state,document.image.getSize(),{lines:[],status:'正在识别文字…'});this.publish(existing);this.resize(existing,1);existing.win.show();existing.win.focus();this.recognize(existing);return;}
    const pinId=randomUUID(),size=document.image.getSize(),area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const scale=Math.min(1,Math.min(600,area.width-40)/size.width,Math.min(500,area.height-100)/size.height);
    // The image fills the window; the toolbar floats over it on hover, so the minimum only keeps that toolbar usable.
    const width=Math.max(220,Math.round(size.width*scale)),height=Math.max(100,Math.round(size.height*scale));
    const win=new BrowserWindow({x:Math.round(area.x+(area.width-width)/2+(this.serial%5)*18),y:Math.round(area.y+(area.height-height)/2+(this.serial++%5)*18),width,height,minWidth:220,minHeight:100,frame:false,show:false,backgroundColor:'#FFFFFF',title:`Lasso 贴图 ${this.serial}`,fullscreenable:false,webPreferences:{preload:join(__dirname,'pin-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    win.setAlwaysOnTop(true,'floating');win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
    win.on('page-title-updated',event=>event.preventDefault());
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
    const pin:Pin={win,document,bytes,state:{id:pinId,revision:0,image:document.image.toDataURL(),...size,lines:[],status:'正在识别文字…',topmost:true,opacity:1,passthrough:false},ocr:new OCRService(()=>this.vision??=require(join(__dirname,'native/capture-vision.node')),(id,revision)=>this.pins.get(id)===pin&&pin.state.revision===revision)};
    this.pins.set(pinId,pin);
    win.on('closed',()=>{pin.ocr.reset();this.pins.delete(pinId);this.changed();});
    try{await win.loadFile(join(__dirname,'renderer/index.html'),{query:{surface:'pin'}});if(!win.isDestroyed()){win.show();win.focus();this.recognize(pin);this.changed();}}
    catch(error){if(!win.isDestroyed())win.destroy();throw error;}
  }
  private recognize(pin:Pin){
    pin.ocr.reset();const {id,revision}=pin.state;
    void pin.ocr.recognize({id,revision,png:pin.document.image.toPNG(),mode:'text',enhance:false}).then(result=>{
      if(this.pins.get(id)!==pin||pin.state.revision!==revision)return;
      // Only flattened pixels are recognized. Suppress whole privacy-mask lines too.
      const crop=pin.document.annotations.crop;
      const masks=pin.document.annotations.privacy.map(r=>({...r,x:r.x-crop.x,y:r.y-crop.y}));
      pin.state.lines=result.lines.filter(l=>!masks.some(r=>l.x<r.x+r.width&&l.x+l.width>r.x&&l.y<r.y+r.height&&l.y+l.height>r.y));
      pin.state.status=pin.state.lines.length?'拖选文字 · 空格拖动贴图':'未识别到文字';this.publish(pin);
    }).catch(()=>{if(this.pins.get(id)===pin&&pin.state.revision===revision){pin.state.status='识字未完成，仍可复制或编辑图片';this.publish(pin);}});
  }
  private resize(pin:Pin,factor:number){const b=pin.win.getBounds(),area=screen.getDisplayMatching(b).workArea;pin.win.setBounds(fitToWorkArea({...b,width:Math.max(220,Math.round(b.width*factor)),height:Math.max(100,Math.round(b.height*factor))},area));}
  private async action(pin:Pin,action:PinAction){
    if(action==='close'){pin.win.close();return;}
    if(action==='hide'){pin.win.hide();this.changed();return;}
    if(action==='menu'){this.menu(pin);return;}
    this.suppress();
    if(action==='edit'){await this.edit(pin.document,pin.state.id);return;}
    if(action==='image'){await this.image(pin.document.image);return;}
    if(action==='copy'){await clipboard.write([new ClipboardItem({'image/png':new Blob([new Uint8Array(pin.document.image.toPNG())],{type:'image/png'})})]);return;}
    throw Error('不支持的贴图操作');
  }
  private restore(pin:Pin){pin.state.passthrough=false;pin.win.setIgnoreMouseEvents(false);pin.win.show();pin.win.focus();this.publish(pin);this.changed();}
  private menu(pin:Pin){Menu.buildFromTemplate([
    {label:'置顶',type:'checkbox',checked:pin.state.topmost,click:()=>{pin.state.topmost=!pin.state.topmost;pin.win.setAlwaysOnTop(pin.state.topmost,'floating');this.publish(pin);}},
    {label:'透明度',submenu:[1,.85,.65,.4].map(opacity=>({label:Math.round(opacity*100)+'%',type:'radio' as const,checked:pin.state.opacity===opacity,click:()=>{pin.state.opacity=opacity;pin.win.setOpacity(opacity);this.publish(pin);}}))},
    {label:'放大',click:()=>this.resize(pin,1.2)},{label:'缩小',click:()=>this.resize(pin,1/1.2)},
    {label:'鼠标穿透（从菜单栏恢复）',type:'checkbox',checked:pin.state.passthrough,click:()=>{pin.state.passthrough=!pin.state.passthrough;pin.win.setIgnoreMouseEvents(pin.state.passthrough,{forward:true});this.publish(pin);this.changed();}},
    {label:'临时隐藏',click:()=>{pin.win.hide();this.changed();}},
    {label:'关闭贴图',click:()=>pin.win.close()}
  ]).popup({window:pin.win});}
  trayItems():Electron.MenuItemConstructorOptions[]{return [
    {label:'恢复全部贴图 / 退出穿透',enabled:this.size>0,click:()=>{for(const pin of this.pins.values())this.restore(pin);}},
    {label:'隐藏全部贴图',enabled:this.size>0,click:()=>{for(const pin of this.pins.values())pin.win.hide();this.changed();}},
    ...[...this.pins.values()].map(pin=>({label:pin.win.getTitle()+(pin.state.passthrough?' · 穿透':!pin.win.isVisible()?' · 已隐藏':''),click:()=>this.restore(pin)}))
  ];}
  dispose(){screen.removeListener('display-removed',this.fit);screen.removeListener('display-metrics-changed',this.fit);for(const pin of [...this.pins.values()]){pin.ocr.reset();pin.win.destroy();}for(const channel of ['pin:state','pin:action','pin:text'])ipcMain.removeHandler(channel);}
}
