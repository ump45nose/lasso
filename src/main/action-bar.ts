import { BrowserWindow, clipboard, ipcMain, screen } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron';
import { join } from 'node:path';
import { fromMainFrame, sealLocal } from './ipc';
import { WindowMotion } from './motion';
import { fitToWorkArea } from './position';
import { composePrompt } from './presets';
import { BAR_MENU, barMenuHeight, type ActionBarLayout, type ActionBarState, type AppPrompt, type FastApiCardState, type Preset, type SelectionContext, type Settings } from '../shared/contracts';

// The window is transparent: the 40px capsule sits between two tip bands, with side room for its CSS shadow.
// While the ··· menu or inline fast-API card is open, the band on the menu side grows to hold it.
const BAR = 40, TIP = 36, SIDE = 16, GAP = 10, HEIGHT = TIP * 2 + BAR, VISIBLE = 4, MENU_EDGE = 6, FAST_WIDTH = 412;

export interface ActionBarFastCallbacks {
  stream(input: { connectionId?: string; model?: string; prompt: string; signal?: AbortSignal }, onDelta: (text: string, firstTokenMs: number) => void): Promise<{ text: string; model: string; firstTokenMs: number }>;
  writeText(text: string): Promise<void>;
  paste(): void;
  pin(image: NativeImage): Promise<void>;
  toast(text: string, badge?: string): void;
  appPrompts(): AppPrompt[];
}

export class ActionBar {
  readonly window: BrowserWindow;
  private motion: WindowMotion;
  private selection: SelectionContext | null = null;
  private presets: Preset[] = [];
  private scripts: ActionBarState['scripts'] = [];
  private fonts: ActionBarState['fonts'] = { fonts: { display: '', text: '', ui: '', mono: '' }, importedFonts: [] };
  private busy = false;
  private width = 340;
  private bar = { x: 240, top: 320 };
  private layout: ActionBarLayout = { tip: 'above', menu: 'above' };
  private menuOpen = false;
  private fastCard: FastApiCardState | null = null;
  private fastCardHeight = 0;
  private fastAbort: AbortController | null = null;
  private fastPreset: Preset | null = null;

  constructor(
    private run: (id: string, selection: SelectionContext, openInWindow?: boolean) => Promise<void>,
    private runScript: (id: string, selection: SelectionContext) => Promise<void>,
    private settings: () => void,
    private fast: ActionBarFastCallbacks,
    private options: { onAppendNote?: (text: string) => Promise<void> | void } = {}
  ) {
    this.window = new BrowserWindow({
      width: this.width + SIDE * 2, height: HEIGHT, frame: false, show: false, resizable: false, movable: false,
      focusable: false, skipTaskbar: true, alwaysOnTop: true, acceptFirstMouse: true,
      transparent: true, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { preload: join(__dirname, 'action-bar-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    this.motion = new WindowMotion(this.window);
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.setAlwaysOnTop(true, 'screen-saver', 1);
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    sealLocal(this.window.webContents);
    const check = (event: IpcMainEvent | IpcMainInvokeEvent) => {
      if (!fromMainFrame(event, this.window)) throw new Error('动作条来源不匹配');
    };
    ipcMain.handle('bar:state', event => { check(event); return this.snapshot(); });
    ipcMain.handle('bar:run', async (event, id: string) => {
      check(event);
      if (!this.selection) return;
      if (this.fastCard?.presetId === id) {
        const selection = this.selection;
        this.hide();
        await this.run(id, selection, true);
        return;
      }
      if (this.busy) return;
      const preset = this.presets.find(p => p.id === id && p.enabled);
      if (preset && preset.target === 'api' && preset.kind !== 'image') {
        await this.startFastCard(preset, this.selection, 'auto');
        return;
      }
      await this.run(id, this.selection);
    });
    ipcMain.handle('bar:script', async (event, id: string) => {
      check(event);
      const selection = this.selection;
      if (!selection || this.busy) return;
      this.hide();
      try { await this.runScript(id, selection); }
      catch (error) { this.fast.toast(`脚本失败：${(error as Error).message}`, 'Error'); }
    });
    ipcMain.handle('bar:append-note', async event => {
      check(event);
      const text = this.selection?.text;
      if (!text?.trim()) return;
      await this.options.onAppendNote?.(text);
      this.hide();
    });
    ipcMain.on('bar:menu', (event, open: boolean) => { check(event); this.menuOpen = open === true; if (this.menuOpen) this.closeFast(); this.place(); });
    ipcMain.on('bar:settings', event => { check(event); this.hide(); this.settings(); });
    ipcMain.on('bar:hit', (event, inside: boolean) => { check(event); this.window.setIgnoreMouseEvents(!inside, { forward: true }); });
    ipcMain.on('bar:resize', (event, width: number) => {
      check(event);
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
        this.width = Math.min(900, Math.ceil(width));
        if (this.selection) this.position(this.selection); else this.place();
      }
    });
    ipcMain.on('bar:card-height', (event, height: number) => {
      check(event);
      if (typeof height === 'number' && Number.isFinite(height)) {
        this.fastCardHeight = height > 20 ? Math.min(480, Math.ceil(height)) : 0;
        this.place();
      }
    });
    ipcMain.on('bar:fast-close', event => { check(event); this.closeFast(); this.publish(); this.place(); });
    ipcMain.handle('bar:fast-retry', async (event, targetLang?: 'auto' | 'zh' | 'en') => {
      check(event);
      if (!this.fastCard || !this.selection) return;
      const preset = this.fastPreset;
      if (preset) await this.startFastCard(preset, this.selection, targetLang || this.fastCard.targetLang, this.fastCard.isTranslation);
    });
    ipcMain.handle('bar:fast-copy', async (event, text: string) => {
      check(event);
      if (typeof text === 'string' && text.trim()) {
        await this.fast.writeText(text);
        const ms = this.fastCard?.firstTokenMs;
        this.hide();
        this.fast.toast('已复制结果到剪贴板', ms ? `${ms}ms` : undefined);
      }
    });
    ipcMain.handle('bar:fast-replace', async (event, text: string) => {
      check(event);
      if (typeof text === 'string' && text.trim()) {
        const previous = await Promise.resolve(clipboard.readText());
        await this.fast.writeText(text);
        this.hide(true);
        setTimeout(() => {
          this.fast.paste();
          this.fast.toast('已替换选中文本', '↵');
          setTimeout(() => {
            void Promise.resolve(clipboard.readText()).then(current => {
              if (current === text) void this.fast.writeText(previous);
            });
          }, 280);
        }, 60);
      }
    });
    ipcMain.handle('bar:fast-pin', async (event, text: string) => {
      check(event);
      if (typeof text !== 'string' || !text.trim()) return;
      const b = this.window.getBounds();
      const cardY = this.layout.menu === 'above' ? Math.max(0, b.height - (TIP + BAR + BAR_MENU.gap) - this.fastCardHeight) : TIP + BAR + BAR_MENU.gap;
      const rect = { x: SIDE, y: Math.max(0, cardY), width: Math.min(FAST_WIDTH, b.width - SIDE * 2), height: Math.min(this.fastCardHeight, b.height - cardY) };
      const image = await this.window.webContents.capturePage(rect);
      this.hide();
      if (!image.isEmpty()) {
        await this.fast.pin(image);
        this.fast.toast('已钉为桌面贴图', 'Pin');
      }
    });
    void this.window.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'action-bar' } });
  }

