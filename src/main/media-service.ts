import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { validImageOptions, validImageSize, imageRequestSize, type ApiConnection, type ApiConnectionInput, type ImageOptions, type MediaConfig, type MediaConfigInput, type MediaJob, type MediaReference } from '../shared/media';
import type { Preset, Settings } from '../shared/contracts';
import type { VisionServiceConfig } from '../shared/intelligence';
import { writeFileAtomic } from './files';

/** Appearance comes from the host's current settings and is never stored with image jobs. */
export interface MediaServiceState { jobs: MediaJob[]; reference: MediaReference | null }
export interface ImageRequest extends ImageOptions { connectionId?: string; requestId: string; prompt: string; presetId: string; presetName: string; referenceId?: string }

export interface NormalizedMediaImage { png: Buffer; width: number; height: number; thumbnail: string }
export type ChatMessageContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatMessageContentPart[];
}

export interface MediaServiceAdapters {
  /** The host supplies Electron safeStorage; no credential crosses into the renderer. */
  secrets: { available(): boolean; encrypt(value: string): Buffer; decrypt(value: Buffer): string };
  normalizeImage(buffer: Buffer): NormalizedMediaImage;
  changed: (state: MediaServiceState) => void;
  references?: () => { presets: readonly Preset[]; translation: Settings['translation']; vision: Settings['vision']; defaultApiChat?: Settings['defaultApiChat'] };
}
type SavedConnection = Omit<ApiConnection, 'hasCredential'> & { credential?: string };
interface SavedConfig { schemaVersion: 3; connections: SavedConnection[] }
export type LegacyVisionConfig = Partial<Omit<VisionServiceConfig, 'hasCredential'>> & { credential?: string };
export const legacyMediaConnectionId = 'conn-legacy-media';
export const legacyVisionConnectionId = 'conn-legacy-vision';
interface SavedMedia { version: 1; jobs: MediaJob[]; references: MediaReference[]; referenceId: string | null }
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 352 * 1024 * 1024;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);

/** Owns durable image files and requests independently from windows and chat tasks. */
export class MediaService {
  private jobs: MediaJob[] = [];
  private references = new Map<string, MediaReference>();
  private referenceId: string | null = null;
  private config: SavedConfig = { schemaVersion: 3, connections: [] };
  private active: Promise<void> | null = null;
  private referenceProvider?: MediaServiceAdapters['references'];

