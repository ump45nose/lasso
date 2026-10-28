import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AgentAnswer, AgentRequest, AgentState, ChatMessage, LocalConfig, LocalTarget, ExecutionProfile, ExecutionCatalog } from '../../shared/contracts';
import { Transport, type Wire } from './transport';
import { CodexRuntime } from './codex';
import { Images, type ImageInput } from '../images';

const contentText = (content: any): string => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(c => c.type === 'text' || c.type === 'output_text').map(c => c.text).join('\n') : '';
const print = (value: any) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) || '';
export class AgentSession {
  readonly state: AgentState;
  image: ImageInput | null = null;
  sessionId: string | null = null;
  sessionFile: string | null = null;
  private transport: Transport | null = null;
  private releaseRuntime: (() => void) | null = null;
  private starting: Promise<void> | null = null;
  private turn: string | null = null;
  private closed = false;
  private assistantId = '';
  private requestData = new Map<string, Wire>();
  private requestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unwatch: () => void;
  private queued = false;
  private submission = false;
  private loadingModels: Promise<void> | null = null;
  private desiredProfile: ExecutionProfile = {};
  private profilePending = false;
  private applyingProfile: Promise<void> | null = null;
  private changingProfile: Promise<void> | null = null;
  private submitted: { text: string; image: ImageInput | null } | null = null;
  constructor(taskId: string, target: LocalTarget, private config: LocalConfig, private runtime: CodexRuntime, private images: Images, private changed: () => void) {
    this.state = { revision: 0, effort: '', efforts: [], modelsLoading: false, controlsBusy: false, modelsError: null, taskId, target, cwd: config.cwd, messages: [], requests: [], models: [], model: '', draft: '', draftRevision: 0, image: null, activity: 'idle', error: null, resident: false, status: '' };
    this.unwatch = runtime.watch(error => { if (target === 'codex' && this.state.resident) this.disconnected(error); });
  }
  private emit() { if (!this.closed) { this.state.revision++; this.changed(); } }
  private assertOpen() { if (this.closed) throw new Error('任务已关闭'); }
  /** Closing a task invalidates replies as well as future requests, without closing another task's transport. */
  private async request(method: string, params: Wire = {}) {
    this.assertOpen();
    if (!this.transport) throw new Error('CLI 连接已关闭，请恢复会话。');
    const result = await this.transport.request(method, params);
    this.assertOpen();
    return result;
  }
  private detach() {
    const transport = this.transport; this.transport = null; this.state.resident = false;
    if (this.state.target === 'pi') transport?.close();
    else {
      if (this.sessionId) this.runtime.listeners.delete(this.sessionId);
      this.releaseRuntime?.(); this.releaseRuntime = null;
    }
  }
  private interrupt(transport: Transport, threadId: string, turnId: string) {
    void transport.request('turn/interrupt', { threadId, turnId }).catch(() => {});
  }
  private upsert(message: ChatMessage) {
    const index = this.state.messages.findIndex(m => m.id === message.id);
    if (index < 0) this.state.messages.push(message); else this.state.messages[index] = message;
    this.emit();
  }
  private notice(text: string) { this.upsert({ id: randomUUID(), role: 'notice', text }); }
  private disconnected(error: Error) {
    this.detach();
    this.restoreFailedInput(); this.clearRequests(); this.state.error = error.message; this.state.activity = 'error'; this.emit();
  }
  async start() {
    this.assertOpen();
    if (this.state.resident) return;
    if (this.starting) return this.starting;
    this.state.activity = 'loading'; this.state.error = null; this.emit();
    this.starting = this.connect().catch(error => {
      this.detach();
      if (!this.closed) { this.state.error = (error as Error).message; this.state.activity = 'error'; this.emit(); }
      throw error;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }
  private async connect() {
    if (this.state.target === 'codex') {
      this.releaseRuntime = this.runtime.retain();
      const transport = await this.runtime.connect(this.config);
      this.assertOpen(); this.transport = transport;
      const result = await this.request(this.sessionId ? 'thread/resume' : 'thread/start', { ...(this.sessionId ? { threadId: this.sessionId } : {}), cwd: this.config.cwd });
      this.assertOpen();
      this.sessionId = result.thread.id;
      this.runtime.listeners.set(this.sessionId!, message => this.codexEvent(message));
      this.state.model = this.state.model || result.model || '';
      this.state.effort = this.state.effort || result.reasoningEffort || '';

    } else {
      const args = ['--mode', 'rpc', ...(this.sessionFile ? ['--session', this.sessionFile] : [])];
      const transport = this.transport = new Transport(this.config.executable, args, this.config.cwd, 'pi');
      transport.on('message', message => this.piEvent(message));
      transport.on('closed', error => { if (this.transport === transport && !this.closed) this.disconnected(error); });
      await this.refreshPi();
      if (this.sessionFile && (this.desiredProfile.model || this.desiredProfile.effort)) this.profilePending = true;

    }
    this.assertOpen();
    this.state.resident = true;
    this.state.activity = this.state.requests.length ? 'waiting' : this.state.draft || this.image ? 'draft' : this.state.messages.length ? 'complete' : 'idle';
    this.emit();
    void this.refreshModels().catch(() => {});
  }
  private async refreshPi() {
    const value = await this.request('get_state');
    this.sessionId = value.sessionId || null; this.sessionFile = value.sessionFile || null;
    if (value.model) this.state.model = `${value.model.provider}/${value.model.id}`;
    this.state.effort = value.thinkingLevel || '';
    this.queued = Boolean(value.pendingMessageCount || value.isCompacting);
  }
  setDraft(text: string) {
    this.assertOpen();
    if (text === this.state.draft) return;
    this.state.draft = text;
    if (['idle', 'draft', 'complete'].includes(this.state.activity)) this.state.activity = text || this.image ? 'draft' : this.state.messages.length ? 'complete' : 'idle';
    this.emit();
  }
  setImage(image: ImageInput | null) {
    this.assertOpen();
    this.images.remove(this.image); this.image = image; this.state.image = image ? this.images.preview(image) : null;
    if (['idle', 'draft', 'complete'].includes(this.state.activity)) this.state.activity = this.state.draft || image ? 'draft' : this.state.messages.length ? 'complete' : 'idle';
    this.emit();
  }
  async send() {
    this.assertOpen();
    if (this.submission || ['running', 'waiting'].includes(this.state.activity)) throw new Error('请等待当前任务完成，或先停止。');
    if (!this.state.draft.trim() && !this.image) return;
    this.submission = true;
    try {
      await this.start();
      if (this.applyingProfile) await this.applyingProfile;
      if (this.changingProfile) await this.changingProfile;
      if (this.profilePending) await this.applyProfile(this.desiredProfile);
      this.assertOpen();
      const image = this.image; const text = this.state.draft;
      const messageIndex = this.state.messages.length;
      const model = this.state.models.find(m => m.id === this.state.model);
      if (image && model?.images === false) throw new Error('当前模型不支持图片，请换一个模型；图片和草稿已保留。');
      this.state.error = null; this.state.activity = 'running'; this.submitted = { text, image }; this.emit();
      if (this.state.target === 'codex') {
        const transport = this.transport!, threadId = this.sessionId!;
        const result = await transport.request('turn/start', { threadId, input: [
          ...(text ? [{ type: 'text', text, text_elements: [] }] : []), ...(image ? [{ type: 'localImage', path: image.path }] : [])
        ], ...(this.state.model ? { model: this.state.model } : {}), ...(this.state.effort ? { effort: this.state.effort } : {}) });
        // A close can precede both turn/started and the acknowledgment. Stop that late turn by its returned ID.
        if (this.closed && this.turn !== result.turn.id && transport.alive) this.interrupt(transport, threadId, result.turn.id);
        this.assertOpen();
        this.turn = result.turn.id;
      } else {
        const result = await this.request('prompt', { message: text, ...(image ? { images: [{ type: 'image', data: this.images.base64(image), mimeType: 'image/png' }] } : {}) });
        if (result?.disposition === 'handled') this.state.activity = 'complete';
      }
      this.upsert({ id: randomUUID(), role: 'user', text, image: image?.thumbnail });
      // Place the user input before any response events received before the acknowledgment.
      const user = this.state.messages.pop()!;
      this.state.messages.splice(messageIndex, 0, user);
      if (this.state.draft === text) { this.state.draft = ''; this.state.draftRevision++; }
      if (this.image === image) { this.image = null; this.state.image = null; }
      if (!['running', 'waiting'].includes(this.state.activity)) this.settleInput();
      this.emit();
    } catch (error) {
      if (!this.closed) { this.restoreFailedInput(); this.state.error = (error as Error).message; this.state.activity = 'error'; this.emit(); }
      throw error;
    }
    finally { this.submission = false; }
  }
  private restoreFailedInput() {
    if (!this.submitted) return;
    const { text, image } = this.submitted;
    if (this.state.draft !== text) this.state.draft = [text, this.state.draft].filter(Boolean).join('\n\n');
    if (image && this.image !== image) { this.images.remove(this.image); this.image = image; this.state.image = this.images.preview(image); }
    this.state.draftRevision++; this.submitted = null;
  }
  private settleInput() {
    if (this.state.error) this.restoreFailedInput();
    else if (this.submitted) { this.images.remove(this.submitted.image); this.submitted = null; }
  }
  async stop() {
    this.assertOpen();
    if (!this.transport) return;
    if (this.state.target === 'codex') {
      if (this.turn) await this.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turn });
    } else {
      const queue = await this.request('clear_queue');
      const pending = [...(queue?.steering || []), ...(queue?.followUp || [])].join('\n\n');
      if (pending) { this.state.draft = [this.state.draft, pending].filter(Boolean).join('\n\n'); this.state.draftRevision++; }
      await this.request('abort');
    }
  }
  configure(profile: ExecutionProfile) {
    this.assertOpen();
    this.desiredProfile = { model: profile.model || '', effort: profile.effort || '' };
    this.profilePending = Boolean(profile.model || profile.effort);
  }
  async refreshModels(force = false): Promise<void> {
    this.assertOpen();
    if (this.loadingModels) return this.loadingModels;
    if (!force && this.state.models.length) return;
    if (!this.transport) await this.start();
    this.assertOpen();
    if (this.loadingModels) return this.loadingModels;
    this.state.modelsLoading = true; this.state.modelsError = null; this.emit();
    this.loadingModels = (async () => {
      if (this.state.target === 'codex') {
        const models = await this.runtime.models(this.config, force);
        this.assertOpen(); this.state.models = models;
        this.state.efforts = this.state.models.find(m => m.id === this.state.model)?.efforts || [];
      } else {
        const models = await this.request('get_available_models');
        this.state.models = models.models.map((m: Wire) => ({ id: `${m.provider}/${m.id}`, label: `${m.name || m.id} · ${m.provider}`, images: m.input?.includes('image') }));
        this.state.efforts = (await this.request('get_available_thinking_levels')).levels;
      }
    })().catch(error => { if (!this.closed) this.state.modelsError = (error as Error).message; throw error; }).finally(() => {
      this.state.modelsLoading = false; this.loadingModels = null; this.emit();
    });
    return this.loadingModels;
  }
  async catalog(model = ''): Promise<ExecutionCatalog> {
    await this.start(); await this.refreshModels();
    if (model && model !== this.state.model) await this.setModel(model);
    return { models: this.state.models, efforts: this.state.efforts, currentModel: this.state.model, currentEffort: this.state.effort };
  }
  applyProfile(profile: ExecutionProfile): Promise<void> {
    this.assertOpen();
    if (this.applyingProfile) return this.applyingProfile;
    this.configure(profile);
    this.applyingProfile = (async () => {
      await this.start();
      this.assertOpen();
      if (!this.profilePending) return;
      await this.refreshModels();
      if (profile.model) await this.setModel(profile.model, true);
      if (profile.effort) await this.setEffort(profile.effort, true);
      this.profilePending = false;
    })().catch(error => { if (!this.closed) { this.state.error = (error as Error).message; this.state.activity = 'error'; this.emit(); } throw error; })
      .finally(() => { this.applyingProfile = null; });
    return this.applyingProfile;
  }
  private changeProfile(operation: () => Promise<void>, applying: boolean): Promise<void> {
    this.assertOpen();
    if (this.changingProfile || (!applying && (this.applyingProfile || this.submission))) return Promise.reject(new Error('正在应用设置或发送，请稍后切换。'));
    this.state.controlsBusy = true; this.emit();
    this.changingProfile = operation().finally(() => { this.changingProfile = null; this.state.controlsBusy = false; this.emit(); });
    return this.changingProfile;
  }
  setModel(id: string, applying = false) { return this.changeProfile(() => this.changeModel(id, applying), applying); }
  private async changeModel(id: string, applying: boolean) {
    if (this.applyingProfile && !applying) throw new Error('正在应用预设，请稍后切换。');
    if (['running', 'waiting'].includes(this.state.activity)) throw new Error('任务结束后才能切换模型。');
    await this.start(); await this.refreshModels();
    this.assertOpen();
    const model = this.state.models.find(m => m.id === id);
    if (!model) throw new Error('指定模型不可用，请在预设设置中刷新模型列表；尚未发送。');
    if (this.state.target === 'pi') {
      const slash = id.indexOf('/');
      const selected = await this.request('set_model', { provider: id.slice(0, slash), modelId: id.slice(slash + 1) });
      if (selected.provider !== id.slice(0, slash) || selected.id !== id.slice(slash + 1)) throw new Error('CLI 未确认模型切换；尚未发送。');
      await this.refreshPi();
      this.state.efforts = (await this.request('get_available_thinking_levels')).levels;
    } else {
      this.state.efforts = model.efforts || [];
      if (this.state.model !== id) this.state.effort = model.defaultEffort || '';
    }
    this.state.model = id;
    if (this.state.effort && !this.state.efforts.includes(this.state.effort)) this.state.effort = '';
    if (!applying) this.acceptManualProfile();
    this.emit();
  }
  private acceptManualProfile() {
    this.desiredProfile = { model: this.state.model, effort: this.state.effort };
    this.profilePending = false; this.state.error = null;
    if (this.state.activity === 'error') this.state.activity = this.state.draft || this.image ? 'draft' : this.state.messages.length ? 'complete' : 'idle';
  }
  setEffort(effort: string, applying = false) { return this.changeProfile(() => this.changeEffort(effort, applying), applying); }
  private async changeEffort(effort: string, applying: boolean) {
    if (this.applyingProfile && !applying) throw new Error('正在应用预设，请稍后切换。');
    if (['running', 'waiting'].includes(this.state.activity)) throw new Error('任务结束后才能切换思考强度。');
    await this.start();
    this.assertOpen();
    if (!effort || !this.state.efforts.includes(effort)) throw new Error('当前模型不支持这个思考强度；尚未发送。');
    if (this.state.target === 'pi') {
      await this.request('set_thinking_level', { level: effort });
      const actual = await this.request('get_state');
      if (actual.thinkingLevel !== effort) throw new Error('CLI 未确认思考强度切换；尚未发送。');
    }
    this.state.effort = effort;
    if (!applying) this.acceptManualProfile();
    this.emit();
  }
  private addRequest(request: AgentRequest, raw: Wire) {
    this.requestData.set(request.id, raw); this.state.requests = [...this.state.requests, request]; this.state.activity = 'waiting';
    if (raw.timeout) this.requestTimers.set(request.id, setTimeout(() => { this.removeRequest(request.id); this.emit(); }, raw.timeout));
    this.emit();
  }
  private removeRequest(id: string) {
    clearTimeout(this.requestTimers.get(id)); this.requestTimers.delete(id); this.requestData.delete(id);
    this.state.requests = this.state.requests.filter(r => r.id !== id);
    if (!this.state.requests.length && this.state.activity === 'waiting') this.state.activity = 'running';
  }
  private clearRequests() { for (const id of this.requestData.keys()) this.removeRequest(id); }
  async answer(id: string, answer: AgentAnswer) {
    this.assertOpen();
    const request = this.requestData.get(id);
    if (!request || !this.transport) throw new Error('这个请求已经结束。');
    if (this.state.target === 'pi') this.transport.send({ type: 'extension_ui_response', id: request.id, ...answer });
    else {
      const p = request.params; let result: Wire;
      if (/\/(commandExecution|fileChange)\/requestApproval$/.test(request.method)) result = { decision: answer.confirmed ? 'accept' : 'decline' };
      else if (request.method === 'item/permissions/requestApproval') result = { permissions: answer.confirmed ? p.permissions : {}, scope: 'turn' };
      else if (request.method === 'item/tool/requestUserInput') result = { answers: Object.fromEntries((p.questions || []).map((q: Wire) => [q.id, { answers: answer.cancelled ? [] : [answer.answers?.[q.id] || ''] }])) };
      else if (request.method === 'mcpServer/elicitation/request') result = { action: answer.cancelled ? 'cancel' : 'accept', content: answer.cancelled ? null : p.mode === 'url' ? null : JSON.parse(answer.value || '{}') };
      else throw new Error('当前请求类型不能在此回答。');
      this.transport.send({ id: request.id, result });
    }
    this.removeRequest(id); this.emit();
  }
  private codexEvent(message: Wire) {
    if (this.closed) return;
    const p = message.params || {}; const method = message.method;
    if (message.id !== undefined) {
      const id = String(message.id);
      if (/\/(commandExecution|fileChange|permissions)\/requestApproval$/.test(method)) this.addRequest({ id, kind: 'confirm', title: 'Codex 请求授权', detail: [p.reason, p.command, p.cwd, p.permissions && print(p.permissions), p.grantRoot].filter(Boolean).join('\n') }, message);
      else if (method === 'item/tool/requestUserInput') this.addRequest({ id, kind: 'questions', title: 'Codex 需要你的回答', questions: p.questions.map((q: Wire) => ({ id: q.id, question: q.question, options: q.options?.map((o: Wire) => o.label), secret: q.isSecret })) }, message);
      else if (method === 'mcpServer/elicitation/request') this.addRequest({ id, kind: p.mode === 'url' ? 'confirm' : 'json', title: p.serverName, detail: [p.message, p.url, p.requestedSchema && print(p.requestedSchema)].filter(Boolean).join('\n'), prefill: '{}' }, message);
      else { this.transport!.send({ id: message.id, error: { code: -32601, message: `Unsupported client request: ${method}` } }); this.notice(`CLI 请求 ${method} 暂不支持；请在原生 CLI 中处理。`); }
      return;
    }
    if (method === 'turn/started') { this.turn = p.turn.id; this.state.activity = 'running'; }
    else if (method === 'turn/completed') {
      this.turn = null; this.clearRequests();
      this.state.error = p.turn.error?.message || null;
      if (!this.submission) this.settleInput();
      this.state.activity = this.state.error ? 'error' : this.state.draft || this.image ? 'draft' : 'complete';
      this.state.messages = this.state.messages.map(m => m.running ? { ...m, running: false } : m);
    } else if (method === 'serverRequest/resolved') this.removeRequest(String(p.requestId));
    else if (method === 'item/agentMessage/delta') {
      const old = this.state.messages.find(m => m.id === p.itemId);
      this.upsert({ id: p.itemId, role: 'assistant', text: (old?.text || '') + p.delta, running: true });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = p.item; const done = method === 'item/completed';
      if (item.type === 'agentMessage') this.upsert({ id: item.id, role: 'assistant', text: item.text || '', running: !done });
      else if (!['userMessage', 'reasoning'].includes(item.type)) this.upsert({ id: item.id, role: 'tool', title: item.command || item.tool || item.type, text: print(item.aggregatedOutput ?? item.result ?? item.changes ?? item.arguments ?? item.status), running: !done });
    } else if (method === 'item/commandExecution/outputDelta') {
      const old = this.state.messages.find(m => m.id === p.itemId);
      this.upsert({ id: p.itemId, role: 'tool', title: old?.title || '命令', text: (old?.text || '') + p.delta, running: true });
    } else if (method === 'error') { this.state.error = p.error?.message || p.message || 'Codex 执行失败'; if (!p.willRetry) this.state.activity = 'error'; }
    this.emit();
  }
  private piEvent(e: Wire) {
    if (this.closed) return;
    if (e.type === 'extension_ui_request') {
      if (['confirm', 'select', 'input', 'editor'].includes(e.method)) this.addRequest({ id: e.id, kind: e.method, title: e.title || 'Pi 需要你的回答', detail: e.message, options: e.options, prefill: e.prefill }, e);
      else if (e.method === 'set_editor_text') { this.state.draftRevision++; this.setDraft(e.text || ''); }
      else if (e.method === 'setStatus') this.state.status = e.statusText || '';
      else if (e.method === 'notify' || e.method === 'setWidget') this.notice(e.message || e.widgetLines?.join('\n') || '');
      this.emit(); return;
    }
    if (e.type === 'agent_start' || e.type === 'compaction_start') this.state.activity = 'running';
    else if (e.type === 'agent_settled') {
      this.clearRequests(); this.queued = false;
      if (!this.submission) this.settleInput();
      this.state.messages = this.state.messages.map(m => m.running ? { ...m, running: false } : m);
      this.state.activity = this.state.error ? 'error' : this.state.draft || this.image ? 'draft' : 'complete';
      void this.refreshPi().then(() => this.emit()).catch(error => { if (!this.closed) this.disconnected(error); });
    } else if (e.type === 'message_start' && e.message.role === 'assistant') {
      this.assistantId = randomUUID(); this.upsert({ id: this.assistantId, role: 'assistant', text: '', running: true });
    } else if (e.type === 'message_update' && e.assistantMessageEvent.type === 'text_delta') {
      const old = this.state.messages.find(m => m.id === this.assistantId);
      this.upsert({ id: this.assistantId, role: 'assistant', text: (old?.text || '') + e.assistantMessageEvent.delta, running: true });
    } else if (e.type === 'message_end' && e.message.role === 'assistant') {
      this.upsert({ id: this.assistantId || randomUUID(), role: 'assistant', text: contentText(e.message.content), running: false });
      if (e.message.errorMessage && e.message.stopReason !== 'aborted') this.state.error = e.message.errorMessage;
    } else if (e.type.startsWith('tool_execution_')) {
      this.upsert({ id: e.toolCallId, role: 'tool', title: e.toolName, text: contentText((e.result || e.partialResult)?.content) || print(e.args), running: e.type !== 'tool_execution_end' });
    } else if (e.type === 'queue_update') this.queued = Boolean(e.steering?.length || e.followUp?.length);
    else if (e.type === 'auto_retry_start') this.state.status = `正在重试（${e.attempt}）：${e.errorMessage}`;
    else if (e.type === 'auto_retry_end') { this.state.status = ''; if (!e.success) this.state.error = e.finalError; }
    this.emit();
  }
  get canRelease() {
    return !this.closed && !this.submitted && !this.submission && !this.starting && !this.loadingModels && !this.applyingProfile && !this.changingProfile && this.state.activity === 'complete' && !this.state.draft && !this.image && !this.state.requests.length && !this.queued
      && Boolean(this.state.target === 'codex' ? this.sessionId : this.sessionFile && existsSync(this.sessionFile));
  }
  release() {
    this.detach(); this.emit();
  }
  dispose() {
    if (this.closed) return;
    this.closed = true; this.clearRequests(); this.unwatch();
    if (this.state.target === 'codex' && this.sessionId && this.turn && this.transport?.alive) this.interrupt(this.transport, this.sessionId, this.turn);
    this.detach();
    this.images.remove(this.image); this.images.remove(this.submitted?.image || null); this.image = null; this.submitted = null;
  }
}
