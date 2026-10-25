import { BrowserWindow, ipcMain, Menu, screen } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { WindowMotion } from './motion';
import { fitToWorkArea } from './position';
import type { ActionBarState, ActionBarTip, Preset, SelectionContext, Settings } from '../shared/contracts';

// The window is transparent: the 40px capsule sits between two tip bands, with side room for its CSS shadow.
const BAR = 40, TIP = 36, SIDE = 16, GAP = 10, HEIGHT = TIP * 2 + BAR;

export class ActionBar {
  readonly window: BrowserWindow;
  private motion: WindowMotion;
  private selection: SelectionContext | null = null;
  private presets: Preset[] = [];
  private fonts: ActionBarState['fonts'] = { fonts: { display: '', text: '', ui: '', mono: '' }, importedFonts: [] };
  private busy = false;
  constructor(private run: (id: string, selection: SelectionContext) => Promise<void>, private settings: () => void) {
    this.window = new BrowserWindow({
      width: 340 + SIDE * 2, height: HEIGHT, frame: false, show: false, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true, acceptFirstMouse: true,
      transparent: true, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { preload: join(__dirname, 'action-bar-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    this.motion = new WindowMotion(this.window);
    this.window.setIgnoreMouseEvents(true, { forward: true });
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
      ]).popup({ window: this.window, callback: () => { if (!this.window.isDestroyed()) this.window.webContents.send('bar:menu-closed'); } });
    });
    ipcMain.on('bar:hit', (event, inside: boolean) => { check(event); this.window.setIgnoreMouseEvents(!inside, { forward: true }); });
    ipcMain.on('bar:resize', (event, width: number) => {
      check(event);
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
        this.window.setSize(Math.min(900, Math.ceil(width)) + SIDE * 2, HEIGHT);
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
  /** Places the capsule above the selection (below when there is no room) and returns the side free for the tip. */
  private position(selection: SelectionContext): ActionBarTip {
    const a = selection.anchor;
    const area = screen.getDisplayNearestPoint({ x: a.x, y: a.y }).workArea;
    const [width] = this.window.getSize();
    const above = a.y - BAR - GAP >= area.y;
    const barY = above ? a.y - BAR - GAP : a.y + a.height + GAP;
    // Only the capsule has to stay on screen; the transparent tip bands may hang past the work area.
    const bounds = fitToWorkArea({ x: a.x - SIDE, y: barY - TIP, width, height: HEIGHT }, { ...area, y: area.y - TIP, height: area.height + TIP * 2 });
    this.window.setBounds(bounds);
    const top = bounds.y + TIP;
    return above ? (top - TIP >= area.y ? 'above' : 'below') : (top + BAR + TIP <= area.y + area.height ? 'below' : 'above');
  }
  show(selection: SelectionContext) {
    this.selection = selection;
    if (!this.presets.some(p => p.enabled) || this.busy) return;
    const tip = this.position(selection);
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.motion.show(true);
    this.window.webContents.send('bar:enter', tip);
  }
  /** Hit-tests the capsule only, so a click on the transparent margin still counts as outside. */
  contains(point: { x: number; y: number }) {
    const b = this.window.getBounds();
    return this.window.isVisible() && point.x >= b.x + SIDE && point.x <= b.x + b.width - SIDE && point.y >= b.y + TIP && point.y <= b.y + TIP + BAR;
  }
  hide() { this.selection = null; this.window.setIgnoreMouseEvents(true, { forward: true }); this.motion.hide(); }
  destroy() { this.motion.dispose(); this.window.destroy(); }
}
