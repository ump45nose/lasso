import { app, BrowserWindow, Menu, Tray, nativeImage, globalShortcut, ipcMain, screen, session, dialog, shell, systemPreferences } from 'electron';
import type { IpcMainInvokeEvent, Rectangle, WebContents } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { readSettings, writeSettings } from './settings';
import { fitToWorkArea, placeNear } from './position';
import { SelectionCapture } from './selection';
import { ActionBar } from './action-bar';
import { TaskManager, CHAT_PARTITION } from './tasks';
import { readPresets, writePresets, renderPrompt } from './presets';
import { taskActivityLabels } from '../shared/contracts';
import type { Action, ShellState, SelectionContext, Preset, Settings } from '../shared/contracts';

const PARTITION = CHAT_PARTITION;
const HEADER_HEIGHT = 80;
app.setName('选中即问');
// Development and later packaged builds use the same application-owned profile.
app.setPath('userData', join(app.getPath('appData'), 'mac-ai-prompt'));
const hasLock = app.requestSingleInstanceLock();
let win: BrowserWindow;
let tasks: TaskManager;
let tray: Tray;
let settingsPath: string;
let presetsPath: string;
let capture: SelectionCapture;
let actionBar: ActionBar;
let lastSelection: SelectionContext | null = null;
let smallBounds: Rectangle | null = null;
let blurTimer: ReturnType<typeof setTimeout>;
let quitting = false;
let quitPromptOpen = false;
let nativeDialogs = 0;
let state: Omit<ShellState, 'tasks' | 'activeTaskId' | 'hasPage' | 'title' | 'hostname' | 'loading' | 'pageError' | 'delivery'>;
function snapshot(): ShellState { return { ...state, ...tasks.snapshot() }; }

