import { RecordingManager } from './capture/recording';
import { saveRecordingOutput, setCopyPngListener } from './capture/output';
import type { RegionPreset } from '../shared/capture-regions';
import { validateScreenshotSettings, type ScreenshotSettings } from '../shared/screenshot-settings';
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  globalShortcut,
  ipcMain,
  screen,
  session,
  dialog,
  shell,
  systemPreferences,
  safeStorage,
  nativeTheme
} from 'electron';
import type { IpcMainInvokeEvent, NativeImage, Rectangle, WebContents } from 'electron';
import { basename, extname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { CaptureManager } from './capture';
import { IntelligenceService } from './capture/intelligence';
import { normalizeVisionConfig, type VisionServiceInput } from '../shared/intelligence';
import { prewarmNativeCapture } from './capture/native';
import { readLocalImage } from './capture/local-images';
import { Images } from './images';
import { applicationIcon } from './app-icons';
import { MediaWindow } from './media-window';
import { SettingsWindow } from './settings-window';
import {
  readSettings,
  writeSettings,
  validateGeneralSettings,
  migrateApiConnectionSettings,
  normalizeActionBarConfig,
  normalizeSuiteSettings
} from './settings';
import { normalizeTranslationSettings, type ApiConnectionInput, type TranslationSettings } from '../shared/media';
import { WebDavSyncService } from './sync-webdav';
import type { WebDavConfigInput, WebDavSyncDirection } from '../shared/history-sync';
import { fontExtensions, importFont, registerFontScheme, removeFont, serveFonts, validateFonts } from './fonts';
import { fitToWorkArea, placeNear } from './position';
import { SelectionCapture } from './selection';
import { WindowMotion } from './motion';
import { initializeWindowPresence, setWindowPresence } from './window-presence';
import { validMemorySettings, type MemorySettings } from '../shared/memory';
import { ActionBar } from './action-bar';
import { NotchIsland } from './island';
import { nativeAx } from './native-ax';
import { TaskManager } from './tasks';
import { readPresets, writePresets, composePrompt, migrateImagePresets } from './presets';
import { HEADER_HEIGHT, FOOTER_ROW } from '../shared/contracts';
import { validateEditorShortcuts, type GlobalActionId, type EditorShortcutMap, type IgnoredAppRule } from '../shared/shortcuts';
import { captureModeLabels, captureModes, type CaptureMode, type CaptureRect, type EditorPresetSummary } from '../shared/capture';
import type { CaptureDelay, EfficiencyCaptureMode } from '../shared/capture-efficiency';
import type {
  Action,
  ActionBarConfig,
  AppPrompt,
  GeneralSettings,
  LaunchOptions,
  PaletteEvent,
  PaletteScope,
  Preset,
  SelectionContext,
  Settings,
  SettingsSection,
  ShellState,
  SnapSlot,
  SuiteSettings,
  Target,
  WebTarget
} from '../shared/contracts';
import { RecordingPanel } from './recording-panel';
import { ActionShortcuts } from './action-shortcuts';
import { installCaptureLibraryIPC } from './capture-library';
import { fromMainFrame, result, sealLocal } from './ipc';

app.setName('Lasso');
const isolatedRoot = process.env.LASSO_DATA_ROOT;
if (isolatedRoot && !isAbsolute(isolatedRoot)) throw Error('LASSO_DATA_ROOT 必须是绝对路径');
app.setPath('userData', join(isolatedRoot || app.getPath('appData'), process.env.LASSO_PROFILE || 'mac-ai-prompt'));
if (isolatedRoot) {
  for (const name of ['sessionData', 'temp', 'crashDumps'] as const) {
    const directory = join(isolatedRoot, name);
    mkdirSync(directory, { recursive: true });
    app.setPath(name, directory);
  }
  app.setAppLogsPath(join(isolatedRoot, 'logs'));
}
registerFontScheme();
const hasLock = app.requestSingleInstanceLock();
const launchInBackground = process.argv.includes('--background');

let win: BrowserWindow;
let settingsWindow: SettingsWindow;
let motion: WindowMotion;
let tasks: TaskManager;
let tray: Tray;
let settingsPath: string;
let presetsPath: string;
let fontsDir: string;
let images: Images;
let screenshots: CaptureManager;
let recording: RecordingManager | undefined;
let recordingPanel: RecordingPanel;
let actionShortcuts: ActionShortcuts;
let webdav: WebDavSyncService;
let media: MediaWindow;
let intelligence: IntelligenceService;
let fileServices: { start(callback: (path: string) => void): void; stop(): void } | undefined;
const pendingMediaFiles: string[] = [];
let openingMediaFile = false;

async function receiveMediaFile(path: string) {
  if (!media || !tasks) {
    pendingMediaFiles.push(path);
    return;
  }
  if (openingMediaFile) {
    state.notice = '正在打开图片，请稍后再选择';
    layout();
    publish();
    return;
  }
  openingMediaFile = true;
  try {
    const { image } = await readLocalImage(path);
    await receiveCaptureImage(image);
  } catch (error) {
    state.notice = (error as Error).message;
    layout();
    showWindow();
    publish();
  } finally {
    openingMediaFile = false;
  }
}
app.on('open-file', (event, path) => {
  event.preventDefault();
  void receiveMediaFile(path);
});

let capture: SelectionCapture;
let actionBar: ActionBar;
let island: NotchIsland;
let lastSelection: SelectionContext | null = null;
let smallBounds: Rectangle | null = null;
let blurTimer: ReturnType<typeof setTimeout>;
let quitting = false;
let recordingShutdown: Promise<void> | undefined;
let shutdownComplete = false;
let nativeDialogs = 0;
let stopCaptureEfficiency: (() => void) | undefined;
let palette: PaletteEvent | null = null;
let state: Omit<ShellState, 'tasks' | 'activeTaskId' | 'hasPage' | 'hostname' | 'loading' | 'pageError' | 'delivery' | 'activeTarget' | 'connections'>;

function snapshot(): ShellState {
  return {
    ...state,
    connections: media ? media.service.connections() : [],
    ...(tasks ? tasks.snapshot() : { tasks: [], activeTaskId: null, hasPage: false, hostname: '', loading: false, pageError: null, delivery: null, activeTarget: null })
  };
}

function publish() {
  if (win && !win.isDestroyed()) win.webContents.send('shell:changed', snapshot());
  settingsWindow?.publish();
  media?.refreshPresets();
  actionBar?.update(state.presets, false, state.settings);
  island?.updateSettings(state.settings);
}

function layout() {
  if (!win || win.isDestroyed() || !tasks) return;
  const [width, height] = win.getContentSize();
  const rows = (state.notice || state.captureEfficiency.phase !== 'idle' ? 1 : 0) + (tasks.snapshot().delivery ? 1 : 0);
  tasks.layout({ x: 0, y: HEADER_HEIGHT, width, height: Math.max(0, height - HEADER_HEIGHT - rows * FOOTER_ROW) }, !palette);
}

async function openPalette(scope: PaletteScope) {
  showWindow();
  if (!win || win.isDestroyed()) return;
  const backdrop = palette ? palette.backdrop : await tasks.capture();
  palette = { scope, backdrop };
  layout();
  win.webContents.focus();
  win.webContents.send('shell:palette', palette);
}

function closePalette(restore = true) {
  if (!palette) return;
  palette = null;
  if (win && !win.isDestroyed()) win.webContents.send('shell:palette', { scope: null, backdrop: null } satisfies PaletteEvent);
  clearSelection();
  if (restore) {
    layout();
    tasks.focus();
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  setWindowPresence(win, true);
  const bounds = win.getBounds();
  const currentDisplay = screen.getDisplayMatching(bounds);
  const targetDisplay = win.isVisible() ? currentDisplay : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = targetDisplay.workArea;
  const nextBounds =
    targetDisplay.id === currentDisplay.id
      ? bounds
      : {
          ...bounds,
          x: Math.round(area.x + (bounds.x - currentDisplay.workArea.x)),
          y: Math.round(area.y + (bounds.y - currentDisplay.workArea.y))
        };
  win.setBounds(state.expanded ? area : fitToWorkArea(nextBounds, area));
  actionBar?.hide();
  motion.show();
  app.focus({ steal: true });
  win.focus();
  if (!palette) {
    tasks.focus();
    setImmediate(() => {
      if (!quitting) tasks.warmPreferred();
    });
  }
}

function openSettings(section?: SettingsSection) {
  capture?.configure(state.settings);
  void settingsWindow?.open(section);
}

function setPin() {
  if (!win || win.isDestroyed()) return;
  state.pinned = !state.pinned;
  win.setAlwaysOnTop(state.pinned, 'floating');
  updateTray();
  publish();
}

function expand() {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  if (!state.expanded) {
    smallBounds = bounds;
    state.expanded = true;
    win.setBounds(area, !systemPreferences.getAnimationSettings().prefersReducedMotion);
  } else {
    state.expanded = false;
    win.setBounds(fitToWorkArea(smallBounds!, area), !systemPreferences.getAnimationSettings().prefersReducedMotion);
  }
  layout();
  publish();
}

function deferHide() {
  clearTimeout(blurTimer);
  blurTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || state.pinned || nativeDialogs > 0) return;
    const focused = BrowserWindow.getFocusedWindow();
    if (focused === win || (focused && focused.getParentWindow() === win)) return;
    if (win.isVisible()) motion.hide();
  }, 150);
}

