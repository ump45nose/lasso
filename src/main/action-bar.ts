import { BrowserWindow, ipcMain, Menu, screen } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { WindowMotion } from './motion';
import { fitToWorkArea } from './position';
import type { ActionBarState, Preset, SelectionContext, Settings } from '../shared/contracts';

export class ActionBar {
  readonly window: BrowserWindow;
  private motion: WindowMotion;
  private selection: SelectionContext | null = null;
  private presets: Preset[] = [];
  private fonts: ActionBarState['fonts'] = { fonts: { display: '', text: '', ui: '', mono: '' }, importedFonts: [] };
  private busy = false;
  constructor(private run: (id: string, selection: SelectionContext) => Promise<void>, private settings: () => void) {
    this.window = new BrowserWindow({
      width: 340, height: 46, frame: false, show: false, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true, acceptFirstMouse: true,
      backgroundColor: '#FFFEFB', roundedCorners: true,
      webPreferences: { preload: join(__dirname, 'action-bar-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    this.motion = new WindowMotion(this.window);
    this.window.setAlwaysOnTop(true, 'pop-up-menu');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', event => event.preventDefault());
    const check = (event: IpcMainEvent | IpcMainInvokeEvent) => {
      if (event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame) throw new Error('动作条来源不匹配');
    };
    ipcMain.handle('bar:state', event => { check(event); return this.snapshot(); });
    ipcMain.handle('bar:run', async (event, id: string) => { check(event); if (this.selection && !this.busy) await this.run(id, this.selection); });
    ipcMain.on('bar:more', event => {
      check(event);
      const selection = this.selection;
      Menu.buildFromTemplate([
        ...this.presets.filter(p => p.enabled).slice(4).map(p => ({ label: p.name, enabled: !this.busy, click: () => { if (selection) void this.run(p.id, selection); } })),
        { type: 'separator' }, { label: '预设设置…', click: () => { this.hide(); this.settings(); } }
      ]).popup({ window: this.window });
    });
    ipcMain.on('bar:resize', (event, width: number) => {
      check(event);
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
        this.window.setSize(Math.min(900, Math.ceil(width)), 46);
        if (this.selection) this.position(this.selection);
      }
    });
    void this.window.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'action-bar' } });
  }
  private snapshot(): ActionBarState { return { presets: this.presets.filter(p => p.enabled).slice(0, 4).map(({ id, name, target, mode }) => ({ id, name, target, mode })), busy: this.busy, fonts: this.fonts }; }
  update(presets: Preset[], busy: boolean, settings: Settings) {
    this.presets = presets; this.busy = busy; this.fonts = { fonts: settings.fonts, importedFonts: settings.importedFonts };
    this.window.webContents.send('bar:changed', this.snapshot());
    if (!presets.some(p => p.enabled)) this.hide();
  }
  private position(selection: SelectionContext) {
    const a = selection.anchor;
    const area = screen.getDisplayNearestPoint({ x: a.x, y: a.y }).workArea;
    const [width, height] = this.window.getSize();
    this.window.setBounds(fitToWorkArea({ x: a.x, y: a.y - height - 8 >= area.y ? a.y - height - 8 : a.y + a.height + 8, width, height }, area));
  }
  show(selection: SelectionContext) {
    this.selection = selection;
    if (!this.presets.some(p => p.enabled) || this.busy) return;
    this.position(selection);
    this.motion.show(true);
  }
  contains(point: { x: number; y: number }) {
    const b = this.window.getBounds();
    return this.window.isVisible() && point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height;
  }
  hide() { this.selection = null; this.motion.hide(); }
  destroy() { this.motion.dispose(); this.window.destroy(); }
}
