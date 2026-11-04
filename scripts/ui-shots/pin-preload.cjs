// Fixture stand-in for pin-preload: serves the pin state main stores for ui-shots.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pin', {
  state: () => ipcRenderer.invoke('ui-shots:pin'),
  onState: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('ui-shots:pin-changed', listener); return () => ipcRenderer.removeListener('ui-shots:pin-changed', listener); },
  action: action => ipcRenderer.invoke('ui-shots:pin-action', action),
  source: () => ipcRenderer.invoke('ui-shots:pin-source'),
  text: (...args) => ipcRenderer.invoke('ui-shots:pin-update', 'text', ...args),
  setOpacity: value => ipcRenderer.invoke('ui-shots:pin-update', 'opacity', value),
  setZoom: value => ipcRenderer.invoke('ui-shots:pin-update', 'zoom', value),
  setGroup: value => ipcRenderer.invoke('ui-shots:pin-update', 'group', value),
  setTitle: value => ipcRenderer.invoke('ui-shots:pin-update', 'title', value),
  updateText: value => ipcRenderer.invoke('ui-shots:pin-update', 'updateText', value),
  startDrag: () => ipcRenderer.send('ui-shots:pin-drag', 'start'),
  drag: () => ipcRenderer.send('ui-shots:pin-drag', 'move'),
  endDrag: () => ipcRenderer.send('ui-shots:pin-drag', 'end')
});
contextBridge.exposeInMainWorld('pinWorkspace', {
  pinWorkspace: () => ipcRenderer.invoke('shell:pin-workspace'),
  savePinWorkspace: settings => ipcRenderer.invoke('shell:pin-workspace-save', settings),
  createPin: input => ipcRenderer.invoke('shell:pin-create', input),
  pinClipboard: () => ipcRenderer.invoke('shell:pin-clipboard'),
  reopenClosedPin: () => ipcRenderer.invoke('shell:pin-reopen'),
  arrangePins: (mode, groupId) => ipcRenderer.invoke('shell:pins-arrange', mode, groupId),
  actPin: (id, action, groupId) => ipcRenderer.invoke('shell:pin-act', id, action, groupId),
  onChanged: callback => { const listener = (_event, state) => callback(state); ipcRenderer.on('pin-workspace:changed', listener); return () => ipcRenderer.removeListener('pin-workspace:changed', listener); },
  setToolbarHeight: height => ipcRenderer.send('ui-shots:toolbar-height', height),
  dropFiles: (files, text, groupId) => ipcRenderer.invoke('ui-shots:pin-drop', files.map(file => ({ name: file.name, type: file.type, size: file.size })), text, groupId)
});
contextBridge.exposeInMainWorld('screenshot', {
  ready: () => {}, loadError: () => {}, onSuspend: () => () => {}, invalidateOCR: () => {},
  recognize: async request => ({ id:request.id, revision:request.revision, lines:[] }),
  action: action => ipcRenderer.invoke('ui-shots:pin-action', action),
  saveAnnotationMemory: memory => ipcRenderer.invoke('ui-shots:annotation-memory', memory),
  export: (frame, action, format, contentMode) => ipcRenderer.invoke('ui-shots:export', frame, action, format, contentMode),
  copyText: async () => {}, sendText: async () => ({ error:null })
});
