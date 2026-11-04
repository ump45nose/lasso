import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import type { PinWorkspaceState } from '../../shared/history-sync';
import { fitToWorkArea } from '../position';

/** The workspace owns this window; stage 4 mounts its renderer through attach(). */
export class FloatingPinBar {
  private win:BrowserWindow|null=null;
  private enabled=false;
  private attached=false;
  private workspace:PinWorkspaceState|null=null;
  get state(){return {enabled:this.enabled,ready:this.attached,visible:!!this.win&&!this.win.isDestroyed()&&this.win.isVisible()};}
  setEnabled(enabled:boolean){
    this.enabled=enabled;
    if(!enabled){this.win?.destroy();this.win=null;this.attached=false;return;}
    if(this.win&&!this.win.isDestroyed())return;
    const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    this.win=new BrowserWindow({...fitToWorkArea({x:area.x+Math.round((area.width-360)/2),y:area.y+12,width:360,height:52},area),show:false,frame:false,resizable:false,fullscreenable:false,skipTaskbar:true,webPreferences:{preload:join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    this.win.setAlwaysOnTop(true,'floating');this.win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
    this.win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    this.win.webContents.on('will-navigate',event=>event.preventDefault());
    this.win.on('closed',()=>{this.win=null;this.attached=false;});
  }
  async attach(){
    if(!this.enabled||!this.win||this.win.isDestroyed())return;
    const win=this.win;
    await win.loadFile(join(__dirname,'renderer/index.html'),{query:{surface:'pin-toolbar'}});
    if(win.isDestroyed()||!this.enabled)return;
    this.attached=true;this.publish(this.workspace);win.showInactive();
  }
  publish(workspace:PinWorkspaceState|null){this.workspace=workspace;if(this.attached&&this.win&&!this.win.isDestroyed())this.win.webContents.send('pin-workspace:changed',workspace);}
  dispose(){this.setEnabled(false);}
}
