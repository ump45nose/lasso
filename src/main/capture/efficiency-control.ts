import type { CaptureDelay, CaptureDisplayBinding, CaptureEfficiencyResult, CaptureEfficiencyState, EfficiencyCaptureMode, SuccessfulCaptureArea } from '../../shared/capture-efficiency';
import { captureModes } from '../../shared/capture';

export interface EfficiencyCaptureRequest {
  mode: EfficiencyCaptureMode;
  /** Present only for repeat. The adapter must target this exact display and rect. */
  area?: SuccessfulCaptureArea;
  signal: AbortSignal;
}
export interface CaptureEfficiencyAdapter {
  displays(): readonly CaptureDisplayBinding[];
  /** Resolve after pixels have been acquired, or null when the operation was canceled.
   * Check signal before creating an editor; cancellation must not publish a stale session.
   * An area may be returned after a successful area selection. Existing selection handlers
   * may instead call rememberSuccessfulArea at their successful pixels-to-editor boundary. */
  capture(request: EfficiencyCaptureRequest): Promise<{ area?: SuccessfulCaptureArea } | null>;
}
export interface CaptureEfficiencyClock {
  now(): number;
  schedule(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}
const clock: CaptureEfficiencyClock = {
  now: () => performance.now(),
  schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};
const copyArea = (area: SuccessfulCaptureArea): SuccessfulCaptureArea => ({ display: { ...area.display, bounds: { ...area.display.bounds } }, rect: { ...area.rect } });
const sameRect = (a: CaptureDisplayBinding['bounds'], b: CaptureDisplayBinding['bounds']) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
export const sameCaptureDisplay = (a: CaptureDisplayBinding, b: CaptureDisplayBinding) => a.id === b.id && a.scaleFactor === b.scaleFactor && a.rotation === b.rotation && sameRect(a.bounds, b.bounds);
const validArea = ({ display, rect }: SuccessfulCaptureArea) => Number.isSafeInteger(display?.id) &&
  display.bounds && [display.bounds.x, display.bounds.y, display.bounds.width, display.bounds.height, display.scaleFactor, display.rotation].every(Number.isFinite) &&
  display.bounds.width > 0 && display.bounds.height > 0 && display.scaleFactor > 0 &&
  rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 &&
  rect.x + rect.width <= display.bounds.width && rect.y + rect.height <= display.bounds.height;
const reselectMessage = '上次区域所在显示器已移除或设置已改变，请重新选择区域';
export class CaptureReselectRequiredError extends Error { constructor(){super(reselectMessage);} }
type PendingCapture = {
  controller: AbortController;
  mode: EfficiencyCaptureMode;
  area?: SuccessfulCaptureArea;
  deadline: number;
  timer?: unknown;
  running: boolean;
  resolve: (result: CaptureEfficiencyResult) => void;
};

/** In-memory capture scheduling. No Electron, persistence, permission requests or UI ownership.
 * CaptureManager's successful area-selection path supplies a display binding once; the
 * main integration routes delayed requests through start and cancels on application exit. */
export class CaptureEfficiencyControl {
  private lastArea: SuccessfulCaptureArea | null = null;
  private pending: PendingCapture | null = null;
  private disposed = false;
  private listeners = new Set<(state: CaptureEfficiencyState) => void>();
  private current: CaptureEfficiencyState = { phase: 'idle', mode: null, remaining: 0, hasLastArea: false, error: null };

  constructor(private adapter: CaptureEfficiencyAdapter, private time: CaptureEfficiencyClock = clock) {}

