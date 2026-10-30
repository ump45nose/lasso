import type { CustomCaptureRequest,RegionPreset } from '../shared/capture-regions';
import { validateScreenshotSettings, type ScreenshotSettings } from '../shared/screenshot-settings';
import { app, BrowserWindow, Menu, Tray, nativeImage, globalShortcut, ipcMain, screen, session, dialog, shell, systemPreferences } from 'electron';
import type { IpcMainInvokeEvent, Rectangle, WebContents } from 'electron';
import { basename, isAbsolute, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CaptureManager } from './capture';
import { prewarmNativeCapture } from './capture/native';
import { readLocalImage } from './capture/local-images';
import { Images, type ImageInput } from './images';
import { applicationIcon } from './app-icons';
import { MediaWindow } from './media-window';
import { readSettings, writeSettings } from './settings';
import { fontExtensions, importFont, registerFontScheme, removeFont, serveFonts, validateFonts } from './fonts';
import { fitToWorkArea, placeNear } from './position';
import { SelectionCapture } from './selection';
import { WindowMotion } from './motion';
import { initializeWindowPresence, setWindowPresence } from './window-presence';
import { validMemorySettings, type MemorySettings } from '../shared/memory';
import { ActionBar } from './action-bar';
import { TaskManager } from './tasks';
import { readPresets, writePresets, composePrompt, migrateImagePresets } from './presets';
import { targetLabels, HEADER_HEIGHT, FOOTER_ROW } from '../shared/contracts';
import { isValidShortcut } from '../shared/shortcuts';
import { captureModeLabels, captureModes, type CaptureMode } from '../shared/capture';
import type { CaptureDelay, EfficiencyCaptureMode } from '../shared/capture-efficiency';
import type { Action, ShellState, SelectionContext, Preset, Settings, LaunchOptions, Target, AgentAnswer, PaletteEvent, PaletteScope } from '../shared/contracts';

app.setName('Lasso');
// Development and later packaged builds use the same application-owned profile.
// LASSO_PROFILE gives tools such as scripts/ui-shots a separate profile that can run beside the installed app.
const isolatedRoot = process.env.LASSO_DATA_ROOT;
if (isolatedRoot && !isAbsolute(isolatedRoot)) throw Error('LASSO_DATA_ROOT 必须是绝对路径');
app.setPath('userData', join(isolatedRoot || app.getPath('appData'), process.env.LASSO_PROFILE || 'mac-ai-prompt'));
if (isolatedRoot) {
  for (const name of ['sessionData', 'temp', 'crashDumps'] as const) {
    const directory = join(isolatedRoot, name); mkdirSync(directory, { recursive: true }); app.setPath(name, directory);
  }
  app.setAppLogsPath(join(isolatedRoot, 'logs'));
}
registerFontScheme();
const hasLock = app.requestSingleInstanceLock();
let win: BrowserWindow;
let motion: WindowMotion;
let tasks: TaskManager;
let tray: Tray;
let settingsPath: string;
let presetsPath: string;
let fontsDir: string;
let images: Images;
let screenshots: CaptureManager;
let media: MediaWindow;
let fileServices: { start(callback: (path: string) => void): void; stop(): void } | undefined;
const pendingMediaFiles: string[] = [];
let openingMediaFile = false;
async function receiveMediaFile(path: string) {
  if (!media) { pendingMediaFiles.push(path); return; }
  if (openingMediaFile) { state.notice = '正在打开图片，请稍后再选择'; layout(); publish(); return; }
  openingMediaFile = true;
  try { const { image } = await readLocalImage(path); openImage(images.add(image)); }
  catch (error) { state.notice = (error as Error).message; layout(); showWindow(); publish(); }
  finally { openingMediaFile = false; }
}
app.on('open-file', (event, path) => { event.preventDefault(); void receiveMediaFile(path); });
let inputImage: ImageInput | null = null;
let capture: SelectionCapture;
let actionBar: ActionBar;
let lastSelection: SelectionContext | null = null;
let smallBounds: Rectangle | null = null;
let blurTimer: ReturnType<typeof setTimeout>;
let quitting = false;
let nativeDialogs = 0;
let stopCaptureEfficiency: (()=>void) | undefined;
/** The command palette hides native pages; its frozen page snapshot stays out of ShellState. */
let palette: PaletteEvent | null = null;
let state: Omit<ShellState, 'tasks' | 'activeTaskId' | 'hasPage' | 'title' | 'hostname' | 'loading' | 'pageError' | 'delivery' | 'activeTarget'>;
function snapshot(): ShellState { return { ...state, ...tasks.snapshot() }; }