async function confirmDialog(message: string, detail: string) {
  nativeDialogs++;
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      message,
      detail,
      buttons: ['取消', '继续'],
      defaultId: 0,
      cancelId: 0
    });
    return response === 1;
  } finally {
    nativeDialogs--;
  }
}

function requestQuit() {
  quitting = true;
  app.quit();
}

function isHTTPS(url: string) {
  return new URL(url).protocol === 'https:';
}

function isLogin(url: string) {
  const host = new URL(url).hostname;
  return ['gemini.google.com', 'chatgpt.com', 'openai.com', 'auth0.com', 'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com'].some(
    domain => host === domain || host.endsWith('.' + domain)
  );
}

function secureRemote(contents: WebContents) {
  contents.on('will-navigate', (event, url) => {
    if (!isHTTPS(url)) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (!isHTTPS(url)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || (isHTTPS(url) && isLogin(url))) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: win,
          width: 560,
          height: 720,
          autoHideMenuBar: true,
          webPreferences: { session: contents.session, nodeIntegration: false, contextIsolation: true, sandbox: true }
        }
      };
    }
    if (isHTTPS(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('did-create-window', popup => {
    secureRemote(popup.webContents);
    popup.on('closed', () => {
      if (!quitting) showWindow();
    });
  });
}

function selectTask(id: string) {
  closePalette(false);
  tasks.select(id);
  layout();
  showWindow();
  publish();
}

function updateTray() {
  if (!tray) return;
  const capturePending = Boolean(screenshots && screenshots.efficiency.state.phase !== 'idle');
  const shortcuts = state.settings.actionShortcuts;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开 AI 对话窗', accelerator: shortcuts['open-launcher'] || undefined, click: showWindow },
      { label: '输入翻译', accelerator: shortcuts['open-translator'] || undefined, click: () => island?.translator.open() },
      { label: '剪贴板历史', accelerator: shortcuts['open-clipboard-history'] || undefined, click: () => island?.clipboardHistory.open() },
      { label: '浮动便签', accelerator: shortcuts['toggle-notes'] || undefined, click: () => island?.notes.toggleDrawer(true) },
      { type: 'separator' },
      { label: captureModeLabels.area, enabled: !capturePending, accelerator: shortcuts.area || undefined, click: () => void startScreenshot('area') },
      { label: captureModeLabels.rect, enabled: !capturePending, accelerator: shortcuts.rect || undefined, click: () => void startScreenshot('rect') },
      {
        label: '更多截图与录屏',
        submenu: [
          ...captureModes
            .filter(mode => mode !== 'area' && mode !== 'rect')
            .map(mode => ({
              label: captureModeLabels[mode],
              enabled: !capturePending,
              accelerator: shortcuts[mode] || undefined,
              click: () => void startScreenshot(mode)
            })),
          {
            label: '滚动长截图',
            accelerator: shortcuts['scroll-capture'] || undefined,
            enabled: !capturePending,
            click: () => void startScreenshot('area', 0, true)
          },
          {
            label: '重截上次',
            accelerator: shortcuts['repeat-last'] || undefined,
            enabled: !capturePending,
            click: () => void startScreenshot('repeat')
          },
          {
            label: '延时截图',
            submenu: [
              ...([3, 5, 10] as const).map(delay => ({
                label: `${delay} 秒延时截图`,
                accelerator: shortcuts[`delay-${delay}s`] || undefined,
                enabled: !screenshots?.active,
                click: () => void startScreenshot('area', delay)
              })),
              ...(capturePending ? [{ label: '取消延时截图', click: () => screenshots.efficiency.cancel() }] : [])
            ]
          },
          ...(screenshots?.sleeping ? [{ label: '恢复休眠中的图片编辑', click: () => screenshots.focus() }] : []),
          { type: 'separator' as const },
          { label: '屏幕录制', submenu: recordingPanel?.trayItems() || [] }
        ]
      },
      { label: 'AI 生图…', click: () => { void media?.show(); } },
      {
        label: `贴图管理（${screenshots?.pins.size || 0}）`,
        submenu: [
          {
            label: '贴出剪贴板内容',
            accelerator: shortcuts['pin-clipboard'] || undefined,
            click: () => {
              void runGlobalAction('pin-clipboard').catch(error => {
                state.notice = (error as Error).message;
                publish();
              });
            }
          },
          { type: 'separator' },
          ...(screenshots?.pins.trayItems() || [])
        ]
      },
      {
        label: '桌面工具与分屏',
        submenu: [
          { label: '今日聚焦看板', click: () => island?.openBoard() },
          { label: '访达动作面板', accelerator: shortcuts['open-finder-panel'] || undefined, click: () => void island?.finder.summon() },
          {
            label: '复制即译',
            type: 'checkbox',
            checked: state.settings.translation.copyTranslateEnabled,
            click: () => {
              try {
                saveTranslation({ ...state.settings.translation, copyTranslateEnabled: !state.settings.translation.copyTranslateEnabled });
              } catch (error) {
                state.notice = (error as Error).message;
                publish();
              }
            }
          },
          {
            label: '暂停划词',
            type: 'checkbox',
            checked: !state.settings.selectionEnabled,
            click: () => {
              const saved = saveCaptureSettings({ selectionEnabled: !state.settings.selectionEnabled, clipboardFallback: state.settings.clipboardFallback });
              if (saved.error) dialog.showErrorBox('未能保存划词设置', saved.error);
            }
          },
          { type: 'separator' },
          { label: '左半屏', accelerator: shortcuts['snap-left-half'] || undefined, click: () => island?.snapWindow('left-half') },
          { label: '右半屏', accelerator: shortcuts['snap-right-half'] || undefined, click: () => island?.snapWindow('right-half') },
          { label: '最大化', accelerator: shortcuts['snap-maximize'] || undefined, click: () => island?.snapWindow('maximize') },
          { label: '窗口居中', accelerator: shortcuts['snap-center'] || undefined, click: () => island?.snapWindow('center') },
          { type: 'separator' },
          { label: '左 1/3', accelerator: shortcuts['snap-left-third'] || undefined, click: () => island?.snapWindow('left-third') },
          { label: '中 1/3', accelerator: shortcuts['snap-center-third'] || undefined, click: () => island?.snapWindow('center-third') },
          { label: '右 1/3', accelerator: shortcuts['snap-right-third'] || undefined, click: () => island?.snapWindow('right-third') },
          { label: '左 2/3', accelerator: shortcuts['snap-left-two-thirds'] || undefined, click: () => island?.snapWindow('left-two-thirds') },
          { label: '右 2/3', accelerator: shortcuts['snap-right-two-thirds'] || undefined, click: () => island?.snapWindow('right-two-thirds') },
          { type: 'separator' },
          { label: '2:1 双栏布局', accelerator: shortcuts['snap-coding-ai'] || undefined, click: () => island?.snapWindow('coding-ai') },
          { label: '1:1 双栏布局', accelerator: shortcuts['snap-equal-split'] || undefined, click: () => island?.snapWindow('equal-split') },
          { label: '移至上一显示器', accelerator: shortcuts['snap-prev-display'] || undefined, click: () => island?.snapWindow('prev-display') },
          { label: '移至下一显示器', accelerator: shortcuts['snap-next-display'] || undefined, click: () => island?.snapWindow('next-display') }
        ]
      },
      { type: 'separator' },
      { label: '设置…', accelerator: 'Command+,', click: () => openSettings() },
      { label: '退出 Lasso', accelerator: 'Command+Q', click: requestQuit }
    ])
  );
}

