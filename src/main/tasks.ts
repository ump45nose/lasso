import { BrowserWindow, WebContentsView, clipboard } from 'electron';
import type { Rectangle, WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { ChatGPTAdapter } from './adapters/chatgpt';
import type { PageSnapshot } from './adapters/chatgpt';
import { isIdleCandidate, IDLE_RELEASE_MS } from './task-policy';
import type { DeliveryStatus, Preset, ShellState, TaskActivity, TaskSummary } from '../shared/contracts';

const HOME = 'https://chatgpt.com/';
export const CHAT_PARTITION = 'persist:chatgpt';
interface Task {
  id: string;
  title: string;
  url: string;
  view: WebContentsView | null;
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
  pendingText: string;
  controller: AbortController | null;
  popups: Set<BrowserWindow>;
  retainedReason: string | null;
  retryReleaseAt: number;
}
type TaskProjection = Pick<ShellState, 'tasks' | 'activeTaskId' | 'hasPage' | 'title' | 'hostname' | 'loading' | 'pageError' | 'delivery'>;

/** Owns task lifetime, page residency and each independent preset execution. */
export class TaskManager {
  private tasks = new Map<string, Task>();
  private activeId: string | null = null;
  private polling = false;
  private probe: { taskId: string; view: WebContentsView; controller: AbortController } | null = null;
  private closing = new Set<string>();
  private timer: ReturnType<typeof setInterval>;
  constructor(
    private window: BrowserWindow,
    private secure: (contents: WebContents) => void,
    private changed: () => void,
    private confirm: (message: string, detail: string) => Promise<boolean>
  ) {
    this.timer = setInterval(() => void this.poll(), 3000);
  }
  get size() { return this.tasks.size; }
  private get active() { return this.activeId ? this.tasks.get(this.activeId) : undefined; }
  private status(task: Task): TaskActivity {
    if (task.error) return 'error';
    if (task.controller) return task.delivery?.phase === 'login' ? 'waiting' : 'loading';
    return task.loading ? 'loading' : task.activity;
  }
  snapshot(): TaskProjection {
    const active = this.active;
    const tasks: TaskSummary[] = [...this.tasks.values()].map(task => ({
      id: task.id, title: task.title, activity: this.status(task), residency: task.view ? 'resident' : 'released', retainedReason: task.retainedReason
    }));
    return {
      tasks, activeTaskId: this.activeId, hasPage: Boolean(active), title: active?.title || 'ChatGPT',
      hostname: active ? new URL(active.url).hostname : 'chatgpt.com', loading: Boolean(active?.loading || active?.preparing),
      pageError: active?.error || null, delivery: active?.delivery || null
    };
  }
  layout(bounds: Rectangle, visible: boolean) {
    for (const task of this.tasks.values()) {
      if (!task.view) continue;
      task.view.setBounds(bounds);
      task.view.setVisible(visible && task.id === this.activeId && !task.error && !task.preparing);
    }
  }
  focus() { this.active?.view?.webContents.focus(); }
  private create(title = '新对话', preparing = false) {
    const task: Task = {
      id: randomUUID(), title, url: HOME, view: null, adapter: null, loading: true, preparing, error: null,
      activity: 'unknown', hasDraft: false, restoreUrl: null, savedResponseId: null, resumeUrl: null, lastActivityAt: Date.now(), observed: null,
      navigation: 0, delivery: null, pendingText: '', controller: null, popups: new Set(), retainedReason: null, retryReleaseAt: 0
    };
    if (this.active) this.active.lastActivityAt = Date.now();
    this.tasks.set(task.id, task); this.activeId = task.id;
    this.attach(task); this.changed();
    return task;
  }
  private attach(task: Task) {
    const view = new WebContentsView({ webPreferences: {
      partition: CHAT_PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: false
    } });
    task.view = view;
    task.adapter = new ChatGPTAdapter(view.webContents);
    task.loading = true; task.error = null; task.activity = 'unknown'; task.observed = null;
    view.setBackgroundColor('#faf9f5'); view.setVisible(false);
    this.window.contentView.addChildView(view);
    const contents = view.webContents;
    this.secure(contents);
    contents.on('page-title-updated', (_event, title) => {
      if (title && title !== 'ChatGPT') task.title = title;
      this.changed();
    });
    contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (!isMainFrame) return;
      task.navigation++; task.restoreUrl = null; task.activity = 'unknown'; task.observed = null;
      task.retainedReason = null; task.retryReleaseAt = 0;
      task.lastActivityAt = Date.now();
    });
    contents.on('did-start-loading', () => { task.loading = true; task.error = null; this.changed(); });
    contents.on('did-stop-loading', () => {
      task.loading = false; this.changed();
      void this.observe(task);
    });
    const navigated = (url: string) => { task.url = url; this.changed(); };
    contents.on('did-navigate', (_event, url) => navigated(url));
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame) navigated(url); });
    contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      task.error = `网页未能加载：${description}（${code}）`; task.loading = false; this.changed();
    });
    contents.on('render-process-gone', (_event, details) => {
      task.error = `网页进程已退出（${details.reason}），请重新加载。`; task.loading = false;
      task.controller?.abort(); this.changed();
    });
    contents.on('did-create-window', popup => {
      task.popups.add(popup); task.lastActivityAt = Date.now();
      popup.on('closed', () => { task.popups.delete(popup); task.lastActivityAt = Date.now(); });
    });
  }
  private async navigate(task: Task, url: string) {
    task.url = url;
    try { await task.view!.webContents.loadURL(url); }
    catch (error) {
      if (this.tasks.has(task.id) && !task.error && (error as NodeJS.ErrnoException).code !== 'ERR_ABORTED') {
        task.error = `网页未能加载：${(error as Error).message}`;
        task.loading = false; this.changed();
      }
      throw error;
    }
  }
  newChat(fresh = true) {
    const task = this.create('新对话', fresh);
    if (!fresh) {
      // The existing Open ChatGPT entry still opens the site as-is, including its saved draft.
      void this.navigate(task, HOME).catch(() => {});
      return;
    }
    const controller = task.controller = new AbortController();
    void this.prepareNew(task, controller.signal).then(() => this.delivery(task, null)).catch(error => {
      if (!controller.signal.aborted) this.delivery(task, { phase: 'error', message: (error as Error).message, canCopy: false });
    }).finally(() => {
      task.preparing = false; if (task.controller === controller) task.controller = null;
      if (this.tasks.has(task.id)) { void this.observe(task); this.changed(); }
    });
  }
  openChat() { if (!this.active) this.newChat(false); }
  private async prepareNew(task: Task, signal: AbortSignal) {
    await this.navigate(task, HOME);
    signal.throwIfAborted();
    await task.adapter!.waitReady(signal, login => {
      task.preparing = !login;
      this.delivery(task, { phase: login ? 'login' : 'waiting', message: login ? '请先在网页中登录，登录后继续' : '正在准备新对话…', canCopy: Boolean(task.pendingText) });
    });
    // ChatGPT may restore a shared homepage draft into a fresh browser page.
    // Clear only this new page before showing it; never edit another task's document.
    await task.adapter!.clearNewDraft(signal);
  }
  select(id: string) {
    const task = this.tasks.get(id);
    if (!task) return;
    if (this.active) this.active.lastActivityAt = Date.now();
    this.activeId = id; task.lastActivityAt = Date.now();
    if (!task.view) {
      const url = task.restoreUrl!;
      this.attach(task);
      // Restoring never invokes a preset or resubmits a prompt.
      void this.restore(task, url);
    }
    this.changed();
  }
  private async restore(task: Task, url: string) {
    const controller = task.controller = new AbortController();
    task.resumeUrl = url;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 30_000);
    this.delivery(task, { phase: 'waiting', message: '正在恢复原对话…', canCopy: false });
    try {
      await this.navigate(task, url);
      await task.adapter!.waitRestored(url, task.savedResponseId!, controller.signal);
      task.resumeUrl = null; this.delivery(task, null);
    } catch (error) {
      if (!controller.signal.aborted || timedOut) this.delivery(task, { phase: 'error', message: '原对话暂未恢复。重新加载将重试原链接，不会重发提示词。', canCopy: false });
    } finally {
      clearTimeout(timeout);
      if (task.controller === controller) task.controller = null;
      if (this.tasks.has(task.id)) { await this.observe(task); this.changed(); }
    }
  }
  private delivery(task: Task, value: DeliveryStatus | null) {
    if (!this.tasks.has(task.id)) return;
    task.delivery = value; this.changed();
  }
  async runPreset(preset: Preset, text: string): Promise<{ error: string | null }> {
    const task = this.create(preset.name, true);
    const controller = task.controller = new AbortController();
    task.pendingText = text;
    try {
      this.delivery(task, { phase: 'waiting', message: '正在打开新对话…', canCopy: true });
      await this.prepareNew(task, controller.signal);
      const adapter = task.adapter!;
      this.delivery(task, { phase: 'filling', message: '正在完整填入…', canCopy: true });
      await adapter.fill(text, controller.signal);
      if (preset.mode === 'send') {
        this.delivery(task, { phase: 'sending', message: '正在发送…', canCopy: true });
        await adapter.submit(text, controller.signal);
      }
      task.pendingText = '';
      this.delivery(task, { phase: preset.mode === 'send' ? 'sent' : 'editing', message: preset.mode === 'send' ? '已发送，可继续在网页追问' : '已完整填入，请在网页中编辑并发送', canCopy: false });
      return { error: null };
    } catch (error) {
      if (controller.signal.aborted) return { error: null };
      this.delivery(task, { phase: 'error', message: (error as Error).message, canCopy: true });
      return { error: (error as Error).message };
    } finally {
      if (task.controller === controller) task.controller = null; task.preparing = false;
      if (this.tasks.has(task.id)) { await this.observe(task); this.changed(); }
    }
  }
  cancelDelivery() {
    const task = this.active;
    if (!task) return;
    task.controller?.abort(); task.pendingText = ''; task.delivery = null; task.resumeUrl = null;
    this.changed();
  }
  dismissDelivery() { if (this.active && !this.active.controller) this.delivery(this.active, null); }
  copyPending() { if (this.active?.pendingText) clipboard.writeText(this.active.pendingText); }
  async reload() {
    const task = this.active;
    if (!task || !await this.confirm('重新加载这个任务？', '该任务未发送的输入可能丢失，正在生成的回答可能中断。其他任务不受影响。')) return;
    if (!this.tasks.has(task.id)) return;
    task.controller?.abort();
    if (task.resumeUrl) { void this.restore(task, task.resumeUrl); return; }
    task.delivery = task.pendingText ? { phase: 'error', message: '已取消待发送动作，原文仍可复制', canCopy: true } : null;
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
      task.observed = snapshot; task.activity = snapshot.activity; task.hasDraft = snapshot.hasDraft;
      task.restoreUrl = snapshot.restoreUrl; task.url = snapshot.url;
      if (task.delivery?.phase === 'editing' && !snapshot.hasDraft && ['running', 'complete'].includes(snapshot.activity)) task.delivery = null;
      this.changed();
      return true;
    } catch {
      // A navigating or changed website is unknown, never evidence of completion.
      if (this.tasks.has(task.id) && task.view === view && task.navigation === navigation) {
        task.activity = 'unknown'; task.restoreUrl = null; this.changed();
      }
      return false;
    }
  }
  private eligible(task: Task) {
    return this.tasks.has(task.id) && isIdleCandidate({
      active: task.id === this.activeId, resident: Boolean(task.view), activity: this.status(task),
      hasDraft: task.hasDraft, pending: Boolean(task.controller || task.pendingText || task.resumeUrl), hasPopup: task.popups.size > 0,
      restoreUrl: task.restoreUrl, lastActivityAt: task.lastActivityAt
    }, Date.now());
  }
  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const task of [...this.tasks.values()]) {
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
      task.retryReleaseAt = Date.now() + IDLE_RELEASE_MS; this.changed();
      return;
    }
    // A conversation-shaped URL alone does not prove that the website can restore it.
    // At most one temporary hidden page checks the saved answer before any resident is destroyed.
    const view = new WebContentsView({ webPreferences: {
      partition: CHAT_PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false
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
      const adapter = new ChatGPTAdapter(view.webContents);
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
      task.retainedReason = '恢复链接暂不可用，保留页面'; this.changed();
      return;
    }
    // The user may have switched to this task, edited it, or started a new turn during the check.
    if (await this.observe(task) && this.eligible(task) && task.restoreUrl === url && task.observed?.responseId === responseId) {
      task.savedResponseId = responseId;
      this.destroyPage(task); task.delivery = null; task.observed = null; task.retainedReason = null; this.changed();
    }
  }
  private destroyPage(task: Task) {
    if (this.probe?.taskId === task.id) this.probe.controller.abort();
    task.controller?.abort();
    for (const popup of task.popups) popup.destroy();
    const view = task.view;
    task.view = null; task.adapter = null;
    if (view) { this.window.contentView.removeChildView(view); view.webContents.close(); }
  }
  async close(id: string) {
    const task = this.tasks.get(id);
    if (!task || this.closing.has(id)) return;
    this.closing.add(id);
    try {
      if (task.view) {
        await this.observe(task);
        const safe = !task.controller && !task.pendingText && !task.hasDraft && task.popups.size === 0 && ['idle', 'complete'].includes(this.status(task));
        if (!safe && !await this.confirm(`关闭「${task.title}」？`, '这个任务可能仍在运行、等待操作或含有草稿。关闭后不能恢复未保存内容，其他任务不受影响。')) return;
      }
      const ids = [...this.tasks.keys()];
      const index = ids.indexOf(id);
      this.tasks.delete(id); this.destroyPage(task);
      if (this.activeId === id) {
        this.activeId = null;
        const next = ids[index + 1] || ids[index - 1];
        if (next) this.select(next);
      }
      this.changed();
    } finally { this.closing.delete(id); }
  }
  dispose() {
    clearInterval(this.timer);
    if (this.probe) {
      this.probe.controller.abort();
      this.window.contentView.removeChildView(this.probe.view);
      this.probe.view.webContents.close();
      this.probe = null;
    }
    const tasks = [...this.tasks.values()];
    this.tasks.clear(); this.activeId = null;
    for (const task of tasks) this.destroyPage(task);
  }
}
