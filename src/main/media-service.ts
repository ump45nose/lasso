import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mediaAspects, type MediaAspect, type MediaConfig, type MediaConfigInput, type MediaGenerateRequest, type MediaJob, type MediaReference, type MediaState } from '../shared/media';

/** Appearance comes from the host's current settings and is never stored with image jobs. */
type MediaServiceState = Omit<MediaState, 'fonts' | 'importedFonts'>;

export interface NormalizedMediaImage { png: Buffer; width: number; height: number; thumbnail: string }
export interface MediaServiceAdapters {
  /** The host supplies Electron safeStorage; no credential crosses into the renderer. */
  secrets: { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string };
  normalizeImage(buffer: Buffer): NormalizedMediaImage;
  fetch?: typeof fetch;
  changed?: (state: MediaServiceState) => void;
}
interface SavedConfig { baseURL: string; generationModel: string; editModel: string; credential?: string }
interface SavedMedia { version: 1; jobs: MediaJob[]; references: MediaReference[]; referenceId: string | null }
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 96 * 1024 * 1024;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const sizes: Record<MediaAspect, string> = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536' };

/** Owns durable image files and requests independently from windows and chat tasks. */
export class MediaService {
  private jobs: MediaJob[] = [];
  private references = new Map<string, MediaReference>();
  private referenceId: string | null = null;
  private config: SavedConfig = { baseURL: '', generationModel: '', editModel: '' };
  private active: Promise<void> | null = null;
  private readonly request: typeof fetch;

  constructor(private directory: string, private adapters: MediaServiceAdapters) {
    this.request = adapters.fetch || fetch;
    mkdirSync(join(directory, 'images'), { recursive: true, mode: 0o700 });
    const configPath = join(directory, 'config.json');
    if (existsSync(configPath)) {
      const value = JSON.parse(readFileSync(configPath, 'utf8')) as SavedConfig;
      this.validateConfig(value);
      if (value.credential !== undefined && typeof value.credential !== 'string') throw Error('图片服务凭据存储无效');
      this.config = value;
    }
    const storePath = join(directory, 'results.json');
    if (existsSync(storePath)) {
      const value = JSON.parse(readFileSync(storePath, 'utf8')) as SavedMedia;
      if (value.version !== 1 || !Array.isArray(value.jobs) || !Array.isArray(value.references)) throw Error('图片结果存储格式无效');
      if (!value.jobs.every(job => validId(job.id) && validId(job.requestId) && typeof job.prompt === 'string' && mediaAspects.includes(job.aspect) && ['running', 'succeeded', 'failed', 'interrupted'].includes(job.status))) throw Error('图片任务存储格式无效');
      if (!value.references.every(image => validId(image.id) && typeof image.thumbnail === 'string' && Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height))) throw Error('图片引用存储格式无效');
      this.jobs = value.jobs;
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
    const config: MediaConfig = { baseURL: this.config.baseURL, generationModel: this.config.generationModel, editModel: this.config.editModel, hasCredential: Boolean(this.config.credential) };
    return structuredClone({ jobs: this.jobs, reference: this.referenceId ? this.references.get(this.referenceId) || null : null, config });
  }

  configure(input: MediaConfigInput): MediaServiceState {
    if (this.active) throw Error('生成期间不能更改图片服务配置');
    this.validateConfig(input);
    if (input.credential !== undefined && (typeof input.credential !== 'string' || input.credential.length > 16000)) throw Error('凭据格式无效');
    const config: SavedConfig = { baseURL: input.baseURL.trim().replace(/\/+$/, ''), generationModel: input.generationModel.trim(), editModel: input.editModel.trim(), credential: this.config.credential };
    if (input.credential !== undefined) {
      if (input.credential.trim()) {
        if (!this.adapters.secrets.available()) throw Error('系统安全存储不可用，未保存凭据');
        try { config.credential = this.adapters.secrets.encrypt(input.credential.trim()).toString('base64'); }
        catch { throw Error('系统安全存储未能加密凭据，未保存配置'); }
      } else delete config.credential;
    }
    this.atomic('config.json', JSON.stringify(config, null, 2) + '\n');
    this.config = config;
    return this.publish();
  }

