import { app, nativeImage, type NativeImage } from 'electron';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CaptureRect } from '../../shared/capture';
import { recordingFormats, validateRecordingSettings, type KeystrokeCue, type MouseClickCue, type RecordingAction, type RecordingExportAction, type RecordingFormat, type RecordingMediaManifest, type RecordingMode, type RecordingSessionState, type RecordingSettings } from '../../shared/recording';
import { screenshotDefaults } from '../../shared/screenshot-settings';
import { encodeScreenshot } from './output';
import { NativeRecordingMedia, type RecordingMedia } from './recording-media';

export interface RecordingOutput {
  bytes: Buffer; format: RecordingFormat; frames: string[]; frameDelayMs: number; loop: true; durationMs: number; width: number; height: number;
}
export interface RecordingInputHandlers {
  keystroke: (cue: Omit<KeystrokeCue, 'timestampMs'> & { timestampMs?: number }) => void;
  mouseClick: (cue: Omit<MouseClickCue, 'timestampMs'> & { timestampMs?: number }) => void;
  error: (error: Error) => void;
}
export interface RecordingManagerOptions {
  directory?: string; settings: () => RecordingSettings; media?: RecordingMedia;
  prepareCapture?: (mode: RecordingMode, bounds?: CaptureRect) => Promise<{ bounds: CaptureRect; displayId: number }>;
  captureFrame: (mode: RecordingMode, bounds: CaptureRect) => Promise<{ image: NativeImage; hostTimeMs: number }>;
  releaseCapture?: () => Promise<void> | void;
  subscribeInput?: (handlers: RecordingInputHandlers) => Promise<() => void>;
  exportOutput?: (output: RecordingOutput, action: RecordingExportAction) => Promise<string | null>;
  onChange?: (state: RecordingSessionState | null) => void;
  now?: () => number; autoTick?: boolean;
}
interface StoredFrame { file: string; timestampMs: number }
interface StoredSession { version: 1; state: RecordingSessionState; frames: StoredFrame[]; keys: KeystrokeCue[]; clicks: MouseClickCue[]; media?: RecordingMediaManifest }
export interface RecordingResult { state: RecordingSessionState | null; path?: string | null; error: string | null }
const validBounds = (r?: CaptureRect): r is CaptureRect => !!r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
const dataURL = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;