const SNAP_ACTION_MAP: Partial<Record<GlobalActionId, SnapSlot>> = {
  'snap-left-half': 'left-half',
  'snap-right-half': 'right-half',
  'snap-maximize': 'maximize',
  'snap-center': 'center',
  'snap-left-third': 'left-third',
  'snap-center-third': 'center-third',
  'snap-right-third': 'right-third',
  'snap-left-two-thirds': 'left-two-thirds',
  'snap-right-two-thirds': 'right-two-thirds',
  'snap-coding-ai': 'coding-ai',
  'snap-equal-split': 'equal-split',
  'snap-prev-display': 'prev-display',
  'snap-next-display': 'next-display'
};

async function runGlobalAction(action: GlobalActionId) {
  if (captureModes.includes(action as CaptureMode)) return startScreenshot(action as CaptureMode);
  const snapSlot = SNAP_ACTION_MAP[action];
  if (snapSlot) {
    island?.snapWindow(snapSlot);
    return;
  }
  if (action === 'open-launcher') {
    clearSelection();
    capture?.current();
    showWindow();
    if (lastSelection) await openPalette('all');
  } else if (action === 'repeat-last') {
    await startScreenshot('repeat');
  } else if (action === 'scroll-capture') {
    await startScreenshot('area', 0, true);
  } else if (action.startsWith('delay-')) {
    await startScreenshot('area', Number(action.slice(6, -1)) as CaptureDelay);
  } else if (action === 'pin-clipboard') {
    capture.suppress();
    await screenshots.pins.pinClipboard();
  } else if (action === 'open-translator') {
    if (!lastSelection?.text?.trim()) capture?.current();
    const selText = lastSelection?.text?.trim();
    const frontPid = nativeAx().frontmostApp?.().pid ?? 0;
    if (selText) actionBar?.hide();
    island.translator.open(selText || undefined, frontPid);
  } else if (action === 'open-clipboard-history') {
    island.clipboardHistory.open();
  } else if (action === 'toggle-notes') {
    island.notes.toggleDrawer();
  } else if (action === 'open-finder-panel') {
    await island.finder.summon();
  }
}

function persistSettings(next: Settings) {
  const changed = JSON.stringify(next) !== JSON.stringify(state.settings);
  validateGeneralSettings(next);
  if (next.launchAtLogin !== state.settings.launchAtLogin && app.isPackaged && !process.env.LASSO_PROFILE) {
    app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
  }
  nativeTheme.themeSource = next.themeMode === 'system' ? 'system' : 'light';
  writeSettings(settingsPath, next);
  state.settings = next;
  if (changed) webdav?.scheduleAutoSync();
}

function persistPresets(next: Preset[]) {
  const changed = JSON.stringify(next) !== JSON.stringify(state.presets);
  writePresets(presetsPath, next, media.service.connections());
  state.presets = next;
  if (changed) webdav?.scheduleAutoSync();
  tasks.warmPreferred();
  publish();
}

function saveTranslation(input: TranslationSettings) {
  const translation = normalizeTranslationSettings(input);
  if (translation.connectionId && !media.service.connections().some(connection => connection.id === translation.connectionId)) {
    throw Error('翻译服务绑定的 API 连接不存在，请重新选择连接');
  }
  persistSettings({ ...state.settings, translation });
  updateTray();
  publish();
}

function applyImportedSettings(next: Settings) {
  validateScreenshotSettings(next.screenshot, screenshots.supportedLanguages());
  const previous = state.settings;
  const conflicts = actionShortcuts.configure(next);
  if (conflicts.length) {
    actionShortcuts.configure(previous);
    throw Error(conflicts.join('；'));
  }
  try {
    intelligence.configure(next.vision);
    persistSettings(next);
  } catch (error) {
    intelligence.configure(previous.vision);
    actionShortcuts.configure(previous);
    throw error;
  }
  actionBar.hide();
  clearSelection();
  capture.configure(next);
  screenshots.memoryChanged();
  tasks.memoryChanged();
  void screenshots.preferencesChanged().catch(error => {
    state.notice = (error as Error).message;
    publish();
  });
  tasks.warmPreferred();
  updateTray();
  layout();
  publish();
}

async function startScreenshot(mode: EfficiencyCaptureMode, delay: CaptureDelay = 0, scroll = false) {
  if (screenshots.efficiency.state.phase !== 'idle') return;
  if (screenshots.active) {
    screenshots.focus();
    return;
  }
  closePalette(false);
  state.notice = null;
  layout();
  publish();
  try {
    if (nativeDialogs) throw Error('请先关闭文件选择窗口');
    const outcome = await (scroll ? screenshots.startScrollCapture() : screenshots.efficiency.start(mode, delay));
    if ('error' in outcome) throw Error(outcome.error);
  } catch (error) {
    console.warn('[screenshot]', (error as Error).message);
    state.notice = '截图未能启动：' + (error as Error).message;
    layout();
    showWindow();
    publish();
  }
}

function assertLocal(event: IpcMainInvokeEvent) {
  if (!fromMainFrame(event, win) && !settingsWindow?.owns(event)) {
    throw new Error('只有本地窗口可以调用应用操作');
  }
}

function clearSelection() {
  if (!lastSelection) return;
  lastSelection = null;
  state.selection = null;
  publish();
}

function saveCaptureSettings(options: Pick<Settings, 'selectionEnabled' | 'clipboardFallback'>) {
  if (!options || typeof options.selectionEnabled !== 'boolean' || typeof options.clipboardFallback !== 'boolean') {
    return { error: '划词开关值无效' };
  }
  const next = { ...state.settings, ...options };
  try {
    persistSettings(next);
  } catch (error) {
    return { error: (error as Error).message };
  }
  capture.configure(next);
  updateTray();
  publish();
  return { error: null };
}

async function triggerFastText(text: string, anchorRect?: CaptureRect) {
  if (anchorRect && (![anchorRect.x, anchorRect.y, anchorRect.width, anchorRect.height].every(Number.isFinite) || anchorRect.width <= 0 || anchorRect.height <= 0)) {
    throw Error('无效的文字位置');
  }
  capture.suppress();
  actionBar.hide();
  island.translator.open(text, 0);
}

function appendNoteText(text: string, sourceApp?: string) {
  island?.notes.appendScratchpad(text, sourceApp);
}

function rememberTarget(target: Target) {
  if (state.settings.lastTarget === target) return;
  const settings = { ...state.settings, lastTarget: target };
  persistSettings(settings);
  updateTray();
}

async function runPreset(id: string, selection: SelectionContext | null, options: LaunchOptions = {}) {
  const preset = state.presets.find(p => p.id === id && p.enabled);
  if (!preset) return { error: '这个预设已停用或删除' };
  return executePreset(preset, selection, options);
}

async function executePreset(preset: Preset, selection: SelectionContext | null, options: LaunchOptions = {}) {
  if (preset.needsSelection && !selection?.text && !options.imageId) {
    return { error: '请先选中文字' };
  }

  const text = composePrompt(preset, selection, state.settings.appPrompts);
  const target = options.target || preset.target;

  if (preset.kind === 'image') {
    try {
      const refImg = options.imageId ? images.get(options.imageId) : undefined;
      const nativeRef = refImg ? nativeImage.createFromPath(refImg.path) : undefined;
      await media.prepare(preset, text, nativeRef);
      if (refImg) images.remove(refImg);
      clearSelection();
      actionBar.hide();
      closePalette(false);
      layout();
      publish();
      return { error: null };
    } catch (error) {
      state.notice = (error as Error).message;
      layout();
      showWindow();
      publish();
      return { error: state.notice };
    }
  }

  if (target === 'api' && selection?.text && !options.imageId && (selection.anchor.x || selection.anchor.y)) {
    closePalette(false);
    motion.hide();
    publish();
    await actionBar.startFastCard(preset, selection);
    return { error: null };
  }

  actionBar.hide();
  capture.suppress();
  clearSelection();
  closePalette(false);
  if (selection && !state.pinned && !state.expanded && (selection.anchor.x || selection.anchor.y)) {
    win.setBounds(placeNear(selection.anchor, screen.getDisplayNearestPoint(selection.anchor).workArea));
  }
  rememberTarget(target);
  const res = tasks.runPreset(preset, text, { ...options, target });
  layout();
  showWindow();
  publish();
  return res;
}

