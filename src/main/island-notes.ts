import { app, ipcMain, screen } from 'electron';
import type { BrowserWindow, Display, IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EdgeNotesState, IslandState } from '../shared/contracts';
import { writeFileAtomic } from './files';
import { createIslandWindow } from './island-window';

const NOTES_W = 420, NOTES_H = 488;
const SCRATCHPAD = 'Scratchpad.md';

function resolveNotesFolder(): string {
  const folder = process.env.LASSO_DATA_ROOT
    ? join(app.getPath('userData'), 'notes')
    : join(homedir(), 'Documents/LassoNotes');
  mkdirSync(folder, { recursive: true });
  const scratchPath = join(folder, SCRATCHPAD);
  if (!existsSync(scratchPath)) writeFileSync(scratchPath, '# Scratchpad 随手记\n\n', 'utf8');
  return folder;
}

export interface EdgeNotesDeps {
  check: (event: IpcMainEvent | IpcMainInvokeEvent) => void;
  toast: (text: string, badge?: string) => void;
  onPinImage: (image: NativeImage) => Promise<void>;
}

export class EdgeNotes {
  readonly window: BrowserWindow;
  private state: Omit<EdgeNotesState, 'notes'>;
  private boundsByDisplay = new Map<number, { x: number; y: number }>();

  constructor(fonts: IslandState['fonts'], private deps: EdgeNotesDeps) {
    const notesDir = resolveNotesFolder();
    this.state = { open: false, pinnedOnTop: true, activeFile: SCRATCHPAD, content: '', files: [], notesDir, fonts };
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
    this.window.on('moved', () => {
      const bounds = this.window.getBounds();
      const display = screen.getDisplayMatching(bounds);
      this.boundsByDisplay.set(display.id, { x: bounds.x, y: bounds.y });
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
      const id = title?.trim().replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '-') || `Note-${stamp}`;
      let file = `${id}.md`;
      if (!title?.trim()) for (let suffix = 2; existsSync(join(this.state.notesDir, file)); suffix++) file = `${id}-${suffix}.md`;
      writeFileSync(join(this.state.notesDir, file), `# ${title || file.slice(0, -3)}\n\n`, { encoding: 'utf8', flag: 'wx' });
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
      this.state.activeFile = SCRATCHPAD;
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
      const image = await this.window.webContents.capturePage({ x: 8, y: 14, width: NOTES_W - 18, height: NOTES_H - 28 });
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
    const position = this.boundsByDisplay.get(display.id) ?? { x: area.x + area.width - NOTES_W - 32, y: area.y + 56 };
    this.window.setBounds({ ...position, width: NOTES_W, height: NOTES_H });
  }

  openDrawer() {
    if (this.window.isDestroyed()) return;
    this.reload();
    this.place();
    this.state.open = true;
    this.publish();
    this.window.show();
    this.window.focus();
  }

  hideDrawer() {
    if (this.window.isDestroyed()) return;
    this.state.open = false;
    this.window.hide();
    this.publish();
  }

  toggleDrawer(open = !this.state.open) {
    if (open) this.openDrawer();
    else this.hideDrawer();
  }

  appendScratchpad(text: string) {
    if (!text.trim()) return;
    const path = join(this.state.notesDir, SCRATCHPAD);
    const latest = readFileSync(path, 'utf8');
    const now = new Date(), pad = (value: number) => String(value).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const addition = `\n\n> ${stamp}\n${text.trim()}\n`;
    const content = latest + addition;
    writeFileAtomic(path, content);
    if (this.state.activeFile === SCRATCHPAD) {
      this.state.content = content;
      this.publish();
    }
    this.deps.toast('已追加到 Scratchpad', 'Note');
  }

  updateFonts(fonts: IslandState['fonts']) {
    this.state.fonts = fonts;
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
      .sort((a, b) => a === SCRATCHPAD ? -1 : b === SCRATCHPAD ? 1 : a.localeCompare(b));
    if (!this.state.files.includes(this.state.activeFile)) this.state.activeFile = SCRATCHPAD;
    this.state.content = readFileSync(join(this.state.notesDir, this.state.activeFile), 'utf8');
  }

  private snapshot(): EdgeNotesState {
    const notes = this.state.files.map(fileName => {
      const path = join(this.state.notesDir, fileName);
      const content = readFileSync(path, 'utf8');
      return { fileName, content };
    });
    return { ...this.state, files: [...this.state.files], notes };
  }

  private publish() {
    if (!this.window.isDestroyed()) this.window.webContents.send('notes:changed', this.snapshot());
  }
}
