import { BrowserWindow, WebContentsView, clipboard } from 'electron';
import type { Rectangle, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { ChatGPTAdapter, isRestoredPage } from './adapters/chatgpt';
import { GeminiAdapter } from './adapters/gemini';
import { WebProfile } from './adapters/web-profile';
import { AgentSession } from './agents/session';
import { CodexRuntime } from './agents/codex';
import { revealPage } from './motion';
import { Images, type ImageInput } from './images';
import type { PageSnapshot } from './adapters/chatgpt';
import { isIdleCandidate, IDLE_RELEASE_MS } from './task-policy';
import type { DeliveryStatus, DeliveryStep, Preset, ShellState, TaskActivity, TaskSummary, Target, LaunchOptions, Settings, AgentState, AgentAnswer, AgentEvent, ExecutionCatalog } from '../shared/contracts';

const homes = { chatgpt: 'https://chatgpt.com/', gemini: 'https://gemini.google.com/app' };
type WebTarget = keyof typeof homes;
type Standby = { task: Task; busy: boolean; expires?: ReturnType<typeof setTimeout> };
const partition = (target: Target) => 'persist:' + target;
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}
const webAdapter = (target: Target, contents: WebContents) => target === 'gemini' ? new GeminiAdapter(contents) : new ChatGPTAdapter(contents);
export const CHAT_PARTITION = 'persist:chatgpt';
interface Task {
  target: Target;
  agent: AgentSession | null;
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
type TaskProjection = Pick<ShellState, 'tasks' | 'activeTaskId' | 'hasPage' | 'title' | 'hostname' | 'loading' | 'pageError' | 'delivery' | 'activeTarget'>;

/** Owns task lifetime, page residency and each independent preset execution. */
export class TaskManager {
  private runtime = new CodexRuntime();
  private catalogSessions = new Set<AgentSession>();
  private standbys = new Map<WebTarget, Standby>();
  private disposed = false;
  private catalogs = new Map<string, Promise<ExecutionCatalog>>();
  private catalogTail = new Map<Target, Promise<unknown>>();
  private warmTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBounds: Rectangle = { x: 0, y: 80, width: 520, height: 560 };
  private projection = '';
  private deliveredAgents = new Map<string, { revision: number; metadata: Omit<AgentState, 'messages'>; messages: Map<string, AgentState['messages'][number]>; order: string[] }>();
  private agentTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private tasks = new Map<string, Task>();
  private activeId: string | null = null;
  private polling = false;
  private probe: { taskId: string; view: WebContentsView; controller: AbortController } | null = null;
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private window: BrowserWindow,
    private secure: (contents: WebContents) => void,
    private changed: () => void,
    private settings: () => Settings,
    private images: Images,
    private agentChanged: (event: AgentEvent) => void,
    private presets: () => Preset[]
  ) {
    this.timer = setInterval(() => void this.poll(), 3000);
  }
  private notify() {
    const projection = JSON.stringify(this.snapshot());
    if (projection !== this.projection) { this.projection = projection; this.changed(); }
  }
  private deliverAgent(task: Task, reset = false) {
    if (!task.agent || task.id !== this.activeId) return;
    const { messages, ...metadata } = task.agent.state;
    const previous = reset ? undefined : this.deliveredAgents.get(task.id);
    const patch: Partial<Omit<AgentState, 'messages'>> = {};
    for (const key of Object.keys(metadata) as (keyof typeof metadata)[]) {
      if (!previous || metadata[key] !== previous.metadata[key]) (patch as Record<string, unknown>)[key] = metadata[key];
    }
    const order = messages.map(m => m.id);
    const changedOrder = !previous || order.length !== previous.order.length || order.some((id, i) => id !== previous.order[i]);
    const changedMessages = messages.filter(m => !previous || m !== previous.messages.get(m.id));
    this.deliveredAgents.set(task.id, { revision: metadata.revision, metadata, messages: new Map(messages.map(m => [m.id, m])), order });
    this.agentChanged({ taskId: task.id, revision: metadata.revision, patch, messages: changedMessages, ...(changedOrder ? { order } : {}) });
  }
  private scheduleWarm() {
    if (this.disposed) return;
    if (this.warmTimer) clearTimeout(this.warmTimer);
    this.warmTimer = setTimeout(() => { this.warmTimer = null; this.warmPreferred(); }, 800);
  }
  private discardStandby(target: WebTarget) {
    const standby = this.standbys.get(target); this.standbys.delete(target);
    if (standby) { clearTimeout(standby.expires); this.destroyPage(standby.task); }
  }
  private warmTargets() {
    const targets = new Set<WebTarget>();
    for (const target of [this.settings().lastTarget, ...this.presets().filter(p => p.enabled).map(p => p.target)]) {
      if (target === 'api') continue;
      if (target === 'chatgpt' || target === 'gemini') targets.add(target);
    }
    return targets;
  }
  warmPreferred() {
    if (this.disposed) return;
    const targets = this.warmTargets();
    for (const [target, standby] of this.standbys) {
      if (!targets.has(target) && !standby.busy) this.discardStandby(target);
    }
    for (const target of targets) this.getStandby(target);
  }
  private armExpiry(target: WebTarget, standby: Standby) {
    clearTimeout(standby.expires);
    standby.expires = setTimeout(() => {
      if (this.standbys.get(target) === standby && !standby.busy) this.discardStandby(target);
    }, IDLE_RELEASE_MS);
  }
  private getStandby(target: WebTarget) {
    const existing = this.standbys.get(target);
    if (existing && (existing.busy || (!existing.task.error && existing.task.view && !existing.task.view.webContents.isDestroyed()))) return existing;
    this.discardStandby(target);
    const task = this.makeTask('待命', true, { target });
    this.attach(task); task.view!.setBounds(this.lastBounds);
    task.view!.webContents.setBackgroundThrottling(true);
    task.warmNavigation = this.navigate(task, homes[target]);
    void task.warmNavigation.catch(() => {});
    const standby: Standby = { task, busy: false };
    this.standbys.set(target, standby); this.armExpiry(target, standby);
    console.info('[prewarm] started', target);
    return standby;
  }
  private sizeHiddenPage(task: Task) {
    // Hidden native views report a zero CSS viewport. Chromium's public sizing
    // override preserves normal desktop layout without exposing a hidden page.
    const size = { width: this.lastBounds.width, height: this.lastBounds.height };
    task.view!.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: size, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 0, viewSize: size, scale: 1 });
    task.emulated = true;
  }
  executionCatalog(target: Target, model = '', refresh = false): Promise<ExecutionCatalog> {
    const key = JSON.stringify([target, model, refresh]);
    const pending = this.catalogs.get(key);
    if (pending) return pending;
    const request = (this.catalogTail.get(target) || Promise.resolve()).catch(() => {}).then(() => {
      if (this.disposed) throw new Error('窗口已关闭');
      return this.readCatalog(target, model, refresh);
    });
    this.catalogs.set(key, request); this.catalogTail.set(target, request);
    void request.finally(() => {
      if (this.catalogs.get(key) === request) this.catalogs.delete(key);
      if (this.catalogTail.get(target) === request) this.catalogTail.delete(target);
    }).catch(() => {});
    return request;
  }
  private async readCatalog(target: Target, model: string, refresh: boolean): Promise<ExecutionCatalog> {
    if (target === 'codex') {
      const models = await this.runtime.models(this.settings().local.codex, true);
      return { models, efforts: models.find(m => m.id === model)?.efforts || [], currentModel: '', currentEffort: '' };
    }
    if (target === 'pi') {
      const agent = new AgentSession('catalog', 'pi', this.settings().local.pi, this.runtime, this.images, () => {});
      this.catalogSessions.add(agent);
      try { return await agent.catalog(model); } finally { this.catalogSessions.delete(agent); agent.dispose(); }
    }
    const standby = this.getStandby(target);
    if (standby.busy) throw new Error('正在读取模型选项，请稍后重试。');
    standby.busy = true;
    standby.task.view!.webContents.setBackgroundThrottling(false);
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(new Error('网页模型菜单准备超时，请等待网站加载完成后刷新。')), 30_000);
    try {
      await abortable(standby.task.warmNavigation!, controller.signal);
      this.sizeHiddenPage(standby.task);
      const snapshot = await abortable(standby.task.adapter!.snapshot(), controller.signal);
      if (snapshot.login) throw new Error('请先打开这个目标并完成网页登录，再刷新选项。');
      await standby.task.adapter!.waitReady(controller.signal, () => {});
      return await standby.task.adapter!.catalog(model, controller.signal, refresh);
    } finally {
      clearTimeout(timeout); standby.busy = false;
      clearTimeout(standby.expires);
      if (this.standbys.get(target) === standby && (controller.signal.aborted || !this.warmTargets().has(target))) this.discardStandby(target);
      else if (this.standbys.get(target) === standby) {
        standby.task.view?.webContents.setBackgroundThrottling(true);
        this.armExpiry(target, standby);
      }
    }
  }
  get size() { return this.tasks.size; }
  private get active() { return this.activeId ? this.tasks.get(this.activeId) : undefined; }
  private status(task: Task): TaskActivity {
    if (task.agent) return task.agent.state.activity;
    if (task.error) return 'error';
    if (task.controller) return task.delivery?.phase === 'login' ? 'waiting' : 'loading';
    return task.loading ? 'loading' : task.activity;
  }
  snapshot(): TaskProjection {
    const active = this.active;
    const tasks: TaskSummary[] = [...this.tasks.values()].map(task => ({
      id: task.id, target: task.target, title: task.title, activity: this.status(task), residency: task.agent ? (!task.agent.state.resident && task.agent.state.activity === 'complete' ? 'released' : 'resident') : task.view ? 'resident' : 'released', retainedReason: task.retainedReason
    }));
    return {
      tasks, activeTaskId: this.activeId, activeTarget: active?.target || null, hasPage: Boolean(active), title: active?.title || 'ChatGPT',
      hostname: active?.agent ? active.target : active ? new URL(active.url).hostname : 'chatgpt.com', loading: Boolean(active?.loading || active?.preparing),
      pageError: active?.error || null, delivery: active?.delivery || null
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
      const show = visible && task.id === this.activeId && !task.error && !task.preparing;
      if (show !== task.visible) {
        task.visible = show; task.view.setVisible(show);
        if (show && task.emulated) { task.view.webContents.disableDeviceEmulation(); task.emulated = false; }
        if (show && !task.loading) revealPage(task.view.webContents);
      }
    }
  }
  focus() { this.active?.view?.webContents.focus(); }
  /** Snapshot of the visible page, used as the command palette backdrop. */
  async capture(): Promise<string | null> {
    const view = this.active?.visible ? this.active.view : null;
    if (!view || view.webContents.isDestroyed()) return null;
    const image = await view.webContents.capturePage().catch(() => null);
    return image && !image.isEmpty() ? 'data:image/jpeg;base64,' + image.toJPEG(82).toString('base64') : null;
  }
  private makeTask(title: string, preparing: boolean, options: LaunchOptions): Task {
    const target = options.target || this.settings().lastTarget;
    const task: Task = {
      target, agent: null, image: null, preset: null, filled: false,
      id: randomUUID(), title, url: target === 'gemini' ? homes.gemini : homes.chatgpt, view: null, visible: false, emulated: false, adapter: null, loading: true, preparing, error: null,
      activity: 'unknown', hasDraft: false, restoreUrl: null, savedResponseId: null, resumeUrl: null, lastActivityAt: Date.now(), observed: null,
      navigation: 0, delivery: null, steps: [], pendingText: '', controller: null, popups: new Set(), retainedReason: null, retryReleaseAt: 0
    };
    return task;
  }
  private create(title = '新对话', preparing = false, options: LaunchOptions = {}) {
    const target = options.target || this.settings().lastTarget;
    let task: Task;
    const standby = target === 'chatgpt' || target === 'gemini' ? this.standbys.get(target) : undefined;
    if (standby && !standby.busy && !standby.task.error && standby.task.view && !standby.task.view.webContents.isDestroyed()) {
      task = standby.task; clearTimeout(standby.expires); this.standbys.delete(target as WebTarget);
      task.view!.setVisible(false);
      console.info('[prewarm] claimed', target);
      task.view!.webContents.setBackgroundThrottling(false);
      task.title = title; task.preparing = preparing;
    } else task = this.makeTask(title, preparing, options);
    if (this.active) this.active.lastActivityAt = Date.now();
    this.tasks.set(task.id, task); this.activeId = task.id;
    if (target === 'codex' || target === 'pi') {
      task.loading = false; task.preparing = false;
      task.agent = new AgentSession(task.id, target, { ...this.settings().local[target], ...(options.cwd ? { cwd: options.cwd } : {}) }, this.runtime, this.images, () => {
        task.lastActivityAt = Date.now();
        if (!this.agentTimers.has(task.id)) this.agentTimers.set(task.id, setTimeout(() => {
          this.agentTimers.delete(task.id);
          if (!this.tasks.has(task.id)) return;
          this.deliverAgent(task); this.notify();
        }, 60));
      });
    } else if (!task.view) this.attach(task);
    this.notify();
    return task;
  }
  private attach(task: Task) {
    const view = new WebContentsView({ webPreferences: {
      partition: partition(task.target), nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: false
    } });
    task.view = view; task.visible = false;
    task.adapter = webAdapter(task.target, view.webContents);
    task.loading = true; task.error = null; task.activity = 'unknown'; task.observed = null;
    view.setBackgroundColor('#faf9f5'); view.setVisible(false);
    this.window.contentView.addChildView(view);
    const contents = view.webContents;
    this.secure(contents);
    contents.on('dom-ready', () => {
      // Preparing tasks and standby pages both need real layout before controls
      // can be detected. Never call the native sizing API before a renderer exists.
      if (!task.visible && task.view && !contents.isDestroyed()) this.sizeHiddenPage(task);
    });
    contents.on('page-title-updated', (_event, title) => {
      if (title && title !== 'ChatGPT') task.title = title;
      this.notify();
    });
    contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (!isMainFrame) return;
      task.navigation++; task.restoreUrl = null; task.activity = 'unknown'; task.observed = null;
      task.retainedReason = null; task.retryReleaseAt = 0;
      task.lastActivityAt = Date.now();
    });
    contents.on('did-start-loading', () => { task.loading = true; task.error = null; this.notify(); });
    contents.on('did-stop-loading', () => {
      task.loading = false; this.notify();
      if (task.visible) revealPage(contents);
      void this.observe(task);
    });
    const navigated = (url: string) => { task.url = url; this.notify(); };
    contents.on('did-navigate', (_event, url) => navigated(url));
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) navigated(url); });
    contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      task.error = `网页未能加载：${description}（${code}）`; task.loading = false; this.notify();
    });
    contents.on('render-process-gone', (_event, details) => {
      task.error = `网页进程已退出（${details.reason}），请重新加载。`; task.loading = false;
      task.controller?.abort(); this.notify();
    });
    contents.on('did-create-window', popup => {
      task.popups.add(popup); task.lastActivityAt = Date.now();
      popup.on('closed', () => { task.popups.delete(popup); task.lastActivityAt = Date.now(); });
    });
  }
  private navigate(task: Task, url: string): Promise<void> {
    task.url = url;
    const contents = task.view!.webContents;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ready = () => { if (settled) return; settled = true; cleanup(); resolve(); };
      const failed = (error: unknown) => {
        if (settled) return; settled = true;
        cleanup();
        if (!contents.isDestroyed() && (error as NodeJS.ErrnoException).code !== 'ERR_ABORTED') {
          task.error = `网页未能加载：${(error as Error).message}`; task.loading = false; this.notify();
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
    if (task.agent) { void task.agent.start().catch(() => {}); return; }
    if (!fresh) {
      // The existing Open ChatGPT entry still opens the site as-is, including its saved draft.
      void this.navigate(task, task.target === 'gemini' ? homes.gemini : homes.chatgpt).catch(() => {});
      return;
    }
    const controller = task.controller = new AbortController();
    void this.prepareNew(task, controller.signal).then(() => this.delivery(task, null)).catch(error => {
      if (!controller.signal.aborted) this.delivery(task, { phase: 'error', message: (error as Error).message, canCopy: false });
    }).finally(() => {
      task.preparing = false; if (task.controller === controller) task.controller = null;
      if (this.tasks.has(task.id)) { void this.observe(task); this.notify(); }
    });
  }
  openChat() { if (!this.active) this.newChat(false); }
  private async prepareNew(task: Task, signal: AbortSignal) {
    const temporary = task.preset?.temporaryChat === true;
    const home = task.target === 'gemini' ? homes.gemini : homes.chatgpt + (temporary ? '?temporary-chat=true' : '');
    if (task.warmNavigation) {
      await abortable(task.warmNavigation, signal); task.warmNavigation = undefined;
      if (temporary && task.target === 'chatgpt') await abortable(this.navigate(task, home), signal);
    } else await abortable(this.navigate(task, home), signal);
    signal.throwIfAborted();
    await task.adapter!.waitReady(signal, login => {
      task.preparing = !login;
      this.delivery(task, { phase: login ? 'login' : 'waiting', message: login ? '请先在网页中登录，登录后继续' : '正在准备新对话…', canCopy: Boolean(task.pendingText), step: 'open' });
    });
    // ChatGPT may restore a shared homepage draft into a fresh browser page.
    // Clear only this new page before showing it; never edit another task's document.
    await task.adapter!.clearNewDraft(signal);
    if (temporary) await task.adapter!.enableTemporary(signal);
    task.preparing = false; this.notify(); this.scheduleWarm();
  }
  select(id: string) {
    const task = this.tasks.get(id);
    if (!task) return;
    if (this.active) this.active.lastActivityAt = Date.now();
    this.activeId = id; task.lastActivityAt = Date.now();
    this.deliveredAgents.delete(id);
    if (task.agent) { void task.agent.start().catch(() => {}); }
    else if (!task.view) {
      const url = task.restoreUrl!;
      this.attach(task);
      // Restoring never invokes a preset or resubmits a prompt.
      void this.restore(task, url);
    }
    this.notify();
  }
  private async restore(task: Task, url: string) {
    const controller = task.controller = new AbortController();
    task.resumeUrl = url; task.steps = [];
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
    this.delivery(task, { phase: 'waiting', message: '正在恢复原对话…', canCopy: false });
    try {
      await this.navigate(task, url);
      controller.signal.throwIfAborted();
      await task.adapter!.waitRestored(url, task.savedResponseId!, controller.signal);
      controller.signal.throwIfAborted();
      if (task.controller === controller) { task.resumeUrl = null; this.delivery(task, null); }
    } catch (error) {
      if (task.controller === controller && (!controller.signal.aborted || timedOut)) {
        this.delivery(task, { phase: 'error', message: '原对话暂未恢复。可在网页重试，或重新加载原链接；不会重发提示词。', canCopy: false });
      }
    } finally {
      clearTimeout(timeout);
      if (task.controller === controller) task.controller = null;
      if (this.tasks.has(task.id)) { await this.observe(task); this.notify(); }
    }
  }
  private delivery(task: Task, value: Omit<DeliveryStatus, 'steps' | 'step'> & { step?: DeliveryStep } | null) {
    if (!this.tasks.has(task.id)) return;
    task.delivery = value && { ...value, steps: task.steps, step: value.step && task.steps.includes(value.step) ? value.step : null };
    this.notify();
  }
  async runPreset(preset: Preset, text: string, options: LaunchOptions = {}): Promise<{ error: string | null }> {
    const target = options.target || preset.target;
    if (target === 'api') return { error: 'API 生图应从图片入口执行' };
    const task = this.create(preset.name, true, { ...options, target });
    // A temporary target override uses that target's defaults, never another provider's model ID.
    task.preset = task.target === preset.target ? preset : { ...preset, target: task.target, model: '', effort: '' }; task.pendingText = text;
    task.image = options.imageId ? this.images.get(options.imageId) || null : null;
    // Steps follow deliverWeb's execution order so progress never runs ahead of the page.
    task.steps = ['open', ...(task.preset.model || task.preset.effort ? ['model' as const] : []), 'fill', ...(task.image ? ['upload' as const] : []), task.preset.mode === 'send' ? 'send' : 'edit'];
    if (task.agent) {
      task.agent.setDraft(text);
      if (task.image) { task.agent.setImage(task.image); task.image = null; }
      task.pendingText = '';
      task.agent.configure(task.preset);
      try { await task.agent.applyProfile(task.preset); if (preset.mode === 'send') await task.agent.send(); return { error: null }; }
      catch (error) { return { error: (error as Error).message }; }
    }
    return this.deliverWeb(task, true);
  }
  private async deliverWeb(task: Task, fresh: boolean): Promise<{ error: string | null }> {
    const controller = task.controller = new AbortController();
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
        if (task.target === 'chatgpt' && task.preset!.effort && !WebProfile.hasEffortPosition('chatgpt', task.preset!)) {
          // Old presets learn native positions on a hidden page, never by
          // sweeping the visible task's slider back and forth.
          await this.executionCatalog(task.target, task.preset!.model || '');
          controller.signal.throwIfAborted();
        }
        await adapter.applyProfile(task.preset!, controller.signal);
      }
      if (!task.filled) {
        if (task.preset!.temporaryChat) await adapter.verifyTemporary(controller.signal);
        step = 'fill';
        this.delivery(task, { phase: 'filling', message: `正在完整填入 ${text.length.toLocaleString()} 字…`, canCopy: Boolean(text), step });
        await adapter.fill(text, controller.signal); task.filled = true;
      }
      task.preparing = false; this.notify();
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
        this.images.remove(task.image); task.image = null;
      }
      task.pendingText = '';
      this.delivery(task, { phase: task.preset!.mode === 'send' ? 'sent' : 'editing', message: task.preset!.mode === 'send' ? '已发送，可继续在网页追问' : '已填入，请在网页中编辑并发送', canCopy: false, step: task.preset!.mode === 'send' ? 'send' : 'edit' });
      return { error: null };
    } catch (error) {
      if (controller.signal.aborted) return { error: null };
      this.delivery(task, { phase: 'error', message: (error as Error).message, canCopy: Boolean(text), step });
      return { error: (error as Error).message };
    } finally {
      if (task.controller === controller) task.controller = null; task.preparing = false;
      if (this.tasks.has(task.id)) { await this.observe(task); this.notify(); }
    }
  }
  async retryDelivery() {
    const task = this.active;
    if (!task?.preset || task.controller || task.agent) return;
    await this.deliverWeb(task, false);
  }
  getAgent(id: string) { const task = this.tasks.get(id); if (task) this.deliverAgent(task, true); return task?.agent?.state || null; }
  private agent(id: string) { const agent = this.tasks.get(id)?.agent; if (!agent) throw new Error('本地任务不存在。'); return agent; }
  agentDraft(id: string, text: string) { this.agent(id).setDraft(text); }
  agentSend(id: string) { return this.agent(id).send(); }
  agentStop(id: string) { return this.agent(id).stop(); }
  agentModel(id: string, model: string) { return this.agent(id).setModel(model); }
  agentEffort(id: string, effort: string) { return this.agent(id).setEffort(effort); }
  agentRefreshModels(id: string) { return this.agent(id).refreshModels(true); }
  agentAnswer(id: string, request: string, answer: AgentAnswer) { return this.agent(id).answer(request, answer); }
  agentImage(id: string, image: ImageInput | null) { this.agent(id).setImage(image); }
  cancelDelivery() {
    const task = this.active;
    if (!task) return;
    task.controller?.abort(); this.images.remove(task.image); task.image = null; task.pendingText = ''; task.delivery = null; task.resumeUrl = null;
    this.notify();
  }
  dismissDelivery() { if (this.active && !this.active.controller) this.delivery(this.active, null); }
  copyPending() { if (this.active?.pendingText) clipboard.writeText(this.active.pendingText); }
  async reload() {
    const task = this.active;
    if (task?.agent) { try { await task.agent.start(); } catch {} return; }
    if (!task) return;
    task.controller?.abort();
    if (task.resumeUrl) { void this.restore(task, task.resumeUrl); return; }
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
      if (!old || old.url !== snapshot.url || old.activity !== snapshot.activity || old.draft !== snapshot.draft
        || old.hasDraft !== snapshot.hasDraft || old.progress !== snapshot.progress || old.responseId !== snapshot.responseId || old.lastInputAt !== snapshot.lastInputAt) {
        task.lastActivityAt = Date.now(); task.retainedReason = null; task.retryReleaseAt = 0;
      }
      // A website retry may finish after our wait timed out. Use the same two-observation
      // proof as waitRestored so a recovered page does not remain permanently pending.
      if (!task.controller && task.resumeUrl && task.savedResponseId && old
        && isRestoredPage(old, task.resumeUrl, task.savedResponseId)
        && isRestoredPage(snapshot, task.resumeUrl, task.savedResponseId)) {
        task.resumeUrl = null; task.delivery = null;
      }
      task.observed = snapshot; task.activity = snapshot.activity; task.hasDraft = snapshot.hasDraft;
      task.restoreUrl = snapshot.restoreUrl; task.url = snapshot.url;
      if (task.delivery?.phase === 'editing' && !snapshot.hasDraft && ['running', 'complete'].includes(snapshot.activity)) { task.delivery = null; this.images.remove(task.image); task.image = null; }
      this.notify();
      return true;
    } catch {
      // A navigating or changed website is unknown, never evidence of completion.
      if (this.tasks.has(task.id) && task.view === view && task.navigation === navigation) {
        task.activity = 'unknown'; task.restoreUrl = null; this.notify();
      }
      return false;
    }
  }
  private eligible(task: Task) {
    return this.tasks.has(task.id) && !task.preset?.temporaryChat && isIdleCandidate({
      active: task.id === this.activeId, resident: Boolean(task.view), activity: this.status(task),
      hasDraft: task.hasDraft, pending: Boolean(task.controller || task.pendingText || task.resumeUrl || task.image), hasPopup: task.popups.size > 0,
      restoreUrl: task.restoreUrl, lastActivityAt: task.lastActivityAt
    }, Date.now());
  }
  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const codex = [...this.tasks.values()].filter(t => t.target === 'codex' && t.agent?.state.resident);
      this.runtime.closeIfIdle(IDLE_RELEASE_MS);
      if (codex.length && codex.every(t => t.id !== this.activeId && t.agent!.canRelease && Date.now() - t.lastActivityAt >= IDLE_RELEASE_MS)) {
        for (const task of codex) task.agent!.release();
        this.runtime.closeIfUnused();
      }
      for (const task of [...this.tasks.values()]) {
        if (task.agent) {
          if (task.target === 'pi' && task.agent.state.resident && task.id !== this.activeId && task.agent.canRelease && Date.now() - task.lastActivityAt >= IDLE_RELEASE_MS) task.agent.release();
          continue;
        }
        if (!await this.observe(task)) continue;
        if (!this.probe && this.eligible(task) && Date.now() >= task.retryReleaseAt) void this.releaseVerified(task);
      }
    } finally { this.polling = false; }
  }
  private async releaseVerified(task: Task) {
    const url = task.restoreUrl!;
    const responseId = task.observed?.responseId;
    if (!responseId) {
      task.retainedReason = '无法确认回答已保存，保留页面';
      task.retryReleaseAt = Date.now() + IDLE_RELEASE_MS; this.notify();
      return;
    }
    // A conversation-shaped URL alone does not prove that the website can restore it.
    // At most one temporary hidden page checks the saved answer before any resident is destroyed.
    const view = new WebContentsView({ webPreferences: {
      partition: partition(task.target), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false
    } });
    view.setBounds(task.view!.getBounds()); view.setVisible(false);
    this.window.contentView.addChildView(view);
    this.secure(view.webContents);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const controller = new AbortController();
    this.probe = { taskId: task.id, view, controller };
    const stop = () => { if (!view.webContents.isDestroyed()) view.webContents.stop(); };
    controller.signal.addEventListener('abort', stop, { once: true });
    const timeout = setTimeout(() => controller.abort(), 20_000);
    let verified = false;
    try {
      await view.webContents.loadURL(url);
      const adapter = webAdapter(task.target, view.webContents);
      await adapter.waitRestored(url, responseId, controller.signal);
      verified = true;
    } catch {
      // Failed/expired login and unavailable conversation links keep the original page alive.
    } finally {
      clearTimeout(timeout); controller.signal.removeEventListener('abort', stop);
      if (this.probe?.view === view) {
        this.window.contentView.removeChildView(view); view.webContents.close(); this.probe = null;
      }
    }
    if (!this.tasks.has(task.id)) return;
    task.retryReleaseAt = Date.now() + IDLE_RELEASE_MS;
    if (!verified) {
      task.retainedReason = '恢复链接暂不可用，保留页面'; this.notify();
      return;
    }
    // The user may have switched to this task, edited it, or started a new turn during the check.
    if (await this.observe(task) && this.eligible(task) && task.restoreUrl === url && task.observed?.responseId === responseId) {
      task.savedResponseId = responseId;
      this.destroyPage(task); task.delivery = null; task.observed = null; task.retainedReason = null; this.notify();
    }
  }
  private destroyPage(task: Task) {
    if (this.probe?.taskId === task.id) this.probe.controller.abort();
    task.controller?.abort();
    for (const popup of task.popups) popup.destroy();
    const view = task.view;
    task.view = null; task.visible = false; task.adapter = null;
    if (view) { this.window.contentView.removeChildView(view); view.webContents.close(); }
  }
  close(id: string) {
    const task = this.tasks.get(id);
    if (!task) return;
    const ids = [...this.tasks.keys()];
    const index = ids.indexOf(id);
    this.tasks.delete(id); this.deliveredAgents.delete(id); task.agent?.dispose(); this.images.remove(task.image); this.destroyPage(task);
    if (![...this.tasks.values()].some(t => t.target === 'codex')) this.runtime.closeIfUnused();
    if (this.activeId === id) {
      this.activeId = null;
      const next = ids[index + 1] || ids[index - 1];
      if (next) this.select(next);
    }
    this.notify();
  }
  dispose() {
    this.disposed = true;
    for (const agent of this.catalogSessions) agent.dispose(); this.catalogSessions.clear();
    if (this.warmTimer) clearTimeout(this.warmTimer);
    for (const target of this.standbys.keys()) this.discardStandby(target);
    this.deliveredAgents.clear();
    clearInterval(this.timer);
    if (this.probe) {
      this.probe.controller.abort();
      this.window.contentView.removeChildView(this.probe.view);
      this.probe.view.webContents.close();
      this.probe = null;
    }
    const tasks = [...this.tasks.values()];
    this.tasks.clear(); this.activeId = null;
    for (const task of tasks) { task.agent?.dispose(); this.images.remove(task.image); this.destroyPage(task); }
    this.runtime.close();
    for (const timer of this.agentTimers.values()) clearTimeout(timer); this.agentTimers.clear();
  }
}
