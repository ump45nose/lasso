import { contextBridge, ipcRenderer } from 'electron';
import type { ActionBarAPI, ActionBarState, ActionBarTip } from '../shared/contracts';
function on<T>(channel: string, callback: (value: T) => void) {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}
const api: ActionBarAPI = {
  getState: () => ipcRenderer.invoke('bar:state'),
  runPreset: id => ipcRenderer.invoke('bar:run', id),
  more: () => ipcRenderer.send('bar:more'),
  resize: width => ipcRenderer.send('bar:resize', width),
  hit: inside => ipcRenderer.send('bar:hit', inside),
  onState: callback => on<ActionBarState>('bar:changed', callback),
  onEnter: callback => on<ActionBarTip>('bar:enter', callback),
  onMenuClosed: callback => on<void>('bar:menu-closed', callback)
};
contextBridge.exposeInMainWorld('actionBar', api);
