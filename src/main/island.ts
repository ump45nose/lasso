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
  IslandTaskListMeta,
  NookReminderPrefs,
  NookReviewBadge,
  NotchFullscreenMode,
  PomodoroSettings,
  SelectionContext,
  Settings,
  SettingsSection,
  SnapSlot
} from '../shared/contracts';
import { fromMainFrame } from './ipc';
import { defaultPomodoroSettings, normalizePomodoroSettings } from './settings';
import { FinderPanel } from './island-finder';
import { ClipboardHistoryPanel, type ClipboardCopyEvent } from './island-clipboard';
import { TranslatorPanel } from './island-translator';
import type { MediaService } from './media-service';
import type { TranslationSettings } from '../shared/media';
import { writeFileAtomic } from './files';
import { EdgeNotes } from './island-notes';
import { createIslandWindow } from './island-window';
import { nativeAx, type NativeAx } from './native-ax';

const WIN_W = 540, WIN_H = 760;

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
  reviewBadge: NookReviewBadge | null;
  taskLists: IslandTaskListMeta[];
  tasks: IslandTaskItem[];
  completedCount: number;
  totalCount: number;
  watchedDirs: string[];
}

function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function todayLocalKey(): string {
  return localDayKey(new Date());
}

function isoToLocalDayKey(iso?: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isFinite(ms)) return localDayKey(new Date(ms));
  return iso.slice(0, 10);
}

function formatDueInfo(dueRaw: string | undefined, todayStr: string): { dueLabel?: string; overdue?: boolean; diffDays?: number } {
  if (!dueRaw) return {};
  const day = dueRaw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return {};
  if (day === todayStr) return { dueLabel: '今天', diffDays: 0 };
  const todayMs = Date.parse(`${todayStr}T00:00:00`);
  const dueMs = Date.parse(`${day}T00:00:00`);
  if (!Number.isFinite(todayMs) || !Number.isFinite(dueMs)) return {};
  const diffDays = Math.round((todayMs - dueMs) / 86_400_000);
  if (diffDays > 0) return { dueLabel: `逾期 ${diffDays} 天`, overdue: true, diffDays };
  if (diffDays === -1) return { dueLabel: '明天', diffDays };
  return { dueLabel: day.slice(5), diffDays };
}

function shortListTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed === '循环任务') return '循环';
  if (trimmed === '持续性任务') return '持续';
  if (trimmed === '阻塞任务') return '阻塞';
  return trimmed || 'Tasks';
}

function isRoutineListTitle(title: string): boolean {
  return title.includes('循环');
}