function editorPresetList(): EditorPresetSummary[] {
  return state.presets
    .filter(p => p.enabled && (!p.needsSelection || p.kind === 'chat'))
    .map(p => ({
      id: p.id,
      name: p.name,
      kind: p.kind === 'image' ? 'image' : 'chat',
      target: p.target,
      mode: p.mode,
      needsSelection: p.needsSelection
    }));
}

async function receiveCaptureImage(image: NativeImage, presetId?: string) {
  actionBar.hide(true);
  capture.suppress();
  clearSelection();
  closePalette(false);

  if (presetId) {
    const preset = state.presets.find(p => p.id === presetId && p.enabled);
    if (preset) {
      if (preset.kind === 'image') {
        await media.prepare(preset, preset.template || '', image);
        return;
      }
      const input = images.add(image);
      rememberTarget(preset.target);
      tasks.runPreset(preset, composePrompt(preset, null, state.settings.appPrompts), { target: preset.target, imageId: input.id });
      layout();
      showWindow();
      publish();
      return;
    }
  }

  const input = images.add(image);
  const taskId = tasks.ensureActiveApiTask();
  try {
    tasks.apiChatImage(taskId, input);
  } catch (error) {
    images.remove(input);
    throw error;
  }
  layout();
  showWindow();
  publish();
}

async function receiveCaptureText(text: string, presetId?: string) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100_000) throw Error('没有可交接的文字');
  actionBar.hide(true);
  capture.suppress();
  clearSelection();
  closePalette(false);

  if (presetId) {
    const preset = state.presets.find(p => p.id === presetId && p.enabled && p.kind !== 'image');
    if (preset) {
      rememberTarget(preset.target);
      tasks.runPreset(preset, composePrompt(preset, { text, sourceApp: 'OCR', anchor: { x: 0, y: 0, width: 0, height: 0 } }, state.settings.appPrompts), {
        target: preset.target
      });
      layout();
      showWindow();
      publish();
      return;
    }
  }

  const taskId = tasks.ensureActiveApiTask();
  tasks.apiChatDraft(taskId, text);
  layout();
  showWindow();
  publish();
}

function handleClipboardAskAi(payload: { kind: 'text'; text: string } | { kind: 'image'; imagePath: string }) {
  closePalette(false);
  if (payload.kind === 'image') {
    const image = nativeImage.createFromPath(payload.imagePath);
    if (!image.isEmpty()) {
      void receiveCaptureImage(image);
    }
    return;
  }
  const taskId = tasks.ensureActiveApiTask();
  tasks.apiChatDraft(taskId, payload.text);
  layout();
  showWindow();
  publish();
}

const IMAGE_FILE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

async function sendFinderFilesToAi(paths: string[]) {
  if (!paths.length) return;
  closePalette(false);
  if (paths.length === 1 && IMAGE_FILE_EXT.has(extname(paths[0]).toLowerCase())) {
    const image = nativeImage.createFromPath(paths[0]);
    if (!image.isEmpty()) {
      await receiveCaptureImage(image);
      return;
    }
  }
  const blocks: string[] = [];
  for (const p of paths.slice(0, 5)) {
    try {
      const st = statSync(p);
      if (st.isFile() && st.size <= 48 * 1024 && !IMAGE_FILE_EXT.has(extname(p).toLowerCase())) {
        const content = readFileSync(p, 'utf8');
        if (!content.includes('\0')) {
          blocks.push(`文件 \`${p}\`:\n\`\`\`\n${content.trim()}\n\`\`\``);
          continue;
        }
      }
      blocks.push(`路径: \`${p}\``);
    } catch {
      blocks.push(`路径: \`${p}\``);
    }
  }
  if (paths.length > 5) blocks.push(`…另外还有 ${paths.length - 5} 个项目`);
  const taskId = tasks.ensureActiveApiTask();
  tasks.apiChatDraft(taskId, `${blocks.join('\n\n')}\n\n`);
  layout();
  showWindow();
  publish();
}

async function choosePath(kind: 'directory' | 'executable' | 'application') {
  nativeDialogs++;
  const parentWin = settingsWindow?.window?.isFocused() ? settingsWindow.window : win;
  try {
    const resultDialog = await dialog.showOpenDialog(parentWin, {
      properties: [kind === 'directory' ? 'openDirectory' : 'openFile'],
      ...(kind === 'application' ? { defaultPath: '/Applications', filters: [{ name: 'macOS 应用', extensions: ['app'] }] } : {})
    });
    const path = resultDialog.filePaths[0];
    if (resultDialog.canceled || !path) return null;
    if (kind !== 'application') return { path };
    const plist = join(path, 'Contents/Info.plist');
    const bundleId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], { encoding: 'utf8' }).trim();
    return { path, bundleId, name: basename(path, '.app') };
  } finally {
    nativeDialogs--;
  }
}

function launchTask(options: LaunchOptions) {
  closePalette(false);
  clearSelection();
  if (options.target) rememberTarget(options.target);
  tasks.newChat(true, options);
  layout();
  showWindow();
  publish();
}

async function readImage(taskId?: string) {
  let image: ReturnType<Images['add']>;
  try {
    image = await images.capture();
  } catch (error) {
    state.notice = (error as Error).message;
    layout();
    showWindow();
    publish();
    throw error;
  }
  state.notice = null;
  const targetTaskId = taskId || tasks.ensureActiveApiTask();
  try {
    tasks.apiChatImage(targetTaskId, image);
  } catch (error) {
    images.remove(image);
    throw error;
  }
  layout();
  showWindow();
  publish();
}

function removeImage(taskId?: string) {
  if (taskId) {
    tasks.apiChatImage(taskId, null);
    publish();
  }
}

