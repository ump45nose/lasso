import { app, ipcMain, screen } from 'electron';
import type { BrowserWindow, Display, IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EdgeNotesState, IslandState, Settings } from '../shared/contracts';
import { writeFileAtomic } from './files';
import { createIslandWindow } from './island-window';

const NOTES_W = 448, NOTES_H = 528;
const SCRATCHPAD = 'Scratchpad.md';

function resolveNotesFolder(): string {
  const folder = process.env.LASSO_DATA_ROOT
    ? join(app.getPath('userData'), 'notes')
    : join(homedir(), 'Documents/LassoNotes');
  mkdirSync(folder, { recursive: true });
  const scratchPath = join(folder, SCRATCHPAD);
  if (!existsSync(scratchPath)) writeFileSync(scratchPath, '# 随手记\n\n', 'utf8');
  return folder;
}

export interface EdgeNotesDeps {
  check: (event: IpcMainEvent | IpcMainInvokeEvent) => void;
  toast: (text: string, badge?: string) => void;
  onPinImage: (image: NativeImage) => Promise<void>;
  settings: () => Settings;
}

export class EdgeNotes {
  readonly window: BrowserWindow;
  private state: Omit<EdgeNotesState, 'notes'>;
  private boundsByDisplay = new Map<number, { x: number; y: number }>();

