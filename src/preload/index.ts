import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, ShellState, AgentEvent, PaletteEvent } from '../shared/contracts';
const api: DesktopAPI = {
  attachImage: prompt => ipcRenderer.invoke('shell:attach-image', prompt),
  mediaConfig: () => ipcRenderer.invoke('shell:media-config'),
  saveMediaConfig: input => ipcRenderer.invoke('shell:media-config-save', input),
  mediaModels: () => ipcRenderer.invoke('shell:media-models'),
  openImagePresets: () => ipcRenderer.invoke('shell:image-presets'),
  openLink: url => ipcRenderer.invoke('shell:external', url),
  getState: () => ipcRenderer.invoke('shell:state'),
  act: action => ipcRenderer.invoke('shell:action', action),
  screenshot: (mode,delay) => ipcRenderer.invoke('shell:screenshot', mode,delay),
  cancelScreenshot:()=>ipcRenderer.invoke('shell:screenshot-cancel'),
  openLocalImage: () => ipcRenderer.invoke('shell:local-image-open'),
  saveCaptureShortcut: (mode, shortcut) => ipcRenderer.invoke('shell:capture-shortcut', mode, shortcut),
  saveShortcut: shortcut => ipcRenderer.invoke('shell:shortcut', shortcut),
  saveScreenshot: options => ipcRenderer.invoke('shell:screenshot-settings', options),
  ocrLanguages: () => ipcRenderer.invoke('shell:ocr-languages'),
  saveCapture: options => ipcRenderer.invoke('shell:capture', options),
  savePresets: presets => ipcRenderer.invoke('shell:presets-save', presets),
  runPreset: (id, options) => ipcRenderer.invoke('shell:preset-run', id, options),
  newTask: options => ipcRenderer.invoke('shell:new-task', options),
  saveIntegrations: value => ipcRenderer.invoke('shell:integrations', value),
  choosePath: kind => ipcRenderer.invoke('shell:choose-path', kind),
  appIcon: bundleId => ipcRenderer.invoke('shell:app-icon', bundleId),
  readImage: id => ipcRenderer.invoke('shell:image', id),
  removeImage: id => ipcRenderer.invoke('shell:image-remove', id),
  editImage: id => ipcRenderer.invoke('shell:image-edit', id),
  removeText: () => ipcRenderer.invoke('shell:text-remove'),
  getAgent: id => ipcRenderer.invoke('agent:state', id),
  agentDraft: (id, text) => ipcRenderer.invoke('agent:draft', id, text),
  agentSend: id => ipcRenderer.invoke('agent:send', id),
  agentStop: id => ipcRenderer.invoke('agent:stop', id),
  executionCatalog: (target, model, refresh) => ipcRenderer.invoke('shell:execution-catalog', target, model, refresh),
  agentEffort: (id, effort) => ipcRenderer.invoke('agent:effort', id, effort),
  agentRefreshModels: id => ipcRenderer.invoke('agent:models-refresh', id),
  agentModel: (id, model) => ipcRenderer.invoke('agent:model', id, model),
  agentAnswer: (id, requestId, answer) => ipcRenderer.invoke('agent:answer', id, requestId, answer),
  onAgent: callback => {
    const listener = (_event: Electron.IpcRendererEvent, event: AgentEvent) => callback(event);
    ipcRenderer.on('agent:changed', listener); return () => ipcRenderer.removeListener('agent:changed', listener);
  },
  saveFonts: fonts => ipcRenderer.invoke('shell:fonts', fonts),
  importFont: () => ipcRenderer.invoke('shell:font-import'),
  removeFont: file => ipcRenderer.invoke('shell:font-remove', file),
  selectTask: id => ipcRenderer.invoke('shell:task-select', id),
  closeTask: id => ipcRenderer.invoke('shell:task-close', id),
  openPalette: scope => ipcRenderer.invoke('shell:palette-open', scope),
  closePalette: () => ipcRenderer.invoke('shell:palette-close'),
  onPalette: callback => {
    const listener = (_event: Electron.IpcRendererEvent, event: PaletteEvent) => callback(event);
    ipcRenderer.on('shell:palette', listener); return () => ipcRenderer.removeListener('shell:palette', listener);
  },
  onState: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: ShellState) => callback(state);
    ipcRenderer.on('shell:changed', listener);
    return () => ipcRenderer.removeListener('shell:changed', listener);
  }
};
contextBridge.exposeInMainWorld('desktop', api);