function publish() {
  if (win && !win.isDestroyed()) win.webContents.send('shell:changed', snapshot());
  actionBar?.update(state.presets, false, state.settings);
}
function layout() {
  if (!win || win.isDestroyed() || !tasks) return;
  const [width, height] = win.getContentSize();
  // Footer rows sit below the page: the app notice, then the active task's delivery progress.
  const rows = (state.notice || state.captureEfficiency.phase!=='idle' ? 1 : 0) + (tasks.snapshot().delivery ? 1 : 0);
  tasks.layout({ x: 0, y: HEADER_HEIGHT, width, height: Math.max(0, height - HEADER_HEIGHT - rows * FOOTER_ROW) }, !state.customCaptureOpen && !state.settingsOpen && !state.inputOpen && !palette);
}
async function openPalette(scope: PaletteScope) {
  showWindow();
  // Capture before hiding so the palette sits on the page the user was looking at.
  const backdrop = palette ? palette.backdrop : await tasks.capture();
  palette = { scope, backdrop };
  layout(); win.webContents.focus();
  win.webContents.send('shell:palette', palette);
}
/** Navigation flows close the palette first and lay out the page themselves. */
function closePalette(restore = true) {
  if (!palette) return;
  palette = null;
  if (!win.isDestroyed()) win.webContents.send('shell:palette', { scope: null, backdrop: null } satisfies PaletteEvent);
  if (restore) { layout(); if (!state.settingsOpen && !state.inputOpen) tasks.focus(); }
}
function showWindow() {
  if (!win) return;
  setWindowPresence(win, true);
  // A display may have been disconnected while the window was hidden.
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  win.setBounds(state.expanded ? area : fitToWorkArea(win.getBounds(), area));
  actionBar?.hide();
  motion.show();
  app.focus({ steal: true });
  win.focus();
  if (!state.customCaptureOpen && !state.settingsOpen && !state.inputOpen && !palette) {
    tasks.focus();
    // Start the preferred page after the launcher is shown; reuse it on the next web action.
    setImmediate(() => { if (!quitting) tasks.warmPreferred(); });
  }
}
function openCustomCapture(){closePalette(false);state.customCaptureOpen=true;layout();showWindow();win.webContents.focus();publish();}
function openSettings() {
  capture?.configure(state.settings);
  closePalette(false);
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
  // Focus moves through a gap when a login child or native menu opens.
  blurTimer = setTimeout(() => {
    if (!state.pinned && nativeDialogs === 0 && !BrowserWindow.getFocusedWindow()) motion.hide();
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
function requestQuit() {
  quitting = true;
  app.quit();
}
function isHTTPS(url: string) { return new URL(url).protocol === 'https:'; }
function isLogin(url: string) {
  const host = new URL(url).hostname;
  return ['gemini.google.com', 'chatgpt.com', 'openai.com', 'auth0.com', 'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com']
    .some(domain => host === domain || host.endsWith('.' + domain));
}
function secureRemote(contents: WebContents) {
  contents.on('will-navigate', (event, url) => { if (!isHTTPS(url)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!isHTTPS(url)) event.preventDefault(); });
  contents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || (isHTTPS(url) && isLogin(url))) {
      return { action: 'allow', overrideBrowserWindowOptions: {
        parent: win, width: 560, height: 720, autoHideMenuBar: true,
        webPreferences: { session: contents.session, nodeIntegration: false, contextIsolation: true, sandbox: true }
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
  closePalette(false); state.settingsOpen = false; state.inputOpen = false;
  if (newTask) tasks.newChat(); else tasks.openChat();
  layout(); showWindow(); publish();
}
function selectTask(id: string) {
  closePalette(false); state.settingsOpen = false; state.inputOpen = false;
  tasks.select(id); layout(); showWindow(); publish();
}
function updateTray() {
  const capturePending=Boolean(screenshots&&screenshots.efficiency.state.phase!=='idle');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开小窗', click: showWindow },
    { label: `打开 ${targetLabels[state.settings.lastTarget]}`, click: () => openChat() },
    { label: `贴图（${screenshots?.pins.size || 0}）`, submenu: screenshots?.pins.trayItems() || [] },
    { label: '新任务…', click: () => void openPalette('new') },
    { label: '图片生成…', click: () => { void openPalette('images'); } },
    { label: '生图结果…', click: () => { void media.show(); } },
    ...(screenshots?.sleeping?[{label:'恢复休眠中的图片编辑',click:()=>screenshots.focus()}]:[]),
    { label: captureModeLabels.rect, enabled:!capturePending, accelerator: state.settings.captureShortcuts.rect || undefined, click: () => void startScreenshot('rect') },
    { label: captureModeLabels.area, enabled:!capturePending, accelerator: state.settings.captureShortcuts.area || undefined, click: () => void startScreenshot('area') },
    { label:'自定义截图…',click:()=>openCustomCapture() },
    { label: '更多截图方式', submenu: [
      ...captureModes.filter(mode => mode !== 'area' && mode !== 'rect').map(mode => ({ label: captureModeLabels[mode], enabled:!capturePending, accelerator: state.settings.captureShortcuts[mode] || undefined, click: () => void startScreenshot(mode) })),
      {type:'separator'},
      {label:'重截上次截图区域',enabled:!capturePending,click:()=>void startScreenshot('repeat')},
      ...([3,5,10] as const).map(delay=>({label:`${delay}秒延时截图`,enabled:!screenshots?.active,click:()=>void startScreenshot('area',delay)})),
      ...(capturePending?[{label:'取消延时截图',click:()=>screenshots.efficiency.cancel()}]:[])
    ] },
    { label: '使用剪贴板图片', click: () => { void readImage().catch(() => {}); } },
    { label: '运行预设…', click: () => void openPalette('all') },
    { label: '暂停划词', type: 'checkbox', checked: !state.settings.selectionEnabled, click: () => { const result = saveCaptureSettings({ selectionEnabled: !state.settings.selectionEnabled, clipboardFallback: state.settings.clipboardFallback }); if (result.error) dialog.showErrorBox('未能保存划词设置', result.error); } },
    { label: '置顶', type: 'checkbox', checked: state.pinned, click: setPin },
    { type: 'separator' },
    { label: '设置…', click: openSettings },
    { label: '退出 Lasso', click: requestQuit }
  ]));
}
function registerShortcut(shortcut: string): string | null {
  if (!shortcut) return null;
  try {
    if (globalShortcut.register(shortcut, () => { clearSelection(); capture?.current(); showWindow(); if (lastSelection) void openPalette('all'); })) return null;
    return `${shortcut} 已被占用，请换一组快捷键。`;
  } catch { return '快捷键格式无效，例如 Control+Option+Space。'; }
}
async function startScreenshot(mode: EfficiencyCaptureMode,delay:CaptureDelay=0) {
  if(screenshots.efficiency.state.phase!=='idle')return;
  if(screenshots.active){screenshots.focus();return;}
  closePalette(false); state.notice = null; layout(); publish();
  try {
    if(nativeDialogs)throw Error('请先关闭文件选择窗口');
    const result=await screenshots.efficiency.start(mode,delay);
    if('error' in result)throw Error(result.error);
  } catch(error) {
    console.warn('[screenshot]', (error as Error).message);
    state.notice = '截图未能启动：' + (error as Error).message; layout(); showWindow(); publish();
  }
}
function registerCaptureShortcut(mode: CaptureMode, shortcut: string): string | null {
  if(!shortcut)return null;
  if(/^(?:Alt|Option)\+Space$/i.test(shortcut))return 'Option+Space 已留给 Raycast，请选择其他快捷键。';
  if(shortcut===state.settings.shortcut)return '截图快捷键不能与唤起小窗相同。';
  const other=captureModes.find(m=>m!==mode&&state.settings.captureShortcuts[m]===shortcut);
  if(other)return `已用于「${captureModeLabels[other]}」。`;
  try { return globalShortcut.register(shortcut,()=>void startScreenshot(mode))?null:'截图快捷键已被占用。'; }catch{return '快捷键格式无效。';}
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
async function runPreset(id: string, selection: SelectionContext | null, options: LaunchOptions = {}) {
  const preset = state.presets.find(p => p.id === id && p.enabled);
  if (!preset) return { error: '这个预设已停用或删除' };
  if (options.imageId && options.imageId !== inputImage?.id) return { error: '图片已被替换，请重新选择。' };
  if(options.textId&&options.textId!==state.inputText?.id)return {error:'文字已被替换，请重新选择。'};
  if(options.imageId&&options.textId)return {error:'请选择图片或文字中的一种输入。'};
  if (options.imagePrompt !== undefined && (preset.kind !== 'image' || typeof options.imagePrompt !== 'string' || options.imagePrompt.length > 24000)) return { error: '生图描述无效' };
  if (preset.kind === 'image' && options.target && !['chatgpt', 'gemini'].includes(options.target)) return { error: '生图预设请选择 ChatGPT、Gemini 或沿用 New API' };
  if(options.textId)selection={text:state.inputText!.text,sourceApp:'',anchor:{x:0,y:0,width:0,height:0}};
  if (options.imageId) selection = null;
  if (preset.kind === 'image' && options.imagePrompt !== undefined) selection = { text: options.imagePrompt, sourceApp: '', anchor: { x: 0, y: 0, width: 0, height: 0 } };
  if (preset.needsSelection && !selection?.text && !options.imageId) return { error: '请先选中文字' };
  const text = composePrompt(preset, selection, state.settings.appPrompts);
  const target = options.target || preset.target;
  if (target === 'api') {
    try {
      await media.prepare(preset, text, options.imageId ? nativeImage.createFromPath(inputImage!.path) : undefined);
      if (options.imageId) { images.remove(inputImage); inputImage = null; state.inputImage = null; }
      state.inputText = null; state.inputOpen = false; clearSelection(); actionBar.hide(); closePalette(false); layout(); publish();
      return { error: null };
    } catch (error) { state.notice = (error as Error).message; layout(); showWindow(); publish(); return { error: state.notice }; }
  }
  actionBar.hide(); capture.suppress(); clearSelection(); closePalette(false);
  if (!options.imageId && inputImage) removeImage();
  if (!options.textId) state.inputText = null;
  if (selection && !options.textId && !state.pinned && !state.expanded) {
    win.setBounds(placeNear(selection.anchor, screen.getDisplayNearestPoint(selection.anchor).workArea));
  }
  state.settingsOpen = false;
  rememberTarget(target);
  const result = tasks.runPreset(preset, text, options);
  if (options.imageId) { inputImage = null; state.inputImage = null; }
  state.inputText = null; state.inputOpen = false;
  layout(); showWindow(); publish();
  return result;
}

async function choosePath(kind: 'directory' | 'executable' | 'application') {
  nativeDialogs++;
  try {
    const result = await dialog.showOpenDialog(win, { properties: [kind === 'directory' ? 'openDirectory' : 'openFile'], ...(kind === 'application' ? { defaultPath: '/Applications', filters: [{ name: 'macOS 应用', extensions: ['app'] }] } : {}) });
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    if (kind !== 'application') return { path };
    const plist = join(path, 'Contents/Info.plist');
    const bundleId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist], { encoding: 'utf8' }).trim();
    return { path, bundleId, name: basename(path, '.app') };
  } finally { nativeDialogs--; }
}
function rememberTarget(target: Target) {
  if (state.settings.lastTarget === target) return;
  const settings = { ...state.settings, lastTarget: target };
  writeSettings(settingsPath, settings); state.settings = settings; updateTray();
}
function launchTask(options: LaunchOptions) {
  closePalette(false); state.settingsOpen = false; state.inputOpen = false; clearSelection();
  if (options.target) rememberTarget(options.target);
  tasks.newChat(true, options); layout(); showWindow(); publish();
}
async function readImage(taskId?: string) {
  if (taskId) {
    const image = await images.capture();
    try { tasks.agentImage(taskId, image); } catch (error) { images.remove(image); throw error; }
    return;
  }
  let image: ImageInput;
  try { image = await images.capture(); }
  catch (error) { state.notice = (error as Error).message; layout(); showWindow(); publish(); throw error; }
  state.notice = null;
  openImage(image);
}
/** A pending image or text is a temporary tab; selecting a task keeps it until it runs or is removed. The two replace each other. */
function openImage(image: ImageInput, prompt = '') {
  state.inputImagePrompt = prompt;
  images.remove(inputImage); inputImage = image; state.inputImage = images.preview(image); state.inputText = null; state.inputOpen = true;
  clearSelection(); closePalette(false); state.settingsOpen = false; layout(); showWindow(); win.webContents.focus(); publish();
}
async function receiveText(text: string) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw Error('没有可交接的文字');
  images.remove(inputImage); inputImage = null; state.inputImage = null;
  state.inputText = { id: randomUUID(), text }; state.inputOpen = true;
  actionBar.hide(); capture.suppress(); clearSelection(); closePalette(false); state.settingsOpen = false; layout(); showWindow(); win.webContents.focus(); publish();
}
function removeImage(taskId?: string) {
  if (taskId) tasks.agentImage(taskId, null);
  else { images.remove(inputImage); inputImage = null; state.inputImage = null; state.inputOpen = false; layout(); if (!state.settingsOpen) tasks.focus(); publish(); }
}

