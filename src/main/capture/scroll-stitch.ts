/** Raw, four-byte pixels in the same BGRA order as nativeImage.toBitmap(). */
export interface ScrollFrame { width: number; height: number; data: Uint8Array }
export type StitchStatus = 'matched' | 'duplicate' | 'unreliable' | 'limit' | 'empty' | 'ok';
export interface StitchResult {
  status: StitchStatus;
  width: number;
  height: number;
  segments: number;
  seams: number[];
  canUndo: boolean;
  fixedTop: number;
  fixedBottom: number;
  reason?: string;
  data?: Uint8Array<ArrayBuffer>;
}

export const SCROLL_MAX_HEIGHT = 16384;
export const SCROLL_MAX_PIXELS = 20_000_000;

type Segment = { rows: number; data: Uint8Array };
type Score = { error: number; inliers: number; texture: number };

/** Stores only the first/last viewport and newly revealed rows, never a history of full frames. */
export class ScrollStitcher {
  private first?: ScrollFrame;
  private last?: ScrollFrame;
  private parts: Segment[] = [];
  private top = 0;
  private bottom = 0;
  private resultHeight = 0;
  private limited = false;

  reset(): StitchResult {
    this.first = this.last = undefined;
    this.parts = [];
    this.top = this.bottom = this.resultHeight = 0;
    this.limited = false;
    return this.result('empty');
  }

  private result(status: StitchStatus, reason?: string): StitchResult {
    let y = (this.first?.height ?? 0) - this.bottom;
    const seams = this.parts.map(part => { const seam = y; y += part.rows; return seam; });
    return { status, width: this.first?.width ?? 0, height: this.resultHeight,
      segments: this.first ? this.parts.length + 1 : 0, seams, canUndo: this.parts.length > 0,
      fixedTop: this.top, fixedBottom: this.bottom, ...(reason ? { reason } : {}) };
  }

  add(frame: ScrollFrame): StitchResult {
    const { width, height, data } = frame;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width * height > SCROLL_MAX_PIXELS * 2 || data.byteLength !== width * height * 4) {
      return this.result('unreliable', '采集帧尺寸无效，已保留之前的结果');
    }
    if (this.limited) return this.result('limit', '已达到滚动截图资源上限');
    const maximum = Math.min(SCROLL_MAX_HEIGHT, Math.floor(SCROLL_MAX_PIXELS / width));
    if (!maximum) return this.result('unreliable', '选区过宽，请缩小选区');
    if (!this.first) {
      const keptHeight = Math.min(height, maximum);
      // The worker owns transferred frames. Copy only when a hard limit cuts a viewport.
      this.first = this.last = keptHeight === height ? frame : { width, height: keptHeight, data: data.slice(0, keptHeight * width * 4) };
      this.resultHeight = keptHeight;
      this.limited = keptHeight >= maximum;
      return this.result(this.limited ? 'limit' : 'matched', this.limited ? '已达到高度或总像素上限，已保留上限以内的原始像素' : undefined);
    }
    const previous = this.last!;
    if (width !== previous.width || height !== previous.height) {
      return this.result('unreliable', '采集区尺寸已变化，已保留之前的结果');
    }
    const duplicate = this.score(previous, frame, 0, 0, 0, 40);
    if (duplicate.error <= .4 && duplicate.inliers >= .995) return this.result('duplicate');

    const firstJoin = this.parts.length === 0;
    const top = firstJoin ? this.fixedBand(previous, frame, false) : this.top;
    const bottom = firstJoin ? this.fixedBand(previous, frame, true) : this.bottom;
    if (!firstJoin && (!this.bandStable(previous, frame, 0, top) || !this.bandStable(previous, frame, height - bottom, height))) {
      return this.result('unreliable', '固定栏发生变化，请暂停动画或调整选区后重新开始');
    }
    const content = height - top - bottom;
    const overlapMinimum = Math.max(32, Math.ceil(content * .18));
    let best = { shift: 0, error: Infinity, inliers: 0, texture: 0 };
    const candidates: Array<{ shift: number; error: number }> = [];
    for (let shift = 1; shift <= content - overlapMinimum; shift++) {
      const score = this.score(previous, frame, shift, top, bottom, 24);
      if (score.error < best.error) best = { shift, ...score };
      candidates.push({ shift, error: score.error });
    }
    if (!best.shift || best.error > 5 || best.inliers < .94 || best.texture < 4) {
      return this.result('unreliable', '未找到可靠的向下重叠，请向上回到上一段，保留重叠后继续');
    }
    const ambiguous = candidates.some(candidate => Math.abs(candidate.shift - best.shift) > 3 &&
      candidate.error <= best.error + Math.max(.7, best.error * .35));
    if (ambiguous) return this.result('unreliable', '内容重复，接缝位置无法确定，请回到上一段后缓慢向下滚动');
    const verified = this.score(previous, frame, best.shift, top, bottom, 64);
    if (verified.error > 5 || verified.inliers < .94) {
      return this.result('unreliable', '重叠区域不稳定，请停止动画或回到上一段后继续');
    }

