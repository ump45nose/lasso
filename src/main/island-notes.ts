import { app, ipcMain, screen } from 'electron';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EdgeNoteItem, EdgeNotesState, IslandState } from '../shared/contracts';
import { createIslandWindow } from './island-window';

const NOTES_W = 376, NOTES_H = 548;

function resolveNotesFolder(): string {
  const folder = process.env.LASSO_DATA_ROOT
    ? join(app.getPath('userData'), 'notes')
    : join(homedir(), 'Documents/LassoNotes');
  mkdirSync(folder, { recursive: true });
  const scratchPath = join(folder, 'Scratchpad.md');
  if (!existsSync(scratchPath)) {
    writeFileSync(
      scratchPath,
      '# Scratchpad 随手记\n\n- 划词选择任意英文后点「翻译」即可走 New API 流式直出，按 `↵` 直接回填替换\n- 右侧贴边悬停即可拉出本抽屉，点击右下角「撕下为贴图」可将当前笔记钉在桌面\n- `⌃⌥N` 展开 / 收起本抽屉，`⌃⌥F` 唤起 Finder 超级动作面板\n- `⌃⌥←` / `⌃⌥→` 左右半屏吸附，`⌃⌥↵` 一键 2/3 编辑器 + 1/3 AI 双栏工作区\n',
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

export interface EdgeNotesDeps {
  check: (event: IpcMainEvent | IpcMainInvokeEvent) => void;
  toast: (text: string, badge?: string) => void;
  onPinImage: (image: NativeImage) => Promise<void>;
}

export class EdgeNotes {
  readonly window: BrowserWindow;
  private folder: string;
  private open = false;
  private notes: EdgeNoteItem[] = [];
  private activeId = 'Scratchpad';

  constructor(private fonts: IslandState['fonts'], private deps: EdgeNotesDeps) {
    this.folder = resolveNotesFolder();
    this.notes = loadNotesFromDisk(this.folder);
    if (this.notes[0]) this.activeId = this.notes[0].id;

    this.window = createIslandWindow(NOTES_W, NOTES_H, { focusable: true });
    this.window.setIgnoreMouseEvents(true, { forward: true });
    this.window.setAlwaysOnTop(true, 'floating');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    const { check } = deps;
    ipcMain.handle('notes:state', event => {
      check(event);
      return this.snapshot();
    });
    ipcMain.on('notes:open', (event, open: boolean) => {
      check(event);
      this.toggleDrawer(Boolean(open));
    });
    ipcMain.on('notes:hit', (event, inside: boolean) => {
      check(event);
      this.window.setIgnoreMouseEvents(!inside, { forward: true });
      if (inside && this.open) this.window.focus();
    });
    ipcMain.handle('notes:select', (event, id: string) => {
      check(event);
      if (this.notes.some(n => n.id === id)) {
        this.activeId = id;
        this.publish();
      }
    });
    ipcMain.handle('notes:save', (event, id: string, content: string) => {
      check(event);
      if (typeof content !== 'string') throw new Error('便签内容无效');
      const note = this.notes.find(n => n.id === id);
      if (!note) return;
      const full = join(this.folder, note.fileName);
      writeFileSync(full, content, 'utf8');
      const firstHeading = content.split('\n').find(line => line.trim().startsWith('#'))?.replace(/^#+\s*/, '').trim();
      const now = new Date();
      note.content = content;
      note.title = firstHeading || note.id;
      note.updatedAt = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      this.publish();
    });
    ipcMain.handle('notes:create', (event, title?: string) => {
      check(event);
      const stamp = new Date().toISOString().slice(5, 16).replace(/[:T]/g, '-');
      const id = title?.trim().replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '-') || `Note-${stamp}`;
      const fileName = `${id}.md`;
      const full = join(this.folder, fileName);
      writeFileSync(full, `# ${title || id}\n\n`, { encoding: 'utf8', flag: 'wx' });
      this.notes = loadNotesFromDisk(this.folder);
      this.activeId = id;
      this.publish();
    });
    ipcMain.handle('notes:pin', async (event, id: string) => {
      check(event);
      const note = this.notes.find(n => n.id === id);
      if (!note) return;
      const image = await this.window.webContents.capturePage({ x: 8, y: 14, width: NOTES_W - 18, height: NOTES_H - 28 });
      if (!image.isEmpty()) {
        await this.deps.onPinImage(image);
        this.deps.toast(`已将「${note.title}」钉为桌面贴图`, 'Pin');
      }
    });

    this.window.once('ready-to-show', () => {
      this.place();
      if (!process.env.LASSO_DATA_ROOT) this.window.showInactive();
      this.publish();
    });
    void this.window.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'edge-notes' } });
  }

  place() {
    if (this.window.isDestroyed()) return;
    const area = screen.getPrimaryDisplay().workArea;
    const x = area.x + area.width - NOTES_W;
    const y = Math.round(area.y + (area.height - NOTES_H) / 2);
    this.window.setBounds({ x, y, width: NOTES_W, height: NOTES_H });
  }

  toggleDrawer(open = !this.open) {
    this.open = open;
    if (open) {
      this.notes = loadNotesFromDisk(this.folder);
      this.window.setIgnoreMouseEvents(false);
    } else {
      this.window.setIgnoreMouseEvents(true, { forward: true });
    }
    this.publish();
  }

  updateFonts(fonts: IslandState['fonts']) {
    this.fonts = fonts;
    this.publish();
  }

  destroy() {
    if (!this.window.isDestroyed()) this.window.destroy();
  }

  private snapshot(): EdgeNotesState {
    return {
      open: this.open,
      folder: this.folder,
      activeId: this.activeId,
      notes: this.notes,
      fonts: this.fonts
    };
  }

  private publish() {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send('notes:changed', this.snapshot());
    }
  }
}
