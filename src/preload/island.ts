import { contextBridge, ipcRenderer } from 'electron';
import type { ClipboardWindowState, EdgeNotesState, FinderPanelState, IslandAPI, IslandState, TranslatorWindowState } from '../shared/contracts';
import { on } from './bridge';

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
  setNookReminderPrefs: patch => ipcRenderer.invoke('island:nook-prefs', patch),
  setCopyTranslate: enabled => ipcRenderer.invoke('island:copy-translate', enabled),
  getTranslatorState: () => ipcRenderer.invoke('translator:state'),
  translateInput: req => ipcRenderer.invoke('translator:translate', req),
  cancelTranslation: () => ipcRenderer.send('translator:cancel'),
  setTranslatorLang: lang => ipcRenderer.invoke('translator:lang', lang),
  setTranslatorPinned: pinned => ipcRenderer.invoke('translator:pinned', pinned),
  translatorAct: (action, text) => ipcRenderer.invoke('translator:act', action, text),
  closeTranslator: () => ipcRenderer.send('translator:close'),
  onTranslatorState: callback => on<TranslatorWindowState>('translator:changed', callback),
  getClipboardState: () => ipcRenderer.invoke('clipboard-history:state'),
  clipboardAct: req => ipcRenderer.invoke('clipboard-history:act', req),
  closeClipboard: () => ipcRenderer.send('clipboard-history:close'),
  onClipboardState: callback => on<ClipboardWindowState>('clipboard-history:changed', callback),
  snapWindow: slot => ipcRenderer.invoke('island:snap-window', slot),
  focusTask: taskId => ipcRenderer.invoke('island:focus-task', taskId),
  onState: callback => on<IslandState>('island:changed', callback),

  getNotesState: () => ipcRenderer.invoke('notes:state'),
  setNotesOpen: open => ipcRenderer.send('notes:open', open),
  selectNote: id => ipcRenderer.invoke('notes:select', id),
  saveNote: (id, content) => ipcRenderer.invoke('notes:save', id, content),
  createNote: title => ipcRenderer.invoke('notes:create', title),
  deleteNote: name => ipcRenderer.invoke('notes:delete', name),
  setNotesPinned: pinned => ipcRenderer.invoke('notes:set-pinned', pinned),
  pinNoteToDesktop: id => ipcRenderer.invoke('notes:pin', id),
  onNotesState: callback => on<EdgeNotesState>('notes:changed', callback),

  getFinderState: () => ipcRenderer.invoke('finder:state'),
  finderAction: req => ipcRenderer.invoke('island:finder-action', req),
  finderClose: () => ipcRenderer.send('finder:close'),
  onFinderState: callback => on<FinderPanelState>('finder:changed', callback)
};

contextBridge.exposeInMainWorld('island', api);
