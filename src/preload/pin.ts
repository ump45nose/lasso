import { contextBridge, ipcRenderer } from 'electron';
import type { PinAPI, PinState } from '../shared/capture';
const api: PinAPI = {
  state:()=>ipcRenderer.invoke('pin:state'),
  onState:callback=>{const listener=(_event:Electron.IpcRendererEvent,state:PinState)=>callback(state);ipcRenderer.on('pin:changed',listener);return()=>ipcRenderer.removeListener('pin:changed',listener);},
  action:action=>ipcRenderer.invoke('pin:action',action),
  text:(text,send,revision)=>ipcRenderer.invoke('pin:text',text,send,revision)
};
contextBridge.exposeInMainWorld('pin',api);