/** Owns disk-backed frames, media and paired capture/input lifetimes. */
export class RecordingManager {
  private session: StoredSession | null = null;
  private readonly directory: string;
  private readonly now: () => number;
  private readonly media: RecordingMedia;
  private ready: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private countdownUntil = 0;
  private activeAt = 0;
  private elapsed = 0;
  private frameTask: Promise<void> | null = null;
  private interruption: Promise<void> | null = null;
  private releaseInput?: () => void;
  private capturePrepared = false;
  private mediaPrepared = false;
  private actions: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private generation = 0;
  private sessionGeneration = 0;
  constructor(private readonly options: RecordingManagerOptions) {
    this.directory = options.directory ?? join(app.getPath('userData'), 'recording-sessions');
    this.media = options.media ?? new NativeRecordingMedia();
    this.now = options.now ?? (() => this.media.nowMs());
    this.ready = this.loadRecovery();
  }
  state(): RecordingSessionState | null { return this.session ? structuredClone(this.session.state) : null; }
  async initialized(): Promise<void> { await this.ready; }
  private path(id = this.session!.state.id) { return join(this.directory, id); }
  private emit() { this.options.onChange?.(this.state()); }
  private isCurrent(generation: number) { return !this.disposed && generation === this.generation; }
  private assertCurrent(generation: number) {
    if (!this.isCurrent(generation)) throw Error(this.disposed ? '录制器已关闭' : '录制已取消');
  }
  private invalidate() { this.generation++; this.unschedule(); }
  private duration() { return this.elapsed + (this.session?.state.status === 'recording' ? Math.max(0, this.now() - this.activeAt) : 0); }
  private async persist() {
    if (!this.session) return;
    const path = this.path(); await mkdir(path, { recursive: true });
    await writeFile(join(path, 'session.json.tmp'), JSON.stringify(this.session));
    await rename(join(path, 'session.json.tmp'), join(path, 'session.json'));
  }
  private async readSession(id: string): Promise<StoredSession> {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw Error('恢复会话无效');
    const stored = JSON.parse(await readFile(join(this.path(id), 'session.json'), 'utf8')) as StoredSession;
    if (stored.version !== 1 || stored.state.id !== id || !validBounds(stored.state.bounds) || !['rect', 'window', 'screen'].includes(stored.state.mode) ||
      !Array.isArray(stored.frames) || !Array.isArray(stored.keys) || !Array.isArray(stored.clicks)) throw Error('录制恢复文件无效');
    validateRecordingSettings(stored.state.settings);
    let previous = -1;
    for (const frame of stored.frames) {
      if (!/^frame-\d+\.png$/.test(frame.file) || !Number.isFinite(frame.timestampMs) || frame.timestampMs < previous || frame.timestampMs < 0) throw Error('录制帧索引无效');
      previous = frame.timestampMs; await readFile(join(this.path(id), frame.file));
    }
    try { stored.media = JSON.parse(await readFile(join(this.path(id), 'media.json'), 'utf8')) as RecordingMediaManifest; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (stored.media && (stored.media.version !== 1 || stored.media.sessionId !== id || !Number.isFinite(stored.media.durationMs) || stored.media.durationMs < 0 ||
      !Array.isArray(stored.media.intervals) || !Array.isArray(stored.media.audio))) throw Error('录制媒体索引无效');
    stored.state.durationMs = Math.max(stored.state.durationMs, stored.media?.durationMs ?? 0);
    return stored;
  }
  async recoveries(): Promise<RecordingSessionState[]> {
    await mkdir(this.directory, { recursive: true });
    const results: RecordingSessionState[] = [];
    for (const entry of await readdir(this.directory, { withFileTypes: true })) if (entry.isDirectory()) {
      try { const stored = await this.readSession(entry.name); if (stored.frames.length) results.push({ ...stored.state, status: 'recoverable' }); }
      catch (error) { console.warn('[recording] 无法恢复会话', entry.name, String(error)); }
    }
    return results.sort((a, b) => b.id.localeCompare(a.id));
  }
  private async loadRecovery() {
    const recovery = (await this.recoveries())[0];
    if (recovery && !this.disposed) { this.session = await this.readSession(recovery.id); this.session.state.status = 'recoverable'; this.emit(); }
  }
  private schedule() {
    if (this.options.autoTick === false) return;
    this.timer = setInterval(() => { void this.tick().catch(error => console.warn('[recording]', String(error))); }, 1000 / this.session!.state.settings.fps);
  }
  private unschedule() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  private async releaseResources(cancel = false) {
    let failure: unknown;
    if (this.mediaPrepared) {
      this.mediaPrepared = false;
      try {
        if (cancel) await this.media.cancel(this.session!.state.id);
        else this.session!.media = await this.media.stop(this.session!.state.id);
      } catch (error) { failure = error; }
    }
    try { this.releaseInput?.(); } catch (error) { failure ??= error; }
    this.releaseInput = undefined;
    if (this.capturePrepared) {
      this.capturePrepared = false;
      try { await this.options.releaseCapture?.(); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  }
  private async interrupt(error: unknown): Promise<void> {
    if (this.interruption) return this.interruption;
    if (!this.session) return;
    this.unschedule(); this.elapsed = this.duration();
    const s = this.session.state;
    s.durationMs = Math.max(s.durationMs, this.elapsed); s.status = 'recoverable';
    s.message = `录制中断：${String(error instanceof Error ? error.message : error)}`;
    this.interruption = (async () => {
      await this.frameTask?.catch(() => {});
      try { await this.releaseResources(); } catch (cleanupError) { console.warn('[recording] 释放媒体失败', String(cleanupError)); }
      s.durationMs = Math.max(s.durationMs, this.session?.media?.durationMs ?? 0);
      s.trimEndMs = s.durationMs;
      await this.persist(); this.emit();
    })();
    try { await this.interruption; } finally { this.interruption = null; }
  }
  /** Frame sample times and media samples share the native host clock. */
  async tick(): Promise<void> {
    const generation = this.sessionGeneration;
    await this.ready;
    if (!this.isCurrent(generation) || !this.session || this.frameTask || this.interruption) return;
    const s = this.session.state;
    this.frameTask = (async () => {
      if (s.status === 'countdown') {
        s.countdownLeft = Math.max(0, Math.ceil((this.countdownUntil - this.now()) / 1000));
        if (s.countdownLeft) { this.emit(); return; }
        const boundary = await this.media.begin(s.id);
        if (!this.isCurrent(generation) || s.status !== 'countdown') return;
        this.elapsed = 0; this.activeAt = boundary.hostTimeMs; s.status = 'recording';
      }
      if (s.status === 'recording') await this.capture();
    })();
    try { await this.frameTask; }
    catch (error) { await this.interrupt(error); throw error; }
    finally { this.frameTask = null; }
  }
  private async capture() {
    const session = this.session!, s = session.state;
    let { image, hostTimeMs } = await this.options.captureFrame(s.mode, { ...s.bounds });
    if (image.isEmpty() || !Number.isFinite(hostTimeMs)) throw Error('录制画面或样本时间无效');
    if (s.settings.cameraOverlay) {
      const size = image.getSize();
      image = nativeImage.createFromBitmap(await this.media.composeCamera({ sessionId: s.id, bgra: image.toBitmap(), ...size, hostTimeMs, corner: s.settings.cameraPosition }), { ...size, scaleFactor: 1 });
    }
    const manifest = await this.media.snapshot(s.id); session.media = manifest;
    const interval = manifest.intervals.find(part => hostTimeMs >= part.hostStartMs && hostTimeMs <= part.hostEndMs);
    if (!interval) return;
    const timestampMs = interval.activeStartMs + hostTimeMs - interval.hostStartMs;
    if (timestampMs < (session.frames.at(-1)?.timestampMs ?? 0)) return;
    const file = `frame-${session.frames.length}.png`, png = image.toPNG();
    await writeFile(join(this.path(), file), png);
    session.frames.push({ file, timestampMs }); s.frameCount = session.frames.length;
    s.durationMs = Math.max(timestampMs, manifest.durationMs); s.trimEndMs = s.durationMs;
    if (s.previewFrames.length < 8) s.previewFrames.push(dataURL(png));
    s.recentKeys = session.keys.filter(c => timestampMs >= c.timestampMs && timestampMs - c.timestampMs < 1200);
    s.recentClicks = session.clicks.filter(c => timestampMs >= c.timestampMs && timestampMs - c.timestampMs < 600);
    await this.persist(); this.emit();
  }
  recordKeystroke(cue: Omit<KeystrokeCue, 'timestampMs'> & { timestampMs?: number }) {
    if (!this.isCurrent(this.sessionGeneration) || this.session?.state.status !== 'recording' || !cue.key || cue.key.length > 80 || !Array.isArray(cue.modifiers)) return;
    this.session.keys.push({ key: cue.key, modifiers: cue.modifiers.slice(0, 5), timestampMs: cue.timestampMs ?? this.duration() });
  }
  recordMouseClick(cue: Omit<MouseClickCue, 'timestampMs'> & { timestampMs?: number }) {
    if (!this.isCurrent(this.sessionGeneration) || this.session?.state.status !== 'recording' || ![cue.x, cue.y].every(Number.isFinite) || !['left', 'right'].includes(cue.button)) return;
    this.session.clicks.push({ ...cue, timestampMs: cue.timestampMs ?? this.duration() });
  }
  action(action: RecordingAction): Promise<RecordingResult> {
    if (action?.type === 'cancel') this.invalidate();
    const generation = this.generation;
    const task = this.actions.then(async () => {
      await this.ready; await this.interruption;
      try {
        if (this.disposed) throw Error('录制器已关闭');
        if (action?.type === 'start' || action?.type === 'resume') this.assertCurrent(generation);
        return await this.apply(action, generation);
      }
      catch (error) { return { state: this.state(), error: error instanceof Error ? error.message : String(error) }; }
    });
    this.actions = task; return task;
  }
  private async apply(action: RecordingAction, generation: number): Promise<RecordingResult> {
    if (!action || !['start', 'recover', 'discard-recovery', 'cancel', 'pause', 'resume', 'stop', 'trim', 'export'].includes(action.type)) throw Error('录制操作无效');
    let path: string | null | undefined;
    if (action.type === 'start') {
      if (this.session) throw Error('请先完成或丢弃当前录制');
      const settings = structuredClone(this.options.settings()); validateRecordingSettings(settings);
      if (!['rect', 'window', 'screen'].includes(action.mode)) throw Error('录制模式无效');
      this.sessionGeneration = generation;
      this.capturePrepared = true;
      try {
        const prepared = this.options.prepareCapture ? await this.options.prepareCapture(action.mode, action.bounds) : { bounds: action.bounds, displayId: 0 };
        this.assertCurrent(generation);
        if (!validBounds(prepared.bounds)) throw Error('请先选择有效的录制范围');
        const state: RecordingSessionState = { id: `${Date.now()}-${randomUUID()}`, status: 'countdown', mode: action.mode,
          bounds: { ...prepared.bounds }, countdownLeft: settings.countdown, durationMs: 0, frameCount: 0, settings, trimStartMs: 0, trimEndMs: 0,
          previewFrames: [], recentKeys: [], recentClicks: [], message: '' };
        this.session = { version: 1, state, frames: [], keys: [], clicks: [] }; this.elapsed = 0;
        await this.persist(); this.assertCurrent(generation); this.mediaPrepared = true;
        await this.media.prepare({ sessionId: state.id, directory: this.path(), displayId: prepared.displayId, systemAudio: settings.systemAudio, microphone: settings.microphone, camera: settings.cameraOverlay });
        this.assertCurrent(generation);
        if (settings.showKeystrokes || settings.showMouseClicks) this.releaseInput = await this.options.subscribeInput?.({ keystroke: cue => this.recordKeystroke(cue), mouseClick: cue => this.recordMouseClick(cue), error: error => { void this.interrupt(error); } });
        this.assertCurrent(generation);
        if (state.status !== 'countdown') {
          this.releaseInput?.(); this.releaseInput = undefined;
          throw Error(state.message || '录制准备已中断');
        }
        this.countdownUntil = this.now() + settings.countdown * 1000;
        this.schedule(); await this.tick(); this.assertCurrent(generation);
      } catch (error) {
        await this.frameTask?.catch(() => {}); await this.interruption;
        try { await this.releaseResources(true); } catch (cleanupError) { console.warn('[recording] 释放媒体失败', String(cleanupError)); }
        if (this.session) await this.interrupt(error);
        throw error;
      }
    } else if (action.type === 'recover') {
      if (this.session && this.session.state.status !== 'recoverable') throw Error('当前录制尚未结束');
      const id = action.sessionId ?? this.session?.state.id; if (!id) throw Error('没有可恢复的录制');
      this.session = await this.readSession(id); const s = this.session.state, savedReview = s.status === 'review';
      s.status = 'review'; s.durationMs = Math.max(s.durationMs, (this.session.frames.at(-1)?.timestampMs ?? 0) + (this.session.media ? 0 : 1000 / s.settings.fps));
      s.trimEndMs = savedReview ? Math.min(s.trimEndMs || s.durationMs, s.durationMs) : s.durationMs; s.frameCount = this.session.frames.length; s.countdownLeft = 0;
      s.message = '已恢复中断的录制'; this.elapsed = s.durationMs; await this.persist();
    } else if (action.type === 'discard-recovery' || action.type === 'cancel') {
      const id = action.type === 'discard-recovery' ? action.sessionId ?? this.session?.state.id : this.session?.state.id;
      if (id && !/^[a-zA-Z0-9-]+$/.test(id)) throw Error('恢复会话无效');
      if (id === this.session?.state.id) {
        this.unschedule(); await this.frameTask?.catch(() => {}); await this.interruption;
        await this.releaseResources(true); this.session = null;
      }
      if (id) await rm(this.path(id), { recursive: true, force: true });
    } else {
      if (!this.session) throw Error('没有进行中的录制');
      const s = this.session.state;
      if (action.type === 'pause' || action.type === 'resume' || action.type === 'stop') {
        if (action.type === 'pause' && s.status !== 'recording') throw Error('当前不能暂停');
        if (action.type === 'resume' && s.status !== 'paused') throw Error('当前不能继续录制');
        if (action.type === 'stop' && !['countdown', 'recording', 'paused'].includes(s.status)) throw Error('当前录制已结束');
        try {
          this.unschedule(); await this.frameTask; await this.interruption;
          if (s.status === 'recoverable') throw Error(s.message);
          if (action.type === 'pause') {
            s.status = 'paused';
            this.elapsed = (await this.media.pause(s.id)).activeTimeMs;
            this.session.media = await this.media.snapshot(s.id); s.durationMs = this.elapsed;
          } else if (action.type === 'resume') {
            this.elapsed = (await this.media.resume(s.id)).activeTimeMs;
            this.assertCurrent(generation);
            this.session.media = await this.media.snapshot(s.id);
            this.assertCurrent(generation);
            const latest = this.session.media.intervals.at(-1);
            this.activeAt = latest?.hostStartMs ?? this.now(); s.status = 'recording';
            this.schedule(); await this.tick();
          } else {
            this.elapsed = this.duration(); s.status = 'paused';
            await this.releaseResources(); this.elapsed = this.session.media?.durationMs ?? this.duration();
            s.durationMs = this.elapsed; s.trimEndMs = this.elapsed; s.status = 'review'; s.countdownLeft = 0;
          }
        } catch (error) { await this.interrupt(error); throw error; }
      } else if (action.type === 'trim') {
        if (s.status !== 'review' || ![action.startMs, action.endMs].every(Number.isFinite) || action.startMs < 0 || action.endMs > s.durationMs || action.startMs >= action.endMs) throw Error('裁剪时间范围无效');
        if (!this.session.frames.length) throw Error('裁剪范围内没有画面');
        s.trimStartMs = action.startMs; s.trimEndMs = action.endMs;
      } else if (action.type === 'export') {
        if (s.status !== 'review' || !recordingFormats.includes(action.format) || !['save', 'quick-save', 'copy-file', 'pin'].includes(action.action)) throw Error('当前不能导出录制');
        if (!this.options.exportOutput) throw Error('录制输出尚未接入');
        path = await this.options.exportOutput(await this.output(action.format), action.action);
      }
      await this.persist();
    }
    this.emit(); return { state: this.state(), ...(path !== undefined ? { path } : {}), error: null };
  }
  async output(format: RecordingFormat): Promise<RecordingOutput> {
    await this.ready;
    if (!this.session || this.session.state.status !== 'review' || !recordingFormats.includes(format)) throw Error('请先停止录制');
    const { state: s, frames: sourceFrames, keys, clicks } = this.session;
    const durationMs = s.trimEndMs - s.trimStartMs;
    if (!sourceFrames.length || durationMs <= 0) throw Error('裁剪范围内没有画面');
    const frameCount = Math.max(1, Math.ceil(durationMs * s.settings.fps / 1000)), frameDelayMs = durationMs / frameCount;
    const images: NativeImage[] = [], delays: number[] = []; let source = -1, sourceImage: NativeImage | undefined;
    for (let i = 0; i < frameCount; i++) {
      const timestamp = s.trimStartMs + i * frameDelayMs;
      let selected = Math.max(0, source);
      while (selected < sourceFrames.length - 1 && sourceFrames[selected + 1].timestampMs <= timestamp) selected++;
      if (selected !== source) {
        source = selected; sourceImage = nativeImage.createFromBuffer(await readFile(join(this.path(), sourceFrames[source].file)));
        if (sourceImage.isEmpty()) throw Error('录制帧已损坏');
        if (images.length) { const size = images[0].getSize(); if (sourceImage.getSize().width !== size.width || sourceImage.getSize().height !== size.height) sourceImage = sourceImage.resize({ ...size, quality: 'best' }); }
      }
      images.push(compositeRecordingFrame(sourceImage!, s.bounds, timestamp, s.settings, keys, clicks)); delays.push(frameDelayMs);
    }
    const manifest = this.session.media ?? { version: 1, sessionId: s.id, durationMs: s.durationMs, intervals: [], audio: [] };
    const bytes = await encodeRecording(images, delays, format, this.path(), s.settings.quality, { media: this.media, manifest, trimStartMs: s.trimStartMs, trimEndMs: s.trimEndMs });
    return { bytes, format, frames: images.map(image => dataURL(image.toPNG())), frameDelayMs, durationMs, ...images[0].getSize(), loop: true };
  }
  async dispose() {
    this.disposed = true; this.invalidate(); await this.ready; await this.actions; await this.frameTask?.catch(() => {}); await this.interruption; this.unschedule();
    if (this.session && ['recording', 'paused', 'countdown'].includes(this.session.state.status)) await this.interrupt(Error('应用退出'));
    else await this.releaseResources();
  }
}

// A small raster font avoids hidden renderer windows and platform font differences in exported frames.
const glyphs: Record<string, string> = {
  A:'0e11111f111111',B:'1e11111e11111e',C:'0e11101010110e',D:'1e11111111111e',E:'1f10101e10101f',F:'1f10101e101010',G:'0e11101711110f',H:'1111111f111111',I:'0e04040404040e',J:'0702020212120c',K:'11121418141211',L:'1010101010101f',M:'111b1515111111',N:'11191513111111',O:'0e11111111110e',P:'1e11111e101010',Q:'0e11111115120d',R:'1e11111e141211',S:'0f10100e01011e',T:'1f040404040404',U:'1111111111110e',V:'11111111110a04',W:'11111115151b11',X:'11110a040a1111',Y:'11110a04040404',Z:'1f01020408101f',
  '0':'0e11131519110e','1':'040c040404040e','2':'0e11010204081f','3':'1e01010601011e','4':'02060a121f0202','5':'1f10101e01011e','6':'0e10101e11110e','7':'1f010204080808','8':'0e11110e11110e','9':'0e11110f01010e','+':'0004041f040400','-':'0000001f000000','?':'0e110102040004','.':'00000000000c0c',',':'00000000000c08','/':'01010204081010','=':'00001f001f0000','[':'0e08080808080e',']':'0e02020202020e',';':'000c0c000c0c08',"'":'0c0c0800000000','`':'08040200000000','\\':'10100804020101',' ':'00000000000000'
};
export function compositeRecordingFrame(image: NativeImage, bounds: CaptureRect, timestampMs: number, settings: RecordingSettings, keys: KeystrokeCue[], clicks: MouseClickCue[]): NativeImage {
  const { width, height } = image.getSize(), pixels = image.toBitmap();
  const paint = (x: number, y: number, color: number[], alpha = 1) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (Math.floor(y) * width + Math.floor(x)) * 4;
    for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(pixels[i + c] * (1 - alpha) + color[2 - c] * alpha);
    pixels[i + 3] = 255;
  };
  if (settings.showMouseClicks) for (const cue of clicks) {
    const age = timestampMs - cue.timestampMs; if (age < 0 || age >= 600) continue;
    const x = (cue.x - bounds.x) * width / bounds.width, y = (cue.y - bounds.y) * height / bounds.height, radius = 9 + 22 * age / 600;
    for (let dy = -Math.ceil(radius + 2); dy <= radius + 2; dy++) for (let dx = -Math.ceil(radius + 2); dx <= radius + 2; dx++)
      if (Math.abs(Math.hypot(dx, dy) - radius) < 2) paint(Math.round(x + dx), Math.round(y + dy), cue.button === 'left' ? [230, 112, 76] : [255, 201, 89], 1 - age / 700);
  }
  if (settings.showKeystrokes) {
    const cue = keys.filter(k => timestampMs >= k.timestampMs && timestampMs - k.timestampMs < 1200).at(-1);
    if (cue) {
      const labels: Record<string,string> = { Meta:'CMD', Control:'CTRL', Alt:'OPT', Shift:'SHIFT', ' ':'SPACE', ArrowLeft:'LEFT', ArrowRight:'RIGHT', ArrowUp:'UP', ArrowDown:'DOWN', '⌘':'CMD', '⌥':'OPT', '⌃':'CTRL', '⇧':'SHIFT' };
      const text = [...cue.modifiers, cue.key].map(v => labels[v] ?? v).join('+').toUpperCase().slice(0, 48);
      const scale = Math.max(1, Math.min(3, Math.floor(width / 320))), boxWidth = Math.min(width, (text.length * 6 + 8) * scale), boxHeight = 13 * scale;
      const left = Math.max(0, Math.floor((width - boxWidth) / 2)), top = Math.max(0, height - boxHeight - 12 * scale);
      for (let y = top; y < Math.min(height, top + boxHeight); y++) for (let x = left; x < left + boxWidth; x++) paint(x, y, [20, 20, 20], 0.82);
      [...text].forEach((char, n) => { const glyph = glyphs[char] ?? glyphs['?'];
        for (let y = 0; y < 7; y++) for (let x = 0; x < 5; x++) if (parseInt(glyph.slice(y * 2, y * 2 + 2), 16) & (1 << (4 - x)))
          for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) paint(left + (4 + n * 6 + x) * scale + sx, top + (3 + y) * scale + sy, [255, 255, 255]);
      });
    }
  }
  return nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 });
}

