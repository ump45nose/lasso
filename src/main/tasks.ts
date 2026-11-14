import { app, BrowserWindow, WebContentsView, clipboard } from 'electron';
import type { Rectangle, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { ChatGPTAdapter, isRestoredPage, type PageSnapshot } from './adapters/chatgpt';
import { GeminiAdapter } from './adapters/gemini';
import { revealPage } from './motion';
import { Images, type ImageInput } from './images';
import type { MediaService, ChatCompletionMessage } from './media-service';
import { isIdleCandidate } from './task-policy';
import { idleMilliseconds } from '../shared/memory';
import type {
  ApiChatEvent,
  ApiChatMessage,
  ApiChatState,
  DeliveryStatus,
  DeliveryStep,
  ExecutionCatalog,
  LaunchOptions,
  Preset,
  Settings,
  ShellState,
  Target,
  TaskActivity,
  TaskSummary,
  WebTarget
} from '../shared/contracts';

const homes: Record<WebTarget, string> = {
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/app'
};
type Standby = { task: Task; busy: boolean; expires?: ReturnType<typeof setTimeout> };
const partition = (target: WebTarget) => 'persist:' + target;

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      })
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

const webAdapter = (target: WebTarget, contents: WebContents) =>
  target === 'gemini' ? new GeminiAdapter(contents) : new ChatGPTAdapter(contents);

class ApiChatSession {
  revision = 1;
  connectionId: string;
  model: string;
  messages: ApiChatMessage[] = [];
  draft = '';
  pendingImage: ImageInput | null = null;
  running = false;
  error: string | null = null;
  private controller: AbortController | null = null;
  private messageImages = new Map<string, ImageInput>();

  constructor(
    readonly taskId: string,
    connectionId: string,
    model: string,
    private images: Images,
    private mediaService: () => MediaService,
    private onChanged: (titleCandidate?: string) => void
  ) {
    this.connectionId = connectionId;
    this.model = model;
  }

  get activity(): TaskActivity {
    if (this.running) return 'running';
    if (this.error) return 'error';
    if (this.draft.trim() || this.pendingImage) return 'draft';
    if (this.messages.length > 0) return 'complete';
    return 'idle';
  }

  snapshot(): ApiChatState {
    return {
      revision: this.revision,
      taskId: this.taskId,
      connectionId: this.connectionId,
      model: this.model,
      messages: this.messages.map(m => ({ ...m, ...(m.image ? { image: { ...m.image } } : {}) })),
      draft: this.draft,
      image: this.pendingImage ? this.images.preview(this.pendingImage) : null,
      running: this.running,
      error: this.error
    };
  }

  private bump(titleCandidate?: string) {
    this.revision++;
    this.onChanged(titleCandidate);
  }

  setDraft(text: string) {
    this.draft = text;
    this.bump();
  }

  setImage(image: ImageInput | null) {
    if (this.pendingImage && this.pendingImage.id !== image?.id) {
      this.images.remove(this.pendingImage);
    }
    this.pendingImage = image;
    this.bump();
  }

  setModel(connectionId: string, model: string) {
    this.connectionId = connectionId.trim();
    this.model = model.trim();
    this.error = null;
    this.bump();
  }

  clearContext() {
    this.stop();
    for (const img of this.messageImages.values()) this.images.remove(img);
    this.messageImages.clear();
    this.messages = [];
    this.error = null;
    this.bump();
  }

  seed(userText: string, assistantText: string) {
    this.messages = [
      { id: randomUUID(), role: 'user', text: userText },
      { id: randomUUID(), role: 'assistant', text: assistantText }
    ];
    this.bump();
  }

  stop() {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    if (this.running) {
      this.running = false;
      const last = this.messages.at(-1);
      if (last?.streaming) last.streaming = false;
      this.bump();
    }
  }

  async send(): Promise<void> {
    if (this.running) throw Error('正在生成回答，请稍候或先停止');
    const text = this.draft.trim();
    const attached = this.pendingImage;
    if (!text && !attached) throw Error('请输入问题或添加图片');
    if (!this.connectionId || !this.model) {
      throw Error('请先在顶栏选择 API 连接与模型（可在「设置 → 模型与 API 连接」中添加）');
    }
    const userMsgId = randomUUID();
    const userMsg: ApiChatMessage = {
      id: userMsgId,
      role: 'user',
      text: text || '请分析这张图片',
      ...(attached ? { image: this.images.preview(attached) } : {})
    };
    if (attached) {
      this.messageImages.set(userMsgId, attached);
      this.pendingImage = null;
    }
    this.draft = '';
    this.error = null;
    const isFirstUser = !this.messages.some(m => m.role === 'user');
    this.messages.push(userMsg);
    await this.streamAssistant(isFirstUser ? userMsg.text : undefined);
  }

  async regenerate(messageId?: string): Promise<void> {
    if (this.running) this.stop();
    if (messageId) {
      const idx = this.messages.findIndex(m => m.id === messageId);
      if (idx >= 0) {
        const removed = this.messages.splice(idx);
        for (const m of removed) {
          const img = this.messageImages.get(m.id);
          if (img) {
            this.images.remove(img);
            this.messageImages.delete(m.id);
          }
        }
      }
    } else if (this.messages.at(-1)?.role === 'assistant') {
      this.messages.pop();
    }
    if (!this.messages.some(m => m.role === 'user')) return;
    this.error = null;
    await this.streamAssistant();
  }

