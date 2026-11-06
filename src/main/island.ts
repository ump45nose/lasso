import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  IslandAlertItem,
  IslandMode,
  IslandState,
  IslandTaskItem,
  Settings,
  SnapSlot
} from '../shared/contracts';
import { FinderPanel } from './island-finder';
import { EdgeNotes } from './island-notes';

interface NativeAxBridge {
  paste?: () => void;
  setGlow?: (enabled: boolean) => void;
  startBridge?: (cb: (event: { name: string; payload: string }) => void) => void;
  postBridge?: (name: string, payload: string) => void;
  snapWindow?: (x: number, y: number, w: number, h: number) => boolean;
  tileTwoWindows?: (x1: number, y1: number, w1: number, h1: number, x2: number, y2: number, w2: number, h2: number) => number;
  frontmostApp?: () => { bundleId: string; name: string; pid: number };
  notchGeometry?: () => { hasNotch: boolean; width: number; height: number; menuBarHeight: number };
  setStationaryWindow?: (handle: Buffer) => void;
}

const WIN_W = 540, WIN_H = 440;

const MODES: readonly IslandMode[] = ['idle', 'focus', 'focus-hover', 'slacking', 'nook-alert', 'toast', 'board'];
const SNAP_SLOTS: readonly SnapSlot[] = ['left-half', 'right-half', 'top-half', 'bottom-half', 'maximize', 'center', 'coding-ai', 'equal-split'];
const QUICK_ACTIONS = ['screenshot-area', 'open-settings', 'toggle-notes', 'open-finder-panel'] as const;

function loadNativeAx(): NativeAxBridge {
  if (process.env.LASSO_DATA_ROOT) return {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(join(__dirname, 'native/capture-ax.node')) as NativeAxBridge;
  } catch {
    return {};
  }
}

function readNookTasks(): IslandTaskItem[] {
  const base = process.env.LASSO_DATA_ROOT
    ? join(app.getPath('userData'), 'nook-cache')
    : join(homedir(), 'Library/Application Support/PersonalDataHub/local-cache');
  for (const file of ['google.json', 'agenda.json']) {
    const p = join(base, file);
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as {
        taskLists?: { title?: string; items?: { id?: string; title?: string; status?: string }[] }[];
      };
      const items: IslandTaskItem[] = [];
      for (const list of raw.taskLists || []) {
        for (const item of list.items || []) {
          if (item.status === 'open' && item.id && item.title) {
            items.push({ id: item.id, title: item.title, listTitle: list.title || 'Nook 待办' });
            if (items.length >= 8) return items;
          }
        }
      }
      if (items.length) return items;
    } catch {
      // ignore malformed cache file
    }
  }
  return [];
}

export interface NotchIslandCallbacks {
  onQuickAction: (action: 'screenshot-area' | 'open-settings') => void;
  onPinImage: (image: NativeImage) => Promise<void>;
  onSendTextToLasso: (text: string) => Promise<void>;
}

export class NotchIsland {
  readonly window: BrowserWindow;
  readonly notes: EdgeNotes;
  readonly finder: FinderPanel;
  private ax: NativeAxBridge;
  private mode: IslandMode = 'idle';
  private glow = false;
  private pomodoro: IslandState['pomodoro'] = null;
  private toastItem: IslandState['toast'] = null;
  private alerts: IslandAlertItem[] = [];
  private nookTasks: IslandTaskItem[] = [];
  private fonts: IslandState['fonts'] = { fonts: { display: '', text: '', ui: '', mono: '' }, importedFonts: [] };
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onDisplayMetricsChanged = () => this.placeWindows();

