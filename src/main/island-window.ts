import { BrowserWindow } from 'electron';
import type { BrowserWindowConstructorOptions } from 'electron';
import { join } from 'node:path';
import { sealLocal } from './ipc';

export function createIslandWindow(width: number, height: number, options: Pick<BrowserWindowConstructorOptions, 'focusable' | 'fullscreenable' | 'enableLargerThanScreen'>) {
  const win = new BrowserWindow({
    width,
    height,
    frame: false,
    show: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: join(__dirname, 'island-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
    ...options
  });
  sealLocal(win.webContents);
  return win;
}