  private buildPayloadMessages(): ChatCompletionMessage[] {
    return this.messages
      .filter(m => !m.streaming && (m.text.trim() || m.image))
      .map(m => {
        if (m.role === 'user' && m.image) {
          const img = this.messageImages.get(m.id);
          if (img) {
            try {
              const dataUrl = `data:image/png;base64,${this.images.base64(img)}`;
              return {
                role: 'user' as const,
                content: [
                  { type: 'text' as const, text: m.text },
                  { type: 'image_url' as const, image_url: { url: dataUrl } }
                ]
              };
            } catch {
              // Fallback to text if temp image was removed
            }
          }
        }
        return { role: m.role, content: m.text };
      });
  }

  private async streamAssistant(titleCandidate?: string) {
    const payload = this.buildPayloadMessages();
    const replyId = randomUUID();
    const reply: ApiChatMessage = { id: replyId, role: 'assistant', text: '', streaming: true, firstTokenMs: null };
    this.messages.push(reply);
    this.running = true;
    const controller = (this.controller = new AbortController());
    this.bump(titleCandidate);
    try {
      const result = await this.mediaService().streamChatMessages(
        { connectionId: this.connectionId, model: this.model, messages: payload, signal: controller.signal },
        (partialText, firstTokenMs) => {
          if (this.controller !== controller) return;
          reply.text = partialText;
          reply.firstTokenMs = firstTokenMs;
          this.bump();
        }
      );
      if (this.controller !== controller) return;
      reply.text = result.text;
      reply.firstTokenMs = result.firstTokenMs;
      reply.streaming = false;
    } catch (error) {
      if (controller.signal.aborted) {
        reply.streaming = false;
        if (!reply.text.trim()) this.messages = this.messages.filter(m => m.id !== replyId);
        return;
      }
      const msg = (error as Error).message || 'API 请求失败';
      reply.streaming = false;
      reply.error = msg;
      if (!reply.text.trim()) this.messages = this.messages.filter(m => m.id !== replyId);
      this.error = msg;
    } finally {
      if (this.controller === controller) {
        this.controller = null;
        this.running = false;
        this.bump();
      }
    }
  }

  latestAnswerText(): string {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'assistant' && m.text.trim()) return m.text.trim();
    }
    return '';
  }

  dispose() {
    this.stop();
    if (this.pendingImage) {
      this.images.remove(this.pendingImage);
      this.pendingImage = null;
    }
    for (const img of this.messageImages.values()) this.images.remove(img);
    this.messageImages.clear();
  }
}

interface Task {
  target: Target;
  apiChat: ApiChatSession | null;
  image: ImageInput | null;
  preset: Preset | null;
  filled: boolean;
  id: string;
  title: string;
  url: string;
  view: WebContentsView | null;
  visible: boolean;
  emulated: boolean;
  adapter: ChatGPTAdapter | null;
  loading: boolean;
  preparing: boolean;
  error: string | null;
  activity: TaskActivity;
  hasDraft: boolean;
  restoreUrl: string | null;
  savedResponseId: string | null;
  resumeUrl: string | null;
  lastActivityAt: number;
  observed: PageSnapshot | null;
  navigation: number;
  delivery: DeliveryStatus | null;
  steps: DeliveryStep[];
  pendingText: string;
  controller: AbortController | null;
  popups: Set<BrowserWindow>;
  retainedReason: string | null;
  retryReleaseAt: number;
  warmNavigation?: Promise<void>;
}

type TaskProjection = Pick<ShellState, 'tasks' | 'activeTaskId' | 'hasPage' | 'hostname' | 'loading' | 'pageError' | 'delivery' | 'activeTarget'>;

/** Owns task lifetime, web page residency, and native multi-turn API chat sessions. */
export class TaskManager {
  private standbys = new Map<WebTarget, Standby>();
  private disposed = false;
  private catalogs = new Map<string, Promise<ExecutionCatalog>>();
  private catalogTail = new Map<WebTarget, Promise<unknown>>();
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBounds: Rectangle = { x: 0, y: 80, width: 520, height: 560 };
  private projection = '';
  private apiTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private tasks = new Map<string, Task>();
  private activeId: string | null = null;
  private polling = false;
  private probe: { taskId: string; view: WebContentsView; nav: number; preview: WebContentsView; controller: AbortController } | null = null;
  private timer: ReturnType<typeof setInterval>;

  constructor(
    private window: BrowserWindow,
    private secure: (contents: WebContents) => void,
    private changed: () => void,
    private settings: () => Settings,
    private mediaService: () => MediaService,
    private images: Images,
    private apiChatChanged: (event: ApiChatEvent) => void
  ) {
    this.window.on('hide', () => { if (this.active) this.active.lastActivityAt = Date.now(); });
    this.window.on('minimize', () => { if (this.active) this.active.lastActivityAt = Date.now(); });
    this.timer = setInterval(() => void this.poll(), 3000);
  }

  private notify() {
    const projection = JSON.stringify(this.snapshot());
    if (projection !== this.projection) {
      this.projection = projection;
      this.changed();
    }
  }

