import { BrowserWindow, clipboard, ipcMain, screen } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron';
import { join } from 'node:path';
import { fromMainFrame, sealLocal } from './ipc';
import { WindowMotion } from './motion';
import { fitToWorkArea } from './position';
import { composePrompt } from './presets';
import {
  BAR_MENU,
  barMenuHeight,
  type ActionBarConfig,
  type ActionBarItem,
  type ActionBarLayout,
  type ActionBarState,
  type AppPrompt,
  type FastApiCardState,
  type Preset,
  type SelectionContext,
  type Settings
} from '../shared/contracts';

const BAR = 40, TIP = 36, SIDE = 16, GAP = 10, HEIGHT = TIP * 2 + BAR, MENU_EDGE = 6, FAST_WIDTH = 440;

export interface ActionBarFastCallbacks {
  stream(
    input: { connectionId?: string; model?: string; prompt: string; signal?: AbortSignal },
    onDelta: (text: string, firstTokenMs: number) => void
  ): Promise<{ text: string; model: string; firstTokenMs: number }>;
  writeText(text: string, options?: { transient?: boolean }): Promise<void>;
  paste(): void;
  pin(image: NativeImage): Promise<void>;
  toast(text: string, badge?: string): void;
  appPrompts(): AppPrompt[];
  onTranslate(selection: SelectionContext): void;
  onAppendNote(text: string, sourceApp?: string): Promise<void> | void;
  onContinueInChat(payload: { title: string; connectionId: string; model: string; userText: string; assistantText: string }): void;
}

export function buildOrderedActionBarItems(presets: readonly Preset[], config: ActionBarConfig): { items: ActionBarItem[]; more: ActionBarItem[] } {
  const catalog = new Map<string, ActionBarItem>();
  catalog.set('translate', { id: 'translate', kind: 'translate', name: '翻译' });
  for (const p of presets) {
    if (!p.enabled || p.kind === 'image') continue;
    catalog.set(`preset:${p.id}`, { id: p.id, kind: 'preset', name: p.name, target: p.target, mode: p.mode });
  }
  catalog.set('note', { id: 'note', kind: 'note', name: '入便签' });

  const cut = Math.max(1, config.inlineCount);
  const hidden = new Set(config.hidden);
  const orderedKeys: string[] = [];
  for (const key of config.order) {
    if (catalog.has(key) && !orderedKeys.includes(key)) orderedKeys.push(key);
  }
  for (const key of catalog.keys()) {
    if (!orderedKeys.includes(key)) {
      if (key === 'note' && !config.order.includes('note')) {
        // Default: keep 入便签 in the last inline capsule slot before overflow presets
        let enabledBefore = 0;
        let insertIdx = orderedKeys.length;
        for (let i = 0; i < orderedKeys.length; i++) {
          if (!hidden.has(orderedKeys[i])) {
            enabledBefore++;
            if (enabledBefore === cut) {
              insertIdx = i;
              break;
            }
          }
        }
        orderedKeys.splice(insertIdx, 0, key);
      } else {
        orderedKeys.push(key);
      }
    }
  }
  const visible = orderedKeys.filter(key => !hidden.has(key)).map(key => catalog.get(key)!);
  return {
    items: visible.slice(0, cut),
    more: visible.slice(cut)
  };
}

export class ActionBar {
  readonly window: BrowserWindow;
  private motion: WindowMotion;
  private selection: SelectionContext | null = null;
  private presets: Preset[] = [];
  private actionBarConfig: ActionBarConfig = { order: [], hidden: [], inlineCount: 5 };
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
  private fastPrompt = '';