  get state(): CaptureEfficiencyState { return { ...this.current }; }
  get rememberedArea(): SuccessfulCaptureArea | null { return this.lastArea ? copyArea(this.lastArea) : null; }
  subscribe(listener: (state: CaptureEfficiencyState) => void) {
    if (this.disposed) throw Error('截图控制已关闭');
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }
  /** Call only after a successful region capture; failed/canceled selection must not call this. */
  rememberSuccessfulArea(area: SuccessfulCaptureArea) {
    if (this.disposed) return;
    if (!area || !validArea(area)) throw Error('无效的截图区域或显示器');
    if (!this.matches(area)) throw Error(reselectMessage);
    this.lastArea = copyArea(area);
    this.publish({ hasLastArea: true, error: null });
  }
  start(mode: EfficiencyCaptureMode, delay: CaptureDelay = 0): Promise<CaptureEfficiencyResult> {
    if (this.disposed) return Promise.resolve({ status: 'failed', error: '截图控制已关闭' });
    if (!(mode === 'repeat' || captureModes.includes(mode)) || ![0, 3, 5, 10].includes(delay)) return Promise.resolve({ status: 'failed', error: '不支持的截图方式或延时时间' });
    if (this.pending) return Promise.resolve({ status: 'failed', error: '请先取消或完成当前截图' });
    let area: SuccessfulCaptureArea | undefined;
    if (mode === 'repeat') {
      const error = !this.lastArea ? '尚无成功截图区域，请先选择区域' : !this.matches(this.lastArea) ? reselectMessage : null;
      if (error) { this.publish({ error }); return Promise.resolve({ status: 'reselect-required', error }); }
      area = copyArea(this.lastArea!);
    }
    return new Promise(resolve => {
      const pending: PendingCapture = { controller: new AbortController(), mode, area, deadline: this.time.now() + delay * 1000, running: false, resolve };
      this.pending = pending;
      this.publish({ phase: delay ? 'countdown' : 'capturing', mode, remaining: delay, error: null });
      // A state subscriber may cancel synchronously (for example, when its owner closes).
      if (this.pending === pending) this.tick(pending);
    });
  }
  /** Canceling an in-flight adapter keeps the lock until it settles, so late completion
   * cannot race a new capture. Countdown cancellation is immediate and never captures. */
  cancel() {
    const pending = this.pending;
    if (!pending || pending.controller.signal.aborted) return;
    pending.controller.abort();
    if (pending.timer !== undefined) this.time.clear(pending.timer);
    pending.timer = undefined;
    if (pending.running) this.publish({ phase: 'canceling', remaining: 0 });
    else this.finish(pending, { status: 'canceled' });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    this.listeners.clear();
  }
  private matches(area: SuccessfulCaptureArea) { return this.adapter.displays().some(display => sameCaptureDisplay(area.display, display)); }
  private publish(update: Partial<CaptureEfficiencyState>) {
    this.current = { ...this.current, ...update };
    if (!this.disposed) for (const listener of this.listeners) listener(this.state);
  }
  private tick(pending: PendingCapture) {
    if (this.pending !== pending || pending.controller.signal.aborted) return;
    const milliseconds = pending.deadline - this.time.now();
    if (milliseconds <= 0) { void this.capture(pending); return; }
    const remaining = Math.ceil(milliseconds / 1000);
    if (remaining !== this.current.remaining) this.publish({ remaining });
    if (this.pending === pending) pending.timer = this.time.schedule(() => { pending.timer = undefined; this.tick(pending); }, Math.min(1000, milliseconds));
  }
  private async capture(pending: PendingCapture) {
    if (this.pending !== pending || pending.controller.signal.aborted) return;
    try {
      if (pending.area && !this.matches(pending.area)) { this.finish(pending, { status: 'reselect-required', error: reselectMessage }); return; }
      pending.running = true;
      this.publish({ phase: 'capturing', remaining: 0 });
      if (pending.controller.signal.aborted) { this.finish(pending, { status: 'canceled' }); return; }
      const result = await this.adapter.capture({ mode: pending.mode, area: pending.area ? copyArea(pending.area) : undefined, signal: pending.controller.signal });
      if (pending.controller.signal.aborted || !result) { this.finish(pending, { status: 'canceled' }); return; }
      const area = result.area ?? pending.area;
      if (area) {
        if (!validArea(area)) throw Error('无效的截图区域或显示器');
        if (!this.matches(area)) { this.finish(pending, { status: 'reselect-required', error: reselectMessage }); return; }
        this.lastArea = copyArea(area);
      }
      this.finish(pending, { status: 'captured' });
    } catch (error) {
      this.finish(pending, pending.controller.signal.aborted ? { status: 'canceled' } : { status: error instanceof CaptureReselectRequiredError?'reselect-required':'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
  private finish(pending: PendingCapture, result: CaptureEfficiencyResult) {
    if (this.pending !== pending) return;
    if (pending.timer !== undefined) this.time.clear(pending.timer);
    this.pending = null;
    this.publish({ phase: 'idle', mode: null, remaining: 0, hasLastArea: Boolean(this.lastArea), error: 'error' in result ? result.error : null });
    pending.resolve(result);
  }
}
