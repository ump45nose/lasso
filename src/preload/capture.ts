import { contextBridge, ipcRenderer } from 'electron';
import type { ScreenshotAPI, ScreenshotState } from '../shared/capture';
const api: ScreenshotAPI = {
  ready:(id,editId)=>ipcRenderer.send('screenshot:ready',id,editId),
  state:()=>ipcRenderer.invoke('screenshot:state'),
  onState:callback=>{const listener=(_e:Electron.IpcRendererEvent,s:ScreenshotState|null)=>callback(s);ipcRenderer.on('screenshot:changed',listener);return()=>ipcRenderer.removeListener('screenshot:changed',listener);},
  requestPixels:request=>{
    const ticket=crypto.randomUUID();
    void ipcRenderer.invoke('screenshot:pixels',request).then(frame=>{
      const bytes=frame.data as Uint8Array;
      const data=bytes.byteOffset===0&&bytes.byteLength===bytes.buffer.byteLength?bytes.buffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
      window.postMessage({source:'lasso-pixels',ticket,width:frame.width,height:frame.height,data},'*',[data as ArrayBuffer]);
    }).catch(error=>window.postMessage({source:'lasso-pixels',ticket,error:(error as Error).message},'*'));
    return ticket;
  },
  loadError:id=>ipcRenderer.send('screenshot:load-error',id),
  action:a=>ipcRenderer.invoke('screenshot:action',a),
  scrollAction:action=>ipcRenderer.invoke('screenshot:scroll-action',action),
  recognize:frame=>ipcRenderer.invoke('screenshot:recognize',frame),
  invalidateOCR:request=>ipcRenderer.send('screenshot:invalidate-ocr',request),
  export:(frame,action,format)=>ipcRenderer.invoke('screenshot:export',frame,action,format),
  copyText:request=>ipcRenderer.invoke('screenshot:copy-text',request),
  sendText:request=>ipcRenderer.invoke('screenshot:send-text',request)
};
contextBridge.exposeInMainWorld('screenshot',api);