    // A fixed footer belongs only at the end. New content replaces it before it is appended once.
    this.top = top;
    this.bottom = bottom;
    const rows = Math.min(best.shift, maximum - this.resultHeight);
    if (rows > 0) {
      const start = (height - bottom - best.shift) * width * 4;
      this.parts.push({ rows, data: data.slice(start, start + rows * width * 4) });
      this.resultHeight += rows;
      this.last = frame;
    }
    this.limited = rows < best.shift || this.resultHeight >= maximum;
    return this.result(this.limited ? 'limit' : 'matched', this.limited ? '已达到高度或总像素上限，已保留上限以内的原始像素' : undefined);
  }

  undo(): StitchResult {
    const part = this.parts.pop();
    if (!part || !this.first) return this.result(this.first ? 'ok' : 'empty');
    this.resultHeight -= part.rows;
    this.limited = false;
    if (!this.parts.length) {
      this.last = this.first;
      this.top = this.bottom = 0;
    } else {
      const combined = this.snapshot().data!;
      const { width, height } = this.first;
      const stride = width * 4;
      const restored = new Uint8Array(width * height * 4);
      restored.set(this.first.data.subarray(0, this.top * stride));
      const contentHeight = height - this.top - this.bottom;
      restored.set(combined.subarray((this.resultHeight - this.bottom - contentHeight) * stride, (this.resultHeight - this.bottom) * stride), this.top * stride);
      restored.set(this.first.data.subarray((height - this.bottom) * stride), (height - this.bottom) * stride);
      this.last = { width, height, data: restored };
    }
    return this.result('ok');
  }

  snapshot(): StitchResult {
    if (!this.first) return this.result('empty');
    const stride = this.first.width * 4;
    const data = new Uint8Array(this.resultHeight * stride);
    const initialBytes = (this.first.height - this.bottom) * stride;
    data.set(this.first.data.subarray(0, initialBytes));
    let cursor = initialBytes;
    for (const part of this.parts) { data.set(part.data, cursor); cursor += part.data.byteLength; }
    data.set(this.first.data.subarray(initialBytes), cursor);
    return { ...this.result(this.limited ? 'limit' : 'ok'), data };
  }

  private columns(width: number, count: number): number[] {
    const inset = Math.min(12, Math.floor(width * .06));
    const span = Math.max(1, width - inset * 2);
    return Array.from({ length: Math.min(count, span) }, (_, i) => inset + Math.floor((i + .5) * span / Math.min(count, span)));
  }

  private fixedBand(a: ScrollFrame, b: ScrollFrame, fromBottom: boolean): number {
    const cap = Math.floor(a.height / 3);
    for (let n = 0; n < cap; n++) {
      const y = fromBottom ? a.height - 1 - n : n;
      if (!this.bandStable(a, b, y, y + 1)) return n;
    }
    return cap;
  }

  private bandStable(a: ScrollFrame, b: ScrollFrame, start: number, end: number): boolean {
    const xs = this.columns(a.width, 32);
    const step = Math.max(1, Math.floor((end - start) / 48));
    for (let y = start; y < end; y += step) {
      let difference = 0;
      for (const x of xs) {
        const i = (y * a.width + x) * 4;
        difference += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      }
      if (difference / (xs.length * 3) > 1.5) return false;
    }
    return true;
  }

  private score(a: ScrollFrame, b: ScrollFrame, shift: number, top: number, bottom: number, samples: number): Score {
    const xs = this.columns(a.width, samples);
    const available = a.height - bottom - top - shift;
    const rowCount = Math.min(samples, available);
    let error = 0, inliers = 0, count = 0, texture = 0;
    for (let row = 0; row < rowCount; row++) {
      const y = top + Math.floor((row + .5) * available / rowCount);
      let last = -1;
      for (const x of xs) {
        const ai = ((y + shift) * a.width + x) * 4, bi = (y * b.width + x) * 4;
        let delta = 0, maximum = 0, value = 0;
        for (let channel = 0; channel < 3; channel++) {
          const d = Math.abs(a.data[ai + channel] - b.data[bi + channel]);
          delta += d; maximum = Math.max(maximum, d); value += a.data[ai + channel];
        }
        error += delta / 3;
        if (maximum <= 14) inliers++;
        if (last >= 0) texture += Math.abs(value / 3 - last);
        last = value / 3;
        count++;
      }
    }
    return { error: count ? error / count : Infinity, inliers: count ? inliers / count : 0, texture: count ? texture / count : 0 };
  }
}
