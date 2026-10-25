import { Worker } from 'node:worker_threads';
import { join } from 'node:path';

export interface ScrollFrame { width: number; height: number; data: Uint8Array }
export interface ScrollReply {
  id: number; type: string; status: string; width: number; height: number;
  segments: number; seams: number[]; reason?: string; data?: Uint8Array;
}
/** One capture and one worker request at a time. No frame queue grows behind a slow matcher. */
export class ScrollSession {
  private worker = new Worker(join(__dirname, 'scroll-worker.cjs'));
  private seq = 0;
  private requests = new Map<number, { resolve: (reply: ScrollReply) => void; reject: (error: Error) => void }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flight: Promise<void> | null = null;
  private dead = false;
  private failure: Error | null = null;
  status: 'running' | 'paused' | 'finished' = 'running';
  metadata: ScrollReply = { id: 0, type: 'frame', status: 'empty', width: 0, height: 0, segments: 0, seams: [] };
  message = '在选区内缓慢向下滚动，每次保留至少三分之一重叠';
  constructor(private capture: () => Promise<ScrollFrame>, private changed: () => void, private stopped: () => void) {
    this.worker.on('message', (reply: ScrollReply) => {
      const request = this.requests.get(reply.id); if (!request) return;
      this.requests.delete(reply.id);
      if (reply.type === 'error') request.reject(Error(reply.reason || '滚动拼接失败'));
      else request.resolve(reply);
    });
    this.worker.on('error', error => this.failed(error));
    this.worker.on('exit', () => { if (!this.dead) this.failed(Error('滚动拼接进程已退出')); });
  }
  private failed(error: Error) {
    this.failure=error;
    for (const request of this.requests.values()) request.reject(error);
    this.requests.clear();
    this.status = 'paused'; this.message = error.message; this.changed();
  }
  private request(type: string, frame?: ScrollFrame): Promise<ScrollReply> {
    if (this.dead || this.failure) return Promise.reject(this.failure || Error('滚动截图已结束'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...frame }, frame ? [frame.data.buffer as ArrayBuffer] : []);
    });
  }
  async start() { await this.tick(); }
  private schedule() {
    if (!this.dead && this.status === 'running') this.timer = setTimeout(() => { this.timer = null; void this.tick(); }, 400);
  }
  private async tick() {
    if (this.dead || this.flight || this.status !== 'running') return;
    let reachedLimit = false;
    this.flight = (async () => {
      try {
        const frame = await this.capture();
        if (this.dead) return;
        const reply = await this.request('frame', frame);
        if (this.dead) return;
        this.metadata = reply;
        if (reply.status === 'unreliable') {
          this.status = 'paused';
          this.message = '匹配不可靠，已暂停并保留结果。请向上回到上次采集位置，再继续慢滚。';
        } else if (reply.status === 'limit') {
          this.status = 'finished'; reachedLimit = true;
          this.message = reply.reason || '已达到尺寸上限，结果已保留';
        }
        this.changed();
      } catch (error) {
        if (this.dead) return;
        this.status = 'paused'; this.message = '采集已暂停，已匹配结果保留：' + (error as Error).message; this.changed();
      }
    })();
    await this.flight; this.flight = null;
    if (reachedLimit && !this.dead) this.stopped(); else this.schedule();
  }
  async pause() {
    this.status = 'paused'; if (this.timer) clearTimeout(this.timer); this.timer = null;
    await this.flight;
    if (!this.dead) { if (this.metadata.status !== 'unreliable') this.message = '已暂停；继续前请保持在上次采集位置'; this.changed(); }
  }
  resume() {
    if (this.dead || this.status !== 'paused') return;
    this.status = 'running'; this.message = '在选区内缓慢向下滚动，每次保留至少三分之一重叠'; this.changed(); this.schedule();
  }
  async finish() {
    this.status = 'finished'; if (this.timer) clearTimeout(this.timer); this.timer = null;
    await this.flight; this.status = 'finished';
    return this.request('snapshot');
  }
  async undo() {
    if (this.status !== 'finished') throw Error('请先结束采集再撤回末段');
    this.metadata = await this.request('undo');
    return this.request('snapshot');
  }
  dispose() {
    if (this.dead) return;
    this.dead = true; if (this.timer) clearTimeout(this.timer); this.timer = null;
    for (const request of this.requests.values()) request.reject(Error('滚动截图已取消'));
    this.requests.clear(); void this.worker.terminate();
  }
}
