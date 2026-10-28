import { app } from 'electron';
import { Transport, type Wire } from './transport';
import type { AgentModel, LocalConfig } from '../../shared/contracts';
/** One lazy app-server shared by this app's threads, never the Desktop connection. */
export class CodexRuntime {
  transport: Transport | null = null;
  private ready: Promise<Transport> | null = null;
  private modelCache: Promise<AgentModel[]> | null = null;
  private users = new Set<symbol>();
  private idleSince = Date.now();
  readonly listeners = new Map<string, (message: Wire) => void>();
  private owners = new Set<(error: Error) => void>();
  /** A session holds its lease from connection start through release; catalog reads hold a temporary lease. */
  retain() {
    const user = Symbol(); this.users.add(user);
    return () => { if (this.users.delete(user)) this.idleSince = Date.now(); };
  }
  closeIfUnused() { if (!this.users.size) this.close(); }
  closeIfIdle(idleMs: number) { if (Date.now() - this.idleSince >= idleMs) this.closeIfUnused(); }
  async connect(config: LocalConfig) {
    if (this.ready) return this.ready;
    const ready = this.start(config); this.ready = ready;
    void ready.catch(() => { if (this.ready === ready) this.ready = null; });
    return ready;
  }
  private async start(config: LocalConfig) {
    const transport = this.transport = new Transport(config.executable, ['app-server', '--listen', 'stdio://'], config.cwd, 'codex');
    transport.on('message', message => {
      const id = message.params?.threadId || message.params?.thread?.id;
      const listener = this.listeners.get(id);
      if (listener) listener(message);
      else if (message.id !== undefined && message.method) transport.send({ id: message.id, error: { code: -32601, message: 'No matching local task for this request' } });
    });
    transport.on('closed', error => {
      if (this.transport !== transport) return;
      this.transport = null; this.ready = null; this.modelCache = null;
      for (const owner of this.owners) owner(error);
    });
    await transport.request('initialize', { clientInfo: { name: 'mac_ai_prompt', title: 'Lasso', version: app.getVersion() }, capabilities: { experimentalApi: true } });
    transport.send({ method: 'initialized' });
    return transport;
  }
  async models(config: LocalConfig, refresh = false): Promise<AgentModel[]> {
    const release = this.retain();
    try {
      if (refresh) this.modelCache = null;
      if (this.modelCache) return await this.modelCache;
      const request = this.connect(config).then(async transport => {
        const models: AgentModel[] = []; let cursor: string | undefined;
        do {
          const page = await transport.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
          models.push(...page.data.map((m: Wire) => ({ id: m.model, label: m.displayName, images: !m.inputModalities || m.inputModalities.includes('image'), efforts: m.supportedReasoningEfforts?.map((e: Wire) => e.reasoningEffort) || [], defaultEffort: m.defaultReasoningEffort })));
          cursor = page.nextCursor || undefined;
        } while (cursor);
        return models;
      });
      this.modelCache = request;
      try { return await request; }
      catch (error) { if (this.modelCache === request) this.modelCache = null; throw error; }
    } finally { release(); }
  }
  watch(callback: (error: Error) => void) { this.owners.add(callback); return () => this.owners.delete(callback); }
  close() { const transport = this.transport; this.transport = null; this.ready = null; this.modelCache = null; transport?.close(); }
}
