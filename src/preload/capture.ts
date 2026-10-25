import { contextBridge, ipcRenderer } from 'electron';
import type { ScreenshotAPI, ScreenshotState } from '../shared/capture';
const api: ScreenshotAPI = {
  state:()=>ipcRenderer.invoke('screenshot:state'),
  onState:callback=>{const listener=(_e:Electron.IpcRendererEvent,s:ScreenshotState)=>callback(s);ipcRenderer.on('screenshot:changed',listener);return()=>ipcRenderer.removeListener('screenshot:changed',listener);},
  hover:(x,y)=>ipcRenderer.send('screenshot:hover',x,y),select:r=>ipcRenderer.invoke('screenshot:select',r),action:a=>ipcRenderer.invoke('screenshot:action',a),
  recognize:frame=>ipcRenderer.invoke('screenshot:recognize',frame),
  invalidateOCR:request=>ipcRenderer.send('screenshot:invalidate-ocr',request),
  export:(frame,action,format)=>ipcRenderer.invoke('screenshot:export',frame,action,format),
  copyText:request=>ipcRenderer.invoke('screenshot:copy-text',request),
  sendText:request=>ipcRenderer.invoke('screenshot:send-text',request)
};
contextBridge.exposeInMainWorld('screenshot',api);