  constructor(
    private runPreset: (id: string, selection: SelectionContext) => Promise<void>,
    private openSettings: () => void,
    private fast: ActionBarFastCallbacks
  ) {
    this.window = new BrowserWindow({
      width: this.width + SIDE * 2,
      height: HEIGHT,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, 'action-bar-preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    });
    this.motion = new WindowMotion(this.window);
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.setAlwaysOnTop(true, 'screen-saver', 1);
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    sealLocal(this.window.webContents);

    const check = (event: IpcMainEvent | IpcMainInvokeEvent) => {
      if (!fromMainFrame(event, this.window)) throw new Error('动作条来源不匹配');
    };

    ipcMain.handle('bar:state', event => {
      check(event);
      return this.snapshot();
    });

    ipcMain.handle('bar:run', async (event, id: string) => {
      check(event);
      const selection = this.selection;
      if (!selection || this.busy) return;
      if (id === 'translate') {
        this.hide(true);
        this.fast.onTranslate(selection);
        return;
      }
      if (id === 'note') {
        if (selection.text.trim()) {
          await this.fast.onAppendNote(selection.text, selection.sourceApp);
        }
        this.hide();
        return;
      }
      const preset = this.presets.find(p => p.id === id && p.enabled && p.kind !== 'image');
      if (!preset) return;
      if (preset.target === 'api') {
        await this.startFastCard(preset, selection);
        return;
      }
      await this.runPreset(id, selection);
    });

    ipcMain.on('bar:menu', (event, open: boolean) => {
      check(event);
      this.menuOpen = open === true;
      if (this.menuOpen) this.closeFast();
      this.place();
    });

    ipcMain.on('bar:settings', event => {
      check(event);
      this.hide();
      this.openSettings();
    });

    ipcMain.on('bar:hit', (event, inside: boolean) => {
      check(event);
      this.window.setIgnoreMouseEvents(!inside, { forward: true });
    });

    ipcMain.on('bar:resize', (event, width: number) => {
      check(event);
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
        this.width = Math.min(900, Math.ceil(width));
        if (this.selection) this.position(this.selection);
        else this.place();
      }
    });

    ipcMain.on('bar:card-height', (event, height: number) => {
      check(event);
      if (typeof height === 'number' && Number.isFinite(height)) {
        this.fastCardHeight = height > 20 ? Math.min(480, Math.ceil(height)) : 0;
        this.place();
      }
    });

    ipcMain.on('bar:fast-close', event => {
      check(event);
      this.closeFast();
      this.publish();
      this.place();
    });

    ipcMain.handle('bar:fast-retry', async event => {
      check(event);
      if (!this.fastCard || !this.selection || !this.fastPreset) return;
      await this.startFastCard(this.fastPreset, this.selection);
    });

    ipcMain.handle('bar:fast-continue', async event => {
      check(event);
      if (!this.fastCard) return;
      const payload = {
        title: this.fastCard.presetName,
        connectionId: this.fastCard.connectionId,
        model: this.fastCard.model,
        userText: this.fastPrompt || this.selection?.text || '',
        assistantText: this.fastCard.text
      };
      this.hide(true);
      this.fast.onContinueInChat(payload);
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

    ipcMain.handle('bar:fast-note', async (event, text: string) => {
      check(event);
      if (typeof text === 'string' && text.trim()) {
        await this.fast.onAppendNote(text, this.selection?.sourceApp);
        this.hide();
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
              if (current === text) void this.fast.writeText(previous, { transient: true });
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
      const rect = {
        x: SIDE,
        y: Math.max(0, cardY),
        width: Math.min(FAST_WIDTH, b.width - SIDE * 2),
        height: Math.min(this.fastCardHeight, b.height - cardY)
      };
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
    const { items, more } = buildOrderedActionBarItems(this.presets, this.actionBarConfig);
    return { items, more, busy: this.busy, fonts: this.fonts, fastCard: this.fastCard };
  }

  private hasActions() {
    const { items, more } = buildOrderedActionBarItems(this.presets, this.actionBarConfig);
    return items.length > 0 || more.length > 0;
  }

  private publish() {
    if (!this.window.isDestroyed()) this.window.webContents.send('bar:changed', this.snapshot());
  }

  update(presets: Preset[], busy: boolean, settings: Settings) {
    this.presets = presets;
    this.busy = busy;
    this.fonts = { fonts: settings.fonts, importedFonts: settings.importedFonts };
    this.actionBarConfig = settings.actionBar;
    this.publish();
    if (!this.hasActions()) this.hide();
  }

  private closeFast() {
    this.fastAbort?.abort();
    this.fastAbort = null;
    this.fastPreset = null;
    this.fastPrompt = '';
    this.fastCard = null;
    this.fastCardHeight = 0;
  }

  async startFastCard(preset: Preset, selection: SelectionContext) {
    this.closeFast();
    this.fastPreset = preset;
    this.menuOpen = false;
    this.selection = selection;
    const prompt = composePrompt(preset, selection, this.fast.appPrompts());
    this.fastPrompt = prompt;
    const connectionId = preset.connectionId?.trim() || '';
    const model = preset.model?.trim() || '';
    this.fastCard = {
      presetId: preset.id,
      presetName: preset.name,
      connectionId,
      model,
      status: 'streaming',
      text: '',
      error: null,
      firstTokenMs: null
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
      const onDelta = (text: string, firstTokenMs: number) => {
        if (this.fastAbort !== controller || !this.fastCard) return;
        this.fastCard = { ...this.fastCard, text, firstTokenMs };
        this.publish();
      };
      const result = await this.fast.stream({ connectionId, model, prompt, signal: controller.signal }, onDelta);
      if (this.fastAbort !== controller || !this.fastCard) return;
      this.fastCard = { ...this.fastCard, status: 'done', text: result.text, model: result.model, firstTokenMs: result.firstTokenMs };
      this.publish();
    } catch (error) {
      if (this.fastAbort !== controller || !this.fastCard || controller.signal.aborted) return;
      this.fastCard = { ...this.fastCard, status: 'error', error: (error as Error).message || '快速 API 调用失败' };
      this.publish();
    }
  }

  private position(selection: SelectionContext) {
    const a = selection.anchor;
    const area = screen.getDisplayNearestPoint({ x: a.x, y: a.y }).workArea;
    const above = a.y - BAR - GAP >= area.y;
    const barY = above ? a.y - BAR - GAP : a.y + a.height + GAP;
    const targetWidth = Math.max(this.width, this.fastCard ? FAST_WIDTH : 0);
    const bounds = fitToWorkArea(
      { x: a.x - SIDE, y: barY - TIP, width: targetWidth + SIDE * 2, height: HEIGHT },
      { ...area, y: area.y - TIP, height: area.height + TIP * 2 }
    );
    const top = bounds.y + TIP;
    const room = (side: 'above' | 'below', need: number) =>
      side === 'above' ? top - need >= area.y : top + BAR + need <= area.y + area.height;
    const away = above ? 'above' : 'below';
    const toward = above ? 'below' : 'above';
    const menuNeed = BAR_MENU.gap + Math.max(barMenuHeight(this.snapshot()), this.fastCardHeight);
    this.bar = { x: bounds.x, top };
    this.layout = { tip: room(away, TIP) ? away : toward, menu: room(away, menuNeed) || !room(toward, menuNeed) ? away : toward };
    this.place();
  }

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
    this.window.setBounds({
      x: this.bar.x,
      y: this.bar.top - TIP - (this.layout.menu === 'above' ? extra : 0),
      width,
      height: HEIGHT + extra
    });
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
