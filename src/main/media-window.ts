import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, safeStorage, screen } from 'electron';
import type { IpcMainInvokeEvent, NativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Preset } from '../shared/contracts';
import {
  defaultImageOptions,
  type MediaDraft,
  type MediaFontSettings,
  type MediaGenerateRequest,
  type MediaOutputAction,
  type MediaPresetItem,
  type MediaState
} from '../shared/media';
import { closeOnCommandW, fromMainFrame, sealLocal } from './ipc';
import { MediaService } from './media-service';
import { fitToWorkArea } from './position';
import { setWindowPresence } from './window-presence';

const MEDIA_W = 560, MEDIA_H = 680;

/** Owns the standalone 560×680 AI image studio; jobs live in MediaService even when hidden. */
export class MediaWindow {
  readonly service: MediaService;
  private win: BrowserWindow | null = null;
  private quitting = false;
  private beforeQuit = () => { this.quitting = true; };
  private outputting = false;
  private channels: string[] = [];
  private draft: MediaDraft | null = null;
  private pinnedOnTop = false;
  private preparing = false;
  private ready: Promise<void> | null = null;
  private closeAfterOutput = false;

  constructor(
    directory: string,
    private edit: (image: NativeImage) => Promise<void>,
    private pin: (image: NativeImage) => Promise<void>,
    private fontSettings: () => Readonly<MediaFontSettings>,
    private imagePresets: () => ReadonlyArray<Preset>
  ) {
    app.on('before-quit', this.beforeQuit);
    this.service = new MediaService(directory, {
      secrets: {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: value => safeStorage.encryptString(value),
        decrypt: value => safeStorage.decryptString(value)
      },
      normalizeImage: bytes => {
        const image = nativeImage.createFromBuffer(bytes), size = image.getSize();
        if (image.isEmpty() || size.width < 1 || size.height < 1 || size.width * size.height > 40_000_000) {
          throw Error('返回内容不是有效图片，或图片尺寸过大');
        }
        return { png: image.toPNG(), ...size, thumbnail: image.resize({ width: Math.min(640, size.width) }).toDataURL() };
      },
      changed: state => this.publish(state)
    });

    const handle = (name: string, fn: (...args: any[]) => unknown) => {
      this.channels.push(name);
      ipcMain.handle(name, (event, ...args) => { this.assertLocal(event); return fn(...args); });
    };

    handle('media:state', () => this.snapshot());
    handle('media:draft', (id: string, prompt: string) => {
      if (this.draft?.id !== id) return;
      if (typeof prompt !== 'string' || prompt.length > 100_000) throw Error('生图提示词过长');
      this.draft.prompt = prompt;
    });
    handle('media:set-reference', (id: string | null) => this.snapshot(this.service.selectReference(id)));
    handle('media:pick-reference', () => this.pickReference());
    handle('media:add-reference-bytes', (bytes: Uint8Array) => this.addReferenceBytes(bytes));
    handle('media:select-preset', (presetId: string) => this.selectPreset(presetId));
    handle('media:set-pinned', (pinned: boolean) => this.setPinned(pinned));
    handle('media:generate', (request: MediaGenerateRequest) => this.generate(request));
    handle('media:choose-preset', async () => { this.ensureDefaultDraft(); this.publish(); });
    handle('media:restore', (id: string, editMode: boolean, imageId?: string) => this.restore(id, editMode, imageId));
    handle('media:remove', (id: string) => this.snapshot(this.service.remove(id)));
    handle('media:hide', () => { this.closeWindow(); });
    handle('media:output', (id: string, action: MediaOutputAction, imageId?: string) => this.output(id, action, imageId));
  }

  private assertLocal(event: IpcMainInvokeEvent) {
    if (!fromMainFrame(event, this.win)) throw Error('生图操作只允许生图窗口调用');
  }

  private availablePresets(): MediaPresetItem[] {
    return this.imagePresets()
      .filter(p => p.enabled && p.kind === 'image' && p.target === 'api' && p.image)
      .map(p => ({
        id: p.id,
        name: p.name,
        connectionId: p.connectionId,
        options: structuredClone(p.image!)
      }));
  }

