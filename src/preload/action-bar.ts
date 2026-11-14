import { contextBridge, ipcRenderer } from 'electron';
import type { ActionBarAPI, ActionBarLayout, ActionBarState } from '../shared/contracts';
import { on } from './bridge';

const api: ActionBarAPI = {
  getState: () => ipcRenderer.invoke('bar:state'),
  runItem: id => ipcRenderer.invoke('bar:run', id),
  menu: open => ipcRenderer.send('bar:menu', open),
  settings: () => ipcRenderer.send('bar:settings'),
  resize: width => ipcRenderer.send('bar:resize', width),
  cardHeight: height => ipcRenderer.send('bar:card-height', height),
  closeFastCard: () => ipcRenderer.send('bar:fast-close'),
  retryFastCard: () => ipcRenderer.invoke('bar:fast-retry'),
  continueFastInChat: () => ipcRenderer.invoke('bar:fast-continue'),
  copyFastResult: text => ipcRenderer.invoke('bar:fast-copy', text),
  replaceSelection: text => ipcRenderer.invoke('bar:fast-replace', text),
  noteFastResult: text => ipcRenderer.invoke('bar:fast-note', text),
  pinFastResult: text => ipcRenderer.invoke('bar:fast-pin', text),
  hit: inside => ipcRenderer.send('bar:hit', inside),
  onState: callback => on<ActionBarState>('bar:changed', callback),
  onEnter: callback => on<ActionBarLayout>('bar:enter', callback)
};
contextBridge.exposeInMainWorld('actionBar', api);