  constructor(fonts: IslandState['fonts'], private deps: EdgeNotesDeps) {
    const notesDir = resolveNotesFolder();
    const shortcut = deps.settings().actionShortcuts?.['toggle-notes'] ?? 'Alt+N';
    this.state = {
      open: false,
      focused: false,
      pinnedOnTop: true,
      activeFile: SCRATCHPAD,
      content: '',
      files: [],
      notesDir,
      shortcut,
      fonts
    };
    this.reload();

    this.window = createIslandWindow(NOTES_W, NOTES_H, { focusable: true });
    this.window.setMovable(true);
    this.window.setAlwaysOnTop(true, 'floating');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.webContents.setIgnoreMenuShortcuts(true);
    this.window.on('close', event => {
      event.preventDefault();
      this.hideDrawer();
    });
    this.window.on('focus', () => {
      this.state.focused = true;
      this.publish();
    });
    this.window.on('blur', () => {
      this.state.focused = false;
      this.publish();
    });
    this.window.on('moved', () => {
      const bounds = this.window.getBounds();
      const display = screen.getDisplayMatching(bounds);
      this.boundsByDisplay.set(display.id, { x: bounds.x, y: bounds.y });
    });
    this.window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.meta && input.key.toLowerCase() === 'w') {
        event.preventDefault();
        this.hideDrawer();
      }
    });

    const { check } = deps;
    ipcMain.handle('notes:state', event => {
      check(event);
      return this.snapshot();
    });
    ipcMain.on('notes:open', (event, open: boolean) => {
      check(event);
      this.toggleDrawer(Boolean(open));
    });
    ipcMain.handle('notes:select', (event, name: string) => {
      check(event);
      const file = this.noteFile(name);
      if (!file) return;
      this.state.activeFile = file;
      this.reload();
      this.publish();
    });
    ipcMain.handle('notes:save', (event, name: string, content: string) => {
      check(event);
      if (typeof content !== 'string') throw new Error('便签内容无效');
      const file = this.noteFile(name);
      if (!file) return;
      writeFileAtomic(join(this.state.notesDir, file), content);
      if (this.state.activeFile === file) this.state.content = content;
      this.publish();
    });
    ipcMain.handle('notes:create', (event, title?: string) => {
      check(event);
      const stamp = new Date().toISOString().slice(5, 16).replace(/[:T]/g, '-');
      const id = title?.trim().replace(/\.md$/i, '').replace(/[^a-zA-Z0-9一-龥_-]/g, '-') || `Note-${stamp}`;
      let file = `${id}.md`;
      for (let suffix = 2; existsSync(join(this.state.notesDir, file)); suffix++) file = `${id}-${suffix}.md`;
      writeFileSync(join(this.state.notesDir, file), `# ${title?.trim().replace(/\.md$/i, '') || file.slice(0, -3)}\n\n`, { encoding: 'utf8', flag: 'wx' });
      this.state.activeFile = file;
      this.reload();
      this.publish();
    });
    ipcMain.handle('notes:delete', (event, name: string) => {
      check(event);
      const file = this.noteFile(name);
      if (!file) throw new Error('便签不存在');
      if (file === SCRATCHPAD) throw new Error('不能删除 Scratchpad.md');
      unlinkSync(join(this.state.notesDir, file));
      if (this.state.activeFile === file) this.state.activeFile = SCRATCHPAD;
      this.reload();
      this.publish();
      return this.snapshot();
    });
    ipcMain.handle('notes:set-pinned', (event, pinned: boolean) => {
      check(event);
      this.state.pinnedOnTop = Boolean(pinned);
      this.window.setAlwaysOnTop(this.state.pinnedOnTop, 'floating');
      this.publish();
      return this.snapshot();
    });
    ipcMain.handle('notes:pin', async (event, name: string) => {
      check(event);
      const file = this.noteFile(name);
      if (!file) return;
      const image = await this.window.webContents.capturePage({ x: 14, y: 14, width: NOTES_W - 28, height: NOTES_H - 28 });
      if (!image.isEmpty()) {
        await this.deps.onPinImage(image);
        this.deps.toast(`已将「${file.replace(/\.md$/i, '')}」钉为桌面贴图`, 'Pin');
      }
    });

    this.window.once('ready-to-show', () => this.publish());
    void this.window.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'edge-notes' } });
  }

  place(display: Display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())) {
    if (this.window.isDestroyed()) return;
    const area = display.workArea;
    const position = this.boundsByDisplay.get(display.id) ?? { x: area.x + area.width - NOTES_W - 24, y: area.y + 44 };
    this.window.setBounds({ ...position, width: NOTES_W, height: NOTES_H });
  }

  openDrawer() {
    if (this.window.isDestroyed()) return;
    this.reload();
    this.place();
    this.state.open = true;
    this.state.focused = true;
    this.publish();
    this.window.show();
    this.window.focus();
  }

  hideDrawer() {
    if (this.window.isDestroyed()) return;
    this.state.open = false;
    this.state.focused = false;
    this.window.hide();
    this.publish();
  }

  toggleDrawer(open = !this.state.open) {
    if (open) this.openDrawer();
    else this.hideDrawer();
  }

  appendScratchpad(text: string, sourceApp?: string) {
    if (!text.trim()) return;
    const path = join(this.state.notesDir, SCRATCHPAD);
    const latest = existsSync(path) ? readFileSync(path, 'utf8') : '# 随手记\n';
    const now = new Date(), pad = (value: number) => String(value).padStart(2, '0');
    const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const header = `## 摘录 ${timeStr}${sourceApp ? ` · ${sourceApp}` : ''}`;
    const trimmedLatest = latest.replace(/\s+$/, '');
    const content = `${trimmedLatest}\n\n${header}\n${text.trim()}\n`;
    writeFileAtomic(path, content);
    if (this.state.activeFile === SCRATCHPAD) {
      this.state.content = content;
    }
    this.publish();
    this.deps.toast('已追加到 Scratchpad', 'Note');
  }

  updateSettings(settings: Settings) {
    this.state.fonts = { fonts: settings.fonts, importedFonts: settings.importedFonts };
    this.state.shortcut = settings.actionShortcuts?.['toggle-notes'] ?? '';
    this.publish();
  }

  destroy() {
    if (!this.window.isDestroyed()) this.window.destroy();
  }

  private noteFile(name: string): string | undefined {
    return this.state.files.find(file => file === name || file.replace(/\.md$/i, '') === name);
  }

  private reload() {
    this.state.files = readdirSync(this.state.notesDir)
      .filter(name => name.endsWith('.md') && statSync(join(this.state.notesDir, name)).isFile())
      .sort((a, b) => (a === SCRATCHPAD ? -1 : b === SCRATCHPAD ? 1 : a.localeCompare(b)));
    if (!this.state.files.includes(this.state.activeFile)) this.state.activeFile = SCRATCHPAD;
    this.state.content = readFileSync(join(this.state.notesDir, this.state.activeFile), 'utf8');
  }

  private snapshot(): EdgeNotesState {
    const notes = this.state.files.map(fileName => {
      const path = join(this.state.notesDir, fileName);
      const stat = statSync(path);
      const content = readFileSync(path, 'utf8');
      return { fileName, content, updatedAt: stat.mtimeMs };
    });
    return { ...this.state, files: [...this.state.files], notes };
  }

  private publish() {
    if (!this.window.isDestroyed()) this.window.webContents.send('notes:changed', this.snapshot());
  }
}
