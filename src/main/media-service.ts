import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validImageOptions, validImageSize, imageRequestSize, type ImageOptions, type MediaConfig, type MediaConfigInput, type MediaJob, type MediaReference } from '../shared/media';

/** Appearance comes from the host's current settings and is never stored with image jobs. */
export interface MediaServiceState { jobs: MediaJob[]; reference: MediaReference | null }
export interface ImageRequest extends ImageOptions { requestId: string; prompt: string; presetId: string; presetName: string; referenceId?: string }

export interface NormalizedMediaImage { png: Buffer; width: number; height: number; thumbnail: string }
export interface MediaServiceAdapters {
  /** The host supplies Electron safeStorage; no credential crosses into the renderer. */
  secrets: { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string };
  normalizeImage(buffer: Buffer): NormalizedMediaImage;
  fetch?: typeof fetch;
  changed?: (state: MediaServiceState) => void;
}
type SavedConfig = Omit<MediaConfig, 'hasCredential'> & { schemaVersion: 2; credential?: string };
interface SavedMedia { version: 1; jobs: MediaJob[]; references: MediaReference[]; referenceId: string | null }
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 352 * 1024 * 1024;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);

/** Owns durable image files and requests independently from windows and chat tasks. */
export class MediaService {
  private jobs: MediaJob[] = [];
  private references = new Map<string, MediaReference>();
  private referenceId: string | null = null;
  private config: SavedConfig = { schemaVersion: 2, baseURL: '' };
  private active: Promise<void> | null = null;
  private readonly request: typeof fetch;