function publish() {
  if (win && !win.isDestroyed()) win.webContents.send('shell:changed', snapshot());
  actionBar?.update(state.presets, false);
}
function layout() {
  if (!win || win.isDestroyed() || !tasks) return;
  const [width, height] = win.getContentSize();
  const top = HEADER_HEIGHT + (tasks.snapshot().delivery ? 36 : 0);
  tasks.layout({ x: 0, y: top, width, height: Math.max(0, height - top) }, !state.settingsOpen);
}
function showWindow() {
  if (!win) return;
  // A display may have been disconnected while the window was hidden.
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  win.setBounds(state.expanded ? area : fitToWorkArea(win.getBounds(), area));
  actionBar?.hide();
  win.show();
  app.focus({ steal: true });
  win.focus();
  if (!state.settingsOpen) tasks.focus();
}
function openSettings() {
  capture?.configure(state.settings);
  state.settingsOpen = true;
  layout();
  showWindow();
  win.webContents.focus();
  publish();
}
function setPin() {
  state.pinned = !state.pinned;
  win.setAlwaysOnTop(state.pinned, 'floating');
  updateTray();
  publish();
}
function expand() {
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  if (!state.expanded) {
    smallBounds = bounds;
    state.expanded = true;
    win.setBounds(area);
  } else {
    state.expanded = false;
    win.setBounds(fitToWorkArea(smallBounds!, area));
  }
  layout();
  publish();
}
function deferHide() {
  clearTimeout(blurTimer);
  // Focus moves through a gap when a login child or native menu opens.
  blurTimer = setTimeout(() => {
    if (!state.pinned && nativeDialogs === 0 && !BrowserWindow.getFocusedWindow()) win.hide();
  }, 150);
}
async function confirm(message: string, detail: string) {
  nativeDialogs++;
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', message, detail, buttons: ['取消', '继续'], defaultId: 0, cancelId: 0
    });
    return response === 1;
  } finally { nativeDialogs--; }
}
async function requestQuit() {
  if (quitPromptOpen) return;
  quitPromptOpen = true;
  if (tasks.size && !await confirm('退出选中即问？', `本次 ${tasks.size} 个任务会关闭，正在进行的任务和未发送内容不会在下次启动时恢复。`)) {
    quitPromptOpen = false;
    return;
  }
  quitting = true;
  app.quit();
}
function isHTTPS(url: string) { return new URL(url).protocol === 'https:'; }
function isLogin(url: string) {
  const host = new URL(url).hostname;
  return ['chatgpt.com', 'openai.com', 'auth0.com', 'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com']
    .some(domain => host === domain || host.endsWith('.' + domain));
}
function secureRemote(contents: WebContents) {
  contents.on('will-navigate', (event, url) => { if (!isHTTPS(url)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!isHTTPS(url)) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || (isHTTPS(url) && isLogin(url))) {
      return { action: 'allow', overrideBrowserWindowOptions: {
        parent: win, width: 560, height: 720, autoHideMenuBar: true,
        webPreferences: { partition: PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true }
      } };
    }
    if (isHTTPS(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('did-create-window', popup => {
    secureRemote(popup.webContents);
    popup.on('closed', () => { if (!quitting) showWindow(); });
  });
}
function openChat(newTask = false) {
  state.settingsOpen = false;
  if (newTask) tasks.newChat(); else tasks.openChat();
  layout(); showWindow(); publish();
}
function selectTask(id: string) {
  state.settingsOpen = false;
  tasks.select(id); layout(); showWindow(); publish();
}
function updateTray() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开小窗', click: showWindow },
    { label: '打开 ChatGPT', click: () => openChat() },
    { label: '新对话', click: () => openChat(true) },
    { label: '运行预设…', click: showPresetMenu },
    { label: '暂停划词', type: 'checkbox', checked: !state.settings.selectionEnabled, click: () => { const result = saveCaptureSettings({ selectionEnabled: !state.settings.selectionEnabled, clipboardFallback: state.settings.clipboardFallback }); if (result.error) dialog.showErrorBox('未能保存划词设置', result.error); } },
    { label: '置顶', type: 'checkbox', checked: state.pinned, click: setPin },
    { type: 'separator' },
    { label: '设置…', click: openSettings },
    { label: '退出选中即问', click: () => void requestQuit() }
  ]));
}
function registerShortcut(shortcut: string): string | null {
  if (!shortcut) return null;
  try {
    if (globalShortcut.register(shortcut, () => { clearSelection(); capture?.current(); showWindow(); if (lastSelection) showPresetMenu(); })) return null;
    return `${shortcut} 已被占用，请换一组快捷键。`;
  } catch { return '快捷键格式无效，例如 Control+Option+Space。'; }
}
function assertLocal(event: IpcMainInvokeEvent) {
  if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) {
    throw new Error('只有本地窗口可以调用应用操作');
  }
}
function clearSelection() {
  if (!lastSelection) return;
  lastSelection = null; state.selection = null; publish();
}
function saveCaptureSettings(options: Pick<Settings, 'selectionEnabled' | 'clipboardFallback'>) {
  if (!options || typeof options.selectionEnabled !== 'boolean' || typeof options.clipboardFallback !== 'boolean') return { error: '划词开关值无效' };
  const next = { ...state.settings, ...options };
  try { writeSettings(settingsPath, next); }
  catch (error) { return { error: (error as Error).message }; }
  state.settings = next;
  capture.configure(next); updateTray(); publish();
  return { error: null };
}
function showPresetMenu() {
  const selection = lastSelection;
  Menu.buildFromTemplate([
    ...state.presets.filter(p => p.enabled).map(p => ({
      label: `${p.name}${p.mode === 'edit' ? ' · 先编辑' : ''}`,
      enabled: !p.needsSelection || Boolean(selection),
      click: () => void runPreset(p.id, selection)
    })),
    { type: 'separator' }, { label: '预设设置…', click: openSettings }
  ]).popup({ window: win });
}
async function runPreset(id: string, selection: SelectionContext | null) {
  const preset = state.presets.find(p => p.id === id && p.enabled);
  if (!preset) return { error: '这个预设已停用或删除' };
  if (preset.needsSelection && !selection?.text) return { error: '请先选中文字' };
  const text = renderPrompt(preset, selection?.text || '');
  actionBar.hide(); capture.suppress(); clearSelection();
  if (selection && !state.pinned && !state.expanded) {
    win.setBounds(placeNear(selection.anchor, screen.getDisplayNearestPoint(selection.anchor).workArea));
  }
  state.settingsOpen = false;
  const result = tasks.runPreset(preset, text);
  layout(); showWindow(); publish();
  return result;
}

