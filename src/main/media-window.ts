import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, safeStorage, screen } from 'electron';
import type { IpcMainInvokeEvent, NativeImage } from 'electron';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { MediaService } from './media-service';
import { readLocalImage } from './capture/local-images';
import type { MediaConfigInput, MediaFontSettings, MediaGenerateRequest, MediaOutputAction, MediaState } from '../shared/media';
import { fitToWorkArea } from './position';

/** Owns the local media surface; jobs live in the service even when this window is hidden. */
export class MediaWindow {
  readonly service: MediaService;
  private win: BrowserWindow | null = null;
  private quitting = false;
  private beforeQuit = () => { this.quitting = true; };
  private outputting = false;
  private channels: string[] = [];
  constructor(directory: string, private edit: (image: NativeImage) => Promise<void>, private pin: (image: NativeImage) => Promise<void>, private fontSettings: () => Readonly<MediaFontSettings>, deliverWeb?: NonNullable<ConstructorParameters<typeof MediaService>[1]['deliverWeb']>) {
    app.on('before-quit', this.beforeQuit);
    this.service = new MediaService(directory, {
      secrets: { available: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) },
      normalizeImage: bytes => {
        const image = nativeImage.createFromBuffer(bytes), size = image.getSize();
        if (image.isEmpty() || size.width < 1 || size.height < 1 || size.width * size.height > 40_000_000) throw Error('返回内容不是有效图片，或图片尺寸过大');
        return { png: image.toPNG(), ...size, thumbnail: image.resize({ width: Math.min(640, size.width) }).toDataURL() };
      },
      changed: state => this.publish(state), deliverWeb
    });
    const handle = (name: string, fn: (...args: any[]) => unknown) => {
      this.channels.push(name);
      ipcMain.handle(name, (event, ...args) => { this.assertLocal(event); return fn(...args); });
    };
    handle('media:state', () => this.snapshot());
    handle('media:configure', (input: MediaConfigInput) => this.snapshot(this.service.configure(input)));
    handle('media:check-connection', () => this.service.checkConnection());
    handle('media:models', () => this.service.models());
    handle('media:open-file', async () => {
      try {
        const result = await dialog.showOpenDialog(this.win!, { title: '选择生图参考图片', properties: ['openFile'], filters: [{ name: 'PNG / JPEG 图片', extensions: ['png', 'jpg', 'jpeg'] }] });
        if (!result.canceled && result.filePaths[0]) await this.receiveFile(result.filePaths[0]);
        return { error: null };
      } catch (error) { return { error: (error as Error).message }; }
    });
    handle('media:set-reference', (id: string | null) => this.snapshot(this.service.selectReference(id)));
    handle('media:generate', (request: MediaGenerateRequest) => this.snapshot(this.service.generate(request)));
    handle('media:remove', (id: string) => this.snapshot(this.service.remove(id)));
    handle('media:hide', () => { this.win?.hide(); });
    handle('media:prepare-reference', async () => {
      try {
        const items = await clipboard.read(), item = items.find(value => value.types.includes('image/png'));
        if (!item) throw Error('剪贴板中没有 PNG 图片，请先复制图片或使用截图编辑器');
        const blob = await item.getType('image/png');
        if (blob.size > 64 * 1024 * 1024) throw Error('参考图过大');
        const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
        await this.edit(image); this.win?.hide();
        return { error: null };
      } catch (error) { return { error: (error as Error).message }; }
    });
    handle('media:output', (id: string, action: MediaOutputAction) => this.output(id, action));
  }
  private assertLocal(event: IpcMainInvokeEvent) {
    if (!this.win || event.sender !== this.win.webContents || event.senderFrame !== this.win.webContents.mainFrame) throw Error('生图操作只允许生图窗口调用');
  }
  private snapshot(state = this.service.snapshot()): MediaState {
    const { fonts, importedFonts } = this.fontSettings();
    return { ...state, ...structuredClone({ fonts, importedFonts }) };
  }
  private publish(state = this.service.snapshot()) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('media:changed', this.snapshot(state));
  }
  async show() {
    if (!this.win || this.win.isDestroyed()) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const width = Math.min(460, area.width), height = Math.min(720, area.height);
      const win = new BrowserWindow({ x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height, minWidth: 340, minHeight: 420,
        frame: false, show: false, backgroundColor: '#FAF9F5', title: 'Lasso 图片生成', fullscreenable: false,
        webPreferences: { preload: join(__dirname, 'media-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
      this.win = win;
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', event => event.preventDefault());
      win.on('close', event => { if (!this.quitting) { event.preventDefault(); win.hide(); } });
      await win.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'quick-image' } });
    }
    const win = this.win;
    this.publish();
    win.setBounds(fitToWorkArea(win.getBounds(), screen.getDisplayMatching(win.getBounds()).workArea));
    win.show(); win.focus();
  }
  /** Receives validated local images or the capture editor's final flattened PNG. */
  async receive(image: NativeImage) {
    this.service.addReference(image.toPNG());
    await this.show();
  }
  async receiveFile(path: string) {
    const { image } = await readLocalImage(path);
    await this.receive(image);
  }
  private async output(id: string, action: MediaOutputAction) {
    if (this.outputting) return { error: '正在输出图片' };
    this.outputting = true;
    try {
      if (!['copy', 'save', 'pin', 'edit'].includes(action)) throw Error('不支持的图片操作');
      const png = this.service.getImage(id), image = nativeImage.createFromBuffer(png);
      if (image.isEmpty()) throw Error('结果图片无法读取');
      if (action === 'copy') await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
      else if (action === 'pin') await this.pin(image);
      else if (action === 'edit') { await this.edit(image); this.win?.hide(); }
      else {
        const result = await dialog.showSaveDialog(this.win!, { defaultPath: 'Lasso-image.png', filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
        if (!result.canceled && result.filePath) await writeFile(result.filePath, png);
      }
      return { error: null };
    } catch (error) { return { error: (error as Error).message }; }
    finally { this.outputting = false; }
  }
  dispose() { this.quitting = true; app.off('before-quit', this.beforeQuit); for (const channel of this.channels) ipcMain.removeHandler(channel); this.win?.destroy(); }
}