  private emitApiChat(task: Task, immediate = false) {
    if (!task.apiChat) return;
    if (immediate) {
      const existing = this.apiTimers.get(task.id);
      if (existing) {
        clearTimeout(existing);
        this.apiTimers.delete(task.id);
      }
      this.apiChatChanged({ taskId: task.id, state: task.apiChat.snapshot() });
      this.notify();
      return;
    }
    if (!this.apiTimers.has(task.id)) {
      this.apiTimers.set(
        task.id,
        setTimeout(() => {
          this.apiTimers.delete(task.id);
          if (!this.tasks.has(task.id) || !task.apiChat) return;
          this.apiChatChanged({ taskId: task.id, state: task.apiChat.snapshot() });
          this.notify();
        }, 45)
      );
    }
  }

  private resolveDefaultApiBinding(preferredConnectionId?: string, preferredModel?: string): { connectionId: string; model: string } {
    const connections = this.mediaService().connections();
    const saved = this.settings().defaultApiChat;
    const byId = (id?: string) => (id ? connections.find(c => c.id === id) : undefined);
    const conn =
      byId(preferredConnectionId) ||
      byId(saved.connectionId) ||
      connections.find(c => c.hasCredential && c.models.length > 0) ||
      connections.find(c => c.hasCredential) ||
      connections[0];
    const connectionId = conn?.id || '';
    const model =
      (preferredModel && preferredModel.trim()) ||
      (conn && conn.id === saved.connectionId && saved.model.trim()) ||
      conn?.models[0] ||
      '';
    return { connectionId, model };
  }