  constructor(private directory: string, private adapters: MediaServiceAdapters) {
    this.request = adapters.fetch || fetch;
    mkdirSync(join(directory, 'images'), { recursive: true, mode: 0o700 });
    const configPath = join(directory, 'config.json');
    if (existsSync(configPath)) {
      const value = JSON.parse(readFileSync(configPath, 'utf8')) as SavedConfig;
      this.validateConfig({ ...this.config, ...value });
      if (value.credential !== undefined && typeof value.credential !== 'string') throw Error('图片服务凭据存储无效');
      this.config = { ...this.config, ...value };
    }
    const storePath = join(directory, 'results.json');
    if (existsSync(storePath)) {
      const value = JSON.parse(readFileSync(storePath, 'utf8')) as SavedMedia;
      if (value.version !== 1 || !Array.isArray(value.jobs) || !Array.isArray(value.references)) throw Error('图片结果存储格式无效');
      if (!value.jobs.every(job => validId(job.id) && validId(job.requestId) && typeof job.prompt === 'string' && validImageSize(job) && ['running', 'succeeded', 'handed-off', 'failed', 'interrupted'].includes(job.status))) throw Error('图片任务存储格式无效');
      if (!value.references.every(image => validId(image.id) && typeof image.thumbnail === 'string' && Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height))) throw Error('图片引用存储格式无效');
      this.jobs = value.jobs.map(saved => {
        const { image, ...job } = saved as MediaJob & { image?: MediaReference };
        return { ...job, ...(image && !job.images ? { images: [image] } : {}) };
      });
      this.references = new Map(value.references.map(image => [image.id, image]));
      this.referenceId = validId(value.referenceId) && this.references.has(value.referenceId) ? value.referenceId : null;
      let interrupted = false;
      for (const job of this.jobs) if (job.status === 'running') {
        job.status = 'interrupted'; job.updatedAt = new Date().toISOString();
        job.error = '应用已重启，请求结果未知；不会自动重发。上游可能仍在处理。';
        interrupted = true;
      }
      if (interrupted) this.persist();
    }
  }

  snapshot(): MediaServiceState {
    return structuredClone({ jobs: this.jobs, reference: this.referenceId ? this.references.get(this.referenceId) || null : null });
  }

  connection(): MediaConfig { return { baseURL: this.config.baseURL, hasCredential: Boolean(this.config.credential) }; }

  configure(input: MediaConfigInput): MediaConfig {
    if (this.active) throw Error('生成期间不能更改图片服务配置');
    this.validateConfig(input);
    if (input.credential !== undefined && (typeof input.credential !== 'string' || input.credential.length > 16000)) throw Error('凭据格式无效');
    const config: SavedConfig = { schemaVersion: 2, baseURL: input.baseURL.trim().replace(/\/+$/, ''), credential: this.config.credential };
    if (input.credential !== undefined) {
      if (input.credential.trim()) {
        if (!this.adapters.secrets.available()) throw Error('系统安全存储不可用，未保存凭据');
        try { config.credential = this.adapters.secrets.encrypt(input.credential.trim()).toString('base64'); }
        catch { throw Error('系统安全存储未能加密凭据，未保存配置'); }
      } else delete config.credential;
    }
    this.atomic('config.json', JSON.stringify(config, null, 2) + '\n'); this.config = config;
    return this.connection();
  }

  async models(): Promise<string[]> {
    const config = this.config;
    if (!config.baseURL) throw Error('请先填写并保存图片服务地址');
    const response = await this.fetchOnce(this.endpoint('models', config), { headers: this.headers(config), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw await this.responseError('读取模型失败', response, config);
    const value = JSON.parse((await this.readLimited(response, 2 * 1024 * 1024)).toString('utf8')) as { data?: { id?: unknown }[] };
    if (!Array.isArray(value.data)) throw Error('服务未返回有效模型列表');
    return [...new Set(value.data.map(model => model.id).filter((id): id is string => typeof id === 'string'))].sort();
  }

  /** Accept an explicitly selected local image or the editor's final composited PNG. */
  addReference(png: Buffer): MediaServiceState {
    const normalized = this.normalize(png);
    const reference = this.saveImage(randomUUID(), normalized);
    this.references.set(reference.id, reference); this.referenceId = reference.id;
    this.persist(); return this.publish();
  }

  selectReference(id: string | null): MediaServiceState {
    if (id === null) this.referenceId = null;
    else {
      if (!validId(id) || !this.references.has(id)) throw Error('保存的参考图片不可用');
      this.readImage(id);
      this.referenceId = id;
    }
    this.persist(); return this.publish();
  }

  generate(input: ImageRequest): MediaServiceState {
    if (!input || !validId(input.requestId)) throw Error('生成请求标识无效');
    // An id remains consumed after a restart or failure: replay is never an implicit paid retry.
    if (this.jobs.some(job => job.requestId === input.requestId)) return this.snapshot();
    if (this.active || this.jobs.some(job => job.status === 'running')) throw Error('已有图片正在生成，请等待完成');
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 32000) throw Error('请填写描述（最多 32000 字符）');
    if (!validImageOptions(input)) throw Error('图片生成参数无效');
    if (input.background === 'transparent' && input.outputFormat === 'jpeg') throw Error('透明背景请选择 PNG 或 WebP');
    if (!input.presetId || typeof input.presetName !== 'string') throw Error('请选择生图预设');
    const reference = input.referenceId ? this.references.get(input.referenceId) : undefined;
    if (input.referenceId && !reference) throw Error('参考图片已不可用，请重新选择');
    const parent = reference && this.jobs.find(job => job.images?.some(image => image.id === reference.id));
    const now = new Date().toISOString();
    const job: MediaJob = { id: randomUUID(), requestId: input.requestId, prompt: input.prompt.trim(), aspect: input.aspect, destination: 'api',
      resolution: input.resolution, count: input.count, customSize: input.customSize && { ...input.customSize },
      presetId: input.presetId, presetName: input.presetName, generationModel: input.generationModel, editModel: input.editModel,
      quality: input.quality, background: input.background, outputFormat: input.outputFormat, status: 'running', createdAt: now, updatedAt: now,
      ...(reference ? { referenceId: reference.id, reference: structuredClone(reference) } : {}), ...(parent ? { parentId: parent.id } : {}) };
    this.jobs.unshift(job);
    try { this.persist(); } catch { this.jobs.shift(); throw Error('未能保存图片任务，尚未发送生成请求'); }
    // Install the active guard before publishing or scheduling any request work.
    this.active = Promise.resolve().then(() => this.run(job, structuredClone(this.config))).finally(() => { this.active = null; this.publish(); });
    return this.publish();
  }

  /** Result bytes stay in the main process. Only previews appear in public snapshots. */
  getImage(id: string, imageId?: string): Buffer {
    const job = this.jobs.find(job => job.id === id);
    const image = imageId ? job?.images?.find(image => image.id === imageId) : job?.images?.[0];
    if (!image) throw Error('图片结果不可用');
    return this.readImage(image.id);
  }

  remove(id: string): MediaServiceState {
    const job = this.jobs.find(job => job.id === id);
    if (!job) throw Error('图片任务不存在');
    if (job.status === 'running') throw Error('生成中的任务暂不能删除');
    const ids = new Set(job.images?.map(image => image.id) || []);
    if (this.jobs.some(other => other.status === 'running' && other.referenceId && ids.has(other.referenceId))) throw Error('此版本正在用作参考图，请等待生成完成');
    // Deleting a result releases its ownership; descendants and the selected draft still own their references.
    this.persist(this.jobs.filter(other => other !== job));
    return this.publish();
  }

  /** Test/host shutdown observation only. Hiding or closing a window never calls this. */
  async waitForIdle(): Promise<void> { await this.active; }

  private async run(job: MediaJob, config: SavedConfig): Promise<void> {
    try {
      const model = job.referenceId ? job.editModel : job.generationModel;
      if (!config.baseURL || !model) throw Error('请在设置 → 预设中配置 New API 地址和对应的生成／改图模型');
      const headers = this.headers(config);
      const prompt = job.renderedPrompt || job.prompt;
      const size = imageRequestSize(job);
      const options = { ...(size ? { size } : {}), ...(job.count ? { n: job.count } : {}), ...(job.quality && job.quality !== 'auto' ? { quality: job.quality } : {}), ...(job.background && job.background !== 'auto' ? { background: job.background } : {}), ...(job.outputFormat && job.outputFormat !== 'png' ? { output_format: job.outputFormat } : {}) };
      let body: BodyInit;
      if (job.referenceId) {
        const form = new FormData();
        form.set('model', model); form.set('prompt', prompt);
        for (const [name, value] of Object.entries(options)) form.set(name, String(value));
        form.set('image', new Blob([new Uint8Array(this.readImage(job.referenceId))], { type: 'image/png' }), 'reference.png');
        body = form;
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ model, prompt, ...options });
      }
      const response = await this.fetchOnce(this.endpoint(job.referenceId ? 'images/edits' : 'images/generations', config), { method: 'POST', headers, body, signal: AbortSignal.timeout(300000) });
      if (!response.ok) throw await this.responseError('图片请求失败', response, config);
      const bytes = await this.readLimited(response, MAX_JSON_BYTES);
      let payload: unknown;
      try { payload = JSON.parse(bytes.toString('utf8')); } catch { throw Error('图片服务返回了无效的 JSON'); }
      const data = (payload as { data?: unknown[] })?.data;
      if (!Array.isArray(data) || data.length < 1 || data.length > 4) throw Error('图片服务未返回有效结果（支持一次 1–4 张）');
      for (const item of data) {
      if (!item || typeof item !== 'object') throw Error('图片服务返回了无效的图片结果');
      const result = item as { b64_json?: unknown; url?: unknown };
      let image: Buffer;
      if (typeof result.b64_json === 'string' && result.b64_json) {
        if (result.b64_json.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.b64_json)) throw Error('图片解码失败：返回的 base64 图片无效或过大');
        image = Buffer.from(result.b64_json, 'base64');
      } else if (typeof result.url === 'string') {
        let url: URL;
        try { url = new URL(result.url); } catch { throw Error('图片服务返回的图片地址无效'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('图片服务返回的图片地址不受支持');
        // Returned URLs may target another host. Never forward the NAS credential to downloads.
        const downloaded = await this.fetchOnce(url.toString(), { signal: AbortSignal.timeout(60000) }, '下载图片');
        if (!downloaded.ok) throw await this.responseError('下载图片失败', downloaded, config);
        image = await this.readLimited(downloaded, MAX_IMAGE_BYTES, '下载图片');
      } else throw Error('图片服务未返回 base64 或图片 URL');
      let normalized: NormalizedMediaImage;
      try { normalized = this.normalize(image); } catch (error) { throw Error('图片解码失败：' + (error as Error).message); }
      const reference = this.saveImage(job.images?.length ? randomUUID() : job.id, normalized);
      this.references.set(reference.id, reference);
      (job.images ||= []).push(reference);
      this.persist();
      }
      if (job.count && data.length !== job.count) throw Error(`请求 ${job.count} 张，服务返回 ${data.length} 张`);
      job.status = 'succeeded'; job.updatedAt = new Date().toISOString();
      this.persist();
    } catch (error) {
      job.status = 'failed'; job.updatedAt = new Date().toISOString();
      job.error = error instanceof Error ? error.message : '图片生成失败；未自动重试';
      if (job.images?.length) job.error += `；已保留 ${job.images.length} 张结果`;
      // Never discard the prompt or frozen reference when an upstream request/download fails.
      try { this.persist(); } catch { job.error += '；任务状态未能写入磁盘'; }
    }
  }

  private normalize(bytes: Buffer): NormalizedMediaImage {
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw Error('图片为空或超过 64 MB');
    let normalized: NormalizedMediaImage;
    try { normalized = this.adapters.normalizeImage(bytes); } catch { throw Error('图片内容无法解码'); }
    if (!Buffer.isBuffer(normalized.png) || !normalized.png.length || normalized.png.length > MAX_IMAGE_BYTES || !Number.isSafeInteger(normalized.width) || !Number.isSafeInteger(normalized.height) || normalized.width < 1 || normalized.height < 1 || normalized.width > 16384 || normalized.height > 16384 || normalized.width * normalized.height > 100000000 || typeof normalized.thumbnail !== 'string' || !normalized.thumbnail.startsWith('data:image/png;base64,')) throw Error('图片内容或尺寸无效');
    return normalized;
  }
  private saveImage(id: string, image: NormalizedMediaImage): MediaReference {
    this.atomic(join('images', id + '.png'), image.png);
    return { id, width: image.width, height: image.height, thumbnail: image.thumbnail };
  }
  private readImage(id: string): Buffer {
    if (!validId(id) || !this.references.has(id)) throw Error('参考图片不可用');
    try { return readFileSync(this.imagePath(id)); } catch { throw Error('保存的图片文件不可读'); }
  }
  private imagePath(id: string) { return join(this.directory, 'images', id + '.png'); }
  private endpoint(path: string, config: SavedConfig) { return config.baseURL.replace(/\/+$/, '') + (config.baseURL.replace(/\/+$/, '').endsWith('/v1') ? '/' : '/v1/') + path; }
  private headers(config: SavedConfig): Record<string, string> {
    if (!config.credential) return {};
    if (!this.adapters.secrets.available()) throw Error('系统安全存储不可用，无法读取图片服务凭据');
    try { return { Authorization: 'Bearer ' + this.adapters.secrets.decrypt(Buffer.from(config.credential, 'base64')) }; }
    catch { throw Error('无法解密图片服务凭据，请在设置中重新保存'); }
  }
  private validateConfig(input: MediaConfigInput) {
    if (!input || typeof input.baseURL !== 'string') throw Error('图片服务配置无效');
    if (input.baseURL.trim()) {
      let url: URL;
      try { url = new URL(input.baseURL.trim()); } catch { throw Error('服务地址须为 HTTP 或 HTTPS URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('服务地址须为不含凭据、查询或片段的 HTTP/HTTPS URL');
    }
  }
  private async fetchOnce(url: string, init: RequestInit, stage = '图片请求'): Promise<Response> {
    try { return await this.request(url, { ...init, redirect: 'error' }); }
    catch { throw Error(stage === '下载图片' ? '下载图片连接失败或超时；生成请求已完成，未重新生成' : '图片服务连接失败或等待超时；请求结果未知，未自动重试，上游可能仍在处理'); }
  }
  private async responseError(stage: string, response: Response, config: SavedConfig): Promise<Error> {
    let raw = '';
    // Error bodies are untrusted and can include an HTML proxy page or echoed credentials.
    const reader = response.body?.getReader();
    if (reader) {
      const chunks: Buffer[] = []; let length = 0;
      try { while (length < 8192) { const part = await reader.read(); if (part.done) break; const bytes = Buffer.from(part.value).subarray(0, 8192 - length); chunks.push(bytes); length += bytes.length; } raw = Buffer.concat(chunks).toString('utf8'); }
      catch { /* HTTP status remains useful when the body is incomplete. */ }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
    let message = '', requestId = response.headers.get('x-request-id') || response.headers.get('request-id') || response.headers.get('x-oneapi-request-id') || '';
    try { const value = JSON.parse(raw); message = typeof value.error === 'string' ? value.error : value.error?.message || value.message || ''; requestId ||= value.request_id || value.error?.request_id || ''; }
    catch { if (!/<(?:html|!doctype|body)/i.test(raw)) message = raw; }
    const secret = this.headers(config).Authorization?.slice(7);
    const clean = (value: unknown) => {
      let text = typeof value === 'string' ? value : '';
      if (secret) text = text.split(secret).join('[已隐藏]');
      return text.replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [已隐藏]').replace(/sk-[\w-]+/g, '[已隐藏]')
        .replace(/([?&](?:key|api_key|token|access_token|signature)=)[^\s&"<>]+/gi, '$1[已隐藏]')
        .replace(/((?:api[_-]?key|access[_-]?token|authorization|credential)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[已隐藏]')
        .replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[已隐藏]@').replace(/[\u0000-\u001f]+/g, ' ').slice(0, 600);
    };
    const detail = clean(message), id = clean(requestId).slice(0, 160);
    return Error(`${stage}（HTTP ${response.status}）${detail ? '：' + detail : ''}${id ? '；请求标识：' + id : ''}；未自动重试`);
  }
  private async readLimited(response: Response, limit: number, stage = '图片服务'): Promise<Buffer> {
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw Error(stage + '响应超过大小限制'); }
    if (!response.body) throw Error(stage + '返回空响应');
    const reader = response.body.getReader(), chunks: Buffer[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > limit) { await reader.cancel(); throw Error(stage + '响应超过大小限制'); }
        chunks.push(Buffer.from(chunk.value));
      }
    } catch (error) {
      if (error instanceof Error && error.message === stage + '响应超过大小限制') throw error;
      throw Error(stage + '响应未完整接收；未自动重试');
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, length);
  }
  private persist(jobs = this.jobs) {
    const used = new Set<string>(this.referenceId ? [this.referenceId] : []);
    for (const job of jobs) {
      if (job.referenceId) used.add(job.referenceId);
      for (const image of job.images || []) used.add(image.id);
    }
    const references = [...this.references.values()].filter(image => used.has(image.id));
    this.atomic('results.json', JSON.stringify({ version: 1, jobs, references, referenceId: this.referenceId } satisfies SavedMedia, null, 2) + '\n');
    this.jobs = jobs;
    // Commit metadata before removing bytes, so a failed write never destroys a recoverable input.
    for (const id of this.references.keys()) if (!used.has(id)) {
      this.references.delete(id);
      if (existsSync(this.imagePath(id))) unlinkSync(this.imagePath(id));
    }
  }
  private atomic(file: string, data: string | Buffer) {
    const path = join(this.directory, file), temporary = path + '.tmp';
    writeFileSync(temporary, data, { mode: 0o600 }); renameSync(temporary, path);
  }
  private publish(): MediaServiceState { const snapshot = this.snapshot(); this.adapters.changed?.(snapshot); return snapshot; }
}
