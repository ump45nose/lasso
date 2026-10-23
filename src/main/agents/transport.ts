import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, openSync, readSync, closeSync, realpathSync, existsSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { EventEmitter } from 'node:events';
// Native protocols own their payloads. No shell or prompt interpolation is involved.
export type Wire = Record<string, any>;
export class Transport extends EventEmitter {
  private process: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  private next = 0;
  private stopped = false;
  private stderr = '';
  constructor(executable: string, args: string[], cwd: string, private protocol: 'codex' | 'pi') {
    super();
    if (!isAbsolute(executable)) throw new Error('请在设置中选择 CLI 的绝对路径。');
    accessSync(executable, constants.X_OK);
    const entry = realpathSync(executable);
    const fd = openSync(entry, 'r'); const bytes = Buffer.alloc(100);
    let head: string; try { head = bytes.subarray(0, readSync(fd, bytes, 0, 100, 0)).toString(); } finally { closeSync(fd); }
    const node = [join(dirname(executable), 'node'), '/opt/homebrew/bin/node', '/usr/local/bin/node'].find(existsSync);
    const isNode = /^#!.*\bnode\b/.test(head);
    if (isNode && !node) throw new Error('未找到运行 CLI 所需的 Node.js。');
    const env = { ...process.env, PATH: [dirname(executable), node && dirname(node), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].filter(Boolean).join(':') };
    // Detached group lets us clean up only the CLI and tools started by this app.
    this.process = spawn(isNode ? node! : executable, isNode ? [entry, ...args] : args, { cwd, env, stdio: 'pipe', detached: true });
    this.process.stdout.setEncoding('utf8'); this.process.stderr.setEncoding('utf8');
    let buffer = '';
    this.process.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message: Wire;
        try { message = JSON.parse(line); } catch { this.fail(new Error('CLI 返回了非 JSON 协议内容，请检查所选入口。')); return; }
        const key = String(message.id);
        const pending = this.pending.get(key);
        if (pending && (protocol === 'codex' ? !message.method : message.type === 'response')) {
          clearTimeout(pending.timer); this.pending.delete(key);
          if (message.error || message.success === false) pending.reject(new Error(typeof message.error === 'string' ? message.error : message.error?.message || 'CLI 请求失败'));
          else pending.resolve(protocol === 'codex' ? message.result : message.data);
        } else this.emit('message', message);
      }
    });
    this.process.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-3000); });
    this.process.stdin.on('error', error => this.fail(error));
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', (code, signal) => {
      this.fail(new Error(`CLI 已退出（${code ?? signal}）${this.stderr ? '\n' + this.stderr : ''}`));
    });
  }
  get alive() { return !this.stopped; }
  send(message: Wire) {
    if (this.stopped) throw new Error('CLI 连接已关闭，请恢复会话。');
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: Wire = {}): Promise<any> {
    const id = 'q' + ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 响应超时；不会自动重复提交。`)); }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send(this.protocol === 'codex' ? { id, method, params } : { id, type: method, ...params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private fail(error: Error) {
    if (this.stopped) return;
    this.stopped = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    const pid = this.process.pid;
    if (pid) { try { process.kill(-pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    this.emit('closed', error);
  }
  close() { this.fail(new Error('CLI 连接已关闭')); }
}