  constructor(private callbacks: NotchIslandCallbacks) {
    this.ax = loadNativeAx();
    this.nookTasks = readNookTasks();

    this.window = new BrowserWindow({
      width: WIN_W,
      height: WIN_H,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      focusable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      acceptFirstMouse: true,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: { preload: join(__dirname, 'island-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.setAlwaysOnTop(true, 'screen-saver', 2);
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Must follow setAlwaysOnTop: Chromium adds the Managed behavior back whenever the level is set.
    this.ax.setStationaryWindow?.(this.window.getNativeWindowHandle());
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', event => event.preventDefault());

    const check = (event: IpcMainEvent | IpcMainInvokeEvent) => {
      const valid = [this.window.webContents, this.notes.window.webContents, this.finder.window.webContents];
      if (!valid.includes(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('套件表面来源不匹配');
    };
    const toast = (text: string, badge?: string) => this.toast(text, badge);
    this.notes = new EdgeNotes(this.fonts, { check, toast, onPinImage: callbacks.onPinImage });
    this.finder = new FinderPanel(this.fonts, {
      check,
      toast,
      frontmostAppName: () => this.ax.frontmostApp?.().name ?? 'Finder',
      onSendTextToLasso: callbacks.onSendTextToLasso
    });

    this.placeWindows();
    screen.on('display-metrics-changed', this.onDisplayMetricsChanged);

    ipcMain.handle('island:state', event => {
      check(event);
      this.nookTasks = readNookTasks();
      return this.snapshot();
    });
    ipcMain.on('island:mode', (event, mode: IslandMode) => {
      check(event);
      if (!MODES.includes(mode)) return;
      this.mode = mode;
      this.publish();
    });
    ipcMain.on('island:hit', (event, inside: boolean) => {
      check(event);
      this.window.setIgnoreMouseEvents(!inside, { forward: true });
    });
    ipcMain.handle('island:pomo-start', (event, task?: { id: string | null; title: string }, minutes = 25, kind: 'focus' | 'slacking' = 'focus') => {
      check(event);
      if (kind !== 'focus' && kind !== 'slacking') throw new Error('番茄钟类型无效');
      this.startPomodoro(task, minutes, kind);
    });
    ipcMain.handle('island:pomo-pause', event => {
      check(event);
      if (!this.pomodoro) return;
      this.pomodoro = { ...this.pomodoro, paused: !this.pomodoro.paused };
      this.publish();
    });
    ipcMain.handle('island:pomo-stop', event => {
      check(event);
      this.stopPomodoro();
    });
    ipcMain.handle('island:complete-task', (event, taskId: string) => {
      check(event);
      if (typeof taskId !== 'string' || !taskId) throw new Error('任务 ID 无效');
      this.completeTask(taskId);
    });
    ipcMain.handle('island:snooze-alert', (event, alertId: string, minutes = 10) => {
      check(event);
      if (typeof alertId !== 'string' || !alertId || !Number.isFinite(minutes) || minutes <= 0) throw new Error('提醒或延后时间无效');
      this.snoozeAlert(alertId, minutes);
    });
    ipcMain.handle('island:dismiss-alert', (event, alertId: string) => {
      check(event);
      this.dismissAlert(alertId);
    });
    ipcMain.handle('island:restart-service', (event, label: string) => {
      check(event);
      if (!this.alerts.some(a => a.kind === 'launchd' && a.target === label)) throw new Error('只能重启告警中的服务');
      this.restartService(label);
    });
    ipcMain.handle('island:quick', (event, action: typeof QUICK_ACTIONS[number]) => {
      check(event);
      if (!QUICK_ACTIONS.includes(action)) throw new Error('不支持的快捷操作');
      if (this.mode === 'board') {
        this.mode = this.resolveBaseMode();
        this.publish();
      }
      if (action === 'toggle-notes') {
        this.notes.toggleDrawer();
        return;
      }
      if (action === 'open-finder-panel') {
        this.finder.summon();
        return;
      }
      this.callbacks.onQuickAction(action);
    });
    ipcMain.handle('island:glow', (event, enabled: boolean) => {
      check(event);
      this.setGlow(Boolean(enabled));
    });
    ipcMain.handle('island:snap-window', (event, slot: SnapSlot) => {
      check(event);
      if (!SNAP_SLOTS.includes(slot)) throw new Error('不支持的分屏位置');
      this.snapWindow(slot);
    });

    this.ax.startBridge?.(({ name, payload }) => this.handleBridgeNotification(name, payload));

    this.window.once('ready-to-show', () => {
      if (!process.env.LASSO_DATA_ROOT) this.window.showInactive();
      this.placeWindows();
      this.publish();
    });
    void this.window.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'island' } });
    this.registerSuiteShortcuts();
  }

  private registerSuiteShortcuts() {
    if (process.env.LASSO_DATA_ROOT) return;
    const binds: [string, () => void][] = [
      ['Control+Option+Left', () => this.snapWindow('left-half')],
      ['Control+Option+Right', () => this.snapWindow('right-half')],
      ['Control+Option+Up', () => this.snapWindow('maximize')],
      ['Control+Option+Down', () => this.snapWindow('center')],
      ['Control+Option+Return', () => this.snapWindow('coding-ai')],
      ['Control+Option+N', () => this.notes.toggleDrawer()],
      ['Control+Option+F', () => this.finder.summon()]
    ];
    for (const [acc, fn] of binds) {
      try {
        globalShortcut.register(acc, fn);
      } catch {
        // ignore if already bound
      }
    }
  }

  private placeWindows() {
    const primary = screen.getPrimaryDisplay();
    if (!this.window.isDestroyed()) {
      const x = Math.round(primary.bounds.x + (primary.bounds.width - WIN_W) / 2);
      const y = primary.bounds.y;
      this.window.setBounds({ x, y, width: WIN_W, height: WIN_H });
    }
    this.notes.place();
  }

  private resolveBaseMode(): IslandMode {
    if (this.alerts.length > 0) return 'nook-alert';
    if (this.pomodoro?.active) return this.pomodoro.kind === 'slacking' ? 'slacking' : 'focus';
    return 'idle';
  }

  private snapshot(): IslandState {
    const geo = this.ax.notchGeometry?.();
    return {
      mode: this.mode,
      glow: this.glow,
      notch: geo
        ? { hasNotch: geo.hasNotch, width: Math.round(geo.width), height: Math.round(geo.height) }
        : { hasNotch: true, width: 156, height: 28 },
      pomodoro: this.pomodoro,
      toast: this.toastItem,
      alerts: this.alerts,
      nookTasks: this.nookTasks,
      fonts: this.fonts
    };
  }

  private publish() {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send('island:changed', this.snapshot());
    }
  }

  updateSettings(settings: Settings) {
    this.fonts = { fonts: settings.fonts, importedFonts: settings.importedFonts };
    this.publish();
    this.notes.updateFonts(this.fonts);
    this.finder.updateFonts(this.fonts);
  }

  openBoard() {
    this.nookTasks = readNookTasks();
    this.mode = 'board';
    this.window.setIgnoreMouseEvents(false);
    this.publish();
  }

  snapWindow(slot: SnapSlot) {
    const cursor = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const gap = 8;
    if (slot === 'coding-ai') {
      const leftW = Math.round((area.width - gap * 3) * 0.66);
      const rightW = area.width - gap * 3 - leftW;
      const moved = this.ax.tileTwoWindows?.(
        area.x + gap,
        area.y + gap,
        leftW,
        area.height - gap * 2,
        area.x + gap * 2 + leftW,
        area.y + gap,
        rightW,
        area.height - gap * 2
      );
      this.toast(moved ? '已排布 2/3 研发 + 1/3 AI 双栏工作区' : '已就绪 2/3 研发双栏排布', '2/3');
      return;
    }
    if (slot === 'equal-split') {
      const halfW = Math.round((area.width - gap * 3) / 2);
      this.ax.tileTwoWindows?.(
        area.x + gap,
        area.y + gap,
        halfW,
        area.height - gap * 2,
        area.x + gap * 2 + halfW,
        area.y + gap,
        halfW,
        area.height - gap * 2
      );
      this.toast('已排布 50/50 双窗对半分屏', '1:1');
      return;
    }

    const rects: Record<Exclude<SnapSlot, 'coding-ai' | 'equal-split'>, [number, number, number, number, string]> = {
      'left-half': [area.x + gap, area.y + gap, Math.round((area.width - gap * 3) / 2), area.height - gap * 2, '左半屏'],
      'right-half': [
        area.x + gap * 2 + Math.round((area.width - gap * 3) / 2),
        area.y + gap,
        Math.round((area.width - gap * 3) / 2),
        area.height - gap * 2,
        '右半屏'
      ],
      'top-half': [area.x + gap, area.y + gap, area.width - gap * 2, Math.round((area.height - gap * 3) / 2), '上半屏'],
      'bottom-half': [
        area.x + gap,
        area.y + gap * 2 + Math.round((area.height - gap * 3) / 2),
        area.width - gap * 2,
        Math.round((area.height - gap * 3) / 2),
        '下半屏'
      ],
      maximize: [area.x + gap, area.y + gap, area.width - gap * 2, area.height - gap * 2, '工作区最大化'],
      center: [
        Math.round(area.x + area.width * 0.12),
        Math.round(area.y + area.height * 0.1),
        Math.round(area.width * 0.76),
        Math.round(area.height * 0.8),
        '居中阅读窗'
      ]
    };
    const [x, y, w, h, label] = rects[slot];
    this.ax.snapWindow?.(x, y, w, h);
    this.toast(`窗口已吸附：${label}`, 'Snap');
  }

  pasteSelection(): void {
    this.ax.paste?.();
  }

  setGlow(enabled: boolean) {
    this.glow = enabled;
    this.ax.setGlow?.(enabled);
    this.publish();
  }

  toast(text: string, badge?: string) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastItem = { id: String(Date.now()), text, badge };
    const previousMode = this.mode;
    if (this.mode !== 'board') this.mode = 'toast';
    this.publish();
    this.toastTimer = setTimeout(() => {
      this.toastItem = null;
      if (this.mode === 'toast') {
        this.mode = previousMode === 'toast' ? this.resolveBaseMode() : previousMode;
      }
      this.publish();
    }, 2400);
  }

  startPomodoro(task?: { id: string | null; title: string }, minutes = 25, kind: 'focus' | 'slacking' = 'focus') {
    if (this.tickTimer) clearInterval(this.tickTimer);
    const totalSeconds = Math.max(60, Math.round(minutes * 60));
    const chosen = task || (this.nookTasks[0] ? { id: this.nookTasks[0].id, title: this.nookTasks[0].title } : { id: null, title: '深度专注' });
    this.pomodoro = {
      active: true,
      paused: false,
      kind,
      taskId: chosen.id,
      taskTitle: chosen.title,
      remainingSeconds: totalSeconds,
      totalSeconds
    };
    this.mode = kind === 'slacking' ? 'slacking' : 'focus';
    if (kind === 'slacking') this.setGlow(true);
    this.publish();

    this.tickTimer = setInterval(() => {
      if (!this.pomodoro || !this.pomodoro.active || this.pomodoro.paused) return;
      const next = this.pomodoro.remainingSeconds - 1;
      if (next <= 0) {
        if (this.pomodoro.kind === 'focus') {
          this.startPomodoro({ id: this.pomodoro.taskId, title: '摸鱼提醒 · 起身活动喝水' }, 5, 'slacking');
        } else {
          this.stopPomodoro();
          this.toast('休息结束，随时开始下一轮番茄钟', '25:00');
        }
        return;
      }
      this.pomodoro = { ...this.pomodoro, remainingSeconds: next };
      this.publish();
    }, 1000);
  }

  stopPomodoro() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.pomodoro = null;
    if (this.glow && this.alerts.length === 0) this.setGlow(false);
    this.mode = this.resolveBaseMode();
    this.publish();
  }

