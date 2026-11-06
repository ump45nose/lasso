import { nativeImage, screen, systemPreferences, type NativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import type { RecordingMode } from '../../shared/recording';
import type { CaptureRect } from '../../shared/capture';
import type { CaptureDisplayBinding } from '../../shared/capture-efficiency';
import type { ScreenshotSettings } from '../../shared/screenshot-settings';
import type { NativeAx, WindowRect } from '../native-ax';
import { excludedCaptureWindows, type NativeCapture, type NativeCaptureEvent } from './native';
import { contains } from './candidates';
import { bindDisplay, sameCaptureDisplay } from './efficiency-control';

export interface RecordingCaptureDeps {
  native: NativeCapture;
  ax: NativeAx;
  settings: () => ScreenshotSettings;
  /** Whether a screenshot or a recording already holds the capture. */
  active: () => boolean;
  before: () => boolean;
  after: (restore?: boolean) => void;
  configureNativeAppearance: () => void;
  candidateWindows: () => WindowRect[];
}

export class RecordingCapture {
  private source:{display:CaptureDisplayBinding;windowId?:number}|null=null;
  private select:((event:NativeCaptureEvent)=>void)|null=null;
  private preparing=false;
  private epoch=0;
  private released=true;
  private disposed=false;
  constructor(private deps: RecordingCaptureDeps) {}
  get busy(){return this.preparing||Boolean(this.source);}
  nativeEvent(event:NativeCaptureEvent){if(!this.select)return false;this.select(event);return true;}
  cancelSelection(){if(this.preparing)this.release();}
  release(restore=false){if(this.released)return;this.released=true;this.epoch++;const select=this.select;this.select=null;select?.({session:'',type:'cancel'});this.source=null;this.deps.after(restore);}
  async prepare(mode:RecordingMode,bounds?:CaptureRect):Promise<{bounds:CaptureRect;displayId:number}>{
    if(this.deps.active())throw Error('请先完成当前截图或录制');
    this.preparing=true;this.released=false;const epoch=++this.epoch;let restore=false;
    const current=()=>{if(epoch!==this.epoch||this.disposed)throw Error('已取消录制选区');};
    try{
      if(systemPreferences.getMediaAccessStatus('screen')!=='granted'){const granted=await this.deps.ax.requestScreen();current();if(!granted)throw Error('请在系统设置允许 Lasso 录制屏幕');}
      restore=this.deps.before();
      this.deps.configureNativeAppearance();
      const display=bounds?screen.getDisplayMatching(bounds):screen.getDisplayNearestPoint(screen.getCursorScreenPoint()),binding=bindDisplay(display);
      let chosen=bounds,windowId:number|undefined;
      const windows=mode==='window'?this.deps.candidateWindows():[];
      if(mode==='screen')chosen={...display.bounds};
      else if(mode==='window'&&bounds){const window=windows.find(w=>contains(w,bounds.x+bounds.width/2,bounds.y+bounds.height/2));if(!window)throw Error('选中的窗口已关闭');chosen=window;windowId=window.id;}
      if(!chosen){
        const frame=await this.deps.native.capture({displayId:display.id,bounds:display.bounds,includeCursor:this.deps.settings().includeCursor,exclude:excludedCaptureWindows(this.deps.native)}),session=randomUUID();
        try{
          current();
          const selection=await new Promise<{bounds:CaptureRect;windowId?:number}>((resolve,reject)=>{
            this.select=event=>{
              if(event.type==='cancel'){reject(Error('已取消录制选区'));return;}
              if(event.session!==session)return;
              if(mode==='window'&&event.type==='window'){const window=windows.find(w=>w.id===event.id);if(window)resolve({bounds:window,windowId:window.id});}
              if(mode==='rect'&&event.type==='select'&&event.rect)resolve({bounds:{...event.rect,x:event.rect.x+display.bounds.x,y:event.rect.y+display.bounds.y}});
            };
            this.deps.native.show({frameId:frame.id,session,mode:mode==='window'?'window':'rect',windows:windows.map(w=>({...w,x:w.x-display.bounds.x,y:w.y-display.bounds.y})),candidates:[]});
          });
          current();chosen=selection.bounds;windowId=selection.windowId;
        }finally{this.select=null;this.deps.native.hide();this.deps.native.release(frame.id);}
      }
      if(![chosen.x,chosen.y,chosen.width,chosen.height].every(Number.isFinite)||chosen.width<2||chosen.height<2||chosen.x<display.bounds.x||chosen.y<display.bounds.y||chosen.x+chosen.width>display.bounds.x+display.bounds.width||chosen.y+chosen.height>display.bounds.y+display.bounds.height)throw Error('录制范围需位于同一显示器内');
      current();this.source={display:binding,windowId};return {bounds:{x:chosen.x,y:chosen.y,width:chosen.width,height:chosen.height},displayId:display.id};
    }catch(error){this.release(restore);throw error;}finally{this.preparing=false;}
  }
  async captureFrame(mode:RecordingMode,bounds:CaptureRect):Promise<{image:NativeImage;hostTimeMs:number}>{
    const source=this.source;if(!source||!screen.getAllDisplays().some(display=>sameCaptureDisplay(source.display,bindDisplay(display))))throw Error('录制显示器已变化，请停止后重新录制');
    if(mode==='window'&&(source.windowId===undefined||!this.deps.ax.windowOnScreen(source.windowId)))throw Error('录制窗口已关闭');
    const frame=await this.deps.native.capture({displayId:source.display.id,bounds,windowId:source.windowId,shadow:false,includeCursor:this.deps.settings().includeCursor,exclude:excludedCaptureWindows(this.deps.native)});
    try{const pixels=await this.deps.native.pixels(frame.id,{format:'bgra'});return {image:nativeImage.createFromBitmap(Buffer.from(pixels.data),{width:pixels.width,height:pixels.height,scaleFactor:1}),hostTimeMs:frame.hostTimeMs};}
    finally{this.deps.native.release(frame.id);}
  }
  dispose(){this.release();this.disposed=true;}
}