  private scheduleWarm() {
    if (this.disposed) return;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => {
      this.warmTimer = null;
      this.warmPreferred();
    }, 800);
  }

  private discardStandby(target: WebTarget) {
    const standby = this.standbys.get(target);
    this.standbys.delete(target);
    if (standby) {
      clearTimeout(standby.expires);
      this.destroyPage(standby.task);
    }
  }

  private warmTargets() {
    const target = this.settings().lastTarget;
    return new Set<WebTarget>(target === 'chatgpt' || target === 'gemini' ? [target] : []);
  }

  warmPreferred() {
    if (this.disposed) return;
    const targets = this.warmTargets();
    for (const [target, standby] of this.standbys) {
      if (!targets.has(target) && !standby.busy) this.discardStandby(target);
    }
    for (const target of targets) {
      const active = this.active;
      if (active?.target !== target || (!active.loading && !active.preparing)) this.getStandby(target);
    }
  }

  private get idleMs() {
    return idleMilliseconds(this.settings().memory);
  }

  memoryChanged() {
    for (const [target, standby] of this.standbys) this.armExpiry(target, standby);
    void this.poll();
  }

  private armExpiry(target: WebTarget, standby: Standby) {
    clearTimeout(standby.expires);
    if (!Number.isFinite(this.idleMs)) return;
    standby.expires = setTimeout(() => {
      if (this.standbys.get(target) === standby && !standby.busy) this.discardStandby(target);
    }, Math.max(0, standby.task.lastActivityAt + this.idleMs - Date.now()));
  }

  private getStandby(target: WebTarget) {
    const existing = this.standbys.get(target);
    if (existing && (existing.busy || (!existing.task.error && existing.task.view && !existing.task.view.webContents.isDestroyed()))) {
      existing.task.lastActivityAt = Date.now();
      this.armExpiry(target, existing);
      return existing;
    }
    this.discardStandby(target);
    const task = this.makeTask('待命', true, { target });
    this.attach(task);
    task.view!.setBounds(this.lastBounds);
    task.view!.webContents.setBackgroundThrottling(true);
    task.warmNavigation = this.navigate(task, homes[target]);
    void task.warmNavigation.catch(() => {});
    const standby: Standby = { task, busy: false };
    this.standbys.set(target, standby);
    this.armExpiry(target, standby);
    return standby;
  }

  private sizeHiddenPage(task: Task) {
    const size = { width: this.lastBounds.width, height: this.lastBounds.height };
    task.view!.webContents.enableDeviceEmulation({
      screenPosition: 'desktop',
      screenSize: size,
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 0,
      viewSize: size,
      scale: 1
    });
    task.emulated = true;
  }

  executionCatalog(target: WebTarget, model = '', refresh = false): Promise<ExecutionCatalog> {
    const key = JSON.stringify([target, model, refresh]);
    const pending = this.catalogs.get(key);
    if (pending) return pending;
    const request = (this.catalogTail.get(target) || Promise.resolve())
      .catch(() => {})
      .then(() => {
        if (this.disposed) throw new Error('窗口已关闭');
        return this.readCatalog(target, model, refresh);
      });
    this.catalogs.set(key, request);
    this.catalogTail.set(target, request);
    void request
      .finally(() => {
        if (this.catalogs.get(key) === request) this.catalogs.delete(key);
        if (this.catalogTail.get(target) === request) this.catalogTail.delete(target);
      })
      .catch(() => {});
    return request;
  }

  private async readCatalog(target: WebTarget, model: string, refresh: boolean): Promise<ExecutionCatalog> {
    const standby = this.getStandby(target);
    if (standby.busy) throw new Error('正在读取模型选项，请稍后重试。');
    standby.busy = true;
    standby.task.view!.webContents.setBackgroundThrottling(false);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('网页模型菜单准备超时，请等待网站加载完成后刷新。')), 30_000);
    try {
      await abortable(standby.task.warmNavigation!, controller.signal);
      this.sizeHiddenPage(standby.task);
      const snapshot = await abortable(standby.task.adapter!.snapshot(), controller.signal);
      if (snapshot.login) throw new Error('请先打开这个目标并完成网页登录，再刷新选项。');
      await standby.task.adapter!.waitReady(controller.signal, () => {});
      return await standby.task.adapter!.catalog(model, controller.signal, refresh);
    } finally {
      clearTimeout(timeout);
      standby.busy = false;
      clearTimeout(standby.expires);
      if (this.standbys.get(target) === standby && (controller.signal.aborted || !this.warmTargets().has(target))) {
        this.discardStandby(target);
      } else if (this.standbys.get(target) === standby) {
        standby.task.view?.webContents.setBackgroundThrottling(true);
        this.armExpiry(target, standby);
      }
    }
  }

  private get active() {
    return this.activeId ? this.tasks.get(this.activeId) : undefined;
  }

  private status(task: Task): TaskActivity {
    if (task.apiChat) return task.apiChat.activity;
    if (task.error) return 'error';
    if (task.controller) return task.delivery?.phase === 'login' ? 'waiting' : 'loading';
    return task.loading ? 'loading' : task.activity;
  }

  snapshot(): TaskProjection {
    const active = this.active;
    const tasks: TaskSummary[] = [...this.tasks.values()].map(task => ({
      id: task.id,
      target: task.target,
      title: task.title,
      activity: this.status(task),
      residency: task.apiChat || task.view ? 'resident' : 'released',
      retainedReason: task.retainedReason
    }));
    return {
      tasks,
      activeTaskId: this.activeId,
      activeTarget: active?.target || null,
      hasPage: Boolean(active),
      hostname: active?.apiChat ? 'api' : active ? new URL(active.url).hostname : 'chatgpt.com',
      loading: Boolean(active?.loading || active?.preparing),
      pageError: active?.error || null,
      delivery: active?.delivery || null
    };
  }

  layout(bounds: Rectangle, visible: boolean) {
    const resized = this.lastBounds.width !== bounds.width || this.lastBounds.height !== bounds.height;
    this.lastBounds = bounds;
    for (const standby of this.standbys.values()) {
      standby.task.view?.setBounds(bounds);
      if (resized && standby.task.emulated && standby.task.view) this.sizeHiddenPage(standby.task);
    }
    for (const task of this.tasks.values()) {
      if (!task.view) continue;
      task.view.setBounds(bounds);
      const show = visible && task.id === this.activeId && !task.error && !task.preparing && !task.apiChat;
      if (show !== task.visible) {
        task.visible = show;
        task.view.setVisible(show);
        if (show && task.emulated) {
          task.view.webContents.disableDeviceEmulation();
          task.emulated = false;
        }
        if (show && !task.loading) revealPage(task.view.webContents);
      }
    }
  }

  focus() {
    const task = this.active;
    if (task && !task.apiChat && !task.view) {
      this.select(task.id);
      this.layout(this.lastBounds, true);
    }
    this.active?.view?.webContents.focus();
  }

  async capture(): Promise<string | null> {
    const view = this.active?.visible ? this.active.view : null;
    if (!view || view.webContents.isDestroyed()) return null;
    const image = await view.webContents.capturePage().catch(() => null);
    return image && !image.isEmpty() ? 'data:image/jpeg;base64,' + image.toJPEG(82).toString('base64') : null;
  }

  private makeTask(title: string, preparing: boolean, options: LaunchOptions): Task {
    const target = options.target || this.settings().lastTarget;
    return {
      target,
      apiChat: null,
      image: null,
      preset: null,
      filled: false,
      id: randomUUID(),
      title,
      url: target === 'gemini' ? homes.gemini : homes.chatgpt,
      view: null,
      visible: false,
      emulated: false,
      adapter: null,
      loading: target !== 'api',
      preparing: target !== 'api' && preparing,
      error: null,
      activity: target === 'api' ? 'idle' : 'unknown',
      hasDraft: false,
      restoreUrl: null,
      savedResponseId: null,
      resumeUrl: null,
      lastActivityAt: Date.now(),
      observed: null,
      navigation: 0,
      delivery: null,
      steps: [],
      pendingText: '',
      controller: null,
      popups: new Set(),
      retainedReason: null,
      retryReleaseAt: 0
    };
  }

  private create(title = '新对话', preparing = false, options: LaunchOptions = {}) {
    const target = options.target || this.settings().lastTarget;
    let task: Task;
    const standby = target === 'chatgpt' || target === 'gemini' ? this.standbys.get(target) : undefined;
    if (standby && !standby.busy && !standby.task.error && standby.task.view && !standby.task.view.webContents.isDestroyed()) {
      task = standby.task;
      clearTimeout(standby.expires);
      this.standbys.delete(target as WebTarget);
      task.view!.setVisible(false);
      task.view!.webContents.setBackgroundThrottling(false);
      task.title = title;
      task.preparing = preparing;
    } else {
      task = this.makeTask(title, preparing, options);
    }
    if (this.active) this.active.lastActivityAt = Date.now();
    this.tasks.set(task.id, task);
    this.activeId = task.id;
    if (target === 'api') {
      task.loading = false;
      task.preparing = false;
      const binding = this.resolveDefaultApiBinding(options.connectionId, options.model);
      task.apiChat = new ApiChatSession(task.id, binding.connectionId, binding.model, this.images, this.mediaService, titleCandidate => {
        task.lastActivityAt = Date.now();
        if (titleCandidate && (task.title === '新对话' || task.title === 'API 对话')) {
          const compact = titleCandidate.replace(/\s+/g, ' ').trim();
          if (compact) task.title = compact.length > 22 ? compact.slice(0, 22) + '…' : compact;
        }
        this.emitApiChat(task);
      });
      if (options.imageId) {
        const img = this.images.get(options.imageId);
        if (img) task.apiChat.setImage(img);
      }
      if (options.prompt) {
        task.apiChat.setDraft(options.prompt);
        if (options.autoSend) void task.apiChat.send().catch(() => {});
      }
    } else if (!task.view) {
      this.attach(task);
    }
    this.notify();
    return task;
  }

  seedApiExchange(input: { title: string; connectionId: string; model: string; userText: string; assistantText: string }): string {
    const task = this.create(input.title || 'API 追问', false, {
      target: 'api',
      connectionId: input.connectionId,
      model: input.model
    });
    task.apiChat!.seed(input.userText, input.assistantText);
    this.emitApiChat(task, true);
    return task.id;
  }

  private attach(task: Task) {
    if (task.target === 'api') return;
    const view = new WebContentsView({
      webPreferences: {
        partition: partition(task.target),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    task.view = view;
    task.visible = false;
    task.adapter = webAdapter(task.target, view.webContents);
    task.loading = true;
    task.error = null;
    task.activity = 'unknown';
    task.observed = null;
    view.setBackgroundColor('#faf9f5');
    view.setVisible(false);
    this.window.contentView.addChildView(view);
    const contents = view.webContents;
    this.secure(contents);
    contents.on('dom-ready', () => {
      if (!task.visible && task.view && !contents.isDestroyed()) this.sizeHiddenPage(task);
    });
    contents.on('page-title-updated', (_event, title) => {
      if (title && title !== 'ChatGPT') task.title = title;
      this.notify();
    });
    contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (!isMainFrame) return;
      this.abortProbeFor(task.id);
      task.navigation++;
      task.restoreUrl = null;
      task.activity = 'unknown';
      task.observed = null;
      task.retainedReason = null;
      task.retryReleaseAt = 0;
      task.lastActivityAt = Date.now();
    });
    contents.on('did-start-loading', () => {
      task.loading = true;
      task.error = null;
      this.notify();
    });
    contents.on('did-stop-loading', () => {
      task.loading = false;
      this.notify();
      if (task.visible) revealPage(contents);
      void this.observe(task);
      if (this.tasks.has(task.id)) this.scheduleWarm();
    });
    const navigated = (url: string) => {
      task.url = url;
      this.notify();
    };
    contents.on('did-navigate', (_event, url) => navigated(url));
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (isMainFrame) navigated(url);
    });
    contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      task.error = `网页未能加载：${description}（${code}）`;
      task.loading = false;
      this.notify();
    });
    contents.on('render-process-gone', (_event, details) => {
      task.error = `网页进程已退出（${details.reason}），请重新加载。`;
      task.loading = false;
      task.controller?.abort();
      this.notify();
    });
    contents.on('did-create-window', popup => {
      task.popups.add(popup);
      task.lastActivityAt = Date.now();
      popup.on('closed', () => {
        task.popups.delete(popup);
        task.lastActivityAt = Date.now();
      });
    });
  }

  private navigate(task: Task, url: string): Promise<void> {
    this.abortProbeFor(task.id);
    task.url = url;
    const contents = task.view!.webContents;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ready = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const failed = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!contents.isDestroyed() && (error as NodeJS.ErrnoException).code !== 'ERR_ABORTED') {
          task.error = `网页未能加载：${(error as Error).message}`;
          task.loading = false;
          this.notify();
        }
        reject(error);
      };
      const cleanup = () => contents.removeListener('dom-ready', ready);
      contents.once('dom-ready', ready);
      void contents.loadURL(url).then(ready, failed);
    });
  }

  newChat(fresh = true, options: LaunchOptions = {}) {
    const task = this.create('新对话', fresh, options);
    if (task.apiChat) {
      this.emitApiChat(task, true);
      return task.id;
    }
    if (!fresh) {
      const navigation = task.warmNavigation ?? this.navigate(task, task.target === 'gemini' ? homes.gemini : homes.chatgpt);
      task.warmNavigation = undefined;
      void navigation.then(() => { if (this.tasks.has(task.id)) this.scheduleWarm(); }).catch(() => {});
      return task.id;
    }
    const controller = (task.controller = new AbortController());
    void this.prepareNew(task, controller.signal)
      .then(() => this.delivery(task, null))
      .catch(error => {
        if (!controller.signal.aborted) this.delivery(task, { phase: 'error', message: (error as Error).message, canCopy: false });
      })
      .finally(() => {
        task.preparing = false;
        if (task.controller === controller) task.controller = null;
        if (this.tasks.has(task.id)) {
          void this.observe(task);
          this.notify();
        }
      });
    return task.id;
  }

  openChat() {
    if (!this.active) this.newChat(false);
  }

  private async prepareNew(task: Task, signal: AbortSignal) {
    const temporary = task.preset?.temporaryChat === true;
    const home = task.target === 'gemini' ? homes.gemini : homes.chatgpt + (temporary ? '?temporary-chat=true' : '');
    if (task.warmNavigation) {
      await abortable(task.warmNavigation, signal);
      task.warmNavigation = undefined;
      if (temporary && task.target === 'chatgpt') await abortable(this.navigate(task, home), signal);
    } else {
      await abortable(this.navigate(task, home), signal);
    }
    signal.throwIfAborted();
    await task.adapter!.waitReady(signal, login => {
      task.preparing = !login;
      this.delivery(task, {
        phase: login ? 'login' : 'waiting',
        message: login ? '请先在网页中登录，登录后继续' : '正在准备新对话…',
        canCopy: Boolean(task.pendingText),
        step: 'open'
      });
    });
    await task.adapter!.clearNewDraft(signal);
    if (temporary) await task.adapter!.enableTemporary(signal);
    task.preparing = false;
    this.notify();
    this.scheduleWarm();
  }

  select(id: string) {
    const task = this.tasks.get(id);
    if (!task) return;
    this.abortProbeFor(task.id);
    if (this.active) this.active.lastActivityAt = Date.now();
    this.activeId = id;
    task.lastActivityAt = Date.now();
    if (task.apiChat) {
      this.emitApiChat(task, true);
    } else if (!task.view) {
      const url = task.restoreUrl!;
      this.attach(task);
      void this.restore(task, url);
    }
    this.notify();
  }

  private async restore(task: Task, url: string) {
    const controller = (task.controller = new AbortController());
    task.resumeUrl = url;
    task.steps = [];
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 30_000);
    this.delivery(task, { phase: 'waiting', message: '正在恢复原对话…', canCopy: false });
    try {
      await this.navigate(task, url);
      controller.signal.throwIfAborted();
      await task.adapter!.waitRestored(url, task.savedResponseId!, controller.signal);
      controller.signal.throwIfAborted();
      if (task.controller === controller) {
        task.resumeUrl = null;
        this.delivery(task, null);
      }
    } catch {
      if (task.controller === controller && (!controller.signal.aborted || timedOut)) {
        this.delivery(task, { phase: 'error', message: '原对话暂未恢复。可在网页重试，或重新加载原链接；不会重发提示词。', canCopy: false });
      }
    } finally {
      clearTimeout(timeout);
      if (task.controller === controller) task.controller = null;
      if (this.tasks.has(task.id)) {
        await this.observe(task);
        this.notify();
      }
    }
  }

  private delivery(task: Task, value: (Omit<DeliveryStatus, 'steps' | 'step'> & { step?: DeliveryStep }) | null) {
    if (!this.tasks.has(task.id)) return;
    task.delivery = value && { ...value, steps: task.steps, step: value.step && task.steps.includes(value.step) ? value.step : null };
    this.notify();
  }

  async runPreset(preset: Preset, text: string, options: LaunchOptions = {}): Promise<{ error: string | null }> {
    const target = options.target || preset.target;
    if (target === 'api') {
      const task = this.create(preset.name, false, {
        ...options,
        target: 'api',
        connectionId: options.connectionId || preset.connectionId,
        model: options.model || preset.model,
        imageId: options.imageId
      });
      task.apiChat!.setDraft(text);
      this.emitApiChat(task, true);
      if (preset.mode === 'send') {
        try {
          await task.apiChat!.send();
        } catch (error) {
          return { error: (error as Error).message };
        }
      }
      return { error: null };
    }
    const task = this.create(preset.name, true, { ...options, target });
    task.preset = task.target === preset.target ? preset : { ...preset, target: task.target, model: '', effort: '' };
    task.pendingText = text;
    task.image = options.imageId ? this.images.get(options.imageId) || null : null;
    task.steps = [
      'open',
      ...(task.preset.model || task.preset.effort ? ['model' as const] : []),
      'fill',
      ...(task.image ? ['upload' as const] : []),
      task.preset.mode === 'send' ? 'send' : 'edit'
    ];
    return this.deliverWeb(task, true);
  }

  private async deliverWeb(task: Task, fresh: boolean): Promise<{ error: string | null }> {
    const controller = (task.controller = new AbortController());
    const text = task.pendingText;
    let step: DeliveryStep = 'open';
    try {
      if (fresh) {
        this.delivery(task, { phase: 'waiting', message: '正在打开新对话…', canCopy: Boolean(text), step });
        await this.prepareNew(task, controller.signal);
      }
      const adapter = task.adapter!;
      if (!task.filled && (task.preset!.model || task.preset!.effort)) {
        step = 'model';
        this.delivery(task, { phase: 'waiting', message: '正在应用预设模型与思考强度…', canCopy: Boolean(text), step });
        await adapter.applyProfile(
          task.preset!,
          controller.signal,
          task.target === 'chatgpt'
            ? async model => {
                await this.executionCatalog('chatgpt', model);
              }
            : undefined
        );
      }
      if (!task.filled) {
        if (task.preset!.temporaryChat) await adapter.verifyTemporary(controller.signal);
        step = 'fill';
        if (text) {
          this.delivery(task, { phase: 'filling', message: `正在完整填入 ${text.length.toLocaleString()} 字…`, canCopy: true, step });
          await adapter.fill(text, controller.signal);
        }
        task.filled = true;
      }
      task.preparing = false;
      this.notify();
      if (task.image) {
        step = 'upload';
        this.delivery(task, { phase: 'filling', message: '正在上传图片…', canCopy: Boolean(text), step });
        await adapter.upload(task.image.path, controller.signal);
      }
      if (task.preset!.mode === 'send') {
        await adapter.verifyProfile(task.preset!, controller.signal);
        if (task.preset!.temporaryChat) await adapter.verifyTemporary(controller.signal);
        step = 'send';
        this.delivery(task, { phase: 'sending', message: '正在发送…', canCopy: Boolean(text), step });
        await adapter.submit(text, controller.signal);
        this.images.remove(task.image);
        task.image = null;
      }
      task.pendingText = '';
      this.delivery(task, {
        phase: task.preset!.mode === 'send' ? 'sent' : 'editing',
        message: task.preset!.mode === 'send' ? '已发送，可继续在网页追问' : '已填入，请在网页中编辑并发送',
        canCopy: false,
        step: task.preset!.mode === 'send' ? 'send' : 'edit'
      });
      return { error: null };
    } catch (error) {
      if (controller.signal.aborted) return { error: null };
      this.delivery(task, { phase: 'error', message: (error as Error).message, canCopy: Boolean(text), step });
      return { error: (error as Error).message };
    } finally {
      if (task.controller === controller) task.controller = null;
      task.preparing = false;
      if (this.tasks.has(task.id)) {
        await this.observe(task);
        this.notify();
      }
    }
  }

  async retryDelivery() {
    const task = this.active;
    if (!task?.preset || task.controller || task.apiChat) return;
    await this.deliverWeb(task, false);
  }

  private apiSession(id: string): ApiChatSession {
    const session = this.tasks.get(id)?.apiChat;
    if (!session) throw new Error('API 对话不存在');
    return session;
  }

  getApiChat(id: string): ApiChatState | null {
    const task = this.tasks.get(id);
    return task?.apiChat?.snapshot() || null;
  }

  apiChatDraft(id: string, text: string) {
    this.apiSession(id).setDraft(text);
  }

  apiChatSend(id: string) {
    return this.apiSession(id).send();
  }

  apiChatStop(id: string) {
    this.apiSession(id).stop();
  }

  apiChatRegenerate(id: string, messageId?: string) {
    return this.apiSession(id).regenerate(messageId);
  }

  apiChatClear(id: string) {
    this.apiSession(id).clearContext();
  }

  apiChatModel(id: string, connectionId: string, model: string) {
    this.apiSession(id).setModel(connectionId, model);
  }

  apiChatImage(id: string, image: ImageInput | null) {
    this.apiSession(id).setImage(image);
  }

  apiChatPendingImage(id: string): ImageInput | null {
    return this.apiSession(id).pendingImage;
  }

  apiChatLatestAnswer(id: string): string {
    return this.apiSession(id).latestAnswerText();
  }

  ensureActiveApiTask(): string {
    const active = this.active;
    if (active?.apiChat) return active.id;
    return this.newChat(true, { target: 'api' });
  }

  cancelDelivery() {
    const task = this.active;
    if (!task) return;
    task.controller?.abort();
    this.images.remove(task.image);
    task.image = null;
    task.pendingText = '';
    task.delivery = null;
    task.resumeUrl = null;
    this.notify();
  }

  dismissDelivery() {
    if (this.active && !this.active.controller) this.delivery(this.active, null);
  }

  copyPending() {
    if (this.active?.pendingText) clipboard.writeText(this.active.pendingText);
  }

  async reload() {
    const task = this.active;
    if (!task || task.apiChat) return;
    task.controller?.abort();
    if (task.resumeUrl) {
      void this.restore(task, task.resumeUrl);
      return;
    }
    this.delivery(task, task.pendingText ? { phase: 'error', message: '已取消待发送动作，原文仍可复制', canCopy: true } : null);
    if (task.view) void this.navigate(task, task.url).catch(() => {});
  }

  private async observe(task: Task): Promise<boolean> {
    if (!task.adapter || task.loading || task.error || !this.tasks.has(task.id)) return false;
    const view = task.view;
    const navigation = task.navigation;
    try {
      const snapshot = await task.adapter.snapshot();
      if (!this.tasks.has(task.id) || task.view !== view || task.navigation !== navigation || task.loading || task.error) return false;
      const old = task.observed;
      if (
        !old ||
        old.url !== snapshot.url ||
        old.activity !== snapshot.activity ||
        old.draft !== snapshot.draft ||
        old.hasDraft !== snapshot.hasDraft ||
        old.progress !== snapshot.progress ||
        old.responseId !== snapshot.responseId ||
        old.lastInputAt !== snapshot.lastInputAt
      ) {
        task.lastActivityAt = Date.now();
        task.retainedReason = null;
        task.retryReleaseAt = 0;
      }
      if (
        !task.controller &&
        task.resumeUrl &&
        task.savedResponseId &&
        old &&
        isRestoredPage(old, task.resumeUrl, task.savedResponseId) &&
        isRestoredPage(snapshot, task.resumeUrl, task.savedResponseId) &&
        old.progress === snapshot.progress
      ) {
        task.resumeUrl = null;
        task.delivery = null;
      }
      task.observed = snapshot;
      task.activity = snapshot.activity;
      task.hasDraft = snapshot.hasDraft;
      task.restoreUrl = snapshot.restoreUrl;
      task.url = snapshot.url;
      if (task.delivery?.phase === 'editing' && !snapshot.hasDraft && ['running', 'complete'].includes(snapshot.activity)) {
        task.delivery = null;
        this.images.remove(task.image);
        task.image = null;
      }
      this.notify();
      return true;
    } catch {
      if (this.tasks.has(task.id) && task.view === view && task.navigation === navigation) {
        task.activity = 'unknown';
        task.restoreUrl = null;
        this.notify();
      }
      return false;
    }
  }

  private isActiveVisible(task: Task) {
    return task.id === this.activeId && !this.window.isDestroyed() && this.window.isVisible() && !this.window.isMinimized() && !app.isHidden();
  }

  private eligible(task: Task) {
    return (
      this.tasks.has(task.id) &&
      !task.apiChat &&
      !task.preset?.temporaryChat &&
      isIdleCandidate(
        {
          active: this.isActiveVisible(task),
          resident: Boolean(task.view),
          activity: this.status(task),
          hasDraft: task.hasDraft,
          pending: Boolean(task.controller || task.pendingText || task.resumeUrl || task.image),
          hasPopup: task.popups.size > 0,
          restoreUrl: task.restoreUrl,
          lastActivityAt: task.lastActivityAt
        },
        Date.now(),
        this.idleMs
      )
    );
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const task of [...this.tasks.values()]) {
        if (task.apiChat) continue;
        if (!(await this.observe(task))) continue;
        if (!this.probe && this.eligible(task) && Date.now() >= task.retryReleaseAt) void this.releaseVerified(task);
      }
    } finally {
      this.polling = false;
    }
  }

  private async releaseVerified(task: Task) {
    if (task.target === 'api') return;
    const url = task.restoreUrl!;
    const responseId = task.observed?.responseId;
    if (!responseId) {
      task.retainedReason = '无法确认回答已保存，保留页面';
      task.retryReleaseAt = Date.now() + this.idleMs;
      this.notify();
      return;
    }
    const view = task.view!;
    const preview = new WebContentsView({
      webPreferences: {
        partition: partition(task.target),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    preview.setBounds(view.getBounds());
    preview.setVisible(false);
    this.window.contentView.addChildView(preview);
    this.secure(preview.webContents);
    preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const controller = new AbortController();
    const probeRef = { taskId: task.id, controller, view, nav: task.navigation, preview };
    this.probe = probeRef;
    const stop = () => {
      if (!preview.webContents.isDestroyed()) preview.webContents.stop();
    };
    controller.signal.addEventListener('abort', stop, { once: true });
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let verified = false;
    try {
      await abortable(preview.webContents.loadURL(url), controller.signal);
      const adapter = webAdapter(task.target, preview.webContents);
      await adapter.waitRestored(url, responseId, controller.signal);
      controller.signal.throwIfAborted();
      verified = true;
    } catch {
      // Keep original page alive if unavailable
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', stop);
      if (!preview.webContents.isDestroyed()) {
        if (!this.window.isDestroyed()) this.window.contentView.removeChildView(preview);
        preview.webContents.close();
      }
      if (this.probe === probeRef) this.probe = null;
    }
    if (!this.tasks.has(task.id) || this.isActiveVisible(task) || task.view !== probeRef.view || task.navigation !== probeRef.nav) return;
    task.retryReleaseAt = Date.now() + this.idleMs;
    if (!verified) {
      task.retainedReason = '恢复链接暂不可用，保留页面';
      this.notify();
      return;
    }
    if (
      (await this.observe(task)) &&
      !controller.signal.aborted &&
      !this.isActiveVisible(task) &&
      task.view === probeRef.view &&
      task.navigation === probeRef.nav &&
      task.activity !== 'running' &&
      task.activity !== 'waiting' &&
      this.eligible(task) &&
      task.restoreUrl === url &&
      task.observed?.responseId === responseId
    ) {
      task.savedResponseId = responseId;
      this.destroyPage(task);
      task.delivery = null;
      task.observed = null;
      task.retainedReason = null;
      this.notify();
    }
  }

  private abortProbeFor(id: string) {
    if (this.probe?.taskId === id) this.probe.controller.abort();
  }

  private destroyPage(task: Task) {
    this.abortProbeFor(task.id);
    task.controller?.abort();
    for (const popup of task.popups) popup.destroy();
    const view = task.view;
    task.view = null;
    task.visible = false;
    task.adapter = null;
    if (view) {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
      view.webContents.close();
    }
  }

  close(id: string) {
    const task = this.tasks.get(id);
    if (!task) return;
    this.abortProbeFor(task.id);
    const ids = [...this.tasks.keys()];
    const index = ids.indexOf(id);
    this.tasks.delete(id);
    const pendingTimer = this.apiTimers.get(id);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.apiTimers.delete(id);
    }
    task.apiChat?.dispose();
    this.images.remove(task.image);
    this.destroyPage(task);
    if (this.activeId === id) {
      this.activeId = null;
      const next = ids[index + 1] || ids[index - 1];
      if (next) this.select(next);
    }
    this.notify();
  }

  dispose() {
    this.disposed = true;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    for (const target of this.standbys.keys()) this.discardStandby(target);
    clearInterval(this.timer);
    if (this.probe) {
      this.probe.controller.abort();
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(this.probe.preview);
      this.probe.preview.webContents.close();
      this.probe = null;
    }
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    this.activeId = null;
    for (const task of tasks) {
      task.apiChat?.dispose();
      this.images.remove(task.image);
      this.destroyPage(task);
    }
    for (const timer of this.apiTimers.values()) clearTimeout(timer);
    this.apiTimers.clear();
  }
}