function installIPC() {
  ipcMain.handle('shell:open-settings', (event, section?: SettingsSection) => {
    assertLocal(event);
    openSettings(section);
  });
  ipcMain.handle('shell:app-icon', (event, bundleId: string) => {
    assertLocal(event);
    return applicationIcon(bundleId);
  });
  ipcMain.handle('shell:media-config', event => {
    assertLocal(event);
    return media.service.connection();
  });
  ipcMain.handle('shell:vision-config', event => {
    assertLocal(event);
    return intelligence.connection();
  });
  ipcMain.handle('shell:vision-config-save', (event, input: VisionServiceInput) => {
    assertLocal(event);
    const config = intelligence.configure(input);
    persistSettings({ ...state.settings, vision: normalizeVisionConfig(config) });
    publish();
    return config;
  });
  ipcMain.handle('shell:media-config-save', (event, input) => {
    assertLocal(event);
    return media.service.configure(input);
  });
  ipcMain.handle('shell:media-models', event => {
    assertLocal(event);
    return media.service.models();
  });
  ipcMain.handle('shell:api-connections', event => {
    assertLocal(event);
    return media.service.connections();
  });
  ipcMain.handle('shell:api-connection-save', (event, input: ApiConnectionInput) => {
    assertLocal(event);
    try {
      const connection = media.service.saveConnection(input);
      publish();
      return { connections: media.service.connections(), connection, error: null };
    } catch (error) {
      return { connections: media.service.connections(), error: (error as Error).message };
    }
  });
  ipcMain.handle('shell:api-connection-delete', (event, id: string) => {
    assertLocal(event);
    try {
      const connections = media.service.deleteConnection(id);
      publish();
      return { connections, error: null };
    } catch (error) {
      return { connections: media.service.connections(), error: (error as Error).message };
    }
  });
  ipcMain.handle('shell:api-connection-models', async (event, id: string) => {
    assertLocal(event);
    try {
      if (typeof id !== 'string' || !id) throw Error('请选择 API 连接');
      return { models: await media.service.models(id), error: null };
    } catch (error) {
      return { models: [], error: (error as Error).message };
    }
  });
  ipcMain.handle('shell:translation-settings', (event, input: TranslationSettings) => {
    assertLocal(event);
    return result(() => saveTranslation(input));
  });
  ipcMain.handle('shell:window-drag-snap', (event, enabled: boolean) => {
    assertLocal(event);
    return result(() => {
      if (typeof enabled !== 'boolean') throw Error('拖拽分屏开关无效');
      persistSettings({ ...state.settings, windowDragSnap: enabled });
      publish();
    });
  });
  ipcMain.handle('shell:action-bar-config', (event, config: ActionBarConfig) => {
    assertLocal(event);
    return result(() => {
      const actionBarCfg = normalizeActionBarConfig(config);
      persistSettings({ ...state.settings, actionBar: actionBarCfg });
      publish();
    });
  });
  ipcMain.handle('shell:suite-settings', (event, patch: Partial<SuiteSettings>) => {
    assertLocal(event);
    return result(() => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('桌面套件配置无效');
      const suite = normalizeSuiteSettings({ ...state.settings, ...patch }, state.settings);
      persistSettings({ ...state.settings, ...suite });
      updateTray();
      publish();
    });
  });
  ipcMain.handle('shell:app-prompts', (event, rules: AppPrompt[]) => {
    assertLocal(event);
    return result(() => {
      if (!Array.isArray(rules)) throw new Error('应用规则格式无效');
      const ids = new Set<string>();
      for (const rule of rules) {
        if (!rule.bundleId.trim() || ids.has(rule.bundleId) || !rule.name.trim() || typeof rule.prompt !== 'string' || typeof rule.enabled !== 'boolean') {
          throw new Error('应用规则需要唯一的 bundle ID 和名称。');
        }
        ids.add(rule.bundleId);
      }
      persistSettings({ ...state.settings, appPrompts: rules.map(r => ({ ...r, name: r.name.trim(), bundleId: r.bundleId.trim() })) });
      publish();
    });
  });
  ipcMain.handle('shell:default-api-chat', (event, config: { connectionId: string; model: string }) => {
    assertLocal(event);
    return result(() => {
      if (!config || typeof config.connectionId !== 'string' || typeof config.model !== 'string') throw Error('默认对话模型配置无效');
      if (config.connectionId && !media.service.connections().some(c => c.id === config.connectionId)) {
        throw Error('所选 API 连接不存在');
      }
      persistSettings({
        ...state.settings,
        defaultApiChat: { connectionId: config.connectionId.trim(), model: config.model.trim() }
      });
      publish();
    });
  });
  ipcMain.handle('shell:external', (event, url: string) => {
    assertLocal(event);
    if (URL.canParse(url) && ['https:', 'http:'].includes(new URL(url).protocol)) return shell.openExternal(url);
  });
  ipcMain.handle('shell:config-export', async event => {
    assertLocal(event);
    nativeDialogs++;
    try {
      return await webdav.exportConfig();
    } finally {
      nativeDialogs--;
    }
  });
  ipcMain.handle('shell:config-import', async event => {
    assertLocal(event);
    nativeDialogs++;
    try {
      return await webdav.importConfig();
    } finally {
      nativeDialogs--;
    }
  });
  ipcMain.handle('shell:webdav-config', event => {
    assertLocal(event);
    return webdav.config();
  });
  ipcMain.handle('shell:webdav-config-save', (event, input: WebDavConfigInput) => {
    assertLocal(event);
    return webdav.saveConfig(input);
  });
  ipcMain.handle('shell:webdav-sync', (event, direction: WebDavSyncDirection) => {
    assertLocal(event);
    return webdav.sync(direction);
  });
  ipcMain.handle('shell:general-settings', (event, options: GeneralSettings) => {
    assertLocal(event);
    return result(() => {
      validateGeneralSettings(options);
      const { launchAtLogin, themeMode, toolbarTools, mouseActions, autoCheckUpdates } = options;
      persistSettings({ ...state.settings, launchAtLogin, themeMode, toolbarTools, mouseActions, autoCheckUpdates });
      publish();
    });
  });
  const saveSettings = (next: Settings) => {
    persistSettings(next);
    publish();
  };
  ipcMain.handle('shell:fonts', (event, fonts: Settings['fonts']) => {
    assertLocal(event);
    return result(() => {
      validateFonts(fonts);
      saveSettings({
        ...state.settings,
        fonts: { display: fonts.display.trim(), text: fonts.text.trim(), ui: fonts.ui.trim(), mono: fonts.mono.trim() }
      });
    });
  });
  ipcMain.handle('shell:font-import', async event => {
    assertLocal(event);
    nativeDialogs++;
    const parentWin = settingsWindow?.window?.isFocused() ? settingsWindow.window : win;
    try {
      const choice = await dialog.showOpenDialog(parentWin, { properties: ['openFile'], filters: [{ name: '字体', extensions: fontExtensions }] });
      if (choice.canceled || !choice.filePaths[0]) return { font: null, error: null };
      const font = importFont(fontsDir, choice.filePaths[0]);
      saveSettings({ ...state.settings, importedFonts: [...state.settings.importedFonts, font] });
      return { font, error: null };
    } catch (error) {
      return { font: null, error: (error as Error).message };
    } finally {
      nativeDialogs--;
    }
  });
  ipcMain.handle('shell:font-remove', (event, file: string) => {
    assertLocal(event);
    return result(() => {
      removeFont(fontsDir, file);
      saveSettings({ ...state.settings, importedFonts: state.settings.importedFonts.filter(font => font.file !== file) });
    });
  });
  ipcMain.handle('shell:choose-path', (event, kind) => {
    assertLocal(event);
    return choosePath(kind);
  });
  ipcMain.handle('shell:new-task', (event, options: LaunchOptions) => {
    assertLocal(event);
    launchTask(options);
  });
  ipcMain.handle('shell:image', (event, id?: string) => {
    assertLocal(event);
    return result(() => readImage(id));
  });
  ipcMain.handle('shell:chat-pick-image', async (event, taskId: string) => {
    assertLocal(event);
    nativeDialogs++;
    try {
      const choice = await dialog.showOpenDialog(win, {
        title: '选择对话图片',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
      });
      if (choice.canceled || !choice.filePaths[0]) return { error: null };
      const image = nativeImage.createFromPath(choice.filePaths[0]);
      if (image.isEmpty()) return { error: '所选文件不是有效图片' };
      const input = images.add(image);
      try {
        tasks.apiChatImage(taskId, input);
      } catch (error) {
        images.remove(input);
        throw error;
      }
      publish();
      return { error: null };
    } catch (error) {
      return { error: (error as Error).message };
    } finally {
      nativeDialogs--;
    }
  });
  ipcMain.handle('shell:local-image-open', async event => {
    assertLocal(event);
    if (nativeDialogs) return { error: null };
    nativeDialogs++;
    try {
      if (screenshots.active) throw Error('请先完成或关闭当前图片编辑');
      const choice = await dialog.showOpenDialog(win, {
        title: '打开图片',
        properties: ['openFile'],
        filters: [{ name: 'PNG / JPEG 图片', extensions: ['png', 'jpg', 'jpeg'] }]
      });
      if (choice.canceled || !choice.filePaths[0] || quitting) return { error: null };
      const { image, source } = await readLocalImage(choice.filePaths[0]);
      if (!quitting) await screenshots.openImage(image, 'clipboard', undefined, undefined, undefined, { file: source });
      return { error: null };
    } catch (error) {
      const message = (error as Error).message;
      state.notice = message;
      layout();
      showWindow();
      publish();
      return { error: message };
    } finally {
      nativeDialogs--;
    }
  });
  ipcMain.handle('shell:image-remove', (event, id?: string) => {
    assertLocal(event);
    removeImage(id);
  });
  ipcMain.handle('shell:image-edit', (event, taskId: string, imageId: string) => {
    assertLocal(event);
    return result(async () => {
      const input = images.get(imageId);
      if (!input) throw Error('图片已被移除，请重新添加');
      const image = nativeImage.createFromPath(input.path);
      await screenshots.openImage(image, 'clipboard', undefined, undefined, taskId);
    });
  });

  ipcMain.handle('apichat:state', (event, id: string) => {
    assertLocal(event);
    return tasks.getApiChat(id);
  });
  ipcMain.handle('apichat:draft', (event, id: string, text: string) => {
    assertLocal(event);
    tasks.apiChatDraft(id, text);
  });
  ipcMain.handle('apichat:send', (event, id: string) => {
    assertLocal(event);
    return result(() => tasks.apiChatSend(id));
  });
  ipcMain.handle('apichat:stop', (event, id: string) => {
    assertLocal(event);
    return result(() => tasks.apiChatStop(id));
  });
  ipcMain.handle('apichat:regenerate', (event, id: string, messageId?: string) => {
    assertLocal(event);
    return result(() => tasks.apiChatRegenerate(id, messageId));
  });
  ipcMain.handle('apichat:clear', (event, id: string) => {
    assertLocal(event);
    tasks.apiChatClear(id);
  });
  ipcMain.handle('apichat:model', (event, id: string, connectionId: string, model: string) => {
    assertLocal(event);
    return result(() => tasks.apiChatModel(id, connectionId, model));
  });
  ipcMain.handle('apichat:pin', async (event, _id: string) => {
    assertLocal(event);
    const [w, h] = win.getContentSize();
    const image = await win.webContents.capturePage({ x: 0, y: HEADER_HEIGHT, width: w, height: Math.max(1, h - HEADER_HEIGHT) });
    if (!image.isEmpty()) {
      const size = image.getSize();
      await screenshots.pins.put({ source: image, image, annotations: { objects: [], crop: { x: 0, y: 0, ...size }, privacy: [], nextNumber: 1 } });
      island?.toast('已钉为桌面贴图', 'Pin');
    }
  });

  ipcMain.handle('shell:execution-catalog', async (event, target: WebTarget, model = '', refresh = false) => {
    assertLocal(event);
    if (!['chatgpt', 'gemini'].includes(target) || typeof model !== 'string' || typeof refresh !== 'boolean') {
      return { catalog: null, error: '无效的目标或模型' };
    }
    try {
      return { catalog: await tasks.executionCatalog(target, model, refresh), error: null };
    } catch (error) {
      return { catalog: null, error: (error as Error).message };
    }
  });
  ipcMain.handle('shell:ocr-languages', event => {
    assertLocal(event);
    return screenshots.supportedLanguages();
  });
  ipcMain.handle('shell:memory', (event, options: MemorySettings) => {
    assertLocal(event);
    return result(() => {
      if (!validMemorySettings(options)) throw Error('休眠时间请输入 1–1440 的整数分钟');
      const next = { ...state.settings, memory: { enabled: options.enabled, idleMinutes: options.idleMinutes } };
      persistSettings(next);
      screenshots.memoryChanged();
      tasks.memoryChanged();
      publish();
    });
  });
  ipcMain.handle('shell:screenshot-settings', (event, options: ScreenshotSettings) => {
    assertLocal(event);
    return result(async () => {
      validateScreenshotSettings(options, screenshots.supportedLanguages());
      const next = { ...state.settings, screenshot: options };
      persistSettings(next);
      await screenshots.preferencesChanged();
      publish();
    });
  });
  ipcMain.handle('shell:capture', (event, options: Pick<Settings, 'selectionEnabled' | 'clipboardFallback'>) => {
    assertLocal(event);
    return saveCaptureSettings(options);
  });
  ipcMain.handle('shell:presets-save', (event, presets: Preset[]) => {
    assertLocal(event);
    return result(() => persistPresets(presets));
  });
  ipcMain.handle('shell:preset-run', (event, id: string, options?: LaunchOptions) => {
    assertLocal(event);
    return runPreset(id, options?.imageId ? null : lastSelection, options);
  });
  ipcMain.handle('shell:state', event => {
    if (!recordingPanel.owns(event)) assertLocal(event);
    const snap = snapshot();
    return settingsWindow?.owns(event) ? { ...snap, settingsSection: settingsWindow.activeSection } : snap;
  });
  ipcMain.handle('shell:task-select', (event, id: string) => {
    assertLocal(event);
    selectTask(id);
  });
  ipcMain.handle('shell:task-close', (event, id: string) => {
    assertLocal(event);
    return tasks.close(id);
  });
  ipcMain.handle('shell:palette-open', (event, scope: PaletteScope) => {
    assertLocal(event);
    if (['all', 'tasks', 'new'].includes(scope)) return openPalette(scope);
  });
  ipcMain.handle('shell:palette-close', event => {
    assertLocal(event);
    closePalette();
  });
  ipcMain.handle('shell:action', async (event, action: Action) => {
    assertLocal(event);
    switch (action) {
      case 'dismiss-notice':
        state.notice = null;
        layout();
        publish();
        break;
      case 'retry-delivery':
        await tasks.retryDelivery();
        break;
      case 'pin':
        setPin();
        break;
      case 'expand':
        expand();
        break;
      case 'hide':
        motion.hide();
        break;
      case 'settings':
        openSettings();
        break;
      case 'open-quick-image':
        await media.show();
        break;
      case 'reload':
        await tasks.reload();
        break;
      case 'quit':
        requestQuit();
        break;
      case 'refresh-capture':
        capture.configure(state.settings);
        break;
      case 'selection-permission':
        systemPreferences.isTrustedAccessibilityClient(true);
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
        break;
      case 'copy-pending':
        tasks.copyPending();
        break;
      case 'cancel-delivery':
        tasks.cancelDelivery();
        break;
      case 'dismiss-delivery':
        tasks.dismissDelivery();
        break;
      case 'open-island-board':
        island?.openBoard();
        break;
      case 'toggle-edge-notes':
        island?.notes.toggleDrawer(true);
        break;
      case 'open-finder-panel':
        void island?.finder.summon();
        break;
      case 'snap-coding-ai':
        island?.snapWindow('coding-ai');
        break;
      case 'snap-equal-split':
        island?.snapWindow('equal-split');
        break;
      default:
        throw new Error('不支持的窗口操作');
    }
  });
  ipcMain.handle('shell:regions', event => {
    assertLocal(event);
    return screenshots.regionConfiguration();
  });
  ipcMain.handle('shell:region-save', (event, p: RegionPreset) => {
    assertLocal(event);
    screenshots.saveRegionPreset(p);
    publish();
  });
  ipcMain.handle('shell:region-delete', (event, id: string) => {
    assertLocal(event);
    screenshots.deleteRegionPreset(id);
    publish();
  });
  ipcMain.handle('shell:screenshot', async (event, mode: EfficiencyCaptureMode, delay: CaptureDelay = 0) => {
    assertLocal(event);
    if ((mode === 'repeat' || captureModes.includes(mode)) && [0, 3, 5, 10].includes(delay)) {
      await startScreenshot(mode, delay);
    }
  });
  ipcMain.handle('shell:screenshot-cancel', event => {
    assertLocal(event);
    screenshots.efficiency.cancel();
  });
  ipcMain.handle('shell:editor-shortcuts', (event, shortcuts: EditorShortcutMap) => {
    assertLocal(event);
    const error = validateEditorShortcuts(shortcuts);
    if (error) return { error };
    return result(() => saveSettings({ ...state.settings, editorShortcuts: shortcuts }));
  });
  ipcMain.handle('shell:ignored-apps', (event, rules: IgnoredAppRule[]) => {
    assertLocal(event);
    return result(() => {
      const ids = new Set<string>();
      if (!Array.isArray(rules)) throw Error('忽略应用规则无效');
      for (const rule of rules) {
        if (
          !rule ||
          typeof rule.bundleId !== 'string' ||
          !/^[\w-]+(?:\.[\w-]+)+$/.test(rule.bundleId) ||
          ids.has(rule.bundleId) ||
          typeof rule.name !== 'string' ||
          !rule.name.trim() ||
          typeof rule.enabled !== 'boolean' ||
          !Array.isArray(rule.scopes) ||
          !rule.scopes.length ||
          new Set(rule.scopes).size !== rule.scopes.length ||
          rule.scopes.some(scope => !['selection', 'shortcuts', 'capture-candidates'].includes(scope))
        ) {
          throw Error('应用规则需要唯一的 bundle ID、名称和有效作用范围');
        }
        ids.add(rule.bundleId);
      }
      saveSettings({ ...state.settings, ignoredApps: rules.map(rule => ({ ...rule, name: rule.name.trim() })) });
      capture.configure(state.settings);
    });
  });
}

