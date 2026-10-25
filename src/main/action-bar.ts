import { BrowserWindow, ipcMain, screen } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { WindowMotion } from './motion';
import { fitToWorkArea } from './position';
import { BAR_MENU, barMenuHeight, type ActionBarLayout, type ActionBarState, type Preset, type SelectionContext, type Settings } from '../shared/contracts';

// The window is transparent: the 40px capsule sits between two tip bands, with side room for its CSS shadow.
// While the ··· menu is open, the band on the menu side grows to hold it.
const BAR = 40, TIP = 36, SIDE = 16, GAP = 10, HEIGHT = TIP * 2 + BAR, VISIBLE = 4, MENU_EDGE = 6;

export class ActionBar {
  readonly window: BrowserWindow;
  private motion: WindowMotion;
  private selection: SelectionContext | null = null;
  private presets: Preset[] = [];
  private fonts: ActionBarState['fonts'] = { fonts: { display: '', text: '', ui: '', mono: '' }, importedFonts: [] };
  private busy = false;
  private width = 340;
  private bar = { x: 0, top: 0 };
  private layout: ActionBarLayout = { tip: 'above', menu: 'above' };
  private menuOpen = false;
  constructor(private run: (id: string, selection: SelectionContext) => Promise<void>, private settings: () => void) {
    this.window = new BrowserWindow({
      width: this.width + SIDE * 2, height: HEIGHT, frame: false, show: false, resizable: false, movable: false,
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
    ipcMain.on('bar:menu', (event, open: boolean) => { check(event); this.menuOpen = open === true; this.place(); });
    ipcMain.on('bar:settings', event => { check(event); this.hide(); this.settings(); });
    ipcMain.on('bar:hit', (event, inside: boolean) => { check(event); this.window.setIgnoreMouseEvents(!inside, { forward: true }); });
    ipcMain.on('bar:resize', (event, width: number) => {
      check(event);
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
        this.width = Math.min(900, Math.ceil(width));
        if (this.selection) this.position(this.selection); else this.place();
      }
    });
    void this.window.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'action-bar' } });
  }
  private snapshot(): ActionBarState {
    const enabled = this.presets.filter(p => p.enabled).map(({ id, name, target, mode }) => ({ id, name, target, mode }));
    return { presets: enabled.slice(0, VISIBLE), more: enabled.slice(VISIBLE), busy: this.busy, fonts: this.fonts };
  }
  update(presets: Preset[], busy: boolean, settings: Settings) {
    this.presets = presets; this.busy = busy; this.fonts = { fonts: settings.fonts, importedFonts: settings.importedFonts };
    this.window.webContents.send('bar:changed', this.snapshot());
    if (!presets.some(p => p.enabled)) this.hide();
  }
  /** Places the capsule above the selection (below when there is no room) and picks the free sides for the tip and the menu. */
  private position(selection: SelectionContext) {
    const a = selection.anchor;
    const area = screen.getDisplayNearestPoint({ x: a.x, y: a.y }).workArea;
    const above = a.y - BAR - GAP >= area.y;
    const barY = above ? a.y - BAR - GAP : a.y + a.height + GAP;
    // Only the capsule has to stay on screen; the transparent bands may hang past the work area.
    const bounds = fitToWorkArea({ x: a.x - SIDE, y: barY - TIP, width: this.width + SIDE * 2, height: HEIGHT }, { ...area, y: area.y - TIP, height: area.height + TIP * 2 });
    const top = bounds.y + TIP, room = (side: 'above' | 'below', need: number) => side === 'above' ? top - need >= area.y : top + BAR + need <= area.y + area.height;
    const away = above ? 'above' : 'below', toward = above ? 'below' : 'above';
    const menu = BAR_MENU.gap + barMenuHeight(this.snapshot().more.length);
    this.bar = { x: bounds.x, top };
    this.layout = { tip: room(away, TIP) ? away : toward, menu: room(away, menu) || !room(toward, menu) ? away : toward };
    this.place();
  }
  /** Sizes the window around the capsule, growing the menu-side band while the menu is open. */
  private place() {
    const extra = this.menuOpen ? Math.max(0, BAR_MENU.gap + barMenuHeight(this.snapshot().more.length) + MENU_EDGE - TIP) : 0;
    const width = Math.max(this.width, this.menuOpen ? BAR_MENU.width : 0) + SIDE * 2;
    this.window.setBounds({ x: this.bar.x, y: this.bar.top - TIP - (this.layout.menu === 'above' ? extra : 0), width, height: HEIGHT + extra });
  }
  show(selection: SelectionContext) {
    this.selection = selection;
    if (!this.presets.some(p => p.enabled) || this.busy) return;
    this.menuOpen = false;
    this.position(selection);
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.motion.show(true);
    this.window.webContents.send('bar:enter', this.layout);
  }
  /** Hit-tests the capsule, or the whole window while the menu is open; a click elsewhere counts as outside. */
  contains(point: { x: number; y: number }) {
    const b = this.window.getBounds();
    if (!this.window.isVisible()) return false;
    if (this.menuOpen) return point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height;
    return point.x >= this.bar.x + SIDE && point.x <= this.bar.x + SIDE + this.width && point.y >= this.bar.top && point.y <= this.bar.top + BAR;
  }
  hide() { this.selection = null; this.menuOpen = false; this.window.setIgnoreMouseEvents(true, { forward: true }); this.motion.hide(); }
  destroy() { this.motion.dispose(); this.window.destroy(); }
}
