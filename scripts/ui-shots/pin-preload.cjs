// Fixture stand-in for pin-preload: serves the pin state main stores for ui-shots.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pin', {
  state: () => ipcRenderer.invoke('ui-shots:pin'),
  onState: () => () => {},
  action: action => ipcRenderer.invoke('ui-shots:pin-action', action),
  text: async () => ({ error: null }),
  startDrag: () => {},
  drag: () => {},
  endDrag: () => {}
});
