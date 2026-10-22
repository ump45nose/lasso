import { contextBridge, ipcRenderer } from 'electron';
import type { ActionBarAPI, ActionBarState } from '../shared/contracts';
const api: ActionBarAPI = {
  getState: () => ipcRenderer.invoke('bar:state'),
  runPreset: id => ipcRenderer.invoke('bar:run', id),
  more: () => ipcRenderer.send('bar:more'),
  resize: width => ipcRenderer.send('bar:resize', width),
  onState: callback => {
    const listener = (_event: Electron.IpcRendererEvent, value: ActionBarState) => callback(value);
    ipcRenderer.on('bar:changed', listener);
    return () => ipcRenderer.removeListener('bar:changed', listener);
  }
};
contextBridge.exposeInMainWorld('actionBar', api);
