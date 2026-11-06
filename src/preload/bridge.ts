import { ipcRenderer } from 'electron';
import type { PinWorkspaceCalls } from '../shared/capture';

export function on<T>(channel: string, callback: (value: T) => void) {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

export const pinWorkspaceCalls: PinWorkspaceCalls = {
  pinWorkspace: () => ipcRenderer.invoke('shell:pin-workspace'),
  savePinWorkspace: settings => ipcRenderer.invoke('shell:pin-workspace-save', settings),
  createPin: input => ipcRenderer.invoke('shell:pin-create', input),
  pinClipboard: () => ipcRenderer.invoke('shell:pin-clipboard'),
  reopenClosedPin: () => ipcRenderer.invoke('shell:pin-reopen'),
  arrangePins: (mode, groupId) => ipcRenderer.invoke('shell:pins-arrange', mode, groupId),
  actPin: (id, action, groupId) => ipcRenderer.invoke('shell:pin-act', id, action, groupId)
};