function installIPC() {
  ipcMain.handle('shell:app-icon', (event, bundleId: string) => { assertLocal(event); return applicationIcon(bundleId); });
  ipcMain.handle('shell:media-config', event => { assertLocal(event); return media.service.connection(); });
  ipcMain.handle('shell:media-config-save', (event, input) => { assertLocal(event); return media.service.configure(input); });
  ipcMain.handle('shell:media-models', event => { assertLocal(event); return media.service.models(); });
  ipcMain.handle('shell:attach-image', async (event, prompt?: string) => {
    assertLocal(event);
    if (prompt !== undefined && (typeof prompt !== 'string' || prompt.length > 24000)) return { error: '生图描述无效' };
    nativeDialogs++;
    try {
      const text = prompt || lastSelection?.text || '';
      const picked = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'PNG / JPEG 图片', extensions: ['png', 'jpg', 'jpeg'] }] });
      if (picked.filePaths[0]) { const { image } = await readLocalImage(picked.filePaths[0]); openImage(images.add(image), text); }
      return { error: null };
    } catch (error) { return { error: (error as Error).message }; } finally { nativeDialogs--; }
  });
  ipcMain.handle('shell:image-presets', event => { assertLocal(event); return openPalette('images'); });
  ipcMain.handle('shell:external', (event, url: string) => { assertLocal(event); if (['https:', 'http:'].includes(new URL(url).protocol)) return shell.openExternal(url); });
  const result = async (action: () => unknown) => { try { await action(); return { error: null }; } catch (error) { return { error: (error as Error).message }; } };
  ipcMain.handle('shell:integrations', (event, value: Pick<Settings, 'local' | 'appPrompts'>) => {
    assertLocal(event);
    return result(() => {
      for (const target of ['codex', 'pi'] as const) {
        const config = value.local[target];
        if (typeof config.executable !== 'string' || !statSync(config.cwd).isDirectory()) throw new Error('请选择有效的 CLI 路径和工作目录。');
      }
      const ids = new Set<string>();
      for (const rule of value.appPrompts) {
        if (!rule.bundleId.trim() || ids.has(rule.bundleId) || !rule.name.trim() || typeof rule.prompt !== 'string' || typeof rule.enabled !== 'boolean') throw new Error('应用规则需要唯一的 bundle ID 和名称。');
        ids.add(rule.bundleId);
      }
      const next = { ...state.settings, local: value.local, appPrompts: value.appPrompts };
      writeSettings(settingsPath, next); state.settings = next; publish();
    });
  });
  const saveSettings = (next: Settings) => { writeSettings(settingsPath, next); state.settings = next; publish(); };
  ipcMain.handle('shell:fonts', (event, fonts: Settings['fonts']) => {
    assertLocal(event);
    return result(() => { validateFonts(fonts); saveSettings({ ...state.settings, fonts: { display: fonts.display.trim(), text: fonts.text.trim(), ui: fonts.ui.trim(), mono: fonts.mono.trim() } }); });
  });
  ipcMain.handle('shell:font-import', async event => {
    assertLocal(event);
    nativeDialogs++;
    try {
      const choice = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: '字体', extensions: fontExtensions }] });
      if (choice.canceled || !choice.filePaths[0]) return { font: null, error: null };
      const font = importFont(fontsDir, choice.filePaths[0]);
      saveSettings({ ...state.settings, importedFonts: [...state.settings.importedFonts, font] });
      return { font, error: null };
    } catch (error) { return { font: null, error: (error as Error).message }; }
    finally { nativeDialogs--; }
  });
  ipcMain.handle('shell:font-remove', (event, file: string) => {
    assertLocal(event);
    return result(() => { removeFont(fontsDir, file); saveSettings({ ...state.settings, importedFonts: state.settings.importedFonts.filter(font => font.file !== file) }); });
  });
  ipcMain.handle('shell:choose-path', (event, kind) => { assertLocal(event); return choosePath(kind); });
  ipcMain.handle('shell:new-task', (event, options: LaunchOptions) => { assertLocal(event); launchTask(options); });
  ipcMain.handle('shell:image', (event, id?: string) => { assertLocal(event); return result(() => readImage(id)); });
  ipcMain.handle('shell:local-image-open', async event => {
    assertLocal(event);if(nativeDialogs)return {error:null};nativeDialogs++;
    try {
      if (screenshots.active) throw Error('请先完成或关闭当前图片编辑');
      const choice=await dialog.showOpenDialog(win,{title:'打开图片',properties:['openFile'],filters:[{name:'PNG / JPEG 图片',extensions:['png','jpg','jpeg']}]});
      if(choice.canceled||!choice.filePaths[0]||quitting)return {error:null};
      const {image,source}=await readLocalImage(choice.filePaths[0]);
      if(!quitting)await screenshots.openImage(image,'clipboard',undefined,undefined,undefined,{file:source});
      return { error: null };
    }
    catch (error) { const message = (error as Error).message; state.notice = message; layout(); showWindow(); publish(); return { error: message }; }
    finally { nativeDialogs--; }
  });
  ipcMain.handle('shell:image-remove', (event, id?: string) => { assertLocal(event); removeImage(id); });
  ipcMain.handle('shell:image-edit',(event,id:string)=>{assertLocal(event);return result(async()=>{if(!inputImage||inputImage.id!==id)throw Error('图片已被替换，请重新读取');const image=nativeImage.createFromPath(inputImage.path);await screenshots.openImage(image,'clipboard',undefined,undefined,id);});});
  ipcMain.handle('shell:text-remove',event=>{assertLocal(event);state.inputText=null;state.inputOpen=false;layout();if(!state.settingsOpen)tasks.focus();publish();});
  ipcMain.handle('agent:state', (event, id: string) => { assertLocal(event); return tasks.getAgent(id); });
  ipcMain.handle('agent:draft', (event, id: string, text: string) => { assertLocal(event); tasks.agentDraft(id, text); });
  ipcMain.handle('agent:send', (event, id: string) => { assertLocal(event); return result(() => tasks.agentSend(id)); });
  ipcMain.handle('agent:stop', (event, id: string) => { assertLocal(event); return result(() => tasks.agentStop(id)); });
  ipcMain.handle('shell:execution-catalog', async (event, target: Target, model = '', refresh = false) => {
    assertLocal(event);
    if (!['chatgpt', 'gemini', 'codex', 'pi'].includes(target) || typeof model !== 'string' || typeof refresh !== 'boolean') return { catalog: null, error: '无效的目标或模型' };
    try { return { catalog: await tasks.executionCatalog(target, model, refresh), error: null }; } catch (error) { return { catalog: null, error: (error as Error).message }; }
  });
  ipcMain.handle('agent:effort', (event, id: string, effort: string) => { assertLocal(event); return result(() => tasks.agentEffort(id, effort)); });
  ipcMain.handle('agent:models-refresh', (event, id: string) => { assertLocal(event); return result(() => tasks.agentRefreshModels(id)); });
  ipcMain.handle('agent:model', (event, id: string, model: string) => { assertLocal(event); return result(() => tasks.agentModel(id, model)); });
  ipcMain.handle('agent:answer', (event, id: string, requestId: string, answer: AgentAnswer) => { assertLocal(event); return result(() => tasks.agentAnswer(id, requestId, answer)); });
  ipcMain.handle('shell:ocr-languages', event => { assertLocal(event); return screenshots.supportedLanguages(); });
  ipcMain.handle('shell:memory',(event,options:MemorySettings)=>{
    assertLocal(event);
    try{
      if(!validMemorySettings(options))throw Error('休眠时间请输入 1–1440 的整数分钟');
      const next={...state.settings,memory:{enabled:options.enabled,idleMinutes:options.idleMinutes}};
      writeSettings(settingsPath,next);state.settings=next;
      screenshots.memoryChanged();tasks.memoryChanged();publish();return {error:null};
    }catch(error){return {error:(error as Error).message};}
  });
  ipcMain.handle('shell:screenshot-settings', (event, options: ScreenshotSettings) => {
    assertLocal(event);
    try { validateScreenshotSettings(options, screenshots.supportedLanguages()); const next = { ...state.settings, screenshot: options }; writeSettings(settingsPath, next); state.settings = next; screenshots.syncRegionPreferences(); publish(); return { error: null }; }
    catch (error) { return { error: (error as Error).message }; }
  });
  ipcMain.handle('shell:capture', (event, options: Pick<Settings, 'selectionEnabled' | 'clipboardFallback'>) => { assertLocal(event); return saveCaptureSettings(options); });
  ipcMain.handle('shell:presets-save', (event, presets: Preset[]) => {
    assertLocal(event);
    try { writePresets(presetsPath, presets); }
    catch (error) { return { error: (error as Error).message }; }
    state.presets = presets;
    tasks.warmPreferred();
    publish();
    return { error: null };
  });
  ipcMain.handle('shell:preset-run', (event, id: string, options?: LaunchOptions) => { assertLocal(event); return runPreset(id, options?.imageId ? null : lastSelection, options); });
  ipcMain.handle('shell:state', event => { assertLocal(event); return snapshot(); });
  ipcMain.handle('shell:task-select', (event, id: string) => { assertLocal(event); selectTask(id); });
  ipcMain.handle('shell:task-close', (event, id: string) => { assertLocal(event); return tasks.close(id); });
  ipcMain.handle('shell:palette-open', (event, scope: PaletteScope) => { assertLocal(event); if (['all', 'tasks', 'new', 'images'].includes(scope)) return openPalette(scope); });
  ipcMain.handle('shell:palette-close', event => { assertLocal(event); closePalette(); });
  ipcMain.handle('shell:action', async (event, action: Action) => {
    assertLocal(event);
    switch (action) {
      case 'dismiss-notice': state.notice = null; layout(); publish(); break;
      case 'show-input': if (inputImage || state.inputText) { closePalette(false); state.settingsOpen = false; state.inputOpen = true; layout(); win.webContents.focus(); publish(); } break;
      case 'retry-delivery': await tasks.retryDelivery(); break;
      case 'pin': setPin(); break;
      case 'expand': expand(); break;
      case 'hide': motion.hide(); break;
      case 'settings': openSettings(); break;
      case 'custom-capture':openCustomCapture();break;
      case 'close-custom-capture':state.customCaptureOpen=false;layout();publish();break;
      case 'close-settings': state.settingsOpen = false; layout(); publish(); break;
      case 'reload': await tasks.reload(); break;
      case 'quit': requestQuit(); break;
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
  ipcMain.handle('shell:regions',event=>{assertLocal(event);return screenshots.regionConfiguration();});
  ipcMain.handle('shell:region-save',(event,p:RegionPreset)=>{assertLocal(event);screenshots.saveRegionPreset(p);});
  ipcMain.handle('shell:region-delete',(event,id:string)=>{assertLocal(event);screenshots.deleteRegionPreset(id);});
  ipcMain.handle('shell:custom-screenshot',async(event,r:CustomCaptureRequest)=>{assertLocal(event);try{const result=await screenshots.customCapture(r);if(result.status==='failed'||result.status==='reselect-required')return {error:result.error};state.customCaptureOpen=false;layout();publish();return {error:null};}catch(error){return {error:(error as Error).message};}});
  ipcMain.handle('shell:screenshot', async (event, mode: EfficiencyCaptureMode,delay:CaptureDelay=0) => { assertLocal(event); if ((mode==='repeat'||captureModes.includes(mode))&&[0,3,5,10].includes(delay)) await startScreenshot(mode,delay); });
  ipcMain.handle('shell:screenshot-cancel',event=>{assertLocal(event);screenshots.efficiency.cancel();});
  ipcMain.handle('shell:capture-shortcut', (event, mode:CaptureMode, shortcut:string) => {
    assertLocal(event);
    if(!captureModes.includes(mode))return {error:'未知的截图方式'};
    if(!isValidShortcut(shortcut))return {error:'支持 F1–F24 单键，其他按键请搭配修饰键。'};
    const current=state.settings.captureShortcuts[mode];
    if(shortcut===current&&(!shortcut||globalShortcut.isRegistered(shortcut)))return {error:null};
    const error=registerCaptureShortcut(mode,shortcut);if(error)return {error};
    const captureShortcuts={...state.settings.captureShortcuts,[mode]:shortcut};
    try{writeSettings(settingsPath,{...state.settings,captureShortcuts});}catch(error){if(shortcut)globalShortcut.unregister(shortcut);return {error:String(error)};}
    if(current)globalShortcut.unregister(current);
    state.settings={...state.settings,captureShortcuts};updateTray();publish();return {error:null};
  });
  ipcMain.handle('shell:shortcut', (event, shortcut: string) => {
    assertLocal(event);
    if (!isValidShortcut(shortcut)) {
      return { error: '支持 F1–F24 单键，其他按键请搭配修饰键；留空则取消绑定。' };
    }
    if (shortcut && Object.values(state.settings.captureShortcuts).includes(shortcut)) return { error: '唤起快捷键不能与截图相同。' };
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
  initializeWindowPresence();
  prewarmNativeCapture();
  mkdirSync(app.getPath('userData'), { recursive: true });
  settingsPath = join(app.getPath('userData'), 'settings.json');
  presetsPath = join(app.getPath('userData'), 'presets.json');
  fontsDir = join(app.getPath('userData'), 'fonts');
  serveFonts(fontsDir);
  images = new Images(join(app.getPath('userData'), 'input-images'));
  state = {
    pinned: false, expanded: false, settingsOpen: false, inputImage: null, inputText: null, inputOpen: false,
    shortcutError: null, notice: null, settings: readSettings(settingsPath),
    presets: readPresets(presetsPath), capture: { status: 'paused', message: '划词未启动' }, selection: null,
    captureEfficiency:{phase:'idle',mode:null,remaining:0,hasLastArea:false,error:null}
  };
  const cursor = screen.getCursorScreenPoint();
  win = new BrowserWindow({
    ...placeNear(cursor, screen.getDisplayNearestPoint(cursor).workArea),
    minWidth: 340, minHeight: 360, frame: false, show: false,
    backgroundColor: '#FAF9F5', title: 'Lasso', fullscreenable: false,
    icon: join(app.getAppPath(), 'assets/lasso-icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  setWindowPresence(win, true);
  motion = new WindowMotion(win);
  tasks = new TaskManager(win, secureRemote, () => { layout(); publish(); }, () => state.settings, images, event => win.webContents.send('agent:changed', event));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('resize', layout);
  win.on('hide', () => closePalette());
  win.on('close', event => {
    if (!quitting) { event.preventDefault(); setWindowPresence(win, false); motion.hide(); }
    else tasks.dispose();
  });
  app.on('browser-window-blur', deferHide);
  app.on('browser-window-focus', () => clearTimeout(blurTimer));
  screen.on('display-removed', () => {
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setBounds(state.expanded ? area : fitToWorkArea(win.getBounds(), area));
  });
  // Local windows need no browser permissions except listing installed fonts for the font picker.
  session.defaultSession.setPermissionCheckHandler((contents, permission) => permission === 'local-fonts' && contents === win.webContents);
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => callback(permission === 'local-fonts' && contents === win.webContents));
  for (const [partition, hosts] of [['persist:chatgpt', ['chatgpt.com', 'www.chatgpt.com']], ['persist:gemini', ['gemini.google.com']]] as const) {
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
    const allowed = await confirm('允许当前 AI 网页使用麦克风或摄像头？', '仅授予当前网页；macOS 可能还会请求系统权限。');
    if (allowed) mediaOrigins.add(new URL(origin).origin);
    callback(allowed);
  });
  }
  installIPC();
  const appIcon = nativeImage.createFromPath(join(app.getAppPath(), 'assets/lasso-icon.png'));
  if (!appIcon.isEmpty()) app.dock?.setIcon(appIcon);
  const trayIcon = nativeImage.createFromPath(join(app.getAppPath(), 'assets/trayTemplate.png'));
  trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip('Lasso');
  updateTray();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Lasso', submenu: [
      { label: '设置…', accelerator: 'Command+,', click: openSettings },
      { role: 'services' },
      { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { label: '退出 Lasso', accelerator: 'Command+Q', click: requestQuit }
    ] },
    { role: 'editMenu' },
    { label: '窗口', submenu: [
      { label: '显示小窗', click: showWindow },
      { label: '指令面板', accelerator: 'Command+K', click: () => { if (palette) closePalette(); else void openPalette('all'); } },
      { label: '新任务…', accelerator: 'Command+N', click: () => void openPalette('new') },
      { type: 'separator' },
      { label: '关闭当前窗口', accelerator: 'Command+W', click: () => {if(!screenshots?.closeFocused())motion.hide();} },
      { label: '贴图管理…', click:()=>Menu.buildFromTemplate(screenshots?.pins.trayItems()||[]).popup({window:BrowserWindow.getFocusedWindow()||win}) }, // ui-check-ignore: continues the native app menu bar
      { label: '放大 / 还原', click: expand }
    ] }
  ]));
  state.shortcutError = registerShortcut(state.settings.shortcut);
  state.settingsOpen = Boolean(state.shortcutError);
  await win.loadFile(join(__dirname, 'renderer/index.html'));
  actionBar = new ActionBar(async (id, selection) => { await runPreset(id, selection); }, openSettings);
  capture = new SelectionCapture(selection => {
    if (screenshots?.active) return;
    lastSelection = selection;
    state.selection = { length: selection.text.length, sourceApp: selection.sourceApp };
    actionBar.show(selection); publish();
  }, status => {
    if (state.capture?.status !== status.status) console.info('[selection]', status.status);
    state.capture = status; publish();
  }, point => {
    if (!actionBar.contains(point)) { actionBar.hide(); clearSelection(); }
  }, () => { actionBar.hide(); clearSelection(); });
  actionBar.update(state.presets, false, state.settings);
  screenshots = new CaptureManager(async image => {
    openImage(images.add(image));
  }, () => { const visible=win.isVisible(); actionBar.hide(true); capture.suppress(); clearSelection(); motion.hide(true); return visible; }, restore => { capture?.suppress(); if (restore && !quitting) showWindow(); }, receiveText, updateTray, async image => { openImage(images.add(image)); }, () => state.settings.screenshot, message => { state.notice = message; publish(); },()=>state.settings,()=>state.settings.memory,preferences=>{writeSettings(settingsPath,{...state.settings,screenshot:preferences});state.settings={...state.settings,screenshot:preferences};publish();});
  const mediaDirectory = join(app.getPath('userData'), 'generated-media');
  mkdirSync(mediaDirectory, { recursive: true, mode: 0o700 });
  state.presets = migrateImagePresets(presetsPath, mediaDirectory);
  media = new MediaWindow(mediaDirectory, image => screenshots.openImage(image), async image => {
    const size = image.getSize();
    await screenshots.pins.put({ source: image, image, annotations: { objects: [], crop: { x: 0, y: 0, ...size }, privacy: [], nextNumber: 1 } });
  }, () => state.settings, () => openPalette('images'));
  fileServices = require(join(__dirname, 'native/file-services.node'));
  fileServices!.start(path => { void receiveMediaFile(path); });
  if (pendingMediaFiles.length) {
    const files = pendingMediaFiles.splice(0);
    if (files.length === 1) void receiveMediaFile(files[0]);
    else { state.notice = '请一次选择一张 PNG 或 JPEG 图片'; publish(); showWindow(); }
  }
  let captureTrayPending=false;
  stopCaptureEfficiency=screenshots.efficiency.subscribe(next=>{
    const starting=next.phase==='countdown'&&state.captureEfficiency.phase!=='countdown';
    state.captureEfficiency=next;
    if(next.error)state.notice=next.error;
    layout();publish();
    if(!captureTrayPending){captureTrayPending=true;setImmediate(()=>{captureTrayPending=false;if(!quitting)updateTray();});}
    if(starting){actionBar.hide();setWindowPresence(win,true);motion.show(true);}
    if(next.error)showWindow();
  });
  for (const mode of captureModes) {
    const error = registerCaptureShortcut(mode, state.settings.captureShortcuts[mode]);
    if (error) console.warn('[screenshot]', mode, error);
  }
  capture.configure(state.settings);
  // The launcher stays task-free; showWindow prepares one reusable preferred webpage.
  showWindow();
}
if (!hasLock) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().some(window => window.isVisible() || window.isMinimized())) showWindow(); });
  app.on('window-all-closed', () => {}); // Menu-bar app stays alive while hidden.
  // Without a confirmation there is nothing to intercept: any quit (⌘Q, Dock, logout) marks the app as quitting so windows close for real.
  app.on('before-quit', () => { quitting = true; screenshots?.dispose(); });
  app.on('will-quit', () => { fileServices?.stop();stopCaptureEfficiency?.();media?.dispose(); motion?.dispose(); tasks?.dispose(); images?.dispose(); capture?.cleanup(); actionBar?.destroy(); clearTimeout(blurTimer); globalShortcut.unregisterAll(); tray?.destroy(); });
  void app.whenReady().then(boot).catch(error => {
    dialog.showErrorBox('Lasso 无法启动', String(error));
    quitting = true;
    app.quit();
  });
}