  async checkConnection(): Promise<{ message: string }> {
    const config = this.config;
    if (!config.baseURL) throw Error('请先填写并保存图片服务地址');
    const response = await this.fetchOnce(this.endpoint('models', config), { headers: this.headers(config), signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw Error(`连接检查失败（HTTP ${response.status}）`); }
    await response.body?.cancel();
    return { message: '服务连接正常；生成/改图能力以实际请求为准。' };
  }

  /** Accept only the host editor's final composited PNG, never a screenshot backdrop. */
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

  generate(input: MediaGenerateRequest): MediaServiceState {
    if (!input || !validId(input.requestId)) throw Error('生成请求标识无效');
    // An id remains consumed after a restart or failure: replay is never an implicit paid retry.
    if (this.jobs.some(job => job.requestId === input.requestId)) return this.snapshot();
    if (this.active || this.jobs.some(job => job.status === 'running')) throw Error('已有图片正在生成，请等待完成');
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 24000) throw Error('请填写描述（最多 24000 字符）');
    if (!mediaAspects.includes(input.aspect)) throw Error('不支持的图片比例');
    const reference = input.referenceId ? this.references.get(input.referenceId) : undefined;
    if (input.referenceId && !reference) throw Error('参考图片已不可用，请重新选择');
    const parent = reference && this.jobs.find(job => job.id === reference.id && job.status === 'succeeded');
    if (input.parentId !== undefined && (!parent || parent.id !== input.parentId)) throw Error('父版本与所选参考图不符');
    const now = new Date().toISOString();
    const job: MediaJob = { id: randomUUID(), requestId: input.requestId, prompt: input.prompt.trim(), aspect: input.aspect, status: 'running', createdAt: now, updatedAt: now,
      ...(reference ? { referenceId: reference.id, reference: structuredClone(reference) } : {}), ...(parent ? { parentId: parent.id } : {}) };
    this.jobs.unshift(job);
    try { this.persist(); } catch { this.jobs.shift(); throw Error('未能保存图片任务，尚未发送生成请求'); }
    // Install the active guard before publishing or scheduling any request work.
    this.active = Promise.resolve().then(() => this.run(job, structuredClone(this.config))).finally(() => { this.active = null; this.publish(); });
    return this.publish();
  }

  /** Result bytes stay in the main process. Only previews appear in public snapshots. */
  getImage(id: string): Buffer {
    const job = this.jobs.find(job => job.id === id && job.status === 'succeeded');
    if (!job?.image) throw Error('图片结果不可用');
    return this.readImage(id);
  }

  remove(id: string): MediaServiceState {
    const job = this.jobs.find(job => job.id === id);
    if (!job) throw Error('图片任务不存在');
    if (job.status === 'running') throw Error('生成中的任务暂不能删除');
    if (this.jobs.some(other => other.status === 'running' && other.referenceId === id)) throw Error('此版本正在用作参考图，请等待生成完成');
    const next = this.jobs.filter(other => other !== job);
    // Descendant metadata keeps parentId/reference previews; removing one result never removes its descendants.
    this.atomic('results.json', JSON.stringify({ version: 1, jobs: next, references: [...this.references.values()].filter(image => image.id !== id), referenceId: this.referenceId === id ? null : this.referenceId }, null, 2) + '\n');
    this.jobs = next; this.references.delete(id); if (this.referenceId === id) this.referenceId = null;
    if (existsSync(this.imagePath(id))) unlinkSync(this.imagePath(id));
    return this.publish();
  }

  /** Test/host shutdown observation only. Hiding or closing a window never calls this. */
  async waitForIdle(): Promise<void> { await this.active; }