  private ensureDefaultDraft() {
    const presets = this.availablePresets();
    const conns = this.service.connections();
    if (this.draft) {
      const matched = presets.find(p => p.id === this.draft!.presetId);
      if (matched) {
        this.draft.presetName = matched.name;
        this.draft.connectionId = matched.connectionId || this.draft.connectionId || conns[0]?.id;
        this.draft.options = structuredClone(matched.options);
      } else if (!this.draft.connectionId && conns[0]) {
        this.draft.connectionId = conns[0].id;
      }
      return;
    }
    const chosen = presets[0];
    if (chosen) {
      this.draft = {
        id: randomUUID(),
        presetId: chosen.id,
        presetName: chosen.name,
        connectionId: chosen.connectionId || conns[0]?.id,
        prompt: '',
        options: structuredClone(chosen.options)
      };
    } else {
      this.draft = {
        id: randomUUID(),
        presetId: 'default-image',
        presetName: '自由生图',
        connectionId: conns[0]?.id,
        prompt: '',
        options: defaultImageOptions()
      };
    }
  }

  refreshPresets() {
    if (this.draft) this.ensureDefaultDraft();
    this.publish();
  }

  private snapshot(state = this.service.snapshot()): MediaState {
    const { fonts, importedFonts } = this.fontSettings();
    return {
      ...state,
      draft: structuredClone(this.draft),
      presets: this.availablePresets(),
      pinnedOnTop: this.pinnedOnTop,
      ...structuredClone({ fonts, importedFonts })
    };
  }