  constructor(private directory: string, private adapters: MediaServiceAdapters) {
    this.referenceProvider = adapters.references;
    mkdirSync(join(directory, 'images'), { recursive: true, mode: 0o700 });
    const configPath = join(directory, 'config.json');
    if (existsSync(configPath)) {
      const value = JSON.parse(readFileSync(configPath, 'utf8'));
      if (value.schemaVersion === 3) {
        if (!Array.isArray(value.connections)) throw Error('API 连接池存储无效');
        const ids = new Set<string>();
        for (const connection of value.connections) {
          this.validateConnection({ name: connection?.name, baseURL: connection?.baseURL, models: connection?.models });
          if (!validId(connection.id) || ids.has(connection.id) || !Array.isArray(connection.models) || (connection.credential !== undefined && typeof connection.credential !== 'string')) throw Error('API 连接存储无效');
          ids.add(connection.id);
        }
        this.config = value;
      } else if (value.schemaVersion === 2) {
        this.validateConfig(value);
        if (value.credential !== undefined && typeof value.credential !== 'string') throw Error('API 密钥存储无效');
        this.persistConnections([{ id: legacyMediaConnectionId, name: '原 API 服务', baseURL: value.baseURL, models: [], ...(value.credential !== undefined ? { credential: value.credential } : {}) }]);
      } else throw Error('请先迁移旧版生图预设，再加载 API 连接池');
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
        job.status = 'interrupted';
        job.error = '应用已重启，请求结果未知；不会自动重发。上游可能仍在处理。';
        interrupted = true;
      }
      if (interrupted) this.persist();
    }
  }

  snapshot(): MediaServiceState {
    return structuredClone({ jobs: this.jobs, reference: this.referenceId ? this.references.get(this.referenceId) || null : null });
  }

  connections(): ApiConnection[] { return this.config.connections.map(({ credential, ...connection }) => ({ ...connection, models: [...connection.models], hasCredential: Boolean(credential) })); }

  /** Legacy wrappers use the former media connection, or the first named connection. */
  connection(connectionId?: string): MediaConfig {
    const connection = this.savedConnection(connectionId, false);
    return { baseURL: connection?.baseURL || '', hasCredential: Boolean(connection?.credential) };
  }

  /** Main-process consumers only; renderer bridges expose connection() instead. */
  credential(connectionId?: string): string | undefined {
    const connection = this.savedConnection(connectionId, false);
    return connection ? this.decryptCredential(connection) : undefined;
  }

  setReferenceProvider(provider: NonNullable<MediaServiceAdapters['references']>): void { this.referenceProvider = provider; }

  presetConnectionId(presetId?: string): string | undefined {
    return presetId ? this.referenceProvider?.().presets.find(preset => preset.target === 'api' && preset.id === presetId)?.connectionId : undefined;
  }

  saveConnection(input: ApiConnectionInput): ApiConnection {
    if (this.active) throw Error('生成期间不能更改 API 连接');
    this.validateConnection(input);
    if (input.id !== undefined && !validId(input.id)) throw Error('API 连接标识无效');
    const existing = input.id ? this.config.connections.find(connection => connection.id === input.id) : undefined;
    if (input.id && !existing) throw Error('API 连接不存在');
    const connection: SavedConnection = { id: existing?.id || 'conn-' + randomUUID(), name: input.name.trim(), baseURL: input.baseURL.trim().replace(/\/+$/, ''), models: input.models ? [...new Set(input.models.map(model => model.trim()).filter(Boolean))] : [...(existing?.models || [])], ...(existing?.credential ? { credential: existing.credential } : {}) };
    if (input.credential !== undefined) {
      if (!input.credential.trim()) delete connection.credential;
      else {
        if (!this.adapters.secrets.available()) throw Error('系统安全存储不可用，未保存 API 密钥');
        try { connection.credential = this.adapters.secrets.encrypt(input.credential.trim()).toString('base64'); }
        catch { throw Error('系统安全存储未能加密 API 密钥，未保存配置'); }
      }
    }
    this.persistConnections(existing ? this.config.connections.map(item => item.id === existing.id ? connection : item) : [...this.config.connections, connection]);
    return this.connections().find(item => item.id === connection.id)!;
  }

  deleteConnection(id: string): ApiConnection[] {
    if (!validId(id) || !this.config.connections.some(connection => connection.id === id)) throw Error('API 连接不存在');
    if (this.active) throw Error('生成期间不能删除 API 连接');
    const references = this.referenceProvider?.();
    const usedBy: string[] = [];
    for (const preset of references?.presets || []) if (preset.target === 'api' && preset.connectionId === id) usedBy.push(`预设「${preset.name}」`);
    if (references?.translation.connectionId === id) usedBy.push('翻译服务');
    if (references?.vision.connectionId === id) usedBy.push('视觉服务');
    if (references?.defaultApiChat?.connectionId === id) usedBy.push('默认 API 对话');
    if (usedBy.length) throw Error('此 API 连接仍被' + usedBy.join('、') + '引用，请先修改绑定');
    this.persistConnections(this.config.connections.filter(connection => connection.id !== id));
    return this.connections();
  }

  /** Copy ciphertext verbatim before returning any bindings for the host to persist. Safe to retry after any interrupted write. */
  migrateLegacyBindings(settings: Settings, presets: Preset[], legacyVision: LegacyVisionConfig = {}): { settings: Settings; presets: Preset[] } {
    const connections = [...this.config.connections];
    if (!connections.length) connections.push({ id: legacyMediaConnectionId, name: '原 API 服务', baseURL: '', models: [] });
    const media = connections.find(connection => connection.id === legacyMediaConnectionId) || connections[0];
    const vision = { ...legacyVision, ...settings.vision };
    const visionBaseURL = vision.baseURL?.trim().replace(/\/+$/, '') || '';
    const independentVision = vision.useMediaCredential === false || Boolean(visionBaseURL && visionBaseURL !== media.baseURL.replace(/\/+$/, ''));
    const visionId = independentVision ? legacyVisionConnectionId : media.id;
    if (!settings.vision.connectionId && independentVision && !connections.some(connection => connection.id === visionId)) {
      const credential = vision.useMediaCredential === false ? legacyVision.credential : media.credential;
      const connection: SavedConnection = { id: visionId, name: '原视觉服务', baseURL: visionBaseURL || (vision.useMediaCredential !== false ? media.baseURL : ''), models: vision.model ? [vision.model] : [], ...(credential !== undefined ? { credential } : {}) };
      this.validateConnection({ name: connection.name, baseURL: connection.baseURL, models: connection.models });
      connections.push(connection);
    }
    this.persistConnections(connections);
    let jobsUpdated = false;
    for (const job of this.jobs) if ((!job.destination || job.destination === 'api') && !job.connectionId) {
      job.connectionId = media.id;
      jobsUpdated = true;
    }
    if (jobsUpdated) this.persist();
    return {
      settings: { ...settings, translation: { ...settings.translation, connectionId: settings.translation.connectionId || media.id }, vision: { ...settings.vision, connectionId: settings.vision.connectionId || visionId } },
      presets: presets.map(preset => preset.target === 'api' && !preset.connectionId ? { ...preset, connectionId: media.id } : preset)
    };
  }

  /** The legacy vision form owns a separate endpoint/key; its ciphertext never replaces the shared media connection. */
  saveLegacyVisionConnection(vision: LegacyVisionConfig): string {
    const connections = [...this.config.connections];
    if (!connections.length) connections.push({ id: legacyMediaConnectionId, name: '原 API 服务', baseURL: '', models: [] });
    const media = connections.find(connection => connection.id === legacyMediaConnectionId) || connections[0];
    const baseURL = vision.baseURL?.trim().replace(/\/+$/, '') || '';
    if (vision.useMediaCredential !== false && (!baseURL || baseURL === media.baseURL.replace(/\/+$/, ''))) {
      if (!this.config.connections.length) this.persistConnections(connections);
      return media.id;
    }
    if (this.active) throw Error('生成期间不能更改 API 连接');
    const existing = connections.find(connection => connection.id === legacyVisionConnectionId);
    const credential = vision.useMediaCredential === false ? vision.credential : media.credential;
    const connection: SavedConnection = { id: legacyVisionConnectionId, name: existing?.name || '原视觉服务', baseURL, models: existing?.models || (vision.model ? [vision.model] : []), ...(credential !== undefined ? { credential } : {}) };
    this.validateConnection(connection);
    this.persistConnections(existing ? connections.map(item => item.id === existing.id ? connection : item) : [...connections, connection]);
    return connection.id;
  }

  configure(input: MediaConfigInput): MediaConfig {
    this.validateConfig(input);
    const existing = this.savedConnection(undefined, false);
    this.saveConnection({ ...input, ...(existing ? { id: existing.id } : {}), name: existing?.name || 'API 服务' });
    return this.connection();
  }

  async models(connectionId?: string): Promise<string[]> {
    const config = this.savedConnection(connectionId)!;
    if (!config.baseURL) throw Error('请先填写并保存图片服务地址');
    const response = await this.fetchOnce(this.endpoint('models', config), { headers: this.headers(config), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw await this.responseError('读取模型失败', response, config);
    const value = JSON.parse((await this.readLimited(response, 2 * 1024 * 1024)).toString('utf8')) as { data?: { id?: unknown }[] };
    if (!Array.isArray(value.data)) throw Error('服务未返回有效模型列表');
    const models = [...new Set(value.data.map(model => model.id).filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 512))].sort();
    const current = this.config.connections.find(connection => connection.id === config.id);
    if (current) this.persistConnections(this.config.connections.map(connection => connection.id === config.id ? { ...current, models } : connection));
    return models;
  }

  /** Multi-turn SSE chat completion with optional vision image attachments. */
  async streamChatMessages(
    input: { connectionId?: string; model?: string; messages: ChatCompletionMessage[]; signal?: AbortSignal },
    onDelta: (text: string, firstTokenMs: number) => void
  ): Promise<{ text: string; model: string; firstTokenMs: number }> {
    const connectionId = input.connectionId?.trim();
    const model = input.model?.trim();
    if (!connectionId || !model) throw Error('请先在「设置 → 模型与 API 连接」中配置连接并选择模型');
    const config = this.savedConnection(connectionId)!;
    if (!config.baseURL) throw Error('请先在「设置 → 模型与 API 连接」中填写 Base URL 与密钥');
    const headers: Record<string, string> = { ...this.headers(config), 'Content-Type': 'application/json', Accept: 'text/event-stream' };
    const started = performance.now();
    let firstTokenMs = 0;
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000);
    const response = await this.fetchOnce(
      this.endpoint('chat/completions', config),
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, stream: true, messages: input.messages }),
        signal
      },
      'API 对话请求'
    );
    if (!response.ok) throw await this.responseError('API 对话请求失败', response, config);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream') || !response.body) {
      const bytes = await this.readLimited(response, 4 * 1024 * 1024, '读取 API 对话响应');
      const payload = JSON.parse(bytes.toString('utf8')) as { choices?: { message?: { content?: unknown } }[] };
      const text = typeof payload.choices?.[0]?.message?.content === 'string' ? payload.choices[0].message.content.trim() : '';
      if (!text) throw Error('服务未返回有效文本内容');
      firstTokenMs = Math.round(performance.now() - started);
      onDelta(text, firstTokenMs);
      return { text, model, firstTokenMs };
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (const raw of lines) {
          const line = raw.trim();
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data) as { choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[] };
            const chunk = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content;
            if (typeof chunk === 'string' && chunk) {
              if (!firstTokenMs) firstTokenMs = Math.round(performance.now() - started);
              full += chunk;
              onDelta(full, firstTokenMs);
            }
          } catch {}
        }
      }
    } finally {
      reader.releaseLock();
    }
    const text = full.trim();
    if (!text) throw Error('服务未返回有效文本内容');
    if (!firstTokenMs) firstTokenMs = Math.round(performance.now() - started);
    return { text, model, firstTokenMs };
  }

  /** Fast direct SSE chat completion for inline presets. */
  async streamChat(
    input: { connectionId?: string; model?: string; prompt: string; signal?: AbortSignal },
    onDelta: (text: string, firstTokenMs: number) => void
  ): Promise<{ text: string; model: string; firstTokenMs: number }> {
    return this.streamChatMessages(
      { connectionId: input.connectionId, model: input.model, messages: [{ role: 'user', content: input.prompt }], signal: input.signal },
      onDelta
    );
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
    const connectionId = input.connectionId || this.presetConnectionId(input.presetId);
    if (!connectionId) throw Error('API 连接不存在，请重新选择连接');
    const config = this.savedConnection(connectionId)!;
    const reference = input.referenceId ? this.references.get(input.referenceId) : undefined;
    if (input.referenceId && !reference) throw Error('参考图片已不可用，请重新选择');
    const parent = reference && this.jobs.find(job => job.images?.some(image => image.id === reference.id));
    const job: MediaJob = { id: randomUUID(), requestId: input.requestId, prompt: input.prompt.trim(), aspect: input.aspect, destination: 'api',
      resolution: input.resolution, count: input.count, customSize: input.customSize && { ...input.customSize },
      connectionId: config.id, presetId: input.presetId, presetName: input.presetName, generationModel: input.generationModel, editModel: input.editModel,
      quality: input.quality, background: input.background, outputFormat: input.outputFormat, status: 'running',
      ...(reference ? { referenceId: reference.id, reference: structuredClone(reference) } : {}), ...(parent ? { parentId: parent.id } : {}) };
    this.jobs.unshift(job);
    try { this.persist(); } catch { this.jobs.shift(); throw Error('未能保存图片任务，尚未发送生成请求'); }
    // Install the active guard before publishing or scheduling any request work.
    this.active = Promise.resolve().then(() => this.run(job, structuredClone(config))).finally(() => { this.active = null; this.publish(); });
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

  private async run(job: MediaJob, config: SavedConnection): Promise<void> {
    try {
      const model = job.referenceId ? job.editModel : job.generationModel;
      if (!config.baseURL || !model) throw Error('请在设置 → 预设中配置 API 地址和对应的生成／改图模型');
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
      job.status = 'succeeded';
      this.persist();
    } catch (error) {
      job.status = 'failed';
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
    writeFileAtomic(this.imagePath(id), image.png);
    return { id, width: image.width, height: image.height, thumbnail: image.thumbnail };
  }
  private readImage(id: string): Buffer {
    if (!validId(id) || !this.references.has(id)) throw Error('参考图片不可用');
    try { return readFileSync(this.imagePath(id)); } catch { throw Error('保存的图片文件不可读'); }
  }
  private imagePath(id: string) { return join(this.directory, 'images', id + '.png'); }
  private endpoint(path: string, config: SavedConnection) { return config.baseURL.replace(/\/+$/, '') + (config.baseURL.replace(/\/+$/, '').endsWith('/v1') ? '/' : '/v1/') + path; }
  private headers(config: SavedConnection): Record<string, string> {
    const credential = this.decryptCredential(config);
    return credential === undefined ? {} : { Authorization: 'Bearer ' + credential };
  }
  private decryptCredential(config: SavedConnection): string | undefined {
    if (!config.credential) return undefined;
    if (!this.adapters.secrets.available()) throw Error('系统安全存储不可用，无法读取 API 密钥');
    try { return this.adapters.secrets.decrypt(Buffer.from(config.credential, 'base64')); }
    catch { throw Error('无法解密 API 密钥，请在设置中重新保存'); }
  }
  private validateConfig(input: MediaConfigInput) {
    if (!input || typeof input.baseURL !== 'string') throw Error('图片服务配置无效');
    if (input.baseURL.trim()) {
      let url: URL;
      try { url = new URL(input.baseURL.trim()); } catch { throw Error('服务地址须为 HTTP 或 HTTPS URL'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('服务地址须为不含凭据、查询或片段的 HTTP/HTTPS URL');
    }
  }
  private validateConnection(input: ApiConnectionInput): void {
    this.validateConfig(input);
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 ||
      (input.credential !== undefined && (typeof input.credential !== 'string' || input.credential.length > 16000)) ||
      (input.models !== undefined && (!Array.isArray(input.models) || input.models.length > 10000 || input.models.some(model => typeof model !== 'string' || !model.trim() || model.length > 512)))) throw Error('API 连接名称、密钥或模型列表无效');
  }
  private savedConnection(id?: string, required = true): SavedConnection | undefined {
    const connection = id ? this.config.connections.find(connection => connection.id === id) : this.config.connections.find(connection => connection.id === legacyMediaConnectionId) || this.config.connections[0];
    if (!connection && (required || id)) throw Error(id ? 'API 连接不存在，请重新选择连接' : '请先配置 API 连接');
    return connection;
  }
  private persistConnections(connections: SavedConnection[]): void {
    const config: SavedConfig = { schemaVersion: 3, connections };
    writeFileAtomic(join(this.directory, 'config.json'), JSON.stringify(config, null, 2) + '\n');
    this.config = config;
  }
  private async fetchOnce(url: string, init: RequestInit, stage = '图片请求'): Promise<Response> {
    try { return await fetch(url, { ...init, redirect: 'error' }); }
    catch { throw Error(stage === '下载图片' ? '下载图片连接失败或超时；生成请求已完成，未重新生成' : '图片服务连接失败或等待超时；请求结果未知，未自动重试，上游可能仍在处理'); }
  }
  private async responseError(stage: string, response: Response, config: SavedConnection): Promise<Error> {
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
    writeFileAtomic(join(this.directory, 'results.json'), JSON.stringify({ version: 1, jobs, references, referenceId: this.referenceId } satisfies SavedMedia, null, 2) + '\n');
    this.jobs = jobs;
    // Commit metadata before removing bytes, so a failed write never destroys a recoverable input.
    for (const id of this.references.keys()) if (!used.has(id)) {
      this.references.delete(id);
      if (existsSync(this.imagePath(id))) unlinkSync(this.imagePath(id));
    }
  }
  private publish(): MediaServiceState { const snapshot = this.snapshot(); this.adapters.changed(snapshot); return snapshot; }
}
