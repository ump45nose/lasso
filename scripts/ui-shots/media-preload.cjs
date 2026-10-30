// Component fixtures only. No generation request, clipboard read or user image upload.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('media', {
  state: () => ipcRenderer.invoke('ui-shots:media-state'),
  onState: callback => { const fn = (_event, value) => callback(value); ipcRenderer.on('media:changed', fn); return () => ipcRenderer.removeListener('media:changed', fn); },
  setReference: id => ipcRenderer.invoke('ui-shots:media-reference', id),
  restore: (id, edit, imageId) => ipcRenderer.invoke('ui-shots:media-restore', id, edit, imageId),
  choosePreset: async () => {},
  saveDraft: async () => {},
  generate: request => ipcRenderer.invoke('ui-shots:media-generate', request),
  output: async () => ({ error: null }),
  remove: () => ipcRenderer.invoke('ui-shots:media-state'),
  hide: async () => {}
});