  private publish(state = this.service.snapshot()) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('media:changed', this.snapshot(state));
  }

  async show() {
    this.ensureDefaultDraft();
    if (!this.win || this.win.isDestroyed()) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const width = Math.min(MEDIA_W, area.width), height = Math.min(MEDIA_H, area.height);
      const win = new BrowserWindow({
        x: Math.round(area.x + (area.width - width) / 2),
        y: Math.round(area.y + (area.height - height) / 2),
        width,
        height,
        minWidth: 460,
        minHeight: 540,
        frame: false,
        show: false,
        backgroundColor: '#FAF9F5',
        title: 'AI 生图',
        fullscreenable: false,
        webPreferences: { preload: join(__dirname, 'media-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
      });
      this.win = win;
      win.setAlwaysOnTop(this.pinnedOnTop, 'floating');
      sealLocal(win.webContents);
      closeOnCommandW(win);
      win.on('close', event => {
        if (this.outputting && !this.quitting) {
          event.preventDefault();
          this.closeAfterOutput = true;
          win.hide();
        }
      });
      win.on('closed', () => {
        if (this.win === win) {
          this.win = null;
          this.ready = null;
        }
      });
      this.ready = win.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'quick-image' } });
    }
    await this.ready;
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    setWindowPresence(win, true);
    this.publish();
    win.setBounds(fitToWorkArea(win.getBounds(), screen.getDisplayMatching(win.getBounds()).workArea));
    win.show();
    app.focus({ steal: true });
    win.focus();
  }

  private closeWindow() {
    const win = this.win;
    if (!win) return;
    win.hide();
    setWindowPresence(win, false);
    if (this.outputting) {
      this.closeAfterOutput = true;
      return;
    }
    setImmediate(() => { if (!win.isDestroyed()) win.close(); });
  }

  async prepare(preset: Preset, prompt: string, reference?: NativeImage) {
    if (preset.kind !== 'image' || preset.target !== 'api' || !preset.image) throw Error('请选择 API 生图预设');
    if (!preset.connectionId || !this.service.connections().some(connection => connection.id === preset.connectionId)) {
      throw Error('API 连接不存在，请重新选择连接');
    }
    if (this.preparing || this.service.snapshot().jobs.some(job => job.status === 'running')) {
      throw Error('已有图片正在生成，请等待完成');
    }
    this.preparing = true;
    try {
      this.draft = {
        id: randomUUID(),
        presetId: preset.id,
        presetName: preset.name,
        connectionId: preset.connectionId,
        prompt,
        options: structuredClone(preset.image)
      };
      if (reference) this.service.addReference(reference.toPNG());
      else this.service.selectReference(null);
      await this.show();
      if (preset.mode === 'send' && prompt.trim()) {
        this.generate({ requestId: this.draft.id, draftId: this.draft.id, prompt, connectionId: preset.connectionId });
      }
    } finally {
      this.preparing = false;
    }
  }

  private selectPreset(presetId: string): MediaState {
    const preset = this.availablePresets().find(p => p.id === presetId);
    if (!preset) throw Error('生图预设不存在或未启用');
    const prompt = this.draft?.prompt ?? '';
    this.draft = {
      id: randomUUID(),
      presetId: preset.id,
      presetName: preset.name,
      connectionId: preset.connectionId || this.service.connections()[0]?.id,
      prompt,
      options: structuredClone(preset.options)
    };
    return this.snapshot();
  }

  private setPinned(pinned: boolean): MediaState {
    this.pinnedOnTop = Boolean(pinned);
    if (this.win && !this.win.isDestroyed()) this.win.setAlwaysOnTop(this.pinnedOnTop, 'floating');
    return this.snapshot();
  }

  private async pickReference(): Promise<{ state: MediaState; error: string | null }> {
    try {
      const result = await dialog.showOpenDialog(this.win!, {
        title: '选择参考图',
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
      });
      if (result.canceled || !result.filePaths[0]) return { state: this.snapshot(), error: null };
      const bytes = await readFile(result.filePaths[0]);
      this.service.addReference(bytes);
      return { state: this.snapshot(), error: null };
    } catch (error) {
      return { state: this.snapshot(), error: (error as Error).message };
    }
  }

  private addReferenceBytes(bytes: Uint8Array): { state: MediaState; error: string | null } {
    try {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 32 * 1024 * 1024) {
        throw Error('参考图内容无效或超过 32MB');
      }
      this.service.addReference(Buffer.from(bytes));
      return { state: this.snapshot(), error: null };
    } catch (error) {
      return { state: this.snapshot(), error: (error as Error).message };
    }
  }

  private generate(request: MediaGenerateRequest): MediaState {
    this.ensureDefaultDraft();
    if (!this.draft || request?.draftId !== this.draft.id) throw Error('生图草稿已更新，请使用当前草稿');
    const reference = this.service.snapshot().reference;
    const connectionId = request.connectionId || this.draft.connectionId || this.service.connections()[0]?.id;
    if (!connectionId) throw Error('请先在设置 → 模型与 API 连接中添加生图连接');
    const next = this.service.generate({
      ...this.draft.options,
      requestId: request.requestId,
      prompt: request.prompt,
      connectionId,
      presetId: this.draft.presetId,
      presetName: this.draft.presetName,
      ...(reference ? { referenceId: reference.id } : {})
    });
    this.draft.prompt = request.prompt;
    return this.snapshot(next);
  }

  private restore(id: string, editMode: boolean, imageId?: string): MediaState {
    const job = this.service.snapshot().jobs.find(item => item.id === id);
    if (!job || (job.destination && job.destination !== 'api')) throw Error('只能恢复 API 生图任务');
    if (this.service.snapshot().jobs.some(item => item.status === 'running')) throw Error('请等待当前生成完成');
    const connectionId = job.connectionId || this.service.presetConnectionId(job.presetId) || this.service.connections()[0]?.id;
    if (!connectionId || !this.service.connections().some(connection => connection.id === connectionId)) {
      throw Error('API 连接不存在，请重新选择连接');
    }
    const image = imageId ? job.images?.find(img => img.id === imageId) : job.images?.[0];
    if (editMode && !image) throw Error('请选择已生成的图片');
    const options = {
      ...defaultImageOptions(),
      aspect: job.aspect,
      resolution: job.resolution,
      count: job.count,
      customSize: job.customSize,
      quality: job.quality || 'auto',
      background: job.background || 'auto',
      outputFormat: job.outputFormat || 'png',
      generationModel: job.generationModel || '',
      editModel: job.editModel || ''
    };
    this.draft = {
      id: randomUUID(),
      presetId: job.presetId || 'historical-image',
      presetName: job.presetName || '图片生成',
      connectionId,
      prompt: editMode ? '' : job.renderedPrompt || job.prompt,
      options
    };
    this.service.selectReference(editMode ? image!.id : job.referenceId || null);
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
      else if (action === 'edit') { await this.edit(image); this.closeAfterOutput = true; this.win?.hide(); }
      else {
        const result = await dialog.showSaveDialog(this.win!, { defaultPath: 'Lasso-image.png', filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
        if (!result.canceled && result.filePath) await writeFile(result.filePath, png);
      }
      return { error: null };
    } catch (error) {
      return { error: (error as Error).message };
    } finally {
      this.outputting = false;
      if (this.closeAfterOutput) {
        this.closeAfterOutput = false;
        this.closeWindow();
      }
    }
  }

  dispose() {
    this.quitting = true;
    app.off('before-quit', this.beforeQuit);
    for (const channel of this.channels) ipcMain.removeHandler(channel);
    this.win?.destroy();
  }
}