  private async run(job: MediaJob, config: SavedConfig): Promise<void> {
    try {
      if (!config.baseURL || !(job.referenceId ? config.editModel : config.generationModel)) throw Error('请先保存服务地址和对应的生成/改图模型');
      const model = job.referenceId ? config.editModel : config.generationModel;
      const headers = this.headers(config);
      let body: BodyInit;
      if (job.referenceId) {
        const form = new FormData();
        form.set('model', model); form.set('prompt', job.prompt); form.set('size', sizes[job.aspect]); form.set('n', '1');
        form.set('image', new Blob([new Uint8Array(this.readImage(job.referenceId))], { type: 'image/png' }), 'reference.png');
        body = form;
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ model, prompt: job.prompt, size: sizes[job.aspect], n: 1 });
      }
      const response = await this.fetchOnce(this.endpoint(job.referenceId ? 'images/edits' : 'images/generations', config), { method: 'POST', headers, body, signal: AbortSignal.timeout(300000) });
      if (!response.ok) { await response.body?.cancel(); throw Error(`图片请求失败（HTTP ${response.status}）；未自动重试`); }
      const bytes = await this.readLimited(response, MAX_JSON_BYTES);
      let payload: unknown;
      try { payload = JSON.parse(bytes.toString('utf8')); } catch { throw Error('图片服务返回了无效的 JSON'); }
      const data = (payload as { data?: unknown[] })?.data;
      if (!Array.isArray(data) || data.length !== 1 || !data[0] || typeof data[0] !== 'object') throw Error('图片服务必须返回一张图片');
      const result = data[0] as { b64_json?: unknown; url?: unknown };
      let image: Buffer;
      if (typeof result.b64_json === 'string' && result.b64_json) {
        if (result.b64_json.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.b64_json)) throw Error('图片服务返回的 base64 图片无效或过大');
        image = Buffer.from(result.b64_json, 'base64');
      } else if (typeof result.url === 'string') {
        let url: URL;
        try { url = new URL(result.url); } catch { throw Error('图片服务返回的图片地址无效'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('图片服务返回的图片地址不受支持');
        // Returned URLs may target another host. Never forward the NAS credential to downloads.
        const downloaded = await this.fetchOnce(url.toString(), { signal: AbortSignal.timeout(60000) });
        if (!downloaded.ok) { await downloaded.body?.cancel(); throw Error(`下载结果失败（HTTP ${downloaded.status}）；未自动重试`); }
        image = await this.readLimited(downloaded, MAX_IMAGE_BYTES);
      } else throw Error('图片服务未返回 base64 或图片 URL');
      const reference = this.saveImage(job.id, this.normalize(image));
      this.references.set(reference.id, reference);
      job.image = reference; job.status = 'succeeded'; job.updatedAt = new Date().toISOString();
      this.persist();
    } catch (error) {
      job.status = 'failed'; job.updatedAt = new Date().toISOString();
      job.error = error instanceof Error ? error.message : '图片生成失败；未自动重试';
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
  private validateConfig(input: MediaConfigInput | SavedConfig) {
    if (!input || typeof input.baseURL !== 'string' || typeof input.generationModel !== 'string' || typeof input.editModel !== 'string' || input.generationModel.length > 512 || input.editModel.length > 512) throw Error('图片服务配置无效');
    if (input.baseURL.trim()) {
      let url: URL;
      try { url = new URL(input.baseURL.trim()); } catch { throw Error('服务地址须为 HTTP 或 HTTPS URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('服务地址须为不含凭据、查询或片段的 HTTP/HTTPS URL');
    }
  }
  private async fetchOnce(url: string, init: RequestInit): Promise<Response> {
    try { return await this.request(url, { ...init, redirect: 'error' }); }
    catch { throw Error('图片服务连接失败或等待超时；请求结果未知，未自动重试，上游可能仍在处理'); }
  }
  private async readLimited(response: Response, limit: number): Promise<Buffer> {
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw Error('图片服务响应超过大小限制'); }
    if (!response.body) throw Error('图片服务返回空响应');
    const reader = response.body.getReader(), chunks: Buffer[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > limit) { await reader.cancel(); throw Error('图片服务响应超过大小限制'); }
        chunks.push(Buffer.from(chunk.value));
      }
    } catch (error) {
      if (error instanceof Error && error.message === '图片服务响应超过大小限制') throw error;
      throw Error('图片服务响应未完整接收；未自动重试');
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, length);
  }
  private persist() { this.atomic('results.json', JSON.stringify({ version: 1, jobs: this.jobs, references: [...this.references.values()], referenceId: this.referenceId } satisfies SavedMedia, null, 2) + '\n'); }
  private atomic(file: string, data: string | Buffer) {
    const path = join(this.directory, file), temporary = path + '.tmp';
    writeFileSync(temporary, data, { mode: 0o600 }); renameSync(temporary, path);
  }
  private publish(): MediaServiceState { const snapshot = this.snapshot(); this.adapters.changed?.(snapshot); return snapshot; }
}
