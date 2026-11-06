import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import type { PinWorkspaceState } from '../../shared/history-sync';
import { fromMainFrame, sealLocal } from '../ipc';
import { fitToWorkArea } from '../position';

/** The workspace owns the desktop toolbar and its narrow workspace bridge. */
export class FloatingPinBar {
  private win:BrowserWindow|null=null;
  private enabled=false;
  private attached=false;
  private workspace:PinWorkspaceState|null=null;
  constructor(){ipcMain.on('pin-toolbar:height',this.resize);}
  owns(event:IpcMainEvent|IpcMainInvokeEvent){return fromMainFrame(event,this.win);}
  private resize=(event:IpcMainEvent,height:number)=>{
    if(!this.owns(event)||!Number.isFinite(height)||!this.win)return;
    const bounds=this.win.getBounds(),area=screen.getDisplayMatching(bounds).workArea;
    this.win.setBounds(fitToWorkArea({...bounds,height:Math.max(52,Math.min(280,Math.round(height)))},area));
  };
  setEnabled(enabled:boolean){
    this.enabled=enabled;
    if(!enabled){this.win?.destroy();this.win=null;this.attached=false;return;}
    if(this.win&&!this.win.isDestroyed())return;
    const area=screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    this.win=new BrowserWindow({...fitToWorkArea({x:area.x+Math.round((area.width-360)/2),y:area.y+12,width:360,height:52},area),show:false,frame:false,transparent:true,resizable:false,fullscreenable:false,skipTaskbar:true,webPreferences:{preload:join(__dirname,'pin-preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    this.win.setAlwaysOnTop(true,'floating');this.win.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true});
    sealLocal(this.win.webContents);
    const win=this.win;
    win.on('closed',()=>{if(this.win===win){this.win=null;this.attached=false;}});
    void this.attach().catch(error=>{if(this.win===win){console.error('[pins] 无法显示悬浮工具栏',error);win.destroy();}});
  }
  async attach(){
    if(!this.enabled||!this.win||this.win.isDestroyed())return;
    const win=this.win;
    await win.loadFile(join(__dirname,'renderer/index.html'),{query:{surface:'pin-toolbar'}});
    if(win.isDestroyed()||this.win!==win||!this.enabled)return;
    this.attached=true;this.publish(this.workspace);win.showInactive();
  }
  publish(workspace:PinWorkspaceState|null){this.workspace=workspace;if(this.attached&&this.win&&!this.win.isDestroyed())this.win.webContents.send('pin-workspace:changed',workspace);}
  dispose(){this.setEnabled(false);ipcMain.removeListener('pin-toolbar:height',this.resize);}
}
