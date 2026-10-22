import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, ShellState } from '../shared/contracts';
const api: DesktopAPI = {
  getState: () => ipcRenderer.invoke('shell:state'),
  act: action => ipcRenderer.invoke('shell:action', action),
  saveShortcut: shortcut => ipcRenderer.invoke('shell:shortcut', shortcut),
  saveCapture: options => ipcRenderer.invoke('shell:capture', options),
  savePresets: presets => ipcRenderer.invoke('shell:presets-save', presets),
  runPreset: id => ipcRenderer.invoke('shell:preset-run', id),
  selectTask: id => ipcRenderer.invoke('shell:task-select', id),
  closeTask: id => ipcRenderer.invoke('shell:task-close', id),
  taskOverflow: (visibleIds, x) => ipcRenderer.invoke('shell:task-overflow', visibleIds, x),
  onState: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: ShellState) => callback(state);
    ipcRenderer.on('shell:changed', listener);
    return () => ipcRenderer.removeListener('shell:changed', listener);
  }
};
contextBridge.exposeInMainWorld('desktop', api);
