import { contextBridge, ipcRenderer } from 'electron';
import type { EdgeNotesState, FinderPanelState, IslandAPI, IslandState } from '../shared/contracts';

function on<T>(channel: string, callback: (value: T) => void) {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

const api: IslandAPI = {
  getState: () => ipcRenderer.invoke('island:state'),
  setMode: mode => ipcRenderer.send('island:mode', mode),
  hit: inside => ipcRenderer.send('island:hit', inside),
  startPomodoro: (task, minutes, kind) => ipcRenderer.invoke('island:pomo-start', task, minutes, kind),
  togglePausePomodoro: () => ipcRenderer.invoke('island:pomo-pause'),
  stopPomodoro: () => ipcRenderer.invoke('island:pomo-stop'),
  completeTask: taskId => ipcRenderer.invoke('island:complete-task', taskId),
  snoozeAlert: (alertId, minutes) => ipcRenderer.invoke('island:snooze-alert', alertId, minutes),
  dismissAlert: alertId => ipcRenderer.invoke('island:dismiss-alert', alertId),
  restartService: label => ipcRenderer.invoke('island:restart-service', label),
  quickAction: action => ipcRenderer.invoke('island:quick', action),
  setGlow: enabled => ipcRenderer.invoke('island:glow', enabled),
  snapWindow: slot => ipcRenderer.invoke('island:snap-window', slot),
  onState: callback => on<IslandState>('island:changed', callback),

  getNotesState: () => ipcRenderer.invoke('notes:state'),
  setNotesOpen: open => ipcRenderer.send('notes:open', open),
  notesHit: inside => ipcRenderer.send('notes:hit', inside),
  selectNote: id => ipcRenderer.invoke('notes:select', id),
  saveNote: (id, content) => ipcRenderer.invoke('notes:save', id, content),
  createNote: title => ipcRenderer.invoke('notes:create', title),
  pinNoteToDesktop: id => ipcRenderer.invoke('notes:pin', id),
  onNotesState: callback => on<EdgeNotesState>('notes:changed', callback),

  getFinderState: () => ipcRenderer.invoke('finder:state'),
  finderCreateFile: ext => ipcRenderer.invoke('finder:create-file', ext),
  finderRunAction: action => ipcRenderer.invoke('finder:run-action', action),
  finderClose: () => ipcRenderer.send('finder:close'),
  onFinderState: callback => on<FinderPanelState>('finder:changed', callback)
};

contextBridge.exposeInMainWorld('island', api);
