import { contextBridge, ipcRenderer } from 'electron';
import type { PinAPI, PinState, ScreenshotAPI } from '../shared/capture';
const api: PinAPI = {
  state:()=>ipcRenderer.invoke('pin:state'),
  onState:callback=>{const listener=(_event:Electron.IpcRendererEvent,state:PinState)=>callback(state);ipcRenderer.on('pin:changed',listener);return()=>ipcRenderer.removeListener('pin:changed',listener);},
  action:action=>ipcRenderer.invoke('pin:action',action),
  setOpacity:opacity=>ipcRenderer.invoke('pin:set-opacity',opacity),
  setZoom:factor=>ipcRenderer.invoke('pin:set-zoom',factor),
  setGroup:groupId=>ipcRenderer.invoke('pin:set-group',groupId),
  setTitle:title=>ipcRenderer.invoke('pin:set-title',title),
  updateText:text=>ipcRenderer.invoke('pin:update-text',text),
  text:(text,send,revision)=>ipcRenderer.invoke('pin:text',text,send,revision),
  source:()=>ipcRenderer.invoke('pin:source'),
  startDrag:()=>ipcRenderer.send('pin:drag-start'),
  drag:()=>ipcRenderer.send('pin:drag-move'),
  endDrag:()=>ipcRenderer.send('pin:drag-end')
};
const screenshot: ScreenshotAPI = {
  onSuspend:()=>()=>{},
  updateRegion:async()=>{},
  lastRegion:async()=>null,
  clearRegion:async()=>{},
  startScroll:async()=>({error:'贴图编辑不支持长截图'}),
  regions:async()=>({presets:[],displays:[]}),
  saveRegionPreset:async()=>{},
  ready:()=>{},
  state:async()=>null,
  onState:()=>()=>{},
  requestPixels:()=>{throw Error('贴图编辑直接读取图片');},
  loadError:()=>{},
  action:action=>ipcRenderer.invoke('pin:editor-action',action),
  scrollAction:async()=>({error:null}),
  recognize:frame=>ipcRenderer.invoke('pin:editor-recognize',frame),
  invalidateOCR:request=>ipcRenderer.send('pin:editor-invalidate',request),
  export:(frame,action,format,contentMode)=>ipcRenderer.invoke('pin:editor-export',frame,action,format,contentMode),
  saveAnnotationMemory:memory=>ipcRenderer.invoke('screenshot:save-annotation-memory',memory),
  copyText:request=>ipcRenderer.invoke('pin:editor-copy-text',request),
  sendText:request=>ipcRenderer.invoke('pin:editor-send',request)
};
contextBridge.exposeInMainWorld('pin',api);
contextBridge.exposeInMainWorld('screenshot',screenshot);
