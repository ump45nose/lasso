import { app, ipcMain, screen } from 'electron';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  IslandAlertItem,
  IslandMode,
  IslandState,
  IslandTaskItem,
  NookFocusReview,
  NookReminderPrefs,
  Settings,
  SnapSlot
} from '../shared/contracts';
import { fromMainFrame } from './ipc';
import { FinderPanel } from './island-finder';
import { ClipboardHistoryPanel, type ClipboardCopyEvent } from './island-clipboard';
import { TranslatorPanel } from './island-translator';
import type { MediaService } from './media-service';
import type { TranslationSettings } from '../shared/media';
import { writeFileAtomic } from './files';
import { EdgeNotes } from './island-notes';
import { createIslandWindow } from './island-window';
import { nativeAx, type NativeAx } from './native-ax';

const WIN_W = 540, WIN_H = 560;

const MODES: readonly IslandMode[] = ['idle', 'focus', 'focus-hover', 'slacking', 'nook-alert', 'toast', 'board'];
const SNAP_SLOTS: readonly SnapSlot[] = [
  'left-half',
  'right-half',
  'top-half',
  'bottom-half',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'left-third',
  'center-third',
  'right-third',
  'left-two-thirds',
  'right-two-thirds',
  'maximize',
  'center',
  'coding-ai',
  'equal-split',
  'prev-display',
  'next-display'
];
const QUICK_ACTIONS = ['screenshot-area', 'open-settings', 'toggle-notes', 'open-finder-panel', 'open-translator', 'open-clipboard'] as const;

interface NookFocusSnapshot {
  review: NookFocusReview | null;
  tasks: IslandTaskItem[];
  completedCount: number;
  totalCount: number;
  watchedDirs: string[];
}

function formatDueInfo(dueRaw: string | undefined, todayStr: string): { dueLabel?: string; overdue?: boolean } {
  if (!dueRaw) return {};
  const day = dueRaw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return {};
  if (day === todayStr) return { dueLabel: '今天' };
  const todayMs = Date.parse(`${todayStr}T00:00:00`);
  const dueMs = Date.parse(`${day}T00:00:00`);
  if (!Number.isFinite(todayMs) || !Number.isFinite(dueMs)) return {};
  const diffDays = Math.round((todayMs - dueMs) / 86_400_000);
  if (diffDays > 0) return { dueLabel: `逾期 ${diffDays} 天`, overdue: true };
  if (diffDays === -1) return { dueLabel: '明天' };
  return { dueLabel: day.slice(5) };
}

function todayLocalKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function resolveSlotJson(slotPath: string, dirs: Set<string>): unknown | null {
  if (!existsSync(slotPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(slotPath, 'utf8')) as { entry?: { path?: string } } | null;
    if (parsed && typeof parsed === 'object' && parsed.entry && typeof parsed.entry.path === 'string' && existsSync(parsed.entry.path)) {
      dirs.add(dirname(parsed.entry.path));
      return JSON.parse(readFileSync(parsed.entry.path, 'utf8'));
    }
    return parsed;
  } catch {
    return null;
  }
}

function resolveNookCacheDir(): string {
  if (process.env.LASSO_NOOK_CACHE_DIR) return process.env.LASSO_NOOK_CACHE_DIR;
  if (process.env.LASSO_DATA_ROOT) return join(app.getPath('userData'), 'nook-cache');
  const primary = join(homedir(), 'Library/Application Support/PersonalHub/local-cache');
  if (existsSync(primary)) return primary;
  const legacy = join(homedir(), 'Library/Application Support/PersonalDataHub/local-cache');
  return existsSync(legacy) ? legacy : primary;
}

function dueRank(dueRaw: string | undefined, overdue: boolean | undefined, dueLabel: string | undefined): { rank: number; dueDay: string } {
  const dueDay = dueRaw ? dueRaw.slice(0, 10) : '';
  if (overdue) return { rank: 0, dueDay: dueDay || '0000-00-00' };
  if (dueLabel === '今天') return { rank: 1, dueDay };
  if (dueDay) return { rank: 2, dueDay };
  return { rank: 3, dueDay: '9999-99-99' };
}

const KNOWN_SERVICE_NAMES: Record<string, string> = {
  'com.wonderwhy-er.desktop-commander': 'Desktop Commander',
  'desktop-commander': 'Desktop Commander',
  'com.yuwk.personal-hub.agent': 'Nook Hub 服务',
  'com.yuwk.personalhub.agent': 'Nook Hub 服务',
  'com.yuwk.nook.agent': 'Nook Hub 服务',
  'local.lasso.sync': 'Lasso 同步服务'
};

function friendlyServiceName(raw?: string): string {
  if (!raw) return '后台服务';
  const trimmed = raw.trim();
  if (!trimmed) return '后台服务';
  const lower = trimmed.toLowerCase();
  for (const [key, label] of Object.entries(KNOWN_SERVICE_NAMES)) {
    if (lower === key || lower.includes(key)) return label;
  }
  if (/^(com|org|net|io|local)\.[a-z0-9_.-]+$/i.test(trimmed)) {
    const tail = trimmed.split('.').filter(Boolean).pop() || trimmed;
    return tail
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, ch => ch.toUpperCase());
  }
  return trimmed;
}

