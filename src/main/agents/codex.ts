import { app } from 'electron';
import { Transport, type Wire } from './transport';
import type { AgentModel, LocalConfig } from '../../shared/contracts';
/** One lazy app-server shared by this app's threads, never the Desktop connection. */
export class CodexRuntime {
  transport: Transport | null = null;
  private ready: Promise<Transport> | null = null;
  private modelCache: Promise<AgentModel[]> | null = null;
  readonly listeners = new Map<string, (message: Wire) => void>();
  private owners = new Set<(error: Error) => void>();
  async connect(config: LocalConfig) {
    if (this.ready) return this.ready;
    this.ready = this.start(config).catch(error => { this.ready = null; throw error; });
    return this.ready;
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
  models(config: LocalConfig, refresh = false): Promise<AgentModel[]> {
    if (refresh) this.modelCache = null;
    return this.modelCache ||= this.connect(config).then(async transport => {
      const models: AgentModel[] = []; let cursor: string | undefined;
      do {
        const page = await transport.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
        models.push(...page.data.map((m: Wire) => ({ id: m.model, label: m.displayName, images: !m.inputModalities || m.inputModalities.includes('image'), efforts: m.supportedReasoningEfforts?.map((e: Wire) => e.reasoningEffort) || [], defaultEffort: m.defaultReasoningEffort })));
        cursor = page.nextCursor || undefined;
      } while (cursor);
      return models;
    }).catch(error => { this.modelCache = null; throw error; });
  }
  watch(callback: (error: Error) => void) { this.owners.add(callback); return () => this.owners.delete(callback); }
  close() { const transport = this.transport; this.transport = null; this.ready = null; this.modelCache = null; transport?.close(); }
}
