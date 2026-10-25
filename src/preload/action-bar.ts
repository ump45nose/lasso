import { contextBridge, ipcRenderer } from 'electron';
import type { ActionBarAPI, ActionBarLayout, ActionBarState } from '../shared/contracts';
function on<T>(channel: string, callback: (value: T) => void) {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}
const api: ActionBarAPI = {
  getState: () => ipcRenderer.invoke('bar:state'),
  runPreset: id => ipcRenderer.invoke('bar:run', id),
  menu: open => ipcRenderer.send('bar:menu', open),
  settings: () => ipcRenderer.send('bar:settings'),
  resize: width => ipcRenderer.send('bar:resize', width),
  hit: inside => ipcRenderer.send('bar:hit', inside),
  onState: callback => on<ActionBarState>('bar:changed', callback),
  onEnter: callback => on<ActionBarLayout>('bar:enter', callback)
};
contextBridge.exposeInMainWorld('actionBar', api);