function matchRoutineSlot(title: string, notes: string | undefined, now: Date): { slotLabel: string; priority: number } | null {
  const firstLine = notes?.split(/\r?\n/, 1)[0]?.trim() || '';
  const timeMatch = firstLine.match(/^时间\s+(\d{1,2}):(\d{2})/);
  if (timeMatch) {
    const h = Number(timeMatch[1]);
    const m = Number(timeMatch[2]);
    if (h >= 0 && h < 24 && m >= 0 && m < 60) {
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const targetMin = h * 60 + m;
      const diff = nowMin - targetMin;
      if (diff >= -45 && diff <= 120) {
        return { slotLabel: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, priority: 0 };
      }
    }
  }

  const hour = now.getHours();
  const day = now.getDay();
  const t = title.trim();

  if (hour >= 5 && hour < 11) {
    if (/早起|晨|早间/.test(t) || (t.includes('洗漱') && !t.includes('睡'))) {
      return { slotLabel: '早间', priority: 1 };
    }
  }
  if (hour >= 11 && hour < 17) {
    if (/摸鱼|午|休息|走走/.test(t)) {
      return { slotLabel: '午后', priority: 1 };
    }
  }
  if (hour >= 17 && hour < 19) {
    if (/下班|整理|傍晚/.test(t)) {
      return { slotLabel: '下班前', priority: 1 };
    }
  }
  if (hour >= 19 && hour < 21) {
    if ([1, 3, 5, 0].includes(day) && t.includes('一三五七')) {
      return { slotLabel: '今日训练', priority: 1 };
    }
    if ([2, 4, 6].includes(day) && t.includes('二四六')) {
      return { slotLabel: '今日训练', priority: 1 };
    }
    if (/健身|训练|运动/.test(t)) {
      return { slotLabel: '晚间训练', priority: 2 };
    }
  }
  if (hour >= 21 && hour < 23) {
    if (day === 0 && t.includes('周报')) {
      return { slotLabel: '周日复盘', priority: 1 };
    }
    if (/日报|复盘/.test(t)) {
      return { slotLabel: '晚间复盘', priority: 2 };
    }
  }
  if (hour >= 22 || hour < 5) {
    if (/睡觉|睡前|洗漱睡觉/.test(t)) {
      return { slotLabel: '睡前', priority: 3 };
    }
  }

  return null;
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

function isGeneralFocusList(listTitle: string): boolean {
  const t = listTitle.trim();
  return t === '一般性' || t === 'Lasso · 今日重点' || t === 'Google Tasks';
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

interface RawTaskRecord {
  id: string;
  title: string;
  listId: string;
  listTitle: string;
  notes?: string;
  completed: boolean;
  completedAt?: string;
  due?: string;
  position: string;
}

function readNookFocusData(): NookFocusSnapshot {
  const base = resolveNookCacheDir();
  const dirs = new Set<string>();
  if (existsSync(base)) dirs.add(base);
  else if (existsSync(dirname(base))) dirs.add(dirname(base));

  const now = new Date();
  const today = localDayKey(now);
  const orderedLists: { id: string; title: string }[] = [];
  const seenListIds = new Set<string>();
  const ensureList = (id: string, title: string) => {
    if (!seenListIds.has(id)) {
      seenListIds.add(id);
      orderedLists.push({ id, title });
    }
  };
  const rawTasks: RawTaskRecord[] = [];

  for (const file of ['google.json', 'agenda.json']) {
    const data = resolveSlotJson(join(base, file), dirs) as {
      lists?: { id?: string; title?: string }[];
      tasks?: {
        id?: string;
        listID?: string;
        listId?: string;
        list_id?: string;
        title?: string;
        notes?: string;
        completed?: boolean;
        deleted?: boolean;
        completedAt?: string;
        due?: string;
        position?: string;
        parent?: string;
      }[];
      taskLists?: {
        id?: string;
        title?: string;
        items?: { id?: string; title?: string; notes?: string; status?: string; due?: string; completedAt?: string }[];
      }[];
    } | null;
    if (!data || typeof data !== 'object') continue;

    if (Array.isArray(data.tasks)) {
      const listNames = new Map<string, string>();
      for (const l of data.lists || []) {
        if (l.id && l.title) {
          listNames.set(l.id, l.title);
          ensureList(l.id, l.title);
        }
      }
      for (let i = 0; i < data.tasks.length; i++) {
        const task = data.tasks[i];
        if (!task.id || !task.title || task.parent || task.deleted) continue;
        const listId = task.listID || task.listId || task.list_id || 'default';
        const listTitle = listNames.get(listId) || 'Google Tasks';
        ensureList(listId, listTitle);
        const notes = typeof task.notes === 'string' && task.notes.trim() ? task.notes.trim() : undefined;
        rawTasks.push({
          id: task.id,
          title: task.title.trim(),
          listId,
          listTitle,
          notes,
          completed: Boolean(task.completed),
          completedAt: task.completedAt,
          due: task.due,
          position: task.position || String(i).padStart(6, '0')
        });
      }
      break;
    }

    if (Array.isArray(data.taskLists)) {
      for (let li = 0; li < data.taskLists.length; li++) {
        const list = data.taskLists[li];
        const listTitle = list.title?.trim() || 'Google Tasks';
        const listId = list.id || `list-${li}`;
        ensureList(listId, listTitle);
        const items = list.items || [];
        for (let ii = 0; ii < items.length; ii++) {
          const item = items[ii];
          if (!item.id || !item.title || item.status === 'deleted') continue;
          const notes = typeof item.notes === 'string' && item.notes.trim() ? item.notes.trim() : undefined;
          const completed = item.status === 'completed' || item.status === 'done';
          rawTasks.push({
            id: item.id,
            title: item.title.trim(),
            listId,
            listTitle,
            notes,
            completed,
            completedAt: item.completedAt,
            due: item.due,
            position: String(ii).padStart(6, '0')
          });
        }
      }
      if (rawTasks.length) break;
    }
  }

  const openEntries: { item: IslandTaskItem; rank: number; dueDay: string; position: string }[] = [];
  const doneTodayTasks: IslandTaskItem[] = [];
  const openCountByList = new Map<string, number>();
  let bestRoutine: { index: number; slotLabel: string; priority: number; position: string } | null = null;

  for (const task of rawTasks) {
    const isRoutine = isRoutineListTitle(task.listTitle);
    if (task.completed) {
      if (!task.completedAt || isoToLocalDayKey(task.completedAt) === today) {
        doneTodayTasks.push({
          id: task.id,
          title: task.title,
          listId: task.listId,
          listTitle: task.listTitle,
          notes: task.notes,
          completed: true,
          isRoutine,
          inFocus: !isRoutine
        });
      }
      continue;
    }

    openCountByList.set(task.listId, (openCountByList.get(task.listId) ?? 0) + 1);
    const dueDay = task.due ? task.due.slice(0, 10) : '';

    if (isRoutine) {
      const idx = openEntries.length;
      openEntries.push({
        item: {
          id: task.id,
          title: task.title,
          listId: task.listId,
          listTitle: task.listTitle,
          notes: task.notes,
          completed: false,
          isRoutine: true,
          inFocus: false
        },
        rank: 6,
        dueDay: dueDay || '9999-99-99',
        position: task.position
      });
      const match = matchRoutineSlot(task.title, task.notes, now);
      if (match) {
        if (
          !bestRoutine ||
          match.priority < bestRoutine.priority ||
          (match.priority === bestRoutine.priority && task.position.localeCompare(bestRoutine.position) < 0)
        ) {
          bestRoutine = { index: idx, slotLabel: match.slotLabel, priority: match.priority, position: task.position };
        }
      }
      continue;
    }

    const { dueLabel, overdue, diffDays } = formatDueInfo(task.due, today);
    const isGeneral = isGeneralFocusList(task.listTitle);
    const dueWithinWeek = diffDays !== undefined && diffDays >= -7;
    const inFocus = isGeneral || Boolean(overdue || dueWithinWeek);
    let rank = 5;
    if (overdue) rank = 1;
    else if (dueLabel === '今天') rank = 2;
    else if (isGeneral) rank = 3;
    else if (dueWithinWeek) rank = 4;

    openEntries.push({
      item: {
        id: task.id,
        title: task.title,
        listId: task.listId,
        listTitle: task.listTitle,
        notes: task.notes,
        completed: false,
        dueLabel,
        overdue,
        inFocus
      },
      rank,
      dueDay: dueDay || '9999-99-99',
      position: task.position
    });
  }

  if (bestRoutine) {
    const picked = openEntries[bestRoutine.index];
    picked.item.routineSlot = bestRoutine.slotLabel;
    picked.item.inFocus = true;
    picked.rank = 0;
  }

  if (!openEntries.some(e => e.item.inFocus)) {
    for (const entry of openEntries) {
      if (!entry.item.isRoutine) entry.item.inFocus = true;
    }
  }

  openEntries.sort((a, b) => a.rank - b.rank || a.dueDay.localeCompare(b.dueDay) || a.position.localeCompare(b.position));
  const tasks = [...openEntries.map(e => e.item), ...doneTodayTasks];
  const taskLists: IslandTaskListMeta[] = orderedLists.map(l => ({
    id: l.id,
    title: l.title,
    shortTitle: shortListTitle(l.title),
    openCount: openCountByList.get(l.id) ?? 0
  }));

  const completedCount = doneTodayTasks.filter(t => t.inFocus).length;
  const totalCount = openEntries.filter(e => e.item.inFocus).length + completedCount;

  let reviewBadge: NookReviewBadge | null = null;
  const hubRaw = resolveSlotJson(join(base, 'hub.json'), dirs) as {
    goals?: {
      data?: {
        reviews?: {
          daily?: { label?: string; id?: string; status?: string };
          weekly?: { label?: string; id?: string; status?: string };
        };
      };
      reviews?: {
        daily?: { label?: string; id?: string; status?: string };
        weekly?: { label?: string; id?: string; status?: string };
      };
    };
  } | null;

  if (hubRaw && typeof hubRaw === 'object') {
    const reviews = hubRaw.goals?.data?.reviews ?? hubRaw.goals?.reviews;
    const daily = reviews?.daily;
    const weekly = reviews?.weekly;
    if (daily?.status === 'open') {
      reviewBadge = { label: '日报待确认', hot: true };
    } else if (weekly?.status === 'open') {
      reviewBadge = { label: '周报待确认', hot: true };
    } else if (now.getHours() >= 20 && !(daily?.label === today && daily?.status === 'finalized')) {
      reviewBadge = { label: '写日报', hot: true };
    }
  }

  return { reviewBadge, taskLists, tasks, completedCount, totalCount, watchedDirs: [...dirs] };
}

export interface NotchIslandCallbacks {
  onQuickAction: (action: 'screenshot-area' | 'open-settings') => void;
  openSettings?: (section?: SettingsSection) => void;
  onPinImage: (image: NativeImage, title?: string) => Promise<void>;
  onPinText: (text: string, title?: string) => Promise<void>;
  onAskAi: (payload: { kind: 'text'; text: string } | { kind: 'image'; imagePath: string }) => void;
  onSendFilesToAi: (paths: string[]) => Promise<void> | void;
  mediaService: MediaService;
  settings: () => Settings;
  saveTranslation: (settings: TranslationSettings) => void;
  saveNookPrefs: (prefs: NookReminderPrefs) => void;
  savePomodoroPrefs: (prefs: PomodoroSettings) => void;
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
  private fullscreenMode: NotchFullscreenMode = 'hide';
  private primaryFullscreen = false;
  private fullscreenHidden = false;
  private pomodoro: IslandState['pomodoro'] = null;
  private toastItem: IslandState['toast'] = null;
  private alerts: IslandAlertItem[] = [];
  private alertBridgeMeta = new Map<string, { route?: string; rule?: string; rules?: string[] }>();
  private dismissedAlertKeys = new Set<string>();
  private serviceRestartCooldown = new Map<string, number>();
  private readonly dismissedAlertsPath = join(app.getPath('userData'), 'island-dismissed-alerts.json');
  private nookPrefs: NookReminderPrefs = { enabled: true, tasks: true, hubAttention: true, aiResets: true, localAndCustom: true };
  private pomodoroPrefs: PomodoroSettings = defaultPomodoroSettings();
  private copyTranslateEnabled = false;
  private dragSnapEnabled: boolean | undefined;
  private snapDwellMs: number | undefined;
  private lastCopy: ClipboardCopyEvent | null = null;
  private lastTranslatedChangeCount = -1;
  private pendingDoubleCopyAt = 0;
  private copyTimer: ReturnType<typeof setTimeout> | null = null;
  private nookReviewBadge: NookReviewBadge | null = null;
  private nookTaskLists: IslandTaskListMeta[] = [];
  private nookTasks: IslandTaskItem[] = [];
  private nookCompletedCount = 0;
  private nookTotalCount = 0;
  private fonts: IslandState['fonts'] = { fonts: { display: '', text: '', ui: '', mono: '' }, importedFonts: [] };
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private nookWatchers = new Map<string, FSWatcher>();
  private nookWatchDebounce: ReturnType<typeof setTimeout> | null = null;
  private lastAnchorX = -1;
  private lastPublishedMode: IslandMode = 'idle';
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

    this.fullscreenMode = callbacks.settings().notchFullscreenMode ?? 'hide';
    this.window = createIslandWindow(WIN_W, WIN_H, { focusable: false, fullscreenable: false, enableLargerThanScreen: true });
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.setAlwaysOnTop(true, 'screen-saver', 2);
    this.applyFullscreenWindowPolicy();

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
      saveTranslation: next => callbacks.saveTranslation(next),
      openSettings: section => callbacks.openSettings ? callbacks.openSettings(section) : callbacks.onQuickAction('open-settings'),
      writeText: (text, options) => this.clipboardHistory.writeText(text, options),
      pinText: callbacks.onPinText,
      noteText: text => this.notes.appendScratchpad(text, '翻译'),
      ax: this.ax
    });

    this.placeWindows();
    screen.on('display-metrics-changed', this.onDisplayMetricsChanged);
    screen.on('display-added', this.onDisplayMetricsChanged);
    screen.on('display-removed', this.onDisplayMetricsChanged);

    ipcMain.handle('island:state', event => {
      check(event);
      this.refreshNookData();
      return this.snapshot();
    });
    ipcMain.on('island:mode', (event, mode: IslandMode) => {
      check(event);
      if (!MODES.includes(mode)) return;
      this.mode = mode;
      if (this.mode === 'board') {
        if (!this.window.isDestroyed()) this.window.setIgnoreMouseEvents(false, { forward: true });
      } else {
        this.syncMousePassthrough();
      }
      this.publish();
    });
    ipcMain.on('island:hit', (event, inside: boolean) => {
      check(event);
      const allowHit =
        inside &&
        (this.mode === 'board' ||
          this.mode === 'focus-hover' ||
          this.mode === 'nook-alert' ||
          this.mode === 'slacking' ||
          this.isCapsuleActive());
      if (!this.window.isDestroyed()) {
        this.window.setIgnoreMouseEvents(!allowHit, { forward: true });
      }
    });
    ipcMain.handle('island:pomo-start', (event, task?: { id: string | null; title: string }, minutes?: number, kind: 'focus' | 'slacking' = 'focus') => {
      check(event);
      if (kind !== 'focus' && kind !== 'slacking') throw new Error('番茄钟类型无效');
      if (minutes !== undefined && (typeof minutes !== 'number' || !Number.isFinite(minutes))) throw new Error('番茄钟时长无效');
      this.startPomodoro(task, minutes, kind);
    });
    ipcMain.handle('island:pomo-prefs', (event, patch: Partial<PomodoroSettings>) => {
      check(event);
      if (
        !patch ||
        typeof patch !== 'object' ||
        Array.isArray(patch) ||
        Object.entries(patch).some(([key, value]) =>
          key === 'soundEnabled' ? typeof value !== 'boolean'
          : key === 'focusMinutes' || key === 'breakMinutes' ? typeof value !== 'number' || !Number.isFinite(value)
          : true
        )
      ) {
        throw Error('番茄钟设置无效');
      }
      const wasSoundEnabled = this.pomodoroPrefs.soundEnabled;
      this.pomodoroPrefs = normalizePomodoroSettings({ ...this.pomodoroPrefs, ...patch }, this.pomodoroPrefs);
      this.callbacks.savePomodoroPrefs(this.pomodoroPrefs);
      if (!wasSoundEnabled && this.pomodoroPrefs.soundEnabled) this.playPomodoroChime('focus');
      this.publish();
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
        this.closeBoard();
      } else {
        this.syncMousePassthrough();
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
    this.ax.startFullscreenWatch?.(fullscreen => this.setFullscreenHidden(fullscreen));
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
      if (this.shouldShowWindow()) this.window.showInactive();
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
    this.nookReviewBadge = data.reviewBadge;
    this.nookTaskLists = data.taskLists;
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

  private applyFullscreenWindowPolicy() {
    if (this.window.isDestroyed()) return;
    const allowFullScreen = this.fullscreenMode !== 'hide';
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: allowFullScreen });
    // Must follow setAlwaysOnTop/setVisibleOnAllWorkspaces: keep Stationary + IgnoresCycle and desired fullscreen flag.
    this.ax.setStationaryWindow?.(this.window.getNativeWindowHandle(), allowFullScreen);
  }

  private isFullscreenClock(): boolean {
    return this.islandEnabled && this.primaryFullscreen && this.fullscreenMode === 'clock';
  }

  private shouldShowWindow(): boolean {
    if (process.env.LASSO_DATA_ROOT || this.destroyed || this.fullscreenHidden) return false;
    return this.islandEnabled || this.mode === 'board';
  }

  private syncFullscreenState() {
    if (this.destroyed) return;
    const nextHidden = this.primaryFullscreen && this.fullscreenMode === 'hide';
    const clockMode = this.isFullscreenClock();
    this.fullscreenHidden = nextHidden;

    if (nextHidden) {
      if (this.mode === 'board') {
        this.mode = this.resolveBaseMode();
      }
      this.syncMousePassthrough();
      this.ax.notchGeometry?.(false);
      if (!this.window.isDestroyed() && this.window.isVisible()) {
        this.window.hide();
      }
      return;
    }

    if (clockMode) {
      if (this.mode === 'board') {
        this.mode = this.resolveBaseMode();
      }
      this.syncMousePassthrough();
      this.ax.notchGeometry?.(false);
    }

    if (!this.window.isDestroyed() && this.shouldShowWindow() && !this.window.isVisible()) {
      this.window.showInactive();
      this.applyFullscreenWindowPolicy();
    }
    this.placeWindows();
    this.publish();
  }

  private setFullscreenHidden(fullscreen: boolean) {
    if (this.primaryFullscreen === fullscreen || this.destroyed) return;
    this.primaryFullscreen = fullscreen;
    this.syncFullscreenState();
  }

  private isCapsuleActive(): boolean {
    if (!this.islandEnabled || this.fullscreenHidden || this.isFullscreenClock()) return false;
    if (this.mode === 'board' || this.toastItem || this.alerts.length > 0 || this.pomodoro?.active) return true;
    return this.nookTasks.some(t => !t.completed && t.inFocus) || Boolean(this.nookReviewBadge?.hot);
  }

  private placeWindows(geo?: ReturnType<NonNullable<NativeAx['notchGeometry']>>) {
    const primary = screen.getPrimaryDisplay();
    if (!this.window.isDestroyed()) {
      const resolved = geo ?? this.ax.notchGeometry?.(this.isCapsuleActive());
      const centerOffset = resolved?.hasNotch && typeof resolved.anchorX === 'number' && resolved.anchorX > 0
        ? resolved.anchorX
        : primary.bounds.width / 2;
      const targetCenter = primary.bounds.x + centerOffset;
      const winW = Math.min(WIN_W, primary.bounds.width);
      const winH = Math.min(WIN_H, Math.max(520, primary.bounds.height - 40));
      const x = Math.round(Math.max(primary.bounds.x, Math.min(targetCenter - winW / 2, primary.bounds.x + primary.bounds.width - winW)));
      const y = primary.bounds.y;
      const cur = this.window.getBounds();
      if (Math.abs(x - this.lastAnchorX) >= 1 || Math.abs(cur.x - x) >= 1 || cur.y !== y || cur.width !== winW || cur.height !== winH) {
        this.lastAnchorX = x;
        this.window.setBounds({ x, y, width: winW, height: winH });
      }
    }
    this.notes.place();
  }

  private resolveBaseMode(): IslandMode {
    if (this.pomodoro?.active) return this.pomodoro.kind === 'slacking' ? 'slacking' : 'focus';
    if (this.nookTasks.some(t => !t.completed && t.inFocus) || Boolean(this.nookReviewBadge?.hot)) return 'focus';
    return 'idle';
  }

  private snapshot(): IslandState {
    const active = this.isCapsuleActive();
    const geo = this.ax.notchGeometry?.(active);
    this.placeWindows(geo);
    return {
      mode: this.islandEnabled ? this.mode : 'idle',
      fullscreenClock: this.isFullscreenClock(),
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
      pomodoroPrefs: { ...this.pomodoroPrefs },
      pomodoro: this.pomodoro,
      toast: this.toastItem,
      alerts: this.alerts,
      nookReviewBadge: this.nookReviewBadge,
      nookTaskLists: this.nookTaskLists,
      nookTasks: this.nookTasks,
      nookCompletedCount: this.nookCompletedCount,
      nookTotalCount: this.nookTotalCount,
      fonts: this.fonts
    };
  }

  private syncMousePassthrough() {
    if (!this.window.isDestroyed() && this.mode !== 'board') {
      this.window.setIgnoreMouseEvents(true, { forward: true });
    }
  }

  private publish() {
    const modeChanged = this.mode !== this.lastPublishedMode;
    this.lastPublishedMode = this.mode;
    if ((this.mode === 'idle' || this.mode === 'focus' || this.mode === 'toast') && (modeChanged || !this.isCapsuleActive())) {
      this.syncMousePassthrough();
    }
    if (!this.window.isDestroyed()) {
      this.window.webContents.send('island:changed', this.snapshot());
    }
  }

  updateSettings(settings: Settings) {
    this.fonts = { fonts: settings.fonts, importedFonts: settings.importedFonts };
    this.copyTranslateEnabled = settings.translation.copyTranslateEnabled;
    if (!this.copyTranslateEnabled) this.pendingDoubleCopyAt = 0;

    this.nookPrefs = { ...settings.nookPrefs };
    this.pomodoroPrefs = { ...settings.pomodoro };
    const nextEnabled = settings.notchIslandEnabled !== false;
    const nextFullscreenMode: NotchFullscreenMode = settings.notchFullscreenMode ?? 'hide';
    const fullscreenModeChanged = this.fullscreenMode !== nextFullscreenMode;
    this.fullscreenMode = nextFullscreenMode;
    if (fullscreenModeChanged) {
      this.applyFullscreenWindowPolicy();
    }
    if (this.islandEnabled !== nextEnabled) {
      this.islandEnabled = nextEnabled;
      if (!nextEnabled) {
        this.ax.notchGeometry?.(false);
        this.mode = 'idle';
        this.syncMousePassthrough();
        if (!this.window.isDestroyed() && this.window.isVisible()) this.window.hide();
      } else if (this.shouldShowWindow() && !this.window.isDestroyed() && !this.window.isVisible()) {
        this.window.showInactive();
        this.applyFullscreenWindowPolicy();
      }
    }
    if (fullscreenModeChanged) {
      this.syncFullscreenState();
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

  async translateSelection(selection: SelectionContext) {
    const source = this.ax.frontmostApp?.();
    let text = selection.text;
    const matchesSource =
      !selection.sourceApp ||
      source?.bundleId === selection.sourceApp ||
      source?.name === selection.sourceApp;
    if (source && source.pid !== process.pid && matchesSource) {
      try { text = await this.clipboardHistory.selectionMarkdown(source.pid) ?? text; }
      catch { console.warn('未能读取划词原文的格式，使用所选文字'); }
    }
    this.translator.open(text, source?.pid);
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
    this.translator.open(copy.markdown || copy.entry.text, copy.pid);
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
    if (this.fullscreenHidden) return;
    if (!this.islandEnabled && !process.env.LASSO_DATA_ROOT) {
      this.window.showInactive();
    }
    this.refreshNookData();
    this.mode = 'board';
    if (!this.window.isDestroyed()) this.window.setIgnoreMouseEvents(false, { forward: true });
    this.publish();
  }

  closeBoard() {
    if (this.mode !== 'toast') {
      this.mode = this.resolveBaseMode();
    }
    this.syncMousePassthrough();
    if (!this.window.isDestroyed()) this.window.blur();
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
      this.syncMousePassthrough();
      this.publish();
    }, 2400);
  }

  startPomodoro(task?: { id: string | null; title: string }, minutes?: number, kind: 'focus' | 'slacking' = 'focus') {
    if (this.tickTimer) clearInterval(this.tickTimer);
    const preferred = kind === 'slacking' ? this.pomodoroPrefs.breakMinutes : this.pomodoroPrefs.focusMinutes;
    const totalSeconds = Math.max(60, Math.min(180 * 60, Math.round((minutes ?? preferred) * 60)));
    const firstOpen = this.nookTasks.find(t => !t.completed && t.inFocus) ?? this.nookTasks.find(t => !t.completed);
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
    this.syncMousePassthrough();
    this.publish();

    this.tickTimer = setInterval(() => {
      if (!this.pomodoro || !this.pomodoro.active || this.pomodoro.paused) return;
      const next = this.pomodoro.remainingSeconds - 1;
      if (next <= 0) {
        if (this.pomodoro.kind === 'focus') {
          this.playPomodoroChime('focus');
          this.startPomodoro({ id: this.pomodoro.taskId, title: '休息提醒 · 起身活动喝水' }, undefined, 'slacking');
        } else {
          this.playPomodoroChime('slacking');
          this.stopPomodoro();
          this.toast('休息结束，随时开始下一轮番茄钟', `${String(this.pomodoroPrefs.focusMinutes).padStart(2, '0')}:00`);
        }
        return;
      }
      this.pomodoro = { ...this.pomodoro, remainingSeconds: next };
      this.publish();
    }, 1000);
  }

  private playPomodoroChime(kind: 'focus' | 'slacking') {
    if (!this.pomodoroPrefs.soundEnabled || process.env.LASSO_DATA_ROOT) return;
    const sound = kind === 'focus' ? 'Glass' : 'Ping';
    execFile('afplay', [`/System/Library/Sounds/${sound}.aiff`], () => {});
  }

  stopPomodoro() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.pomodoro = null;
    this.mode = this.resolveBaseMode();
    this.syncMousePassthrough();
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
      if (existing.inFocus) {
        this.nookCompletedCount = Math.max(0, this.nookCompletedCount + (nextCompleted ? 1 : -1));
      }
      if (existing.listId) {
        this.nookTaskLists = this.nookTaskLists.map(list =>
          list.id === existing.listId
            ? { ...list, openCount: Math.max(0, list.openCount + (nextCompleted ? -1 : 1)) }
            : list
        );
      }
    }
    if (nextCompleted) {
      this.alerts = this.alerts.filter(a => a.id !== taskId && a.target !== taskId);
      if (this.pomodoro?.taskId === taskId) {
        this.stopPomodoro();
      }
      if (this.mode === 'nook-alert' && this.alerts.length === 0) {
        this.mode = this.resolveBaseMode();
        this.syncMousePassthrough();
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
      this.syncMousePassthrough();
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
      this.syncMousePassthrough();
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
      this.syncMousePassthrough();
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
        this.syncMousePassthrough();
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
          this.startPomodoro({ id: null, title: data.title || '休息提醒 · 站起来喝口水' }, undefined, 'slacking');
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
    screen.off('display-added', this.onDisplayMetricsChanged);
    screen.off('display-removed', this.onDisplayMetricsChanged);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.copyTimer) clearTimeout(this.copyTimer);
    if (this.nookWatchDebounce) clearTimeout(this.nookWatchDebounce);
    for (const watcher of this.nookWatchers.values()) watcher.close();
    this.nookWatchers.clear();
    this.ax.notchGeometry?.(false);
    this.ax.stopFullscreenWatch?.();
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
