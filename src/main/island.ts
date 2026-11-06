import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, screen } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  EdgeNoteItem,
  EdgeNotesState,
  FinderPanelState,
  IslandAlertItem,
  IslandMode,
  IslandState,
  IslandTaskItem,
  Settings,
  SnapSlot
} from '../shared/contracts';

interface NativeAxBridge {
  paste?: () => boolean;
  setGlow?: (enabled: boolean) => void;
  startBridge?: (cb: (name: string, payload: string) => void) => void;
  postBridge?: (name: string, payload: string) => void;
  snapWindow?: (x: number, y: number, w: number, h: number) => boolean;
  tileTwoWindows?: (x1: number, y1: number, w1: number, h1: number, x2: number, y2: number, w2: number, h2: number) => number;
  frontmostApp?: () => { bundleId: string; name: string; pid: number };
}

const WIN_W = 540, WIN_H = 440;
const NOTES_W = 376, NOTES_H = 548;
const FINDER_W = 384, FINDER_H = 430;

function loadNativeAx(): NativeAxBridge {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(join(__dirname, 'capture-ax.node')) as NativeAxBridge;
  } catch {
    return {};
  }
}

function readNookTasks(): IslandTaskItem[] {
  const base = join(homedir(), 'Library/Application Support/PersonalDataHub/local-cache');
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
  return [
    { id: 'nook-default-1', title: '核对 New API 翻译流式延迟与回填', listTitle: 'Lasso · 今日重点' },
    { id: 'nook-default-2', title: '检查 launchd 守护服务状态与错误日志', listTitle: 'Nook · 运维巡检' },
    { id: 'nook-default-3', title: '整理本周设计规范与截图回归', listTitle: 'Lasso · 工程验收' }
  ];
}

function resolveNotesFolder(): string {
  const folder = process.env.LASSO_DATA_ROOT
    ? join(app.getPath('userData'), 'notes')
    : join(homedir(), 'Documents/LassoNotes');
  mkdirSync(folder, { recursive: true });
  const scratchPath = join(folder, 'Scratchpad.md');
  if (!existsSync(scratchPath)) {
    writeFileSync(
      scratchPath,
      '# Scratchpad 随手记\n\n- 划词选择任意英文后点「翻译」即可走 New API 流式直出，按 `↵` 直接回填替换\n- 右侧贴边悬停即可拉出本抽屉，点击右下角「撕下为贴图」可将当前笔记钉在桌面\n- 常用命令：`launchctl kickstart -k gui/$UID/com.personalhub.app`\n',
      'utf8'
    );
  }
  const secondPath = join(folder, 'Workspace-Notes.md');
  if (!existsSync(secondPath)) {
    writeFileSync(
      secondPath,
      '# 研发分屏与巡检备忘\n\n1. `⌃⌥←` / `⌃⌥→` 左右半屏吸附\n2. `⌃⌥↵` 一键 2/3 编辑器 + 1/3 AI 双栏工作区\n3. `⌃⌥F` 唤起 Finder 超级动作面板\n',
      'utf8'
    );
  }
  return folder;
}

function loadNotesFromDisk(folder: string): EdgeNoteItem[] {
  const files = readdirSync(folder).filter(name => name.endsWith('.md'));
  const items: EdgeNoteItem[] = files.map(fileName => {
    const full = join(folder, fileName);
    const stat = statSync(full);
    const content = readFileSync(full, 'utf8');
    const firstHeading = content.split('\n').find(line => line.trim().startsWith('#'))?.replace(/^#+\s*/, '').trim();
    const id = fileName.replace(/\.md$/i, '');
    const pinned = fileName.toLowerCase() === 'scratchpad.md';
    const d = stat.mtime;
    const updatedAt = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return {
      id,
      title: firstHeading || id,
      fileName,
      pinned,
      updatedAt,
      content
    };
  });
  items.sort((a, b) => (a.pinned === b.pinned ? a.fileName.localeCompare(b.fileName) : a.pinned ? -1 : 1));
  return items;
}

function queryFinderContext(frontAppName: string): { folder: string; selection: string[]; frontmostApp: string } {
  const fallback = { folder: join(homedir(), 'WorkSpace/Code/Github/mac-ai-prompt'), selection: [], frontmostApp: frontAppName || 'Finder' };
  if (process.env.LASSO_DATA_ROOT) return fallback;
  try {
    const script = `
      tell application "Finder"
        set folderPath to ""
        if (count of Finder windows) > 0 then
          set folderPath to POSIX path of (target of front Finder window as alias)
        else
          set folderPath to POSIX path of (desktop as alias)
        end if
        set selPaths to {}
        set selList to selection as alias list
        repeat with itemRef in selList
          set end of selPaths to POSIX path of itemRef
        end repeat
        set AppleScript's text item delimiters to "\\n"
        return folderPath & "\\n" & (selPaths as string)
      end tell
    `;
    const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 900 }).trim();
    const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
    return {
      folder: lines[0] || fallback.folder,
      selection: lines.slice(1),
      frontmostApp: frontAppName || 'Finder'
    };
  } catch {
    return fallback;
  }
}