function installIPC() {
  ipcMain.handle('shell:capture', (event, options: Pick<Settings, 'selectionEnabled' | 'clipboardFallback'>) => { assertLocal(event); return saveCaptureSettings(options); });
  ipcMain.handle('shell:presets-save', (event, presets: Preset[]) => {
    assertLocal(event);
    try { writePresets(presetsPath, presets); }
    catch (error) { return { error: (error as Error).message }; }
    state.presets = presets;
    publish();
    return { error: null };
  });
  ipcMain.handle('shell:preset-run', (event, id: string) => { assertLocal(event); return runPreset(id, lastSelection); });
  ipcMain.handle('shell:state', event => { assertLocal(event); return snapshot(); });
  ipcMain.handle('shell:task-select', (event, id: string) => { assertLocal(event); selectTask(id); });
  ipcMain.handle('shell:task-close', (event, id: string) => { assertLocal(event); return tasks.close(id); });
  ipcMain.handle('shell:task-overflow', (event, visibleIds: string[], x: number) => {
    assertLocal(event);
    const overflow = tasks.snapshot().tasks.filter(task => !visibleIds.includes(task.id));
    if (!overflow.length) return;
    nativeDialogs++;
    Menu.buildFromTemplate(overflow.map(task => ({
      label: `${task.title} · ${task.residency === 'released' ? '已释放页面' : task.retainedReason || taskActivityLabels[task.activity]}`,
      click: () => selectTask(task.id)
    }))).popup({ window: win, x: Math.round(x), y: 42, callback: () => { nativeDialogs--; } });
  });
  ipcMain.handle('shell:action', async (event, action: Action) => {
    assertLocal(event);
    switch (action) {
      case 'open-chat': openChat(); break;
      case 'new-task': openChat(true); break;
      case 'pin': setPin(); break;
      case 'expand': expand(); break;
      case 'hide': win.hide(); break;
      case 'settings': openSettings(); break;
      case 'close-settings': state.settingsOpen = false; layout(); publish(); break;
      case 'reload': await tasks.reload(); break;
      case 'quit': await requestQuit(); break;
      case 'presets': showPresetMenu(); break;
      case 'refresh-capture': capture.configure(state.settings); break;
      case 'selection-permission':
        systemPreferences.isTrustedAccessibilityClient(true);
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
        break;
      case 'copy-pending': tasks.copyPending(); break;
      case 'cancel-delivery': tasks.cancelDelivery(); break;
      case 'dismiss-delivery': tasks.dismissDelivery(); break;
      default: throw new Error('不支持的窗口操作');
    }
  });
  ipcMain.handle('shell:shortcut', (event, shortcut: string) => {
    assertLocal(event);
    if (typeof shortcut !== 'string' || (shortcut !== '' && !/^(?:(?:Command|Control|CommandOrControl|Alt|Option|Shift|Super)\+)+(?:[A-Z0-9]|Space|F(?:[1-9]|1[0-9]|2[0-4]))$/i.test(shortcut))) {
      return { error: '请输入带修饰键的快捷键，例如 Control+Option+Space；留空则取消绑定。' };
    }
    if (shortcut === state.settings.shortcut && !state.shortcutError) return { error: null };
    const error = registerShortcut(shortcut);
    if (error) return { error };
    try { writeSettings(settingsPath, { ...state.settings, shortcut }); }
    catch (error) {
      if (shortcut) globalShortcut.unregister(shortcut);
      return { error: `无法保存设置：${(error as Error).message}` };
    }
    if (state.settings.shortcut && !state.shortcutError) globalShortcut.unregister(state.settings.shortcut);
    state.settings = { ...state.settings, shortcut };
    state.shortcutError = null;
    publish();
    return { error: null };
  });
}
async function boot() {
  mkdirSync(app.getPath('userData'), { recursive: true });
  settingsPath = join(app.getPath('userData'), 'settings.json');
  presetsPath = join(app.getPath('userData'), 'presets.json');
  state = {
    pinned: false, expanded: false, settingsOpen: false,
    shortcutError: null, settings: readSettings(settingsPath),
    presets: readPresets(presetsPath), capture: { status: 'paused', message: '划词未启动' }, selection: null
  };
  const cursor = screen.getCursorScreenPoint();
  win = new BrowserWindow({
    ...placeNear(cursor, screen.getDisplayNearestPoint(cursor).workArea),
    minWidth: 340, minHeight: 360, frame: false, show: false,
    backgroundColor: '#FAF9F5', title: '选中即问', fullscreenable: false,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  tasks = new TaskManager(win, secureRemote, () => { layout(); publish(); }, confirm);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('resize', layout);
  win.on('close', event => {
    if (!quitting) { event.preventDefault(); win.hide(); }
    else tasks.dispose();
  });
  app.on('browser-window-blur', deferHide);
  app.on('browser-window-focus', () => clearTimeout(blurTimer));
  screen.on('display-removed', () => {
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setBounds(state.expanded ? area : fitToWorkArea(win.getBounds(), area));
  });
  const webSession = session.fromPartition(PARTITION);
  const mediaOrigins = new Set<string>();
  webSession.setPermissionCheckHandler((_contents, permission, origin) => {
    if (!['https://chatgpt.com', 'https://www.chatgpt.com'].includes(origin)) return false;
    return permission === 'clipboard-sanitized-write' || (permission === 'media' && mediaOrigins.has(origin));
  });
  webSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const origin = details.requestingUrl || contents.getURL();
    if (!isHTTPS(origin) || !['chatgpt.com', 'www.chatgpt.com'].includes(new URL(origin).hostname)) return callback(false);
    if (permission === 'clipboard-sanitized-write') return callback(true);
    if (permission !== 'media') return callback(false);
    const allowed = await confirm('允许 ChatGPT 使用麦克风或摄像头？', '仅授予当前网页；macOS 可能还会请求系统权限。');
    if (allowed) mediaOrigins.add(new URL(origin).origin);
    callback(allowed);
  });
  installIPC();
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('✳');
  tray.setToolTip('选中即问');
  updateTray();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '选中即问', submenu: [
      { label: '设置…', accelerator: 'Command+,', click: openSettings },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { label: '退出选中即问', accelerator: 'Command+Q', click: () => void requestQuit() }
    ] },
    { role: 'editMenu' },
    { label: '窗口', submenu: [
      { label: '显示小窗', click: showWindow },
      { label: '隐藏小窗', accelerator: 'Command+W', click: () => win.hide() },
      { label: '放大 / 还原', click: expand }
    ] }
  ]));
  state.shortcutError = registerShortcut(state.settings.shortcut);
  state.settingsOpen = Boolean(state.shortcutError);
  await win.loadFile(join(__dirname, 'renderer/index.html'));
  actionBar = new ActionBar(async (id, selection) => { await runPreset(id, selection); }, openSettings);
  capture = new SelectionCapture(selection => {
    lastSelection = selection;
    state.selection = { length: selection.text.length, sourceApp: selection.sourceApp };
    actionBar.show(selection); publish();
  }, status => { state.capture = status; publish(); }, point => {
    if (!actionBar.contains(point)) { actionBar.hide(); clearSelection(); }
  }, () => { actionBar.hide(); clearSelection(); });
  actionBar.update(state.presets, false);
  capture.configure(state.settings);
  showWindow();
}
if (!hasLock) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {}); // Menu-bar app stays alive while hidden.
  app.on('before-quit', event => { if (!quitting && win) { event.preventDefault(); void requestQuit(); } });
  app.on('will-quit', () => { tasks?.dispose(); capture?.cleanup(); actionBar?.destroy(); clearTimeout(blurTimer); globalShortcut.unregisterAll(); tray?.destroy(); });
  void app.whenReady().then(boot).catch(error => {
    dialog.showErrorBox('选中即问无法启动', String(error));
    quitting = true;
    app.quit();
  });
}
