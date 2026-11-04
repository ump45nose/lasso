// Fixture stand-in for capture-preload: serves component states, fixed OCR, and records outputs locally.
// It never reaches the real clipboard, capture, image-generation service or user files.
const { contextBridge, ipcRenderer } = require('electron');
const done = async () => ({ error: null });
contextBridge.exposeInMainWorld('screenshot', {
  recordingState:async()=>null,recordingAction:async()=>({state:null,error:null}),onRecording:()=>()=>{},
  updateRegion:r=>ipcRenderer.invoke('ui-shots:region',r), lastRegion:async()=>null,clearRegion:()=>ipcRenderer.invoke('ui-shots:clear-region'),startScroll:done,regions:async()=>({presets:[],displays:[]}),saveRegionPreset:async()=>{},
  state: () => ipcRenderer.invoke('ui-shots:state').then(state=>({...state,imageFrame:state.image?'fixture-image':undefined,backdropFrame:state.backdrop?'fixture-backdrop':undefined})),
  requestPixels: request=>{const ticket=crypto.randomUUID();void ipcRenderer.invoke('ui-shots:pixels',request.frameId).then(frame=>{const bytes=frame.data;const data=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);window.postMessage({source:'lasso-pixels',ticket,width:frame.width,height:frame.height,data},'*',[data]);});return ticket;},
  loadError:()=>{},
  ready: () => {},
  onState: cb=>{const listener=(_e,s)=>cb(s);ipcRenderer.on('ui-shots:changed',listener);return()=>ipcRenderer.removeListener('ui-shots:changed',listener);},
  onSuspend: () => () => {},
  action:done, scrollAction:request=>ipcRenderer.invoke('ui-shots:scroll-action',request),
  analyze: request=>ipcRenderer.invoke('ui-shots:analyze',request),
  visionLanguage: ()=>ipcRenderer.invoke('ui-shots:vision-language'),
  previewFormula: request=>ipcRenderer.invoke('ui-shots:formula-preview',request),
  openURL: request=>ipcRenderer.invoke('ui-shots:open-url',request),
  exportTable: request=>ipcRenderer.invoke('ui-shots:table-export',request), pinFormula:request=>ipcRenderer.invoke('ui-shots:formula-pin',request),
  recognize: request=>ipcRenderer.invoke('ui-shots:recognize',request),
  invalidateOCR: () => {}, export: (frame, action, format, contentMode) => ipcRenderer.invoke('ui-shots:export', frame, action, format, contentMode),
  saveAnnotationMemory: memory => ipcRenderer.invoke('ui-shots:annotation-memory', memory), copyText: request => ipcRenderer.invoke('ui-shots:editor-text', 'copy', request), sendText: request => ipcRenderer.invoke('ui-shots:editor-text', 'send', request)
});