export interface NotchIslandCallbacks {
  onQuickAction: (action: 'screenshot-area' | 'open-main' | 'open-settings') => void;
  onPinImage: (image: NativeImage) => Promise<void>;
  onSendTextToLasso: (text: string) => Promise<void>;
}

export class NotchIsland {
  readonly window: BrowserWindow;
  readonly notesWindow: BrowserWindow;
  readonly finderWindow: BrowserWindow;
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

  private notesFolder: string;
  private notesOpen = false;
  private notesList: EdgeNoteItem[] = [];
  private activeNoteId = 'Scratchpad';

  private finderState: FinderPanelState;

  constructor(private callbacks: NotchIslandCallbacks) {
    this.ax = loadNativeAx();
    this.nookTasks = readNookTasks();
    this.notesFolder = resolveNotesFolder();
    this.notesList = loadNotesFromDisk(this.notesFolder);
    if (this.notesList[0]) this.activeNoteId = this.notesList[0].id;
    this.finderState = {
      folder: join(homedir(), 'WorkSpace/Code/Github/mac-ai-prompt'),
      selection: [],
      frontmostApp: 'Finder',
      fonts: this.fonts
    };

    const preloadPath = join(__dirname, 'island-preload.cjs');
    this.window = new BrowserWindow({
      width: WIN_W,
      height: WIN_H,
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
      webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.setAlwaysOnTop(true, 'screen-saver');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', event => event.preventDefault());

    this.notesWindow = new BrowserWindow({
      width: NOTES_W,
      height: NOTES_H,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      focusable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    this.notesWindow.setIgnoreMouseEvents(true, { forward: true });
    this.notesWindow.setAlwaysOnTop(true, 'floating');
    this.notesWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.notesWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.notesWindow.webContents.on('will-navigate', event => event.preventDefault());

    this.finderWindow = new BrowserWindow({
      width: FINDER_W,
      height: FINDER_H,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      focusable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: { preload: preloadPath, nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    this.finderWindow.setAlwaysOnTop(true, 'pop-up-menu');
    this.finderWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.finderWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.finderWindow.webContents.on('will-navigate', event => event.preventDefault());
    this.finderWindow.on('blur', () => {
      if (!this.finderWindow.isDestroyed()) this.finderWindow.hide();
    });

    this.placeWindows();
    screen.on('display-metrics-changed', () => this.placeWindows());

    const check = (event: IpcMainEvent | IpcMainInvokeEvent) => {
      const valid = [this.window.webContents, this.notesWindow.webContents, this.finderWindow.webContents];
      if (!valid.includes(event.sender)) throw new Error('套件表面来源不匹配');
    };

    ipcMain.handle('island:state', event => {
      check(event);
      this.nookTasks = readNookTasks();
      return this.snapshot();
    });
    ipcMain.on('island:mode', (event, mode: IslandMode) => {
      check(event);
      this.mode = mode;
      this.publish();
    });
    ipcMain.on('island:hit', (event, inside: boolean) => {
      check(event);
      this.window.setIgnoreMouseEvents(!inside, { forward: true });
    });
    ipcMain.handle('island:pomo-start', (event, task?: { id: string | null; title: string }, minutes = 25, kind: 'focus' | 'slacking' = 'focus') => {
      check(event);
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
      this.completeTask(taskId);
    });
    ipcMain.handle('island:snooze-alert', (event, alertId: string, minutes = 10) => {
      check(event);
      this.snoozeAlert(alertId, minutes);
    });
    ipcMain.handle('island:dismiss-alert', (event, alertId: string) => {
      check(event);
      this.dismissAlert(alertId);
    });
    ipcMain.handle('island:restart-service', (event, label: string) => {
      check(event);
      this.restartService(label);
    });
    ipcMain.handle('island:quick', (event, action: 'screenshot-area' | 'open-main' | 'open-settings' | 'toggle-notes' | 'open-finder-panel') => {
      check(event);
      if (this.mode === 'board') {
        this.mode = this.resolveBaseMode();
        this.publish();
      }
      if (action === 'toggle-notes') {
        this.toggleNotesDrawer(!this.notesOpen);
        return;
      }
      if (action === 'open-finder-panel') {
        this.summonFinderPanel();
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
      this.snapWindow(slot);
    });

    // EdgeNotes IPC
    ipcMain.handle('notes:state', event => {
      check(event);
      return this.notesSnapshot();
    });
    ipcMain.on('notes:open', (event, open: boolean) => {
      check(event);
      this.toggleNotesDrawer(Boolean(open));
    });
    ipcMain.on('notes:hit', (event, inside: boolean) => {
      check(event);
      this.notesWindow.setIgnoreMouseEvents(!inside, { forward: true });
      if (inside && this.notesOpen) this.notesWindow.focus();
    });
    ipcMain.handle('notes:select', (event, id: string) => {
      check(event);
      if (this.notesList.some(n => n.id === id)) {
        this.activeNoteId = id;
        this.publishNotes();
      }
    });
    ipcMain.handle('notes:save', (event, id: string, content: string) => {
      check(event);
      const note = this.notesList.find(n => n.id === id);
      if (!note) return;
      const full = join(this.notesFolder, note.fileName);
      writeFileSync(full, content, 'utf8');
      const firstHeading = content.split('\n').find(line => line.trim().startsWith('#'))?.replace(/^#+\s*/, '').trim();
      const now = new Date();
      note.content = content;
      note.title = firstHeading || note.id;
      note.updatedAt = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      this.publishNotes();
    });
    ipcMain.handle('notes:create', (event, title?: string) => {
      check(event);
      const stamp = new Date().toISOString().slice(5, 16).replace(/[:T]/g, '-');
      const id = title?.trim().replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '-') || `Note-${stamp}`;
      const fileName = `${id}.md`;
      const full = join(this.notesFolder, fileName);
      writeFileSync(full, `# ${title || id}\n\n`, 'utf8');
      this.notesList = loadNotesFromDisk(this.notesFolder);
      this.activeNoteId = id;
      this.publishNotes();
    });
    ipcMain.handle('notes:pin', async (event, id: string) => {
      check(event);
      const note = this.notesList.find(n => n.id === id);
      if (!note) return;
      const image = await this.notesWindow.webContents.capturePage({ x: 8, y: 14, width: NOTES_W - 18, height: NOTES_H - 28 });
      if (!image.isEmpty()) {
        await this.callbacks.onPinImage(image);
        this.toast(`已将「${note.title}」钉为桌面贴图`, 'Pin');
      }
    });

    // Finder Super Action Panel IPC
    ipcMain.handle('finder:state', event => {
      check(event);
      return this.finderState;
    });
    ipcMain.on('finder:close', event => {
      check(event);
      if (!this.finderWindow.isDestroyed()) this.finderWindow.hide();
    });
    ipcMain.handle('finder:create-file', (event, ext: 'md' | 'txt' | 'py' | 'json' | 'sh') => {
      check(event);
      this.createFinderFile(ext);
    });
    ipcMain.handle('finder:run-action', async (event, action: 'copy-path' | 'open-terminal' | 'open-cursor' | 'open-vscode' | 'send-to-lasso') => {
      check(event);
      await this.runFinderAction(action);
    });

    this.ax.startBridge?.((name, payload) => this.handleBridgeNotification(name, payload));

    this.window.once('ready-to-show', () => {
      this.placeWindows();
      if (!process.env.LASSO_DATA_ROOT) this.window.showInactive();
      this.publish();
    });
    this.notesWindow.once('ready-to-show', () => {
      this.placeWindows();
      if (!process.env.LASSO_DATA_ROOT) this.notesWindow.showInactive();
      this.publishNotes();
    });
    void this.window.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'island' } });
    void this.notesWindow.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'edge-notes' } });
    void this.finderWindow.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'finder-panel' } });
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
      ['Control+Option+N', () => this.toggleNotesDrawer(!this.notesOpen)],
      ['Control+Option+F', () => this.summonFinderPanel()]
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
    if (!this.notesWindow.isDestroyed()) {
      const area = primary.workArea;
      const x = area.x + area.width - NOTES_W;
      const y = Math.round(area.y + (area.height - NOTES_H) / 2);
      this.notesWindow.setBounds({ x, y, width: NOTES_W, height: NOTES_H });
    }
  }

  private resolveBaseMode(): IslandMode {
    if (this.alerts.length > 0) return 'nook-alert';
    if (this.pomodoro?.active) return this.pomodoro.kind === 'slacking' ? 'slacking' : 'focus';
    return 'idle';
  }

  private snapshot(): IslandState {
    return {
      mode: this.mode,
      glow: this.glow,
      pomodoro: this.pomodoro,
      toast: this.toastItem,
      alerts: this.alerts,
      nookTasks: this.nookTasks,
      fonts: this.fonts
    };
  }

  private notesSnapshot(): EdgeNotesState {
    return {
      open: this.notesOpen,
      folder: this.notesFolder,
      activeId: this.activeNoteId,
      notes: this.notesList,
      fonts: this.fonts
    };
  }

  private publish() {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send('island:changed', this.snapshot());
    }
  }

  private publishNotes() {
    if (!this.notesWindow.isDestroyed()) {
      this.notesWindow.webContents.send('notes:changed', this.notesSnapshot());
    }
  }

  private publishFinder() {
    if (!this.finderWindow.isDestroyed()) {
      this.finderWindow.webContents.send('finder:changed', this.finderState);
    }
  }

  updateSettings(settings: Settings) {
    this.fonts = { fonts: settings.fonts, importedFonts: settings.importedFonts };
    this.finderState = { ...this.finderState, fonts: this.fonts };
    this.publish();
    this.publishNotes();
    this.publishFinder();
  }

  toggleNotesDrawer(open: boolean) {
    this.notesOpen = open;
    if (open) {
      this.notesList = loadNotesFromDisk(this.notesFolder);
      this.notesWindow.setIgnoreMouseEvents(false);
    } else {
      this.notesWindow.setIgnoreMouseEvents(true, { forward: true });
    }
    this.publishNotes();
  }

  summonFinderPanel() {
    const front = this.ax.frontmostApp?.() || { bundleId: 'com.apple.finder', name: 'Finder', pid: 0 };
    const ctx = queryFinderContext(front.name);
    this.finderState = { ...ctx, fonts: this.fonts };
    const cursor = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const x = Math.min(Math.max(area.x + 12, cursor.x - Math.round(FINDER_W / 2)), area.x + area.width - FINDER_W - 12);
    const y = Math.min(Math.max(area.y + 12, cursor.y - 24), area.y + area.height - FINDER_H - 12);
    this.finderWindow.setBounds({ x, y, width: FINDER_W, height: FINDER_H });
    this.publishFinder();
    this.finderWindow.show();
    this.finderWindow.focus();
  }

  private createFinderFile(ext: 'md' | 'txt' | 'py' | 'json' | 'sh') {
    const folder = this.finderState.folder;
    const defaults: Record<typeof ext, string> = {
      md: '# 新建笔记\n\n',
      txt: '',
      py: '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n\n',
      json: '{\n  \n}\n',
      sh: '#!/usr/bin/env zsh\nset -euo pipefail\n\n'
    };
    let index = 1;
    let filePath = join(folder, `Untitled.${ext}`);
    while (existsSync(filePath)) {
      index += 1;
      filePath = join(folder, `Untitled-${index}.${ext}`);
    }
    try {
      writeFileSync(filePath, defaults[ext], { encoding: 'utf8', mode: ext === 'sh' || ext === 'py' ? 0o755 : 0o644 });
      this.finderWindow.hide();
      this.toast(`已创建 ${basename(filePath)}`, `.${ext}`);
    } catch (error) {
      this.toast(`新建失败：${(error as Error).message}`, 'Error');
    }
  }

  private async runFinderAction(action: 'copy-path' | 'open-terminal' | 'open-cursor' | 'open-vscode' | 'send-to-lasso') {
    const targets = this.finderState.selection.length ? this.finderState.selection : [this.finderState.folder];
    const primaryTarget = targets[0];
    this.finderWindow.hide();
    if (action === 'copy-path') {
      await Promise.resolve(clipboard.writeText(targets.join('\n')));
      this.toast(`已复制路径：${basename(primaryTarget)}`, '⌘C');
      return;
    }
    if (action === 'open-terminal') {
      execFile('open', ['-a', 'Terminal', this.finderState.folder]);
      this.toast(`已在终端打开 ${basename(this.finderState.folder)}`, 'Term');
      return;
    }
    if (action === 'open-cursor') {
      execFile('open', ['-a', 'Cursor', primaryTarget]);
      this.toast(`已用 Cursor 打开 ${basename(primaryTarget)}`, 'Cursor');
      return;
    }
    if (action === 'open-vscode') {
      execFile('open', ['-a', 'Visual Studio Code', primaryTarget]);
      this.toast(`已用 VS Code 打开 ${basename(primaryTarget)}`, 'Code');
      return;
    }
    if (action === 'send-to-lasso') {
      await this.callbacks.onSendTextToLasso(`请分析以下路径或文件：\n${targets.join('\n')}`);
      this.toast('已发送到 Lasso 主窗口', 'AI');
    }
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
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.ax.setGlow?.(false);
    for (const w of [this.window, this.notesWindow, this.finderWindow]) {
      if (!w.isDestroyed()) w.destroy();
    }
  }
}