async function boot() {
  initializeWindowPresence();
  prewarmNativeCapture();
  mkdirSync(app.getPath('userData'), { recursive: true });
  settingsPath = join(app.getPath('userData'), 'settings.json');
  presetsPath = join(app.getPath('userData'), 'presets.json');
  fontsDir = join(app.getPath('userData'), 'fonts');
  serveFonts(fontsDir);
  images = new Images(join(app.getPath('userData'), 'input-images'));

  state = {
    pinned: false,
    expanded: false,
    shortcutError: null,
    notice: null,
    settings: readSettings(settingsPath),
    presets: readPresets(presetsPath),
    capture: { status: 'paused', message: '划词未启动' },
    selection: null,
    captureEfficiency: { phase: 'idle', remaining: 0, error: null }
  };

  nativeTheme.themeSource = state.settings.themeMode === 'system' ? 'system' : 'light';
  if (app.isPackaged && !process.env.LASSO_PROFILE) {
    app.setLoginItemSettings({ openAtLogin: state.settings.launchAtLogin });
  }
  if (app.isPackaged && !process.env.LASSO_PROFILE && state.settings.autoCheckUpdates) {
    void fetch('https://api.github.com/repos/ump45nose/lasso/releases/latest', { signal: AbortSignal.timeout(5000) })
      .then(async response => {
        if (!response.ok) return;
        const release = (await response.json()) as { tag_name?: string };
        const latest = release.tag_name?.replace(/^v/, '');
        if (!latest || !/^\d+\.\d+\.\d+$/.test(latest)) return;
        const current = app.getVersion().split('.').map(Number);
        const candidate = latest.split('.').map(Number);
        const first = candidate.findIndex((n, i) => n !== current[i]);
        if (first >= 0 && candidate[first] > current[first]) {
          state.notice = `发现新版本 ${latest}，可从项目发布页下载`;
          publish();
        }
      })
      .catch(() => {});
  }

  const cursor = screen.getCursorScreenPoint();
  win = new BrowserWindow({
    ...placeNear(cursor, screen.getDisplayNearestPoint(cursor).workArea),
    minWidth: 380,
    minHeight: 420,
    frame: false,
    show: false,
    backgroundColor: '#FAF9F5',
    title: 'Lasso',
    fullscreenable: false,
    icon: join(app.getAppPath(), 'assets/lasso-icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  setWindowPresence(win, true);
  motion = new WindowMotion(win);
  settingsWindow = new SettingsWindow(snapshot);

  const mediaDirectory = join(app.getPath('userData'), 'generated-media');
  mkdirSync(mediaDirectory, { recursive: true, mode: 0o700 });
  state.presets = migrateImagePresets(presetsPath, mediaDirectory);

  const pinImage = async (image: NativeImage) => {
    const size = image.getSize();
    await screenshots.pins.put({ source: image, image, annotations: { objects: [], crop: { x: 0, y: 0, ...size }, privacy: [], nextNumber: 1 } });
  };

  media = new MediaWindow(
    mediaDirectory,
    image => screenshots.openImage(image),
    pinImage,
    () => state.settings,
    () => state.presets
  );

  const visionDirectory = join(app.getPath('userData'), 'vision-service');
  const migrated = migrateApiConnectionSettings(media.service, settingsPath, presetsPath, state.settings, state.presets, visionDirectory);
  state.settings = migrated.settings;
  state.presets = migrated.presets;
  media.service.setReferenceProvider(() => ({
    presets: state.presets,
    translation: state.settings.translation,
    vision: state.settings.vision,
    defaultApiChat: state.settings.defaultApiChat
  }));

  tasks = new TaskManager(
    win,
    secureRemote,
    () => {
      layout();
      publish();
    },
    () => state.settings,
    () => media.service,
    images,
    event => {
      if (!win.isDestroyed()) win.webContents.send('apichat:changed', event);
    }
  );
  sealLocal(win.webContents);
  win.on('resize', layout);
  win.on('hide', () => closePalette());
  win.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      setWindowPresence(win, false);
      motion.hide();
    } else {
      tasks.dispose();
    }
  });
  app.on('browser-window-blur', deferHide);
  app.on('browser-window-focus', () => clearTimeout(blurTimer));
  screen.on('display-removed', () => {
    if (!win || win.isDestroyed()) return;
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setBounds(state.expanded ? area : fitToWorkArea(win.getBounds(), area));
  });

  const localMainURL = pathToFileURL(join(__dirname, 'renderer/index.html')).href;
  const localPermission = (contents: WebContents | null, permission: string, details: { isMainFrame: boolean; requestingUrl?: string }) =>
    (contents === win.webContents || contents === settingsWindow.window?.webContents) &&
    (permission === 'local-fonts' ||
      (permission === 'clipboard-sanitized-write' &&
        details.isMainFrame &&
        Boolean(details.requestingUrl?.startsWith(localMainURL)) &&
        contents.mainFrame.url.startsWith(localMainURL)));
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => localPermission(contents, permission, details));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(localPermission(contents, permission, details)));

  for (const [partition, hosts] of [
    ['persist:chatgpt', ['chatgpt.com', 'www.chatgpt.com']],
    ['persist:gemini', ['gemini.google.com']]
  ] as const) {
    const webSession = session.fromPartition(partition);
    const mediaOrigins = new Set<string>();
    webSession.setPermissionCheckHandler((_contents, permission, origin) => {
      if (!hosts.some(host => origin === 'https://' + host)) return false;
      return permission === 'clipboard-sanitized-write' || (permission === 'media' && mediaOrigins.has(origin));
    });
    webSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
      const origin = details.requestingUrl || contents.getURL();
      if (!isHTTPS(origin) || !hosts.some(host => new URL(origin).hostname === host)) return callback(false);
      if (permission === 'clipboard-sanitized-write') return callback(true);
      if (permission !== 'media') return callback(false);
      const allowed = await confirmDialog('允许当前 AI 网页使用麦克风或摄像头？', '仅授予当前网页；macOS 可能还会请求系统权限。');
      if (allowed) mediaOrigins.add(new URL(origin).origin);
      callback(allowed);
    });
  }

  recordingPanel = new RecordingPanel({
    quitting: () => quitting,
    recording: () => recording,
    screenshots: () => screenshots,
    notice: message => {
      state.notice = message;
      layout();
      publish();
    },
    assertLocal
  });
  actionShortcuts = new ActionShortcuts({
    state: () => state,
    persistSettings,
    run: runGlobalAction,
    notice: message => {
      state.notice = message;
      layout();
      publish();
    },
    changed: () => {
      updateTray();
      publish();
    },
    assertLocal
  });
  installCaptureLibraryIPC({ screenshots: () => screenshots, pinClipboard: () => runGlobalAction('pin-clipboard'), assertLocal });
  installIPC();

  const appIcon = nativeImage.createFromPath(join(app.getAppPath(), 'assets/lasso-icon.png'));
  if (!appIcon.isEmpty()) app.dock?.setIcon(appIcon);
  const trayIcon = nativeImage.createFromPath(join(app.getAppPath(), 'assets/trayTemplate.png'));
  trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip('Lasso');
  updateTray();

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Lasso',
        submenu: [
          { label: '设置…', accelerator: 'Command+,', click: () => openSettings() },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { label: '退出 Lasso', accelerator: 'Command+Q', click: requestQuit }
        ]
      },
      { role: 'editMenu' },
      {
        label: '窗口',
        submenu: [
          { label: '显示 AI 对话窗', click: showWindow },
          { label: '指令面板', accelerator: 'Command+K', click: () => { if (palette) closePalette(); else void openPalette('all'); } },
          { label: '新任务…', accelerator: 'Command+N', click: () => void openPalette('new') },
          { label: 'AI 生图…', click: () => { void media.show(); } },
          { type: 'separator' },
          {
            label: '关闭当前窗口',
            accelerator: 'Command+W',
            click: () => {
              if (!screenshots?.closeFocused()) motion.hide();
            }
          },
          {
            label: '贴图管理…',
            click: () => Menu.buildFromTemplate(screenshots?.pins.trayItems() || []).popup({ window: BrowserWindow.getFocusedWindow() || win }) // ui-check-ignore: continues the native app menu bar
          },
          { label: '放大 / 还原', click: expand }
        ]
      }
    ])
  );

  await win.loadFile(join(__dirname, 'renderer/index.html'));

  island = new NotchIsland({
    onQuickAction: action => {
      if (action === 'screenshot-area') void startScreenshot('area');
      else openSettings();
    },
    onPinImage: pinImage,
    onPinText: async text => {
      await screenshots.pins.create({ kind: 'text', text });
    },
    onAskAi: handleClipboardAskAi,
    onSendFilesToAi: sendFinderFilesToAi,
    mediaService: media.service,
    settings: () => state.settings,
    saveTranslation,
    saveNookPrefs: nookPrefs => {
      persistSettings({ ...state.settings, nookPrefs });
    }
  });
  island.updateSettings(state.settings);
  setCopyPngListener(png => {
    island?.clipboardHistory.recordImage(png);
  });

  actionBar = new ActionBar(
    async (id, selection) => {
      await runPreset(id, selection);
    },
    () => openSettings('selection'),
    {
      stream: (input, onDelta) => media.service.streamChat(input, onDelta),
      writeText: (text, opts) => island.clipboardHistory.writeText(text, opts),
      paste: () => island.pasteSelection(),
      pin: pinImage,
      toast: (text, badge) => island.toast(text, badge),
      appPrompts: () => state.settings.appPrompts,
      onTranslate: selection => {
        const frontPid = nativeAx().frontmostApp?.().pid ?? 0;
        island.translator.open(selection.text, frontPid);
      },
      onAppendNote: appendNoteText,
      onContinueInChat: payload => {
        tasks.seedApiExchange(payload);
        layout();
        showWindow();
        publish();
      }
    }
  );

  capture = new SelectionCapture(
    selection => {
      if (screenshots?.active) return;
      lastSelection = selection;
      state.selection = { length: selection.text.length, sourceApp: selection.sourceApp };
      actionBar.show(selection);
      publish();
    },
    status => {
      if (state.capture?.status !== status.status) console.info('[selection]', status.status);
      state.capture = status;
      publish();
    },
    point => {
      if (!actionBar.contains(point)) {
        actionBar.hide();
        if (!palette) clearSelection();
      }
    },
    () => {
      actionBar.hide();
      if (!palette) clearSelection();
    }
  );
  actionBar.update(state.presets, false, state.settings);

  screenshots = new CaptureManager(
    receiveCaptureImage,
    () => {
      const visible = Boolean(win && !win.isDestroyed() && win.isVisible());
      actionBar.hide(true);
      capture.suppress();
      clearSelection();
      motion.hide(true);
      return visible;
    },
    restore => {
      capture?.suppress();
      if (restore && !quitting) showWindow();
    },
    receiveCaptureText,
    updateTray,
    () => state.settings.screenshot,
    message => {
      state.notice = message;
      publish();
    },
    () => state.settings,
    () => state.settings.memory,
    preferences => {
      persistSettings({ ...state.settings, screenshot: preferences });
      publish();
    },
    () => intelligence,
    {
      fastText: triggerFastText,
      noteText: text => appendNoteText(text, '截图 OCR'),
      presets: editorPresetList,
      onStartRecording: async bounds => {
        await recordingPanel.show();
        if (bounds) {
          await recordingPanel.act({ type: 'start', mode: 'rect', bounds });
        }
      }
    }
  );

  let recordingTrayState: string | undefined;
  recording = new RecordingManager({
    settings: () => state.settings.screenshot.recording,
    prepareCapture: (mode, bounds) => screenshots.prepareRecording(mode, bounds),
    captureFrame: (mode, bounds) => screenshots.captureRecordingFrame(mode, bounds),
    releaseCapture: () => screenshots.releaseRecording(),
    subscribeInput: handlers => capture.subscribeInput(handlers),
    exportOutput: async (output, action) => {
      if (action === 'pin') {
        await screenshots.pins.putAnimated(output);
        return null;
      }
      nativeDialogs++;
      try {
        return await saveRecordingOutput(output, action, state.settings.screenshot, recordingPanel.window ?? win);
      } finally {
        nativeDialogs--;
      }
    },
    onChange: recSession => {
      recordingPanel.changed(recSession);
      const trayState = recSession ? `${recSession.status}:${recSession.frameCount > 0}` : 'idle';
      if (trayState !== recordingTrayState) {
        recordingTrayState = trayState;
        if (tray && !quitting) updateTray();
      }
    }
  });

  intelligence = new IntelligenceService(visionDirectory, {
    secrets: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: value => safeStorage.encryptString(value),
      decrypt: value => safeStorage.decryptString(value)
    },
    mediaConnection: () => media.service.connection(),
    mediaCredential: () => media.service.credential(),
    mediaService: media.service,
    pinFormula: (latex, svg, current) => screenshots.pins.pinFormula(latex, svg, current)
  });
  intelligence.configure(state.settings.vision);

  webdav = new WebDavSyncService(app.getPath('userData'), {
    readSettings: () => state.settings,
    writeSettings: applyImportedSettings,
    readPresets: () => state.presets,
    writePresets: persistPresets
  });
  webdav.scheduleAutoSync();

  fileServices = require(join(__dirname, 'native/file-services.node'));
  fileServices!.start(path => {
    void receiveMediaFile(path);
  });
  if (pendingMediaFiles.length) {
    const files = pendingMediaFiles.splice(0);
    if (files.length === 1 && existsSync(files[0])) void receiveMediaFile(files[0]);
    else {
      state.notice = '请一次选择一张 PNG 或 JPEG 图片';
      publish();
      showWindow();
    }
  }

  let captureTrayPending = false;
  stopCaptureEfficiency = screenshots.efficiency.subscribe(next => {
    const starting = next.phase === 'countdown' && state.captureEfficiency.phase !== 'countdown';
    state.captureEfficiency = next;
    if (next.error) state.notice = next.error;
    layout();
    publish();
    if (!captureTrayPending) {
      captureTrayPending = true;
      setImmediate(() => {
        captureTrayPending = false;
        if (!quitting) updateTray();
      });
    }
    if (starting) {
      actionBar.hide();
      setWindowPresence(win, true);
      motion.show(true);
    }
    if (next.error) showWindow();
  });

  const conflicts = actionShortcuts.configure(state.settings);
  if (conflicts.length) state.notice = conflicts.join('；');
  capture.configure(state.settings);
  if (!launchInBackground) showWindow();
}

