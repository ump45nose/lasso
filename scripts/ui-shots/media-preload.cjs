// Component fixtures only. No generation request, clipboard read or user image upload.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('media', {
  state: () => ipcRenderer.invoke('ui-shots:media-state'),
  onState: callback => { const fn = (_event, value) => callback(value); ipcRenderer.on('media:changed', fn); return () => ipcRenderer.removeListener('media:changed', fn); },
  configure: () => ipcRenderer.invoke('ui-shots:media-state'),
  checkConnection: async () => ({ message: '服务连接正常；生成/改图能力以实际请求为准。' }),
  models: async () => ['gpt-image-example', 'configured-generation-model'],
  openFile: async () => ({ error: null }),
  setReference: id => ipcRenderer.invoke('ui-shots:media-reference', id),
  prepareReference: async () => ({ error: '组件示例：请在现有编辑器完成裁剪和隐私处理。' }),
  generate: request => ipcRenderer.invoke('ui-shots:media-generate', request),
  output: async () => ({ error: null }),
  remove: () => ipcRenderer.invoke('ui-shots:media-state'),
  hide: async () => {}
});
