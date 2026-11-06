import { contextBridge, ipcRenderer } from 'electron';
import type { MediaAPI, MediaState } from '../shared/media';
import { on } from './bridge';

const api: MediaAPI = {
  saveDraft: (id,prompt) => ipcRenderer.invoke('media:draft',id,prompt),
  state: () => ipcRenderer.invoke('media:state'),
  onState: callback => on<MediaState>('media:changed', callback),
  setReference: id => ipcRenderer.invoke('media:set-reference', id),
  restore: (id, edit, imageId) => ipcRenderer.invoke('media:restore', id, edit, imageId),
  choosePreset: () => ipcRenderer.invoke('media:choose-preset'),
  generate: request => ipcRenderer.invoke('media:generate', request),
  output: (id, action, imageId) => ipcRenderer.invoke('media:output', id, action, imageId),
  remove: id => ipcRenderer.invoke('media:remove', id),
  hide: () => ipcRenderer.invoke('media:hide')
};
contextBridge.exposeInMainWorld('media', api);