  completeTask(taskId: string) {
    this.ax.postBridge?.('com.nook.bridge.action', JSON.stringify({ action: 'complete-task', taskId }));
    this.nookTasks = this.nookTasks.filter(t => t.id !== taskId);
    this.alerts = this.alerts.filter(a => a.id !== taskId && a.target !== taskId);
    if (this.pomodoro?.taskId === taskId) {
      this.stopPomodoro();
    }
    if (this.alerts.length === 0 && this.glow) this.setGlow(false);
    this.toast('已在 Nook 标记任务完成', 'Done');
  }

  snoozeAlert(alertId: string, minutes = 10) {
    this.ax.postBridge?.('com.nook.bridge.action', JSON.stringify({ action: 'snooze', id: alertId, minutes }));
    this.alerts = this.alerts.filter(a => a.id !== alertId);
    if (this.alerts.length === 0) this.setGlow(false);
    this.mode = this.resolveBaseMode();
    this.publish();
  }

  dismissAlert(alertId: string) {
    this.alerts = this.alerts.filter(a => a.id !== alertId);
    if (this.alerts.length === 0 && this.pomodoro?.kind !== 'slacking') this.setGlow(false);
    this.mode = this.resolveBaseMode();
    this.publish();
  }

  restartService(label: string) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    execFile('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], () => {
      this.ax.postBridge?.('com.nook.bridge.action', JSON.stringify({ action: 'restart-launchd', label }));
    });
    this.alerts = this.alerts.filter(a => a.target !== label && a.id !== label);
    if (this.alerts.length === 0) this.setGlow(false);
    this.mode = this.resolveBaseMode();
    this.toast(`已重启服务 ${label}`, 'launchd');
  }

  private handleBridgeNotification(name: string, payload: string) {
    if (name === 'com.lasso.island.dismiss') {
      try {
        const parsed = payload ? (JSON.parse(payload) as { id?: string }) : {};
        if (parsed.id) this.alerts = this.alerts.filter(a => a.id !== parsed.id);
        else this.alerts = [];
      } catch {
        this.alerts = [];
      }
      if (this.alerts.length === 0) this.setGlow(false);
      this.mode = this.resolveBaseMode();
      this.publish();
      return;
    }

    if (name === 'com.lasso.island.present') {
      try {
        const data = JSON.parse(payload) as {
          id?: string;
          kind?: 'task' | 'reset' | 'launchd' | 'custom' | 'slacking';
          title?: string;
          subtitle?: string;
          target?: string;
          glow?: boolean;
          items?: IslandAlertItem[];
        };
        if (data.kind === 'slacking') {
          this.startPomodoro({ id: null, title: data.title || '摸鱼提醒 · 站起来喝口水' }, 5, 'slacking');
          return;
        }
        if (Array.isArray(data.items) && data.items.length > 0) {
          this.alerts = data.items;
        } else if (data.title) {
          const item: IslandAlertItem = {
            id: data.id || String(Date.now()),
            kind: data.kind === 'launchd' || data.kind === 'reset' || data.kind === 'task' ? data.kind : 'custom',
            title: data.title,
            subtitle: data.subtitle || '来自 Nook 提醒中心',
            target: data.target
          };
          this.alerts = [item, ...this.alerts.filter(a => a.id !== item.id)].slice(0, 6);
        }
        if (data.glow !== false) this.setGlow(true);
        this.mode = 'nook-alert';
        this.publish();
      } catch {
        // ignore invalid payload
      }
    }
  }

  destroy() {
    screen.off('display-metrics-changed', this.onDisplayMetricsChanged);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.ax.setGlow?.(false);
    if (!this.window.isDestroyed()) this.window.destroy();
    this.notes.destroy();
    this.finder.destroy();
  }
}
