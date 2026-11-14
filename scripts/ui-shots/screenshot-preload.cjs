// Fixture stand-in for capture-preload: serves component states and fixed OCR locally.
const { contextBridge, ipcRenderer } = require('electron');
const done = async () => ({ error: null });
contextBridge.exposeInMainWorld('screenshot', {
  updateRegion: r => ipcRenderer.invoke('ui-shots:region', r),
  lastRegion: async () => null,
  clearRegion: () => ipcRenderer.invoke('ui-shots:clear-region'),
  startScroll: done,
  startRecording: done,
  saveRegionPreset: async () => {},
  deleteRegionPreset: async () => {},
  state: () =>
    ipcRenderer
      .invoke('ui-shots:state')
      .then(state => ({ ...state, imageFrame: state.image ? 'fixture-image' : undefined, backdropFrame: state.backdrop ? 'fixture-backdrop' : undefined })),
  requestPixels: request => {
    const ticket = crypto.randomUUID();
    void ipcRenderer.invoke('ui-shots:pixels', request.frameId).then(frame => {
      const bytes = frame.data;
      const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      window.postMessage({ source: 'lasso-pixels', ticket, width: frame.width, height: frame.height, data }, '*', [data]);
    });
    return ticket;
  },
  loadError: () => {},
  ready: () => {},
  onState: cb => {
    const listener = (_e, s) => cb(s);
    ipcRenderer.on('ui-shots:changed', listener);
    return () => ipcRenderer.removeListener('ui-shots:changed', listener);
  },
  onSuspend: () => () => {},
  action: action => ipcRenderer.invoke('ui-shots:screenshot-action', action),
  scrollAction: request => ipcRenderer.invoke('ui-shots:scroll-action', request),
  analyze: request => ipcRenderer.invoke('ui-shots:analyze', request),
  visionLanguage: async () => '简体中文',
  previewFormula: async () => ({ svg: '', error: null }),
  openURL: done,
  exportTable: async () => ({ path: null, error: null }),
  pinFormula: done,
  recognize: request => ipcRenderer.invoke('ui-shots:recognize', request),
  invalidateOCR: () => {},
  export: (frame, action, format, contentMode, presetId) => ipcRenderer.invoke('ui-shots:export', frame, action, format, contentMode, presetId),
  saveAnnotationMemory: async () => {},
  copyText: done,
  sendText: done,
  fastText: done,
  translateText: done,
  askPreset: done,
  noteText: done
});
