import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, safeStorage, screen } from 'electron';
import type { IpcMainInvokeEvent, NativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import type { Preset } from '../shared/contracts';
import { defaultImageOptions } from '../shared/media';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { MediaService } from './media-service';
import type { MediaFontSettings, MediaGenerateRequest, MediaOutputAction, MediaState, MediaDraft } from '../shared/media';
import { fitToWorkArea } from './position';

/** Owns the local media surface; jobs live in the service even when this window is hidden. */
export class MediaWindow {
  readonly service: MediaService;
  private win: BrowserWindow | null = null;
  private quitting = false;
  private beforeQuit = () => { this.quitting = true; };
  private outputting = false;
  private channels: string[] = [];
  private draft: MediaDraft | null = null;
  private preparing = false;
  constructor(directory: string, private edit: (image: NativeImage) => Promise<void>, private pin: (image: NativeImage) => Promise<void>, private fontSettings: () => Readonly<MediaFontSettings>, private choosePreset: () => Promise<void>) {
    app.on('before-quit', this.beforeQuit);
    this.service = new MediaService(directory, {
      secrets: { available: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) },
      normalizeImage: bytes => {
        const image = nativeImage.createFromBuffer(bytes), size = image.getSize();
        if (image.isEmpty() || size.width < 1 || size.height < 1 || size.width * size.height > 40_000_000) throw Error('返回内容不是有效图片，或图片尺寸过大');
        return { png: image.toPNG(), ...size, thumbnail: image.resize({ width: Math.min(640, size.width) }).toDataURL() };
      },
      changed: state => this.publish(state)
    });
    const handle = (name: string, fn: (...args: any[]) => unknown) => {
      this.channels.push(name);
      ipcMain.handle(name, (event, ...args) => { this.assertLocal(event); return fn(...args); });
    };
    handle('media:state', () => this.snapshot());
    handle('media:set-reference', (id: string | null) => this.snapshot(this.service.selectReference(id)));
    handle('media:generate', (request: MediaGenerateRequest) => this.generate(request));
    handle('media:choose-preset', async () => { this.win?.hide(); await this.choosePreset(); });
    handle('media:restore', (id: string, edit: boolean, imageId?: string) => this.restore(id, edit, imageId));
    handle('media:remove', (id: string) => this.snapshot(this.service.remove(id)));
    handle('media:hide', () => { this.win?.hide(); });
    handle('media:output', (id: string, action: MediaOutputAction, imageId?: string) => this.output(id, action, imageId));
  }
  private assertLocal(event: IpcMainInvokeEvent) {
    if (!this.win || event.sender !== this.win.webContents || event.senderFrame !== this.win.webContents.mainFrame) throw Error('生图操作只允许生图窗口调用');
  }
  private snapshot(state = this.service.snapshot()): MediaState {
    const { fonts, importedFonts } = this.fontSettings();
    return { ...state, draft: structuredClone(this.draft), ...structuredClone({ fonts, importedFonts }) };
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
  async prepare(preset: Preset, prompt: string, reference?: NativeImage) {
    if (preset.kind !== 'image' || preset.target !== 'api' || !preset.image) throw Error('请选择 New API 生图预设');
    if (this.preparing || this.service.snapshot().jobs.some(job => job.status === 'running')) throw Error('已有图片正在生成，请等待完成');
    this.preparing = true;
    try {
    this.draft = { id: randomUUID(), presetId: preset.id, presetName: preset.name, prompt, options: structuredClone(preset.image) };
    if (reference) this.service.addReference(reference.toPNG()); else this.service.selectReference(null);
    await this.show();
    if (preset.mode === 'send') this.generate({ requestId: this.draft.id, draftId: this.draft.id, prompt });
    } finally { this.preparing = false; }
  }
  private generate(request: MediaGenerateRequest): MediaState {
    if (!this.draft || request?.draftId !== this.draft.id) throw Error('生图草稿已更新，请使用当前草稿');
    const reference = this.service.snapshot().reference;
    const next = this.service.generate({ ...this.draft.options, requestId: request.requestId, prompt: request.prompt,
      presetId: this.draft.presetId, presetName: this.draft.presetName, ...(reference ? { referenceId: reference.id } : {}) });
    this.draft.prompt = request.prompt;
    return this.snapshot(next);
  }
  private restore(id: string, edit: boolean, imageId?: string): MediaState {
    const job = this.service.snapshot().jobs.find(item => item.id === id);
    if (!job || job.destination && job.destination !== 'api') throw Error('只能恢复 API 生图任务');
    if (this.service.snapshot().jobs.some(item => item.status === 'running')) throw Error('请等待当前生成完成');
    const image = imageId ? job.images?.find(image => image.id === imageId) : job.images?.[0];
    if (edit && !image) throw Error('请选择已生成的图片');
    const options = { ...defaultImageOptions(), aspect: job.aspect, resolution: job.resolution, count: job.count, customSize: job.customSize, quality: job.quality || 'auto', background: job.background || 'auto', outputFormat: job.outputFormat || 'png', generationModel: job.generationModel || '', editModel: job.editModel || '' };
    this.draft = { id: randomUUID(), presetId: job.presetId || 'historical-image', presetName: job.presetName || '图片生成', prompt: edit ? '' : job.renderedPrompt || job.prompt, options };
    this.service.selectReference(edit ? image!.id : job.referenceId || null);
    return this.snapshot();
  }
  private async output(id: string, action: MediaOutputAction, imageId?: string) {
    if (this.outputting) return { error: '正在输出图片' };
    this.outputting = true;
    try {
      if (!['copy', 'save', 'pin', 'edit'].includes(action)) throw Error('不支持的图片操作');
      const png = this.service.getImage(id, imageId), image = nativeImage.createFromBuffer(png);
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
