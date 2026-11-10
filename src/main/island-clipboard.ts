import { app, clipboard, ClipboardItem, ipcMain, nativeImage, screen } from 'electron';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ClipboardEntry, ClipboardWindowState, IslandAPI } from '../shared/contracts';
import { applicationIcon } from './app-icons';
import { writeFileAtomic } from './files';
import { createIslandWindow } from './island-window';
import { nativeAx, type NativeAx } from './native-ax';

const SENSITIVE_APPS = /^(?:com\.agilebits\.onepassword(?:[0-9]|\.|$)|com\.1password(?:\.|$)|com\.bitwarden(?:\.|$)|com\.apple\.Passwords$|org\.keepassxc\.keepassxc$|com\.lastpass(?:\.|$)|com\.keepassx(?:\.|$)|local\.mac-ai-prompt$|com\.lasso(?:\.|$))/i;

/** Both copy translation and history must apply this before reading clipboard payloads. */
export function isSensitiveCopy(bundleId: string, concealed: boolean): boolean { return concealed || SENSITIVE_APPS.test(bundleId); }

export interface ClipboardCopyEvent { entry: ClipboardEntry; pid: number; changeCount: number; timestamp: number }
export interface ClipboardHistoryPanelDeps {
  check: (event: IpcMainEvent | IpcMainInvokeEvent) => void;
  pinImage: (image: NativeImage, title?: string) => Promise<void>;
  pinText: (text: string, title?: string) => Promise<void>;
  noteText: (text: string) => void | Promise<void>;
  onCopy?: (event: ClipboardCopyEvent) => void;
  ax?: Partial<NativeAx>;
}