const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const atom = (name: string, ...data: Buffer[]) => { const body = Buffer.concat(data); return Buffer.concat([u32(body.length + 8), Buffer.from(name), body]); };
const full = (name: string, ...data: Buffer[]) => atom(name, Buffer.alloc(4), ...data);
/** Quantize cumulative boundaries so fractional frame durations do not accumulate rounding drift. */
function quantizeFrameDelays(delays: number[], unitMs = 1, totalMs?: number): number[] {
  let elapsedMs = 0, emitted = 0;
  const unitsPerMs = 1 / unitMs;
  return delays.map((delay, index) => {
    elapsedMs += delay;
    const boundaryMs = index === delays.length - 1 && totalMs !== undefined ? totalMs : elapsedMs;
    const duration = Math.max(1, Math.round(boundaryMs * unitsPerMs) - emitted);
    emitted += duration; return duration;
  });
}
/** GIF89a RGB332 palette; bounded literal LZW blocks keep the dictionary at a constant 9-bit width. */
export function encodeRecordingGif(images: NativeImage[], delays: number[]): Buffer {
  const { width, height } = images[0].getSize();
  if (width > 65535 || height > 65535) throw Error('GIF 画面过大');
  const palette = Buffer.alloc(768);
  for (let i = 0; i < 256; i++) { palette[i * 3] = Math.round((i >> 5) * 255 / 7); palette[i * 3 + 1] = Math.round(((i >> 2) & 7) * 255 / 7); palette[i * 3 + 2] = (i & 3) * 85; }
  const chunks = [Buffer.from('GIF89a'), u16le(width), u16le(height), Buffer.from([0xf7, 0, 0]), palette, Buffer.from([0x21,0xff,11]), Buffer.from('NETSCAPE2.0'), Buffer.from([3,1,0,0,0])];
  const durations = quantizeFrameDelays(delays, 10);
  images.forEach((image, frame) => {
    const pixels = image.toBitmap(), packed: number[] = []; let value = 0, bits = 0;
    const code = (n: number) => { value |= n << bits; bits += 9; while (bits >= 8) { packed.push(value & 255); value >>>= 8; bits -= 8; } };
    for (let i = 0; i < width * height; i++) { if (i % 250 === 0) code(256); const p = i * 4; code((pixels[p + 2] & 0xe0) | ((pixels[p + 1] & 0xe0) >> 3) | (pixels[p] >> 6)); }
    code(257); if (bits) packed.push(value & 255);
    const delayCs = durations[frame];
    if (delayCs > 65535) throw Error('单帧停留时间超出 GIF 范围');
    chunks.push(Buffer.from([0x21,0xf9,4,4]), u16le(delayCs), Buffer.from([0,0,0x2c]), Buffer.alloc(4), u16le(width), u16le(height), Buffer.from([0,8]));
    const bytes = Buffer.from(packed); for (let i = 0; i < bytes.length; i += 255) chunks.push(Buffer.from([Math.min(255, bytes.length - i)]), bytes.subarray(i, i + 255));
    chunks.push(Buffer.from([0]));
  });
  return Buffer.concat([...chunks, Buffer.from([0x3b])]);
}
export function encodeRecordingWebp(images: NativeImage[], delays: number[]): Buffer {
  const { width, height } = images[0].getSize();
  const chunk = (name: string, bytes: Buffer) => { const header = Buffer.alloc(8); header.write(name); header.writeUInt32LE(bytes.length, 4); return Buffer.concat([header, bytes, Buffer.alloc(bytes.length & 1)]); };
  const extended = Buffer.alloc(10); extended[0] = 0x12; extended.writeUIntLE(width - 1, 4, 3); extended.writeUIntLE(height - 1, 7, 3);
  const chunks = [Buffer.from('WEBP'), chunk('VP8X', extended), chunk('ANIM', Buffer.alloc(6))];
  const durations = quantizeFrameDelays(delays);
  images.forEach((image, i) => {
    if (durations[i] > 0xffffff) throw Error('单帧停留时间超出 WebP 范围');
    const header = Buffer.alloc(16); header.writeUIntLE(width - 1, 6, 3); header.writeUIntLE(height - 1, 9, 3); header.writeUIntLE(durations[i], 12, 3); header[15] = 2;
    chunks.push(chunk('ANMF', Buffer.concat([header, encodeScreenshot(image, screenshotDefaults(), 'webp').subarray(12)])));
  });
  const body = Buffer.concat(chunks), header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(body.length, 4); return Buffer.concat([header, body]);
}
/** Preserve exact sample durations in the intermediate movie; native assembly writes H.264. */
function jpegMovie(images: NativeImage[], delays: number[], quality: number, durationMs: number): Buffer {
  const { width, height } = images[0].getSize(), samples = images.map(image => image.toJPEG(quality));
  // Match native CMTime's 60000 ticks/second, including the exact requested final boundary.
  const timeScale = 60000, durations = quantizeFrameDelays(delays, 1000 / timeScale, durationMs), duration = durations.reduce((a,b) => a+b,0);
  const ftyp = atom('ftyp', Buffer.from('qt  '), u32(0), Buffer.from('qt  '));
  const matrix = Buffer.concat([u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)]);
  const mvhd = full('mvhd', Buffer.alloc(8), u32(timeScale), u32(duration), u32(0x10000), Buffer.from([1,0]), Buffer.alloc(10), matrix, Buffer.alloc(24), u32(2));
  const tkhdData = Buffer.concat([Buffer.from([0,0,0,7]), Buffer.alloc(8), u32(1), u32(0), u32(duration), Buffer.alloc(16), matrix, u32(width * 65536), u32(height * 65536)]);
  const mdhd = full('mdhd', Buffer.alloc(8), u32(timeScale), u32(duration), Buffer.alloc(4));
  const hdlr = full('hdlr', u32(0), Buffer.from('vide'), Buffer.alloc(12), Buffer.from('Lasso\0'));
  const description = Buffer.alloc(78); description.writeUInt16BE(1, 6); description.write('appl', 12); description.writeUInt16BE(width, 24); description.writeUInt16BE(height, 26);
  description.writeUInt32BE(72 * 65536, 28); description.writeUInt32BE(72 * 65536, 32); description.writeUInt16BE(1, 40); description[42] = 5; description.write('Photo',43); description.writeUInt16BE(24,74); description.writeInt16BE(-1,76);
  const stsd = full('stsd', u32(1), atom('jpeg', description));
  const stts = full('stts', u32(samples.length), ...durations.flatMap(d => [u32(1),u32(d)]));
  const stsc = full('stsc', u32(1), u32(1), u32(samples.length), u32(1));
  const stsz = full('stsz', u32(0), u32(samples.length), ...samples.map(s => u32(s.length)));
  const stco = full('stco', u32(1), u32(ftyp.length + 8));
  const dref = full('dref', u32(1), atom('url ', Buffer.from([0,0,0,1])));
  const minf = atom('minf', atom('vmhd', Buffer.from([0,0,0,1]), Buffer.alloc(8)), atom('dinf', dref), atom('stbl',stsd,stts,stsc,stsz,stco));
  return Buffer.concat([ftyp, atom('mdat', ...samples), atom('moov', mvhd, atom('trak', atom('tkhd', tkhdData), atom('mdia', mdhd, hdlr, minf)))]);
}
export async function encodeRecording(images: NativeImage[], delays: number[], format: RecordingFormat, workDirectory: string, quality: RecordingSettings['quality'] = 'high', encoding?: { media: RecordingMedia; manifest: RecordingMediaManifest; trimStartMs: number; trimEndMs: number }): Promise<Buffer> {
  if (!images.length || images.length !== delays.length || delays.some(d => !Number.isFinite(d) || d <= 0)) throw Error('录制帧或时长无效');
  if (format === 'gif') return encodeRecordingGif(images, delays);
  if (format === 'webp') return encodeRecordingWebp(images, delays);
  if (format !== 'mp4') throw Error('录制格式无效');
  await mkdir(workDirectory, { recursive: true });
  const id = randomUUID(), source = join(workDirectory, `${id}.mov`), output = join(workDirectory, `${id}.mp4`);
  const durationMs = encoding ? encoding.trimEndMs - encoding.trimStartMs : delays.reduce((sum, delay) => sum + delay, 0);
  const media = encoding?.media ?? new NativeRecordingMedia();
  const manifest = encoding?.manifest ?? { version: 1, sessionId: id, durationMs, intervals: [], audio: [] };
  try {
    await writeFile(source, jpegMovie(images, delays, quality === 'high' ? 95 : quality === 'medium' ? 80 : 60, durationMs));
    await media.muxMp4({ directory: workDirectory, videoPath: source, manifest, trimStartMs: encoding?.trimStartMs ?? 0, trimEndMs: encoding?.trimEndMs ?? durationMs, outputPath: output });
    return await readFile(output);
  } finally { await Promise.all([rm(source, { force: true }), rm(output, { force: true })]); }
}
