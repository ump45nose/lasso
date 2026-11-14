import { app, BrowserWindow, screen } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import type { SettingsSection, ShellState } from '../shared/contracts';
import { closeOnCommandW, fromMainFrame, sealLocal } from './ipc';
import { fitToWorkArea } from './position';
import { setWindowPresence } from './window-presence';

const SETTINGS_W = 760, SETTINGS_H = 560;

/** Standalone 760×560 settings window that never auto-hides on blur. */
export class SettingsWindow {
  private win: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private quitting = false;
  private section: SettingsSection = 'general';

  constructor(private snapshot: () => ShellState) {
    app.on('before-quit', () => { this.quitting = true; });
  }

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  get activeSection(): SettingsSection {
    return this.section;
  }

  owns(event: IpcMainInvokeEvent): boolean {
    return Boolean(this.win && !this.win.isDestroyed() && fromMainFrame(event, this.win));
  }

  publish() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('shell:changed', { ...this.snapshot(), settingsSection: this.section });
    }
  }

  async open(section?: SettingsSection) {
    if (section) this.section = section;
    if (!this.win || this.win.isDestroyed()) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const width = Math.min(SETTINGS_W, area.width);
      const height = Math.min(SETTINGS_H, area.height);
      const win = new BrowserWindow({
        x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + (area.height - height) / 2),
        width,
        height,
        minWidth: 680,
        minHeight: 480,
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 14, y: 15 },
        show: false,
        backgroundColor: '#FAF9F5',
        title: 'Lasso 设置',
        fullscreenable: false,
        icon: join(app.getAppPath(), 'assets/lasso-icon.png'),
        webPreferences: {
          preload: join(__dirname, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      });
      this.win = win;
      sealLocal(win.webContents);
      closeOnCommandW(win);
      win.on('close', event => {
        if (!this.quitting) {
          event.preventDefault();
          win.hide();
          setWindowPresence(win, false);
        }
      });
      win.on('closed', () => {
        if (this.win === win) {
          this.win = null;
          this.ready = null;
        }
      });
      this.ready = win.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'settings' } });
    }
    await this.ready;
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    setWindowPresence(win, true, true);
    win.setBounds(fitToWorkArea(win.getBounds(), screen.getDisplayMatching(win.getBounds()).workArea));
    this.publish();
    if (win.isMinimized()) win.restore();
    win.show();
    app.focus({ steal: true });
    win.focus();
  }

  dispose() {
    this.quitting = true;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}