function cleanAlertText(raw?: string): string {
  if (!raw) return '';
  return raw
    .replace(/\(?\bExit\s*-?\d+\)?/gi, '')
    .replace(/\bcli_failed\b/gi, '执行失败')
    .replace(/\bmissing_executable\b/gi, '未找到可执行程序')
    .replace(/\btimeout\b/gi, '执行超时')
    .replace(/\bmodel_unavailable\b/gi, '模型额度耗尽')
    .replace(/\bunknown_error\b/gi, '运行异常')
    .replace(/\bLaunchAgents?\b/gi, '后台服务')
    .replace(/\b(com|org|net|io|local)\.[a-z0-9_.-]+/gi, match => friendlyServiceName(match))
    .replace(/[·•]\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizeAlertItem(raw: IslandAlertItem): IslandAlertItem {
  const kind = raw.kind === 'launchd' || raw.kind === 'reset' || raw.kind === 'task' ? raw.kind : 'custom';
  let title = raw.title || '';
  let subtitle = raw.subtitle || '';
  const target = raw.target;

  if (kind === 'launchd') {
    const baseName = friendlyServiceName(target || title.replace(/\s*(异常退出|未运行|服务异常).*$/u, ''));
    if (!title || /^(com|org|net|io|local)\./i.test(title) || /\bExit\b|cli_failed/i.test(title)) {
      title = `${baseName} 未运行`;
    } else {
      title = cleanAlertText(title);
    }
    subtitle = cleanAlertText(subtitle);
    if (!subtitle || subtitle === baseName) {
      subtitle = '后台服务异常 · 点击重启';
    }
  } else {
    title = cleanAlertText(title) || 'Nook 提醒';
    subtitle = cleanAlertText(subtitle) || (kind === 'task' ? '待办提醒' : 'Nook 提醒');
  }

  return {
    id: raw.id || String(Date.now()),
    kind,
    title,
    subtitle,
    target
  };
}

function readNookFocusData(): NookFocusSnapshot {
  const base = resolveNookCacheDir();
  const dirs = new Set<string>();
  if (existsSync(base)) dirs.add(base);
  else if (existsSync(dirname(base))) dirs.add(dirname(base));

  const today = todayLocalKey();
  const openEntries: { item: IslandTaskItem; rank: number; dueDay: string }[] = [];
  const doneTodayTasks: IslandTaskItem[] = [];

  for (const file of ['google.json', 'agenda.json']) {
    const data = resolveSlotJson(join(base, file), dirs) as {
      lists?: { id?: string; title?: string }[];
      tasks?: {
        id?: string;
        listID?: string;
        title?: string;
        completed?: boolean;
        deleted?: boolean;
        completedAt?: string;
        due?: string;
        parent?: string;
      }[];
      taskLists?: { title?: string; items?: { id?: string; title?: string; status?: string; due?: string; completedAt?: string }[] }[];
    } | null;
    if (!data || typeof data !== 'object') continue;

    if (Array.isArray(data.tasks)) {
      const listNames = new Map<string, string>();
      for (const l of data.lists || []) {
        if (l.id && l.title) listNames.set(l.id, l.title);
      }
      for (const task of data.tasks) {
        if (!task.id || !task.title || task.parent || task.deleted) continue;
        const listTitle = (task.listID && listNames.get(task.listID)) || 'Google Tasks';
        if (task.completed) {
          if (!task.completedAt || task.completedAt.slice(0, 10) === today) {
            doneTodayTasks.push({ id: task.id, title: task.title, listTitle, completed: true });
          }
        } else {
          const { dueLabel, overdue } = formatDueInfo(task.due, today);
          const { rank, dueDay } = dueRank(task.due, overdue, dueLabel);
          openEntries.push({
            item: { id: task.id, title: task.title, listTitle, completed: false, dueLabel, overdue },
            rank,
            dueDay
          });
        }
      }
      break;
    }

    if (Array.isArray(data.taskLists)) {
      for (const list of data.taskLists) {
        for (const item of list.items || []) {
          if (!item.id || !item.title || item.status === 'deleted') continue;
          const listTitle = list.title || 'Google Tasks';
          if (item.status === 'completed' || item.status === 'done') {
            doneTodayTasks.push({ id: item.id, title: item.title, listTitle, completed: true });
          } else if (item.status === 'open' || !item.status) {
            const { dueLabel, overdue } = formatDueInfo(item.due, today);
            const { rank, dueDay } = dueRank(item.due, overdue, dueLabel);
            openEntries.push({
              item: { id: item.id, title: item.title, listTitle, completed: false, dueLabel, overdue },
              rank,
              dueDay
            });
          }
        }
      }
      if (openEntries.length || doneTodayTasks.length) break;
    }
  }

  openEntries.sort((a, b) => a.rank - b.rank || a.dueDay.localeCompare(b.dueDay));
  const openTasks = openEntries.map(entry => entry.item);
  const completedCount = doneTodayTasks.length;
  const totalCount = openTasks.length + completedCount;
  const tasks = [...openTasks.slice(0, 6), ...doneTodayTasks.slice(0, 2)];

  let review: NookFocusReview | null = null;
  const hubRaw = resolveSlotJson(join(base, 'hub.json'), dirs) as {
    mainGoal?: string;
    items?: string[];
    goals?: {
      data?: {
        mainline?: { direction?: string; status?: string };
        goals?: { domain?: string; goal?: string }[];
      };
      mainline?: { direction?: string; status?: string };
    };
  } | null;

  if (hubRaw && typeof hubRaw === 'object') {
    if (typeof hubRaw.mainGoal === 'string' && hubRaw.mainGoal.trim()) {
      review = {
        mainGoal: hubRaw.mainGoal.trim(),
        items: Array.isArray(hubRaw.items) ? hubRaw.items.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 3) : []
      };
    } else {
      const goalsData = hubRaw.goals?.data ?? (hubRaw.goals as { mainline?: { direction?: string }; goals?: { domain?: string; goal?: string }[] } | undefined);
      const mainGoal = goalsData?.mainline?.direction?.trim() || '';
      const items = Array.isArray(goalsData?.goals)
        ? goalsData.goals
            .map(g => {
              const goal = g?.goal?.trim() || '';
              if (!goal) return '';
              const domain = g?.domain?.trim();
              return domain ? `${domain} · ${goal}` : goal;
            })
            .filter(Boolean)
            .slice(0, 3)
        : [];
      if (mainGoal || items.length > 0) {
        review = { mainGoal: mainGoal || items[0] || '', items };
      }
    }
  }

  return { review, tasks, completedCount, totalCount, watchedDirs: [...dirs] };
}

export interface NotchIslandCallbacks {
  onQuickAction: (action: 'screenshot-area' | 'open-settings') => void;
  onPinImage: (image: NativeImage, title?: string) => Promise<void>;
  onPinText: (text: string, title?: string) => Promise<void>;
  onAskAi: (payload: { kind: 'text'; text: string } | { kind: 'image'; imagePath: string }) => void;
  onSendFilesToAi: (paths: string[]) => Promise<void> | void;
  mediaService: MediaService;
  settings: () => Settings;
  saveTranslation: (settings: TranslationSettings) => void;
  saveNookPrefs: (prefs: NookReminderPrefs) => void;
}

export class NotchIsland {
  readonly window: BrowserWindow;
  readonly notes: EdgeNotes;
  readonly finder: FinderPanel;
  readonly translator: TranslatorPanel;
  readonly clipboardHistory: ClipboardHistoryPanel;
  private ax: Partial<NativeAx>;
  private mode: IslandMode = 'idle';
  private islandEnabled = true;
  private pomodoro: IslandState['pomodoro'] = null;
  private toastItem: IslandState['toast'] = null;
  private alerts: IslandAlertItem[] = [];
  private alertBridgeMeta = new Map<string, { route?: string; rule?: string; rules?: string[] }>();
  private dismissedAlertKeys = new Set<string>();
  private serviceRestartCooldown = new Map<string, number>();
  private readonly dismissedAlertsPath = join(app.getPath('userData'), 'island-dismissed-alerts.json');
  private nookPrefs: NookReminderPrefs = { enabled: true, tasks: true, hubAttention: true, aiResets: true, localAndCustom: true };
  private copyTranslateEnabled = false;
  private dragSnapEnabled: boolean | undefined;
  private snapDwellMs: number | undefined;
  private lastCopy: ClipboardCopyEvent | null = null;
  private lastTranslatedChangeCount = -1;
  private pendingDoubleCopyAt = 0;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private nookReview: NookFocusReview | null = null;
  private nookTasks: IslandTaskItem[] = [];
  private nookCompletedCount = 0;
  private nookTotalCount = 0;
  private fonts: IslandState['fonts'] = { fonts: { display: '', text: '', ui: '', mono: '' }, importedFonts: [] };
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private nookWatchers = new Map<string, FSWatcher>();
  private nookWatchDebounce: ReturnType<typeof setTimeout> | null = null;
  private lastAnchorX = -1;
  private destroyed = false;

  private readonly onDisplayMetricsChanged = () => this.placeWindows();

  constructor(private callbacks: NotchIslandCallbacks) {
    this.ax = process.env.LASSO_DATA_ROOT ? {} : nativeAx();
    if (existsSync(this.dismissedAlertsPath)) {
      try {
        const keys: unknown = JSON.parse(readFileSync(this.dismissedAlertsPath, 'utf8'));
        if (Array.isArray(keys)) this.dismissedAlertKeys = new Set(keys.filter((key): key is string => typeof key === 'string'));
      } catch {
        // ignore corrupt dismissed alerts cache
      }
    }
    this.refreshNookData();

    this.window = createIslandWindow(WIN_W, WIN_H, { focusable: false, fullscreenable: false, enableLargerThanScreen: true });
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.setAlwaysOnTop(true, 'screen-saver', 2);
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Must follow setAlwaysOnTop: Chromium adds the Managed behavior back whenever the level is set.
    this.ax.setStationaryWindow?.(this.window.getNativeWindowHandle());

    const check = (event: IpcMainEvent | IpcMainInvokeEvent) => {
      if (![this.window, this.notes?.window, this.finder?.window, this.translator?.window, this.clipboardHistory?.window].some(win => win && fromMainFrame(event, win))) {
        throw new Error('套件表面来源不匹配');
      }
    };
    const toast = (text: string, badge?: string) => this.toast(text, badge);
    this.notes = new EdgeNotes(this.fonts, { check, toast, onPinImage: callbacks.onPinImage, settings: callbacks.settings });
    this.finder = new FinderPanel(this.fonts, {
      check,
      toast,
      pinImage: callbacks.onPinImage,
      pinText: callbacks.onPinText,
      sendToAi: paths => callbacks.onSendFilesToAi(paths),
      settings: callbacks.settings
    });
    this.clipboardHistory = new ClipboardHistoryPanel(this.fonts, {
      check,
      pinImage: callbacks.onPinImage,
      pinText: callbacks.onPinText,
      noteText: (text, sourceApp) => this.notes.appendScratchpad(text, sourceApp),
      translateText: text => this.translator.open(text),
      askAi: text => callbacks.onAskAi(text),
      onCopy: event => this.handleCopy(event),
      settings: callbacks.settings,
      ax: this.ax
    });
    this.translator = new TranslatorPanel(this.fonts, {
      check,
      mediaService: callbacks.mediaService,
      translationSettings: () => callbacks.settings().translation,
      saveTargetLang: targetLang => callbacks.saveTranslation({ ...callbacks.settings().translation, targetLang }),
      writeText: (text, options) => this.clipboardHistory.writeText(text, options),
      pinText: callbacks.onPinText,
      noteText: text => this.notes.appendScratchpad(text, '翻译'),
      ax: this.ax
    });

    this.placeWindows();
    screen.on('display-metrics-changed', this.onDisplayMetricsChanged);

    ipcMain.handle('island:state', event => {
      check(event);
      this.refreshNookData();
      return this.snapshot();
    });
    ipcMain.on('island:mode', (event, mode: IslandMode) => {
      check(event);
      if (!MODES.includes(mode)) return;
      this.mode = mode;
      if (this.mode === 'idle' || this.mode === 'focus') {
        this.window.setIgnoreMouseEvents(true, { forward: true });
      }
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
    ipcMain.handle('island:open-nook', event => {
      check(event);
      this.openNook();
    });
    ipcMain.handle('island:snooze-alert', (event, alertId: string, minutes = 10) => {
      check(event);
      if (typeof alertId !== 'string' || !alertId || ![10, 30, 120].includes(minutes)) throw new Error('提醒或延后时间无效');
      this.snoozeAlert(alertId, minutes);
    });
    ipcMain.handle('island:dismiss-alert', (event, alertId?: string) => {
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
        void this.finder.summon();
        return;
      }
      if (action === 'open-translator') {
        this.translator.open();
        return;
      }
      if (action === 'open-clipboard') {
        this.clipboardHistory.open();
        return;
      }
      this.callbacks.onQuickAction(action);
    });
    ipcMain.handle('island:nook-prefs', (event, patch: Partial<NookReminderPrefs>) => {
      check(event);
      if (
        !patch ||
        typeof patch !== 'object' ||
        Array.isArray(patch) ||
        Object.entries(patch).some(([key, value]) => !Object.hasOwn(this.nookPrefs, key) || typeof value !== 'boolean')
      ) {
        throw Error('Nook 提醒设置无效');
      }
      this.nookPrefs = { ...this.nookPrefs, ...patch };
      this.callbacks.saveNookPrefs(this.nookPrefs);
      this.ax.postBridge?.('com.nook.bridge.action', JSON.stringify({ action: 'set-reminder-prefs', ...patch }));
      this.publish();
    });
    ipcMain.handle('island:copy-translate', (event, enabled: boolean) => {
      check(event);
      if (typeof enabled !== 'boolean') throw Error('复制即译开关无效');
      callbacks.saveTranslation({ ...callbacks.settings().translation, copyTranslateEnabled: enabled });
    });
    ipcMain.handle('island:snap-window', (event, slot: SnapSlot) => {
      check(event);
      if (!SNAP_SLOTS.includes(slot)) throw new Error('不支持的分屏位置');
      this.snapWindow(slot);
    });

    this.ax.startBridge?.(({ name, payload }) => this.handleBridgeNotification(name, payload));
    this.ax.postBridge?.('com.nook.bridge.action', JSON.stringify({ action: 'get-reminder-prefs' }));
    this.ax.startFinderTrigger?.(() => void this.finder.summon());
    this.ax.startIslandStatusClick?.(() => {
      if (this.mode === 'board') this.closeBoard();
      else this.openBoard();
    });
    this.ax.startCopyWatch?.(event => {
      if (!event.doubleCopy || !this.callbacks.settings().translation.copyTranslateEnabled || this.callbacks.settings().translation.copyTranslateTrigger !== 'double-cmd-c') return;
      this.pendingDoubleCopyAt = event.timestamp;
      if (this.copyTimer) clearTimeout(this.copyTimer);
      this.copyTimer = setTimeout(() => {
        this.copyTimer = null;
        void this.clipboardHistory.poll().then(() => this.translateCopy()).catch(error => console.error('复制即译采集失败', error));
      }, 25);
    });

    this.window.once('ready-to-show', () => {
      if (!process.env.LASSO_DATA_ROOT && this.islandEnabled) this.window.showInactive();
      this.placeWindows();
      this.publish();
      if (!process.env.LASSO_DATA_ROOT) {
        for (const delay of [280, 750, 1400]) {
          setTimeout(() => {
            if (!this.window.isDestroyed()) this.publish();
          }, delay);
        }
      }
    });
    void this.window.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'island' } });
  }

  private refreshNookData() {
    const data = readNookFocusData();
    this.nookReview = data.review;
    this.nookTasks = data.tasks;
    this.nookCompletedCount = data.completedCount;
    this.nookTotalCount = data.totalCount;
    this.syncNookWatchers(data.watchedDirs);
  }

  private syncNookWatchers(dirs: string[]) {
    const wanted = new Set(dirs);
    for (const [dir, watcher] of this.nookWatchers) {
      if (!wanted.has(dir)) {
        watcher.close();
        this.nookWatchers.delete(dir);
      }
    }
    for (const dir of wanted) {
      if (this.nookWatchers.has(dir) || !existsSync(dir)) continue;
      try {
        const watcher = watch(dir, () => {
          if (this.nookWatchDebounce) clearTimeout(this.nookWatchDebounce);
          this.nookWatchDebounce = setTimeout(() => {
            this.nookWatchDebounce = null;
            this.refreshNookData();
            this.publish();
          }, 200);
        });
        watcher.on('error', () => {
          watcher.close();
          this.nookWatchers.delete(dir);
        });
        this.nookWatchers.set(dir, watcher);
      } catch {
        // directory unavailable
      }
    }
  }

  private isCapsuleActive(): boolean {
    if (!this.islandEnabled) return false;
    if (this.mode === 'board' || this.toastItem || this.alerts.length > 0 || this.pomodoro?.active) return true;
    return this.nookTasks.some(t => !t.completed) || Boolean(this.nookReview && (this.nookReview.mainGoal || this.nookReview.items.length > 0));
  }

  private placeWindows(anchorX?: number) {
    const primary = screen.getPrimaryDisplay();
    if (!this.window.isDestroyed()) {
      const geoAnchor = anchorX ?? this.ax.notchGeometry?.(this.isCapsuleActive())?.anchorX;
      const targetCenter = typeof geoAnchor === 'number' && geoAnchor > 0
        ? primary.bounds.x + geoAnchor
        : primary.bounds.x + primary.bounds.width / 2;
      const x = Math.round(Math.max(primary.bounds.x, Math.min(targetCenter - WIN_W / 2, primary.bounds.x + primary.bounds.width - WIN_W)));
      const y = primary.bounds.y;
      const cur = this.window.getBounds();
      if (Math.abs(x - this.lastAnchorX) >= 2 || Math.abs(cur.x - x) >= 2 || cur.y !== y || cur.width !== WIN_W || cur.height !== WIN_H) {
        this.lastAnchorX = x;
        this.window.setBounds({ x, y, width: WIN_W, height: WIN_H });
      }
    }
    this.notes.place();
  }

  private resolveBaseMode(): IslandMode {
    if (this.pomodoro?.active) return this.pomodoro.kind === 'slacking' ? 'slacking' : 'focus';
    if (this.nookTasks.some(t => !t.completed) || Boolean(this.nookReview && (this.nookReview.mainGoal || this.nookReview.items.length > 0))) return 'focus';
    return 'idle';
  }

  private snapshot(): IslandState {
    const active = this.isCapsuleActive();
    const geo = this.ax.notchGeometry?.(active);
    if (geo?.anchorX) this.placeWindows(geo.anchorX);
    return {
      mode: this.islandEnabled ? this.mode : 'idle',
      notch: geo
        ? {
            hasNotch: geo.hasNotch,
            width: Math.round(geo.width),
            height: Math.round(geo.height),
            menuBarHeight: Math.round(geo.menuBarHeight),
            leftSafeWidth: typeof geo.leftSafeWidth === 'number' ? Math.round(geo.leftSafeWidth) : 152,
            rightSafeWidth: typeof geo.rightSafeWidth === 'number' ? Math.round(geo.rightSafeWidth) : 88,
            anchorX: geo.anchorX ? Math.round(geo.anchorX) : undefined
          }
        : { hasNotch: false, width: 156, height: 28, menuBarHeight: 28, leftSafeWidth: 152, rightSafeWidth: 88 },
      nookPrefs: { ...this.nookPrefs },
      copyTranslateEnabled: this.copyTranslateEnabled,
      pomodoro: this.pomodoro,
      toast: this.toastItem,
      alerts: this.alerts,
      nookReview: this.nookReview,
      nookTasks: this.nookTasks,
      nookCompletedCount: this.nookCompletedCount,
      nookTotalCount: this.nookTotalCount,
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
    this.copyTranslateEnabled = settings.translation.copyTranslateEnabled;
    if (!this.copyTranslateEnabled) this.pendingDoubleCopyAt = 0;

    this.nookPrefs = { ...settings.nookPrefs };
    const nextEnabled = settings.notchIslandEnabled !== false;
    if (this.islandEnabled !== nextEnabled) {
      this.islandEnabled = nextEnabled;
      if (!nextEnabled) {
        this.ax.notchGeometry?.(false);
        if (!this.window.isDestroyed() && this.window.isVisible()) this.window.hide();
      } else if (!process.env.LASSO_DATA_ROOT && !this.window.isDestroyed() && !this.window.isVisible()) {
        this.window.showInactive();
      }
    }

    if (this.dragSnapEnabled !== settings.windowDragSnap || this.snapDwellMs !== settings.snapDwellMs) {
      this.ax.setWindowDragSnapEnabled?.(settings.windowDragSnap, settings.snapDwellMs);
      this.dragSnapEnabled = settings.windowDragSnap;
      this.snapDwellMs = settings.snapDwellMs;
    }
    this.ax.setFinderTriggerOptions?.(settings.finderTriggers.middleClick, settings.finderTriggers.rightHold);

    if (this.mode !== 'board' && this.mode !== 'toast') {
      this.mode = this.resolveBaseMode();
    }
    this.publish();
    this.notes.updateSettings(settings);
    this.finder.updateSettings(settings);
    this.translator.updateSettings(settings);
    this.clipboardHistory.updateSettings(settings);
  }

  private handleCopy(event: ClipboardCopyEvent) {
    this.lastCopy = event;
    const settings = this.callbacks.settings().translation;
    if (settings.copyTranslateEnabled && (settings.copyTranslateTrigger === 'every-copy' || (this.pendingDoubleCopyAt && !this.copyTimer))) {
      this.translateCopy();
    }
  }

  private translateCopy() {
    const settings = this.callbacks.settings().translation;
    const copy = this.lastCopy;
    if (!settings.copyTranslateEnabled || !copy || copy.entry.kind !== 'text' || copy.changeCount === this.lastTranslatedChangeCount) return;
    if (settings.copyTranslateTrigger === 'double-cmd-c' && (!this.pendingDoubleCopyAt || Date.now() - this.pendingDoubleCopyAt > 700 || copy.timestamp < this.pendingDoubleCopyAt - 450)) return;
    const meta = this.ax.pasteboardMeta?.();
    if (!meta || meta.concealed || meta.changeCount !== copy.changeCount) return;
    this.pendingDoubleCopyAt = 0;
    this.lastTranslatedChangeCount = copy.changeCount;
    this.translator.open(copy.entry.text, copy.pid);
  }

  private persistDismissedAlerts() {
    writeFileAtomic(this.dismissedAlertsPath, JSON.stringify([...this.dismissedAlertKeys]) + '\n');
  }

  openNook() {
    if (this.mode === 'board') this.closeBoard();
    this.ax.postBridge?.('com.nook.bridge.action', JSON.stringify({ action: 'open-review' }));
    const homeApp = join(homedir(), 'Applications/Nook.app');
    if (existsSync(homeApp)) {
      execFile('open', [homeApp], () => {});
    } else {
      execFile('open', ['-a', 'Nook'], () => {});
    }
  }

  openBoard() {
    if (!this.islandEnabled && !process.env.LASSO_DATA_ROOT) {
      this.window.showInactive();
    }
    this.refreshNookData();
    this.mode = 'board';
    this.window.setIgnoreMouseEvents(false);
    this.publish();
  }

  closeBoard() {
    this.mode = this.resolveBaseMode();
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.blur();
    this.publish();
  }

  snapWindow(slot: SnapSlot) {
    if (this.mode === 'board') this.closeBoard();
    if (slot === 'prev-display' || slot === 'next-display') {
      const displays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
      if (displays.length < 2) {
        this.toast('当前仅连接一台显示器', 'Snap');
        return;
      }
      const frame = this.ax.focusedWindowFrame?.();
      if (!frame) {
        this.toast('未找到可移动的前台窗口', 'Snap');
        return;
      }
      const center = { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) };
      const current = screen.getDisplayNearestPoint(center);
      const index = displays.findIndex(display => display.id === current.id);
      const target = displays[(index + (slot === 'prev-display' ? -1 : 1) + displays.length) % displays.length];
      const from = current.workArea, to = target.workArea;
      const x = Math.round(to.x + ((frame.x - from.x) / from.width) * to.width);
      const y = Math.round(to.y + ((frame.y - from.y) / from.height) * to.height);
      const width = Math.max(1, Math.round((frame.width / from.width) * to.width));
      const height = Math.max(1, Math.round((frame.height / from.height) * to.height));
      const moved = this.ax.snapWindow?.(x, y, width, height);
      this.toast(moved ? `已移至显示器：${target.label || target.id}` : '未能移动前台窗口', 'Snap');
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const gap = 8;
    if (slot === 'coding-ai' || slot === 'equal-split') {
      const label = slot === 'coding-ai' ? '2:1' : '1:1';
      const leftW = Math.round((area.width - gap * 3) * (slot === 'coding-ai' ? 0.66 : 0.5));
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
      this.toast(moved === 2 ? `已完成 ${label} 双栏布局` : moved === 1 ? '仅移动了一个窗口，未完成双栏布局' : '未能排布窗口，请检查辅助功能权限及可用窗口', label);
      return;
    }

    const halfW = Math.round((area.width - gap * 3) / 2);
    const halfH = Math.round((area.height - gap * 3) / 2);
    const thirdW = Math.round((area.width - gap * 4) / 3);
    const twoThirdW = area.width - gap * 3 - thirdW;
    const fullH = area.height - gap * 2;
    const fullW = area.width - gap * 2;

    const rects: Record<Exclude<SnapSlot, 'coding-ai' | 'equal-split' | 'prev-display' | 'next-display'>, [number, number, number, number, string]> = {
      'left-half': [area.x + gap, area.y + gap, halfW, fullH, '左半屏'],
      'right-half': [area.x + gap * 2 + halfW, area.y + gap, halfW, fullH, '右半屏'],
      'top-half': [area.x + gap, area.y + gap, fullW, halfH, '上半屏'],
      'bottom-half': [area.x + gap, area.y + gap * 2 + halfH, fullW, halfH, '下半屏'],
      'top-left': [area.x + gap, area.y + gap, halfW, halfH, '左上角'],
      'top-right': [area.x + gap * 2 + halfW, area.y + gap, halfW, halfH, '右上角'],
      'bottom-left': [area.x + gap, area.y + gap * 2 + halfH, halfW, halfH, '左下角'],
      'bottom-right': [area.x + gap * 2 + halfW, area.y + gap * 2 + halfH, halfW, halfH, '右下角'],
      'left-third': [area.x + gap, area.y + gap, thirdW, fullH, '左 1/3'],
      'center-third': [area.x + gap * 2 + thirdW, area.y + gap, thirdW, fullH, '中 1/3'],
      'right-third': [area.x + gap * 3 + thirdW * 2, area.y + gap, area.width - gap * 4 - thirdW * 2, fullH, '右 1/3'],
      'left-two-thirds': [area.x + gap, area.y + gap, twoThirdW, fullH, '左 2/3'],
      'right-two-thirds': [area.x + gap * 2 + thirdW, area.y + gap, twoThirdW, fullH, '右 2/3'],
      maximize: [area.x + gap, area.y + gap, fullW, fullH, '最大化'],
      center: [
        Math.round(area.x + area.width * 0.12),
        Math.round(area.y + area.height * 0.1),
        Math.round(area.width * 0.76),
        Math.round(area.height * 0.8),
        '窗口居中'
      ]
    };
    const [x, y, w, h, label] = rects[slot];
    const moved = this.ax.snapWindow?.(x, y, w, h);
    this.toast(moved ? `已调整窗口：${label}` : '未能调整窗口，请检查辅助功能权限及前台窗口', '分屏');
  }

  pasteSelection(): void {
    this.ax.paste?.();
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
      if (this.mode === 'idle' || this.mode === 'focus') {
        this.window.setIgnoreMouseEvents(true, { forward: true });
      }
      this.publish();
    }, 2400);
  }

  startPomodoro(task?: { id: string | null; title: string }, minutes = 25, kind: 'focus' | 'slacking' = 'focus') {
    if (this.tickTimer) clearInterval(this.tickTimer);
    const totalSeconds = Math.max(60, Math.round(minutes * 60));
    const firstOpen = this.nookTasks.find(t => !t.completed);
    const chosen = task || (firstOpen ? { id: firstOpen.id, title: firstOpen.title } : { id: null, title: '深度专注' });
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
    this.publish();

    this.tickTimer = setInterval(() => {
      if (!this.pomodoro || !this.pomodoro.active || this.pomodoro.paused) return;
      const next = this.pomodoro.remainingSeconds - 1;
      if (next <= 0) {
        if (this.pomodoro.kind === 'focus') {
          this.startPomodoro({ id: this.pomodoro.taskId, title: '休息提醒 · 起身活动喝水' }, 5, 'slacking');
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
    this.mode = this.resolveBaseMode();
    this.publish();
  }

  completeTask(taskId: string) {
    const existing = this.nookTasks.find(t => t.id === taskId);
    const nextCompleted = existing ? !existing.completed : true;
    if (nextCompleted) {
      this.dismissedAlertKeys.add(taskId);
      this.persistDismissedAlerts();
    }
    this.ax.postBridge?.('com.nook.bridge.action', JSON.stringify({ action: nextCompleted ? 'complete-task' : 'reopen-task', taskId }));
    if (existing) {
      this.nookTasks = this.nookTasks.map(t => (t.id === taskId ? { ...t, completed: nextCompleted } : t));
      this.nookCompletedCount = Math.max(0, this.nookCompletedCount + (nextCompleted ? 1 : -1));
    }
    if (nextCompleted) {
      this.alerts = this.alerts.filter(a => a.id !== taskId && a.target !== taskId);
      if (this.pomodoro?.taskId === taskId) {
        this.stopPomodoro();
      }
      if (this.mode === 'nook-alert' && this.alerts.length === 0) {
        this.mode = this.resolveBaseMode();
        if (this.mode === 'idle' || this.mode === 'focus') {
          this.window.setIgnoreMouseEvents(true, { forward: true });
        }
      }
    }
    this.publish();
  }

  snoozeAlert(alertId: string, minutes = 10) {
    const target = this.alerts.find(a => a.id === alertId);
    const meta = this.alertBridgeMeta.get(alertId);
    this.ax.postBridge?.('com.nook.bridge.action', JSON.stringify({
      action: 'snooze',
      id: alertId,
      minutes,
      ...(target ? { title: target.title, subtitle: target.subtitle, kind: target.kind, target: target.target } : {}),
      ...(meta ?? {})
    }));
    this.alerts = this.alerts.filter(a => a.id !== alertId);
    if (this.mode !== 'board') {
      this.mode = this.resolveBaseMode();
      if (this.mode === 'idle' || this.mode === 'focus') {
        this.window.setIgnoreMouseEvents(true, { forward: true });
      }
    }
    this.publish();
  }

  dismissAlert(alertId?: string) {
    const dismissAll = !alertId || alertId === '*';
    if (dismissAll) {
      const ids = this.alerts.map(alert => alert.id);
      for (const a of this.alerts) {
        if (a.id) this.dismissedAlertKeys.add(a.id);
        this.dismissedAlertKeys.add(`${a.kind}:${a.target || ''}:${a.title}`);
      }
      this.alerts = [];
      this.ax.postBridge?.('com.nook.bridge.action', JSON.stringify({ action: 'dismiss', ids }));
    } else {
      const target = this.alerts.find(a => a.id === alertId);
      if (target) {
        if (target.id) this.dismissedAlertKeys.add(target.id);
        this.dismissedAlertKeys.add(`${target.kind}:${target.target || ''}:${target.title}`);
      } else {
        this.dismissedAlertKeys.add(alertId);
      }
      this.alerts = this.alerts.filter(a => a.id !== alertId);
      this.ax.postBridge?.('com.nook.bridge.action', JSON.stringify({ action: 'dismiss', id: alertId }));
    }
    this.persistDismissedAlerts();
    if (this.mode !== 'board') {
      this.mode = this.resolveBaseMode();
      if (this.mode === 'idle' || this.mode === 'focus') {
        this.window.setIgnoreMouseEvents(true, { forward: true });
      }
    }
    this.publish();
  }

  restartService(label: string) {
    this.serviceRestartCooldown.set(label, Date.now() + 120_000);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    execFile('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], () => {
      this.ax.postBridge?.('com.nook.bridge.action', JSON.stringify({ action: 'restart-launchd', label }));
    });
    this.alerts = this.alerts.filter(a => a.target !== label && a.id !== label && a.id !== `launchd:${label}`);
    if (this.mode !== 'board') {
      this.mode = this.resolveBaseMode();
      if (this.mode === 'idle' || this.mode === 'focus') {
        this.window.setIgnoreMouseEvents(true, { forward: true });
      }
    }
    this.toast(`已重启 ${friendlyServiceName(label)}`, '服务');
  }

  private handleBridgeNotification(name: string, payload: string) {
    if (name === 'com.lasso.island.prefs') {
      try {
        const prefs = JSON.parse(payload) as Partial<NookReminderPrefs>;
        if (prefs && typeof prefs === 'object') {
          this.nookPrefs = {
            enabled: typeof prefs.enabled === 'boolean' ? prefs.enabled : this.nookPrefs.enabled,
            tasks: typeof prefs.tasks === 'boolean' ? prefs.tasks : this.nookPrefs.tasks,
            hubAttention: typeof prefs.hubAttention === 'boolean' ? prefs.hubAttention : this.nookPrefs.hubAttention,
            aiResets: typeof prefs.aiResets === 'boolean' ? prefs.aiResets : this.nookPrefs.aiResets,
            localAndCustom: typeof prefs.localAndCustom === 'boolean' ? prefs.localAndCustom : this.nookPrefs.localAndCustom
          };
          this.callbacks.saveNookPrefs(this.nookPrefs);
          this.publish();
        }
      } catch {
        // Ignore malformed bridge data.
      }
      return;
    }
    if (name === 'com.lasso.island.dismiss') {
      try {
        const parsed = payload ? (JSON.parse(payload) as { id?: string }) : {};
        if (parsed.id) {
          this.dismissedAlertKeys.delete(parsed.id);
          this.alerts = this.alerts.filter(a => a.id !== parsed.id);
        } else {
          this.alerts = [];
        }
      } catch {
        this.alerts = [];
      }
      this.persistDismissedAlerts();
      if (this.mode !== 'board') {
        this.mode = this.resolveBaseMode();
        if (this.mode === 'idle' || this.mode === 'focus') {
          this.window.setIgnoreMouseEvents(true, { forward: true });
        }
      }
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
          route?: string;
          rule?: string;
          rules?: string[];
          items?: (IslandAlertItem & { route?: string; rule?: string; rules?: string[] })[];
        };
        if (data.kind === 'slacking') {
          if (!this.nookPrefs.enabled || !this.nookPrefs.localAndCustom) return;
          this.startPomodoro({ id: null, title: data.title || '休息提醒 · 站起来喝口水' }, 5, 'slacking');
          return;
        }
        if (!this.nookPrefs.enabled) return;

        const isAllowedByPrefs = (item: { kind?: string; route?: string }) => {
          const kind = item.kind || 'custom';
          if (kind === 'task') return this.nookPrefs.tasks;
          if (kind === 'reset') return this.nookPrefs.aiResets;
          if (kind === 'launchd') return this.nookPrefs.localAndCustom;
          if (item.route && item.route !== 'reminders') return this.nookPrefs.hubAttention;
          return this.nookPrefs.hubAttention || this.nookPrefs.localAndCustom;
        };

        const recordMeta = (id: string, item: { route?: string; rule?: string; rules?: string[] }) => {
          const rules = Array.isArray(item.rules) ? item.rules.filter((r): r is string => typeof r === 'string' && r.length > 0) : undefined;
          const rule = typeof item.rule === 'string' && item.rule.length > 0 ? item.rule : undefined;
          const route = typeof item.route === 'string' && item.route.length > 0 ? item.route : undefined;
          if (route || rule || rules?.length) {
            this.alertBridgeMeta.set(id, { ...(route ? { route } : {}), ...(rule ? { rule } : {}), ...(rules?.length ? { rules } : {}) });
          }
        };

        const isSuppressed = (item: { id?: string; kind?: string; target?: string; title?: string }) => {
          if (item.target) {
            const until = this.serviceRestartCooldown.get(item.target);
            if (until && until > Date.now()) return true;
            if (until && until <= Date.now()) this.serviceRestartCooldown.delete(item.target);
          }
          if (item.id && this.dismissedAlertKeys.has(item.id)) return true;
          if (item.target && (this.dismissedAlertKeys.has(item.target) || this.dismissedAlertKeys.has(`launchd:${item.target}`))) return true;
          const key = `${item.kind || 'custom'}:${item.target || ''}:${item.title || ''}`;
          return this.dismissedAlertKeys.has(key);
        };

        if (Array.isArray(data.items) && data.items.length > 0) {
          const fresh = data.items
            .filter(item => isAllowedByPrefs(item) && !isSuppressed(item))
            .map(item => ({ raw: item, clean: sanitizeAlertItem(item) }))
            .filter(({ clean }) => !isSuppressed(clean));
          if (fresh.length === 0) return;
          for (const { raw, clean } of fresh) {
            recordMeta(clean.id, raw);
          }
          this.alerts = fresh.map(({ clean }) => clean);
        } else if (data.title) {
          if (!isAllowedByPrefs(data) || isSuppressed(data)) return;
          const item = sanitizeAlertItem({
            id: data.id || String(Date.now()),
            kind: data.kind === 'launchd' || data.kind === 'reset' || data.kind === 'task' ? data.kind : 'custom',
            title: data.title,
            subtitle: data.subtitle || '来自 Nook 提醒中心',
            target: data.target
          });
          if (isSuppressed(item)) return;
          recordMeta(item.id, data);
          this.alerts = [item, ...this.alerts.filter(a => a.id !== item.id && !isSuppressed(a))].slice(0, 6);
        } else {
          return;
        }

        this.refreshNookData();
        if (this.alerts.length === 0) return;
        this.publish();
      } catch {
        // ignore invalid payload
      }
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    screen.off('display-metrics-changed', this.onDisplayMetricsChanged);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.copyTimer) clearTimeout(this.copyTimer);
    if (this.nookWatchDebounce) clearTimeout(this.nookWatchDebounce);
    for (const watcher of this.nookWatchers.values()) watcher.close();
    this.nookWatchers.clear();
    this.ax.notchGeometry?.(false);
    this.ax.stopFinderTrigger?.();
    this.ax.stopCopyWatch?.();
    this.ax.setWindowDragSnapEnabled?.(false);
    if (!this.window.isDestroyed()) this.window.destroy();
    this.notes.destroy();
    this.finder.destroy();
    this.translator.destroy();
    this.clipboardHistory.destroy();
  }
}
