import { contextBridge, ipcRenderer } from 'electron';
import type { MediaAPI, MediaState } from '../shared/media';

const api: MediaAPI = {
  state: () => ipcRenderer.invoke('media:state'),
  onState: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: MediaState) => callback(state);
    ipcRenderer.on('media:changed', listener);
    return () => ipcRenderer.removeListener('media:changed', listener);
  },
  configure: input => ipcRenderer.invoke('media:configure', input),
  checkConnection: () => ipcRenderer.invoke('media:check-connection'),
  setReference: id => ipcRenderer.invoke('media:set-reference', id),
  prepareReference: () => ipcRenderer.invoke('media:prepare-reference'),
  generate: request => ipcRenderer.invoke('media:generate', request),
  output: (id, action) => ipcRenderer.invoke('media:output', id, action),
  remove: id => ipcRenderer.invoke('media:remove', id),
  hide: () => ipcRenderer.invoke('media:hide')
};
contextBridge.exposeInMainWorld('media', api);
