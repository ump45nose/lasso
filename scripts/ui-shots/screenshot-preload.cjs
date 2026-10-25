// Fixture stand-in for capture-preload: serves the state main stores for ui-shots, with a fixed OCR line and no-op outputs.
const { contextBridge, ipcRenderer } = require('electron');
const done = async () => ({ error: null });
contextBridge.exposeInMainWorld('screenshot', {
  state: () => ipcRenderer.invoke('ui-shots:state'),
  onState: () => () => {},
  hover: () => {}, select: async () => {}, action: done, captureWindow: done,
  startScroll:done, scrollAction:done,
  recognize: async request => ({ id: request.id, revision: request.revision, lines: [{ x: 24, y: 40, width: 260, height: 26, text: '示例识别文字', confidence: 0.95, glyphs: [...'示例识别文字'].map((text, i) => ({ x: 24 + i * 43, y: 40, width: 42, height: 26, text })) }] }),
  invalidateOCR: () => {}, export: done, copyText: async () => {}, sendText: done
});
