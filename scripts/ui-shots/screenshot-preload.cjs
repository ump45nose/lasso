// Fixture stand-in for capture-preload: serves component states, fixed OCR, and records outputs locally.
// It never reaches the real clipboard, capture, image-generation service or user files.
const { contextBridge, ipcRenderer } = require('electron');
const done = async () => ({ error: null });
contextBridge.exposeInMainWorld('screenshot', {
  state: () => ipcRenderer.invoke('ui-shots:state').then(state=>({...state,imageFrame:state.image?'fixture-image':undefined,backdropFrame:state.backdrop?'fixture-backdrop':undefined})),
  requestPixels: request=>{const ticket=crypto.randomUUID();void ipcRenderer.invoke('ui-shots:pixels',request.frameId).then(frame=>{const bytes=frame.data;const data=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);window.postMessage({source:'lasso-pixels',ticket,width:frame.width,height:frame.height,data},'*',[data]);});return ticket;},
  loadError:()=>{},
  ready: () => {},
  onState: () => () => {},
  action:done, scrollAction:done,
  recognize: async request => ({ id: request.id, revision: request.revision, lines: [{ x: 24, y: 40, width: 260, height: 26, text: '示例识别文字', confidence: 0.95, glyphs: [...'示例识别文字'].map((text, i) => ({ x: 24 + i * 43, y: 40, width: 42, height: 26, text })) }] }),
  invalidateOCR: () => {}, export: (frame, action, format) => ipcRenderer.invoke('ui-shots:export', frame, action, format), copyText: async () => {}, sendText: done
});
