// Fixture stand-in for pin-preload: serves the pin state main stores for ui-shots.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pin', {
  state: () => ipcRenderer.invoke('ui-shots:pin'),
  onState: () => () => {},
  action: async () => ({ error: null }),
  text: async () => ({ error: null })
});