if (!hasLock) app.quit();
else {
  app.on('second-instance', (_event, argv) => {
    if (!argv.includes('--background')) showWindow();
  });
  app.on('activate', () => {
    if (!win || win.isDestroyed()) return;
    showWindow();
  });
  app.on('window-all-closed', () => {
    if (quitting) app.quit();
  });
  app.on('before-quit', event => {
    if (shutdownComplete) return;
    if (recordingShutdown) {
      event.preventDefault();
      return;
    }
    quitting = true;
    if (recording?.active) {
      event.preventDefault();
      screenshots?.cancelRecordingSelection();
      recordingShutdown = recording
        .dispose()
        .catch(error => console.error('[recording] 退出保存失败', error))
        .finally(() => {
          screenshots?.dispose();
          actionBar?.destroy();
          island?.destroy();
          shutdownComplete = true;
          setImmediate(() => app.quit());
        });
    } else {
      void recording?.dispose().catch(() => {});
      screenshots?.dispose();
      actionBar?.destroy();
      island?.destroy();
      shutdownComplete = true;
    }
  });
  app.on('will-quit', () => {
    webdav?.dispose();
    fileServices?.stop();
    stopCaptureEfficiency?.();
    settingsWindow?.dispose();
    media?.dispose();
    motion?.dispose();
    tasks?.dispose();
    images?.dispose();
    capture?.cleanup();
    actionBar?.destroy();
    island?.destroy();
    clearTimeout(blurTimer);
    globalShortcut.unregisterAll();
    tray?.destroy();
  });
  void app.whenReady().then(boot).catch(error => {
    dialog.showErrorBox('Lasso 无法启动', String(error));
    quitting = true;
    app.quit();
  });
}