export class ClipboardHistoryPanel {
  readonly window: BrowserWindow;
  private readonly ax: Partial<NativeAx>;
  private readonly directory = join(app.getPath('userData'), 'clipboard-history');
  private readonly statePath = join(this.directory, 'entries.json');
  private state: ClipboardWindowState;
  private changeCount = -1;
  private targetPid = 0;
  private polling = false;
  private writing = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(fonts: ClipboardWindowState['fonts'], private readonly deps: ClipboardHistoryPanelDeps) {
    this.ax = deps.ax ?? (process.env.LASSO_DATA_ROOT ? {} : nativeAx());
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.state = { entries: this.loadEntries(), pinnedOnTop: false, fonts };
    this.window = createIslandWindow(420, 500, { focusable: true });
    this.window.setAlwaysOnTop(false);
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.on('close', event => { event.preventDefault(); this.close(); });
    this.window.on('blur', () => { if (!this.state.pinnedOnTop) this.close(); });
    this.window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.key === 'Escape' || input.meta && input.key.toLowerCase() === 'w')) { event.preventDefault(); this.close(); }
    });
    const { check } = deps;
    ipcMain.handle('clipboard-history:state', event => { check(event); return this.snapshot(); });
    ipcMain.handle('clipboard-history:act', (event, req: Parameters<IslandAPI['clipboardAct']>[0]) => { check(event); return this.act(req); });
    ipcMain.on('clipboard-history:close', event => { check(event); this.close(); });
    void this.window.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'clipboard' } });
    if (this.ax.pasteboardMeta) {
      this.changeCount = this.ax.pasteboardMeta().changeCount;
      this.timer = setInterval(() => { void this.poll().catch(error => console.error('剪贴板历史采集失败', error)); }, 200);
      this.timer.unref();
    }
  }

  snapshot(): ClipboardWindowState { return structuredClone(this.state); }

  open(sourcePid?: number) {
    if (this.window.isDestroyed()) return;
    if (!this.window.isVisible() || sourcePid !== undefined) {
      const pid = sourcePid ?? this.ax.frontmostApp?.().pid ?? 0;
      this.targetPid = Number.isInteger(pid) && pid > 0 && pid !== process.pid ? pid : 0;
    }
    const cursor = screen.getCursorScreenPoint(), area = screen.getDisplayNearestPoint(cursor).workArea;
    this.window.setPosition(Math.round(Math.max(area.x, Math.min(cursor.x - 210, area.x + area.width - 420))), Math.round(Math.max(area.y, Math.min(cursor.y + 12, area.y + area.height - 500))));
    this.window.show();
    this.window.focus();
    this.publish();
  }

  close() { if (!this.window.isDestroyed()) this.window.hide(); }

  /** Use for all Lasso writes so history and copy translation ignore the same changeCount. */
  ignoreCurrentCopy() { this.changeCount = this.ax.pasteboardMeta?.().changeCount ?? this.changeCount; }

  async writeText(text: string) {
    ++this.writing;
    try { await clipboard.writeText(text); }
    finally { this.ignoreCurrentCopy(); --this.writing; }
  }

  async poll(): Promise<ClipboardEntry | null> {
    if (this.polling || this.writing) return null;
    const meta = this.ax.pasteboardMeta?.();
    if (!meta || meta.changeCount === this.changeCount) return null;
    this.changeCount = meta.changeCount;
    const source = this.ax.frontmostApp?.();
    if (!source || source.pid === process.pid || isSensitiveCopy(source.bundleId, meta.concealed)) return null;
    this.polling = true;
    try {
      const timestamp = Date.now(), id = randomUUID();
      const common = { id, text: '', preview: '', charCount: 0, lineCount: 0, sourceBundleId: source.bundleId,
        sourceAppName: source.name, sourceAppIcon: applicationIcon(source.bundleId), createdAt: timestamp, favorite: false };
      const items = await clipboard.read();
      if (!this.copyStillCurrent(meta.changeCount)) return null;
      const files = await this.readFiles(items);
      if (!this.copyStillCurrent(meta.changeCount)) return null;
      let entry: ClipboardEntry;
      if (files.length) {
        const text = files.join('\n');
        entry = { ...common, kind: 'files', files, text, preview: files.map(file => basename(file)).join('、'), charCount: text.length, lineCount: files.length };
      } else if (items.some(item => item.types.some(type => type.startsWith('image/')))) {
        const type = items.some(item => item.types.includes('image/png')) ? 'image/png' : items.flatMap(item => item.types).find(type => type.startsWith('image/'))!;
        const image = nativeImage.createFromBuffer(await this.readData(items, type));
        if (image.isEmpty()) return null;
        const size = image.getSize(), imagePath = join(this.directory, `${id}.png`);
        entry = { ...common, kind: 'image', preview: `图片 ${size.width} × ${size.height}`, imagePath,
          imageWidth: size.width, imageHeight: size.height, imageThumbnail: image.resize({ width: Math.min(160, size.width) }).toDataURL() };
        if (!this.copyStillCurrent(meta.changeCount)) return null;
        writeFileSync(imagePath, image.toPNG(), { mode: 0o600 });
      } else {
        const text = (await this.readData(items, 'text/plain')).toString('utf8');
        if (!text.trim()) return null;
        entry = { ...common, kind: 'text', text, preview: text.replace(/\s+/g, ' ').slice(0, 240), charCount: Array.from(text).length, lineCount: text.split(/\r\n|\r|\n/).length };
      }
      if (!this.copyStillCurrent(meta.changeCount)) return null;
      this.state.entries.unshift(entry);
      const removed = this.state.entries.splice(200);
      this.persist();
      this.removeImages(removed);
      this.publish();
      this.deps.onCopy?.({ entry: structuredClone(entry), pid: source.pid, changeCount: meta.changeCount, timestamp });
      return entry;
    } finally { this.polling = false; }
  }

  async act(req: Parameters<IslandAPI['clipboardAct']>[0]): Promise<{ error: string | null }> {
    try {
      if (!req || typeof req.action !== 'string') throw Error('剪贴板操作无效');
      if (req.action === 'clear-all') {
        const removed = this.state.entries;
        this.state.entries = [];
        this.persist();
        this.removeImages(removed);
        this.publish();
        return { error: null };
      }
      const entry = this.state.entries.find(item => item.id === req.id);
      if (!entry) throw Error('剪贴板条目不存在');
      if (req.action === 'copy' || req.action === 'paste') {
        if (req.action === 'paste' && !this.targetPid) throw Error('没有可回贴的原应用');
        await this.writeEntry(entry);
        if (req.action === 'paste') {
          this.close();
          if (!this.ax.pasteToProcess?.(this.targetPid)) throw Error('未能回贴到原应用，请检查辅助功能权限');
        }
      } else if (req.action === 'toggle-fav') {
        entry.favorite = !entry.favorite;
        this.persist();
        this.publish();
      } else if (req.action === 'delete') {
        this.state.entries = this.state.entries.filter(item => item.id !== entry.id);
        this.persist();
        this.removeImages([entry]);
        this.publish();
      } else if (req.action === 'pin') {
        if (entry.kind === 'image' && entry.imagePath) await this.deps.pinImage(nativeImage.createFromPath(entry.imagePath), entry.preview);
        else await this.deps.pinText(entry.text, entry.sourceAppName);
      } else if (req.action === 'note') {
        const content = entry.kind === 'image' && entry.imagePath
          ? `![${entry.preview}](data:image/png;base64,${readFileSync(entry.imagePath).toString('base64')})`
          : entry.text;
        await this.deps.noteText(content);
      } else throw Error('不支持的剪贴板操作');
      return { error: null };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }

  updateFonts(fonts: ClipboardWindowState['fonts']) { this.state.fonts = fonts; this.publish(); }

  destroy() {
    if (this.timer) clearInterval(this.timer);
    ipcMain.removeHandler('clipboard-history:state');
    ipcMain.removeHandler('clipboard-history:act');
    ipcMain.removeAllListeners('clipboard-history:close');
    if (!this.window.isDestroyed()) this.window.destroy();
  }

  private async readFiles(items: ClipboardItem[]): Promise<string[]> {
    const formats = items.flatMap(item => item.types);
    const filenamesType = formats.find(type => type === 'NSFilenamesPboardType' || type === 'electron application/osclipboard;format="NSFilenamesPboardType"');
    if (filenamesType) {
      const payload = await this.readData(items, filenamesType);
      if (payload.length) {
        const files: unknown = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: payload, encoding: 'utf8', timeout: 1000, maxBuffer: 8 * 1024 * 1024 }));
        return Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string' && file.startsWith('/')) : [];
      }
    }
    const format = ['text/uri-list', 'electron application/osclipboard;format="public.file-url"', 'public.file-url'].find(type => formats.includes(type));
    if (!format) return [];
    return (await this.readData(items, format)).toString('utf8').split(/[\r\n\0]+/).filter(line => line.startsWith('file://')).map(line => fileURLToPath(line));
  }

  private async readData(items: ClipboardItem[], type: string): Promise<Buffer> {
    const item = items.find(item => item.types.includes(type));
    if (!item) return Buffer.alloc(0);
    const value = await item.getType(type);
    return 'arrayBuffer' in value ? Buffer.from(await value.arrayBuffer()) : Buffer.alloc(0);
  }

  private copyStillCurrent(changeCount: number): boolean {
    const current = this.ax.pasteboardMeta?.();
    return !this.window.isDestroyed() && !this.writing && this.changeCount === changeCount && current?.changeCount === changeCount && !current.concealed;
  }

  private async writeEntry(entry: ClipboardEntry) {
    ++this.writing;
    try {
      if (entry.kind === 'image' && entry.imagePath) {
        const image = nativeImage.createFromPath(entry.imagePath);
        if (image.isEmpty()) throw Error('历史图片已不存在');
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })]);
      } else if (entry.kind === 'files' && entry.files?.length) {
        await clipboard.write([new ClipboardItem({ 'text/uri-list': entry.files.map(file => pathToFileURL(file).href).join('\r\n') })]);
      } else await clipboard.writeText(entry.text);
    } finally { this.ignoreCurrentCopy(); --this.writing; }
  }

  private loadEntries(): ClipboardEntry[] {
    if (!existsSync(this.statePath)) return [];
    const entries: unknown = JSON.parse(readFileSync(this.statePath, 'utf8'));
    if (!Array.isArray(entries)) throw Error('剪贴板历史文件格式无效');
    return entries.filter((entry): entry is ClipboardEntry => entry && /^[a-f0-9-]{36}$/.test(entry.id) && ['text', 'image', 'files'].includes(entry.kind) && typeof entry.text === 'string')
      .slice(0, 200).filter(entry => entry.kind !== 'image' || entry.imagePath === join(this.directory, `${entry.id}.png`) && existsSync(entry.imagePath));
  }

  private removeImages(entries: ClipboardEntry[]) {
    for (const entry of entries) if (entry.kind === 'image' && entry.imagePath === join(this.directory, `${entry.id}.png`) && existsSync(entry.imagePath)) unlinkSync(entry.imagePath);
  }

  private persist() { writeFileAtomic(this.statePath, JSON.stringify(this.state.entries)); }
  private publish() { if (!this.window.isDestroyed()) this.window.webContents.send('clipboard-history:changed', this.snapshot()); }
}
