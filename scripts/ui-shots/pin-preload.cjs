// Fixture stand-in for pin-preload: serves the pin state main stores for ui-shots.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pin', {
  state: () => ipcRenderer.invoke('ui-shots:pin'),
  onState: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('ui-shots:pin-changed', listener); return () => ipcRenderer.removeListener('ui-shots:pin-changed', listener); },
  action: action => ipcRenderer.invoke('ui-shots:pin-action', action),
  source: () => ipcRenderer.invoke('ui-shots:pin-source'),
  text: async () => ({ error: null }),
  startDrag: () => {},
  drag: () => {},
  endDrag: () => {}
});
contextBridge.exposeInMainWorld('screenshot', {
  ready: () => {}, loadError: () => {}, onSuspend: () => () => {}, invalidateOCR: () => {},
  recognize: async request => ({ id:request.id, revision:request.revision, lines:[] }),
  action: action => ipcRenderer.invoke('ui-shots:pin-action', action),
  saveAnnotationMemory: memory => ipcRenderer.invoke('ui-shots:annotation-memory', memory),
  export: (frame, action, format, contentMode) => ipcRenderer.invoke('ui-shots:export', frame, action, format, contentMode),
  copyText: async () => {}, sendText: async () => ({ error:null })
});
