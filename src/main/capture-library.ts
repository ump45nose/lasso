import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import type { PinArrangeMode, PinWorkspaceSettings } from '../shared/history-sync';
import type { DesktopAPI } from '../shared/contracts';
import type { CaptureManager } from './capture';
import { result } from './ipc';

export function installCaptureLibraryIPC(deps: { screenshots: () => CaptureManager; pinClipboard: () => Promise<unknown>; assertLocal: (event: IpcMainInvokeEvent) => void }) {
  const { screenshots, pinClipboard, assertLocal } = deps;
  const assertPinWorkspace = (event: IpcMainInvokeEvent) => { if (!screenshots().pins.owns(event)) assertLocal(event); };
  ipcMain.handle('shell:capture-history',(event,query?:string)=>{assertLocal(event);if(query!==undefined&&typeof query!=='string')throw Error('历史搜索词无效');return screenshots().history.state(query);});
  ipcMain.handle('shell:capture-history-act',(event,id:string,action:Parameters<DesktopAPI['actCaptureHistory']>[1])=>{assertLocal(event);return result(()=>screenshots().actCaptureHistory(id,action));});
  ipcMain.handle('shell:capture-history-clear',event=>{assertLocal(event);return result(()=>screenshots().history.clear());});
  ipcMain.handle('shell:pin-workspace',async event=>{assertPinWorkspace(event);await screenshots().pins.ready;return screenshots().pins.state();});
  ipcMain.handle('shell:pin-workspace-save',(event,settings:PinWorkspaceSettings)=>{assertPinWorkspace(event);return result(()=>screenshots().pins.saveWorkspace(settings));});
  ipcMain.handle('shell:pin-create',(event,input:Parameters<DesktopAPI['createPin']>[0])=>{assertPinWorkspace(event);return result(()=>screenshots().pins.create(input));});
  ipcMain.handle('shell:pin-clipboard',event=>{assertPinWorkspace(event);return result(pinClipboard);});
  ipcMain.handle('shell:pin-reopen',event=>{assertPinWorkspace(event);return result(()=>screenshots().pins.reopenClosedPin());});
  ipcMain.handle('shell:pins-arrange',(event,mode:PinArrangeMode,groupId?:string)=>{assertPinWorkspace(event);return result(async()=>{await screenshots().pins.ready;screenshots().pins.arrange(mode,groupId);});});
  ipcMain.handle('shell:pin-act',(event,id:string,action:Parameters<DesktopAPI['actPin']>[1],groupId?:string)=>{assertPinWorkspace(event);return result(async()=>{await screenshots().pins.ready;await screenshots().pins.actPin(id,action,groupId);});});
}