  private snapshot(): ActionBarState {
    const enabled = this.presets.filter(p => p.enabled).map(({ id, name, target, mode }) => ({ id, name, target, mode }));
    return { presets: enabled.slice(0, VISIBLE), more: enabled.slice(VISIBLE), scripts: this.scripts, busy: this.busy, fonts: this.fonts, fastCard: this.fastCard };
  }

  private hasActions() { return Boolean(this.options.onAppendNote) || this.presets.some(p => p.enabled) || this.scripts.length > 0; }

  private publish() {
    if (!this.window.isDestroyed()) this.window.webContents.send('bar:changed', this.snapshot());
  }

  update(presets: Preset[], busy: boolean, settings: Settings) {
    this.presets = presets; this.busy = busy; this.fonts = { fonts: settings.fonts, importedFonts: settings.importedFonts };
    this.scripts = settings.scriptActions.filter(action => action.enabled).map(({ id, name }) => ({ id, name }));
    this.publish();
    if (!this.hasActions()) this.hide();
  }

  private closeFast() {
    this.fastAbort?.abort();
    this.fastAbort = null;
    this.fastPreset = null;
    this.fastCard = null;
    this.fastCardHeight = 0;
  }

  /** Opens the inline streaming card directly attached to the action bar (or summons the bar near cursor for OCR/palette runs). */
  async startFastCard(preset: Preset, selection: SelectionContext, targetLang: 'auto' | 'zh' | 'en' = 'auto', languageSwitch = false) {
    this.closeFast();
    this.fastPreset = preset;
    this.menuOpen = false;
    this.selection = selection;
    const isTranslation = preset.id === 'translate' || /翻译|translate/i.test(preset.name);
    let prompt = composePrompt(preset, selection, this.fast.appPrompts());
    if (targetLang !== 'auto') {
      prompt += isTranslation
        ? targetLang === 'zh' ? '\n\n请将上述内容准确翻译为简体中文，只输出译文。' : '\n\nPlease translate the content above into natural English and output only the translation.'
        : targetLang === 'zh' ? '\n\n请用简体中文输出。' : '\n\nPlease output in English.';
    }
    const model = preset.model?.trim() || 'gpt-4.1-mini';
    this.fastCard = {
      presetId: preset.id,
      presetName: preset.name,
      model,
      status: 'streaming',
      text: '',
      error: null,
      firstTokenMs: null,
      isTranslation: isTranslation || languageSwitch,
      targetLang
    };
    if (this.window.isDestroyed()) return;
    const wasVisible = this.window.isVisible();
    if (!wasVisible) {
      this.position(selection);
      this.motion.show(true);
      this.window.webContents.send('bar:enter', this.layout);
    } else {
      this.place();
    }
    this.window.setIgnoreMouseEvents(false);
    this.publish();

    const controller = new AbortController();
    this.fastAbort = controller;
    try {
      const result = await this.fast.stream(
        { connectionId: preset.connectionId, model, prompt, signal: controller.signal },
        (text, firstTokenMs) => {
          if (this.fastAbort !== controller || !this.fastCard) return;
          this.fastCard = { ...this.fastCard, text, firstTokenMs };
          this.publish();
        }
      );
      if (this.fastAbort !== controller || !this.fastCard) return;
      this.fastCard = { ...this.fastCard, status: 'done', text: result.text, model: result.model, firstTokenMs: result.firstTokenMs };
      this.publish();
    } catch (error) {
      if (this.fastAbort !== controller || !this.fastCard || controller.signal.aborted) return;
      this.fastCard = { ...this.fastCard, status: 'error', error: (error as Error).message || '快速 API 调用失败' };
      this.publish();
    }
  }

