import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, ShellState, AgentEvent } from '../shared/contracts';
const api: DesktopAPI = {
  openLink: url => ipcRenderer.invoke('shell:external', url),
  getState: () => ipcRenderer.invoke('shell:state'),
  act: action => ipcRenderer.invoke('shell:action', action),
  saveScreenshotShortcut: shortcut => ipcRenderer.invoke('shell:screenshot-shortcut', shortcut),
  saveShortcut: shortcut => ipcRenderer.invoke('shell:shortcut', shortcut),
  saveCapture: options => ipcRenderer.invoke('shell:capture', options),
  savePresets: presets => ipcRenderer.invoke('shell:presets-save', presets),
  runPreset: (id, options) => ipcRenderer.invoke('shell:preset-run', id, options),
  newTask: options => ipcRenderer.invoke('shell:new-task', options),
  saveIntegrations: value => ipcRenderer.invoke('shell:integrations', value),
  choosePath: kind => ipcRenderer.invoke('shell:choose-path', kind),
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
  selectTask: id => ipcRenderer.invoke('shell:task-select', id),
  closeTask: id => ipcRenderer.invoke('shell:task-close', id),
  taskOverflow: (visibleIds, x) => ipcRenderer.invoke('shell:task-overflow', visibleIds, x),
  onState: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: ShellState) => callback(state);
    ipcRenderer.on('shell:changed', listener);
    return () => ipcRenderer.removeListener('shell:changed', listener);
  }
};
contextBridge.exposeInMainWorld('desktop', api);
