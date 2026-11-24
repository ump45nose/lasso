import { app, clipboard, ClipboardItem, ipcMain, nativeImage, protocol, screen, shell } from 'electron';
import type { BrowserWindow, Display, IpcMainEvent, IpcMainInvokeEvent, NativeImage, Point, Rectangle } from 'electron';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appearanceOf, type EdgeNotesState, type IslandState, type NotesResizeEdge, type Settings } from '../shared/contracts';
import { writeFileAtomic } from './files';
import { createIslandWindow } from './island-window';
import { fitToWorkArea } from './position';

const NOTES_W = 448, NOTES_H = 528;
const NOTES_MIN_W = 360, NOTES_MIN_H = 320;
const RESIZE_EDGES = new Set<NotesResizeEdge>(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
const SCRATCHPAD = 'Scratchpad.md';
const ASSETS_DIR = 'assets';
const MAX_NOTE_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_NOTE_IMAGE_PIXELS = 40_000_000;

export const NOTE_ASSET_SCHEME = 'lasso-note';

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

export function registerNoteAssetScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: NOTE_ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
  ]);
}

/** Serves only image files directly inside the note assets directory. */
export function serveNoteAssets(notesDir: string) {
  const assetsDir = join(notesDir, ASSETS_DIR);
  protocol.handle(NOTE_ASSET_SCHEME, async request => {
    const url = new URL(request.url);
    if (url.hostname !== ASSETS_DIR) return new Response(null, { status: 404 });
    const name = decodeURIComponent(url.pathname.slice(1));
    const type = IMAGE_MIME_BY_EXT[extname(name).toLowerCase()];
    if (!type || !name || basename(name) !== name) return new Response(null, { status: 404 });
    try {
      return new Response(await readFile(join(assetsDir, name)), {
        headers: {
          'content-type': type,
          'cache-control': 'public, max-age=31536000, immutable'
        }
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}

export function resolveNotesFolder(): string {
  const folder = process.env.LASSO_DATA_ROOT
    ? join(app.getPath('userData'), 'notes')
    : join(homedir(), 'Documents/LassoNotes');
  mkdirSync(folder, { recursive: true });
  const scratchPath = join(folder, SCRATCHPAD);
  if (!existsSync(scratchPath)) writeFileSync(scratchPath, '# 随手记\n\n', 'utf8');
  return folder;
}

function detectImageExtension(bytes: Buffer): '.png' | '.jpg' | '.gif' | '.webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a')) return '.gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
  return null;
}

function formatImageStamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function saveImageBufferToAssets(notesDir: string, input: Buffer | Uint8Array): { relativePath: string; filePath: string } {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (raw.byteLength === 0 || raw.byteLength > MAX_NOTE_IMAGE_BYTES) {
    throw new Error('图片内容为空或超过 32 MB 限制');
  }

  let ext = detectImageExtension(raw);
  let output = raw;
  if (ext === '.png' || ext === '.jpg') {
    const decoded = nativeImage.createFromBuffer(raw);
    const size = decoded.getSize();
    if (decoded.isEmpty() || size.width < 1 || size.height < 1 || size.width * size.height > MAX_NOTE_IMAGE_PIXELS) {
      throw new Error('图片内容无效或尺寸过大');
    }
  } else if (!ext) {
    const decoded = nativeImage.createFromBuffer(raw);
    const size = decoded.getSize();
    if (decoded.isEmpty() || size.width < 1 || size.height < 1 || size.width * size.height > MAX_NOTE_IMAGE_PIXELS) {
      throw new Error('不支持的图片格式或图片内容无效');
    }
    output = decoded.toPNG();
    ext = '.png';
  }

  const assetsDir = join(notesDir, ASSETS_DIR);
  mkdirSync(assetsDir, { recursive: true });
  const stamp = formatImageStamp();
  let fileName = '';
  let filePath = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    fileName = `img-${stamp}-${randomBytes(3).toString('hex')}${ext}`;
    filePath = join(assetsDir, fileName);
    try {
      writeFileSync(filePath, output, { flag: 'wx' });
      return { relativePath: `${ASSETS_DIR}/${fileName}`, filePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new Error('保存便签图片失败');
}

async function readClipboardData(items: ClipboardItem[], type: string): Promise<Buffer> {
  const item = items.find(entry => entry.types.includes(type));
  if (!item) return Buffer.alloc(0);
  const value = await item.getType(type);
  return 'arrayBuffer' in value ? Buffer.from(await value.arrayBuffer()) : Buffer.alloc(0);
}

async function readClipboardFiles(items: ClipboardItem[]): Promise<string[]> {
  const formats = items.flatMap(item => item.types);
  const filenamesType = formats.find(type => type === 'NSFilenamesPboardType' || type === 'electron application/osclipboard;format="NSFilenamesPboardType"');
  if (filenamesType) {
    const payload = await readClipboardData(items, filenamesType);
    if (payload.length) {
      try {
        const files: unknown = JSON.parse(
          execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], {
            input: payload,
            encoding: 'utf8',
            timeout: 1000,
            maxBuffer: 8 * 1024 * 1024
          })
        );
        return Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string' && file.startsWith('/')) : [];
      } catch {
        return [];
      }
    }
  }
  const format = ['text/uri-list', 'electron application/osclipboard;format="public.file-url"', 'public.file-url'].find(type => formats.includes(type));
  if (!format) return [];
  return (await readClipboardData(items, format))
    .toString('utf8')
    .split(/[\r\n\0]+/)
    .filter(line => line.startsWith('file://'))
    .map(line => fileURLToPath(line));
}

async function readClipboardImagePayload(): Promise<Buffer | null> {
  const items = await clipboard.read();
  const files = await readClipboardFiles(items);
  if (files.length > 0) {
    const imageFile = files.find(file => Boolean(IMAGE_MIME_BY_EXT[extname(file).toLowerCase()]) && existsSync(file) && statSync(file).isFile());
    if (!imageFile) return null;
    const info = statSync(imageFile);
    if (info.size === 0 || info.size > MAX_NOTE_IMAGE_BYTES) throw new Error('图片文件为空或超过 32 MB 限制');
    return readFileSync(imageFile);
  }

  const preferredTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const matchedType = preferredTypes.find(type => items.some(item => item.types.includes(type)))
    ?? items.flatMap(item => item.types).find(type => type.startsWith('image/'));
  if (matchedType) {
    const data = await readClipboardData(items, matchedType);
    if (data.length > 0) return data;
  }

  return null;
}

function resolveNoteImageSource(notesDir: string, src: string): { kind: 'file'; filePath: string } | { kind: 'data'; bytes: Buffer; ext: string } {
  const trimmed = src.trim();
  const dataMatch = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(trimmed);
  if (dataMatch) {
    const ext = dataMatch[1].toLowerCase() === 'jpeg' ? '.jpg' : `.${dataMatch[1].toLowerCase()}`;
    return { kind: 'data', bytes: Buffer.from(dataMatch[2], 'base64'), ext };
  }
  const normalized = trimmed.replace(/^\.\//, '');
  if (!normalized.startsWith(`${ASSETS_DIR}/`)) throw new Error('只支持操作当前便签目录内的图片');
  const fileName = normalized.slice(ASSETS_DIR.length + 1);
  if (!fileName || basename(fileName) !== fileName || !IMAGE_MIME_BY_EXT[extname(fileName).toLowerCase()]) {
    throw new Error('便签图片路径无效');
  }
  const filePath = join(notesDir, ASSETS_DIR, fileName);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) throw new Error('图片文件不存在，可能已被移动或删除');
  return { kind: 'file', filePath };
}

function loadNativeImageFromSource(source: { kind: 'file'; filePath: string } | { kind: 'data'; bytes: Buffer; ext: string }): NativeImage {
  const bytes = source.kind === 'file' ? readFileSync(source.filePath) : source.bytes;
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('当前图片格式暂不支持直接复制或贴图，请用系统预览打开');
  return image;
}

export interface EdgeNotesDeps {
  check: (event: IpcMainEvent | IpcMainInvokeEvent) => void;
  toast: (text: string, badge?: string) => void;
  onPinImage: (image: NativeImage) => Promise<void>;
  writeClipboardImage?: (image: NativeImage) => Promise<void>;
  settings: () => Settings;
}

export class EdgeNotes {
  readonly window: BrowserWindow;
  private state: Omit<EdgeNotesState, 'notes'>;
  private boundsByDisplay = new Map<number, Rectangle>();
  private lastSize = { width: NOTES_W, height: NOTES_H };
  private resizeDrag: { edge: NotesResizeEdge; cursor: Point; bounds: Rectangle; workArea: Rectangle } | null = null;
  private quitting = false;

  constructor(fonts: IslandState['fonts'], private deps: EdgeNotesDeps) {
    app.on('before-quit', () => { this.quitting = true; });
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
    this.window.setResizable(true);
    this.window.setMinimumSize(NOTES_MIN_W, NOTES_MIN_H);
    this.window.setAlwaysOnTop(true, 'floating');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.on('close', event => {
      if (!this.quitting) {
        event.preventDefault();
        this.hideDrawer();
      }
    });
    this.window.on('focus', () => {
      this.state.focused = true;
      this.publish();
    });
    this.window.on('blur', () => {
      this.state.focused = false;
      this.publish();
    });
    const rememberBounds = () => {
      if (this.window.isDestroyed() || !this.state.open) return;
      const bounds = this.window.getBounds();
      const display = screen.getDisplayMatching(bounds);
      this.boundsByDisplay.set(display.id, bounds);
      this.lastSize = { width: bounds.width, height: bounds.height };
    };
    this.window.on('moved', rememberBounds);
    this.window.on('resized', rememberBounds);
    this.window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.meta || input.control || input.alt || input.shift) return;
      const key = input.key.toLowerCase();
      if (key === 'w') {
        event.preventDefault();
        this.hideDrawer();
      } else if (key === 'n') {
        event.preventDefault();
        this.window.webContents.send('notes:new');
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
      this.reload();
      const file = this.noteFile(name);
      if (!file) return;
      this.state.activeFile = file;
      this.reload();
      this.publish();
      return this.snapshot();
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
      const [contentW, contentH] = this.window.getContentSize();
      const image = await this.window.webContents.capturePage({
        x: 14,
        y: 14,
        width: Math.max(1, contentW - 28),
        height: Math.max(1, contentH - 28)
      });
      if (!image.isEmpty()) {
        await this.deps.onPinImage(image);
        this.deps.toast(`已将「${file.replace(/\.md$/i, '')}」钉为桌面贴图`, 'Pin');
      }
    });
    ipcMain.on('notes:resize-start', (event, edge: NotesResizeEdge) => {
      check(event);
      if (this.window.isDestroyed() || !RESIZE_EDGES.has(edge)) return;
      const bounds = this.window.getBounds();
      const workArea = screen.getDisplayMatching(bounds).workArea;
      this.resizeDrag = { edge, cursor: screen.getCursorScreenPoint(), bounds, workArea };
    });
    ipcMain.on('notes:resize-move', event => {
      check(event);
      if (!this.resizeDrag || this.window.isDestroyed()) return;
      const { edge, cursor: startCursor, bounds, workArea } = this.resizeDrag;
      const cursor = screen.getCursorScreenPoint();
      const dx = cursor.x - startCursor.x;
      const dy = cursor.y - startCursor.y;
      const minW = Math.min(NOTES_MIN_W, workArea.width);
      const minH = Math.min(NOTES_MIN_H, workArea.height);
      let x = bounds.x;
      let y = bounds.y;
      let width = bounds.width;
      let height = bounds.height;
      if (edge.includes('e')) {
        const maxW = Math.max(minW, workArea.x + workArea.width - bounds.x);
        width = Math.max(minW, Math.min(bounds.width + dx, maxW));
      } else if (edge.includes('w')) {
        const right = bounds.x + bounds.width;
        const maxW = Math.max(minW, right - workArea.x);
        width = Math.max(minW, Math.min(bounds.width - dx, maxW));
        x = right - width;
      }
      if (edge.includes('s')) {
        const maxH = Math.max(minH, workArea.y + workArea.height - bounds.y);
        height = Math.max(minH, Math.min(bounds.height + dy, maxH));
      } else if (edge.includes('n')) {
        const bottom = bounds.y + bounds.height;
        const maxH = Math.max(minH, bottom - workArea.y);
        height = Math.max(minH, Math.min(bounds.height - dy, maxH));
        y = bottom - height;
      }
      this.window.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }, false);
    });
    ipcMain.on('notes:resize-end', event => {
      check(event);
      if (!this.resizeDrag) return;
      this.resizeDrag = null;
      if (!this.window.isDestroyed()) {
        const bounds = this.window.getBounds();
        const display = screen.getDisplayMatching(bounds);
        this.boundsByDisplay.set(display.id, bounds);
        this.lastSize = { width: bounds.width, height: bounds.height };
      }
    });
    ipcMain.handle('notes:save-image', (event, payload: { bytes: Uint8Array; name?: string; mimeType?: string }) => {
      check(event);
      if (!payload || !(payload.bytes instanceof Uint8Array)) throw new Error('图片数据无效');
      const saved = saveImageBufferToAssets(this.state.notesDir, payload.bytes);
      return { relativePath: saved.relativePath };
    });
    ipcMain.handle('notes:paste-clipboard-image', async event => {
      check(event);
      const bytes = await readClipboardImagePayload();
      if (!bytes) return null;
      const saved = saveImageBufferToAssets(this.state.notesDir, bytes);
      return { relativePath: saved.relativePath };
    });
    ipcMain.handle('notes:copy-image', async (event, src: string) => {
      check(event);
      try {
        const source = resolveNoteImageSource(this.state.notesDir, src);
        const image = loadNativeImageFromSource(source);
        if (this.deps.writeClipboardImage) {
          await this.deps.writeClipboardImage(image);
        } else {
          const png = image.toPNG();
          await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
        }
        this.deps.toast('已复制图片', 'Copy');
        return { error: null };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle('notes:open-image', async (event, src: string, action: 'open' | 'pin') => {
      check(event);
      try {
        const source = resolveNoteImageSource(this.state.notesDir, src);
        if (action === 'pin') {
          const image = loadNativeImageFromSource(source);
          await this.deps.onPinImage(image);
          this.deps.toast('已将图片钉为桌面贴图', 'Pin');
          return { error: null };
        }
        if (action === 'open') {
          let targetPath = '';
          if (source.kind === 'file') {
            targetPath = source.filePath;
          } else {
            const tempPath = join(app.getPath('temp'), `lasso-note-preview-${randomBytes(4).toString('hex')}${source.ext}`);
            writeFileSync(tempPath, source.bytes, { mode: 0o600 });
            targetPath = tempPath;
          }
          const openError = await shell.openPath(targetPath);
          if (openError) throw new Error(openError);
          return { error: null };
        }
        throw new Error('不支持的图片操作');
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    });

    this.window.once('ready-to-show', () => this.publish());
    void this.window.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'edge-notes' } });
  }

  place(display: Display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())) {
    if (this.window.isDestroyed()) return;
    const area = display.workArea;
    const saved = this.boundsByDisplay.get(display.id);
    const width = Math.max(Math.min(NOTES_MIN_W, area.width), Math.min(saved?.width ?? this.lastSize.width, area.width));
    const height = Math.max(Math.min(NOTES_MIN_H, area.height), Math.min(saved?.height ?? this.lastSize.height, area.height));
    const target: Rectangle = saved
      ? { x: saved.x, y: saved.y, width, height }
      : { x: area.x + area.width - width - 24, y: area.y + 44, width, height };
    this.window.setBounds(fitToWorkArea(target, area));
  }

  fitOnScreen() {
    if (this.window.isDestroyed() || !this.state.open) return;
    const bounds = this.window.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const fitted = fitToWorkArea(bounds, display.workArea);
    if (fitted.x !== bounds.x || fitted.y !== bounds.y || fitted.width !== bounds.width || fitted.height !== bounds.height) {
      this.window.setBounds(fitted);
    }
  }

  openDrawer() {
    if (this.window.isDestroyed()) return;
    const wasVisible = this.window.isVisible();
    this.reload();
    if (!wasVisible) this.place();
    this.state.open = true;
    this.state.focused = true;
    this.publish();
    this.window.show();
    this.window.focus();
  }

  hideDrawer() {
    if (this.window.isDestroyed()) return;
    this.resizeDrag = null;
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

  appendScratchpadImage(imagePath: string, alt = '', sourceApp?: string) {
    if (!existsSync(imagePath)) throw new Error('图片文件不存在');
    const saved = saveImageBufferToAssets(this.state.notesDir, readFileSync(imagePath));
    const safeAlt = alt.replace(/[\[\]\r\n]/g, ' ').trim();
    this.appendScratchpad(`![${safeAlt}](${saved.relativePath})`, sourceApp);
  }

  updateSettings(settings: Settings) {
    this.state.fonts = appearanceOf(settings);
    this.state.shortcut = settings.actionShortcuts?.['toggle-notes'] ?? '';
    this.publish();
  }

  destroy() {
    this.quitting = true;
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