  /** Places the capsule above the selection (below when there is no room) and picks the free sides for the tip and the menu/card. */
  private position(selection: SelectionContext) {
    const a = selection.anchor;
    const area = screen.getDisplayNearestPoint({ x: a.x, y: a.y }).workArea;
    const above = a.y - BAR - GAP >= area.y;
    const barY = above ? a.y - BAR - GAP : a.y + a.height + GAP;
    const targetWidth = Math.max(this.width, this.fastCard ? FAST_WIDTH : 0);
    const bounds = fitToWorkArea({ x: a.x - SIDE, y: barY - TIP, width: targetWidth + SIDE * 2, height: HEIGHT }, { ...area, y: area.y - TIP, height: area.height + TIP * 2 });
    const top = bounds.y + TIP, room = (side: 'above' | 'below', need: number) => side === 'above' ? top - need >= area.y : top + BAR + need <= area.y + area.height;
    const away = above ? 'above' : 'below', toward = above ? 'below' : 'above';
    const menuNeed = BAR_MENU.gap + Math.max(barMenuHeight(this.snapshot()), this.fastCardHeight);
    this.bar = { x: bounds.x, top };
    this.layout = { tip: room(away, TIP) ? away : toward, menu: room(away, menuNeed) || !room(toward, menuNeed) ? away : toward };
    this.place();
  }

  /** Sizes the window around the capsule, growing the menu-side band while the menu or fast card is open. */
  private place() {
    if (this.window.isDestroyed()) return;
    const cardH = this.fastCard ? (this.fastCardHeight || 196) : this.fastCardHeight;
    const activeExtraHeight = cardH > 0
      ? BAR_MENU.gap + cardH + MENU_EDGE
      : this.menuOpen
        ? BAR_MENU.gap + barMenuHeight(this.snapshot()) + MENU_EDGE
        : 0;
    const extra = Math.max(0, activeExtraHeight - TIP);
    const width = Math.max(this.width, cardH > 0 ? FAST_WIDTH : this.menuOpen ? BAR_MENU.width : 0) + SIDE * 2;
    this.window.setBounds({ x: this.bar.x, y: this.bar.top - TIP - (this.layout.menu === 'above' ? extra : 0), width, height: HEIGHT + extra });
  }

  show(selection: SelectionContext) {
    if (this.window.isDestroyed()) return;
    this.closeFast();
    this.selection = selection;
    if (!this.hasActions() || this.busy) return;
    this.menuOpen = false;
    this.position(selection);
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.motion.show(true);
    this.window.webContents.send('bar:enter', this.layout);
    this.publish();
  }

  /** Hit-tests the capsule, or the whole window while the menu or fast card is open; a click elsewhere counts as outside. */
  contains(point: { x: number; y: number }) {
    if (this.window.isDestroyed() || !this.window.isVisible()) return false;
    const b = this.window.getBounds();
    if (this.menuOpen || this.fastCard) return point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height;
    return point.x >= this.bar.x + SIDE && point.x <= this.bar.x + SIDE + this.width && point.y >= this.bar.top && point.y <= this.bar.top + BAR;
  }

  hide(immediate = false) {
    if (this.window.isDestroyed()) return;
    this.closeFast();
    this.selection = null;
    this.menuOpen = false;
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.motion.hide(immediate);
  }

  destroy() {
    this.closeFast();
    this.motion.dispose();
    this.window.destroy();
  }
}
