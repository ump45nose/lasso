import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { PinAPI, PinState, PinWorkspaceAPI, ScreenshotAPI } from '../shared/capture';
import type { PinWorkspaceState } from '../shared/history-sync';
import { on, pinWorkspaceCalls } from './bridge';
const api: PinAPI = {
  state:()=>ipcRenderer.invoke('pin:state'),
  onState:callback=>on<PinState>('pin:changed',callback),
  action:action=>ipcRenderer.invoke('pin:action',action),
  setOpacity:opacity=>ipcRenderer.invoke('pin:set-opacity',opacity),
  setZoom:factor=>ipcRenderer.invoke('pin:set-zoom',factor),
  setGroup:groupId=>ipcRenderer.invoke('pin:set-group',groupId),
  updateText:text=>ipcRenderer.invoke('pin:update-text',text),
  text:(text,send,revision)=>ipcRenderer.invoke('pin:text',text,send,revision),
  source:()=>ipcRenderer.invoke('pin:source'),
  startDrag:()=>ipcRenderer.send('pin:drag-start'),
  drag:()=>ipcRenderer.send('pin:drag-move'),
  endDrag:()=>ipcRenderer.send('pin:drag-end')
};
const screenshot: ScreenshotAPI = {
  onSuspend:()=>()=>{},
  updateRegion:async()=>{},
  lastRegion:async()=>null,
  clearRegion:async()=>{},
  startScroll:async()=>({error:'贴图编辑不支持长截图'}),
  saveRegionPreset:async()=>{},
  ready:()=>{},
  state:async()=>null,
  onState:()=>()=>{},
  requestPixels:()=>{throw Error('贴图编辑直接读取图片');},
  loadError:()=>{},
  action:action=>ipcRenderer.invoke('pin:editor-action',action),
  scrollAction:async()=>({error:null}),
  recognize:frame=>ipcRenderer.invoke('pin:editor-recognize',frame),
  analyze:request=>ipcRenderer.invoke('pin:editor-analyze',request),
  visionLanguage:()=>ipcRenderer.invoke('pin:editor-vision-language'),
  previewFormula:request=>ipcRenderer.invoke('pin:editor-preview-formula',request),
  openURL:request=>ipcRenderer.invoke('pin:editor-open-url',request),
  exportTable:rows=>ipcRenderer.invoke('pin:editor-export-table',rows),
  pinFormula:latex=>ipcRenderer.invoke('pin:editor-pin-formula',latex),
  invalidateOCR:request=>ipcRenderer.send('pin:editor-invalidate',request),
  export:(frame,action,format,contentMode)=>ipcRenderer.invoke('pin:editor-export',frame,action,format,contentMode),
  saveAnnotationMemory:memory=>ipcRenderer.invoke('screenshot:save-annotation-memory',memory),
  copyText:request=>ipcRenderer.invoke('pin:editor-copy-text',request),
  sendText:request=>ipcRenderer.invoke('pin:editor-send',request)
};
contextBridge.exposeInMainWorld('pin',api);
contextBridge.exposeInMainWorld('screenshot',screenshot);
const workspace: PinWorkspaceAPI = {
  ...pinWorkspaceCalls,
  onChanged:callback=>on<PinWorkspaceState>('pin-workspace:changed',callback),
  setToolbarHeight:height=>ipcRenderer.send('pin-toolbar:height',height),
  dropFiles:async(files,text,groupId)=>{
    for(const file of files){
      const filePath=webUtils.getPathForFile(file);
      if(!filePath)return {error:'请拖入本地图片或文件'};
      const kind=file.type.startsWith('image/')||/\.(png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/i.test(file.name)?'image':'file';
      const result=await pinWorkspaceCalls.createPin({kind,filePath,groupId});if(result.error)return result;
    }
    return files.length?{error:null}:text.trim()?pinWorkspaceCalls.createPin({kind:'text',text,groupId}):{error:'请拖入文件、图片或文字'};
  }
};
contextBridge.exposeInMainWorld('pinWorkspace',workspace);
