import { contextBridge, ipcRenderer } from 'electron';
import type { ScreenshotAPI, ScreenshotState } from '../shared/capture';
const api: ScreenshotAPI = {
  state:()=>ipcRenderer.invoke('screenshot:state'),
  onState:callback=>{const listener=(_e:Electron.IpcRendererEvent,s:ScreenshotState)=>callback(s);ipcRenderer.on('screenshot:changed',listener);return()=>ipcRenderer.removeListener('screenshot:changed',listener);},
  hover:(x,y)=>ipcRenderer.send('screenshot:hover',x,y),select:r=>ipcRenderer.invoke('screenshot:select',r),action:a=>ipcRenderer.invoke('screenshot:action',a)
};
contextBridge.exposeInMainWorld('screenshot',api);
