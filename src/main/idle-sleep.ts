import { idleMilliseconds, type MemorySettings } from '../shared/memory';

/** Hidden time survives configuration changes; visibility cancels a pending sleep. */
export class IdleSleep {
  private since: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  constructor(private settings: () => MemorySettings, private sleep: () => Promise<void>) {}
  get due(){return this.since !== null && Date.now()-this.since >= idleMilliseconds(this.settings());}
  active(active: boolean) { this.since = active ? null : this.since ?? Date.now(); this.refresh(); }
  refresh() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed || this.since === null) return;
    const delay = idleMilliseconds(this.settings());
    if (!Number.isFinite(delay)) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sleep().catch(error => console.warn('[memory] sleep', error.message)).finally(() => {
        if (!this.disposed && this.since !== null && !this.timer) this.timer = setTimeout(() => this.refresh(), 30_000);
      });
    }, Math.max(0, this.since + delay - Date.now()));
  }
  dispose() { this.disposed = true; if (this.timer) clearTimeout(this.timer); this.timer = null; }
}
