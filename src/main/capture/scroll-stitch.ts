import type { ScrollDirection } from '../../shared/capture';
/** Raw, four-byte pixels in the same BGRA order as nativeImage.toBitmap(). */
export interface ScrollFrame { width: number; height: number; data: Uint8Array }
export type StitchStatus = 'matched' | 'duplicate' | 'unreliable' | 'limit' | 'empty' | 'ok';
export interface StitchResult {
  status: StitchStatus;
  width: number;
  height: number;
  segments: number;
  seams: number[];
  segmentSizes: number[];
  direction: ScrollDirection;
  reversedTrimmed: number;
  canUndo: boolean;
  fixedTop: number;
  fixedBottom: number;
  fixedLeft: number;
  fixedRight: number;
  reason?: string;
  data?: Uint8Array<ArrayBuffer>;
}

export const SCROLL_MAX_HEIGHT = 16384;
export const SCROLL_MAX_PIXELS = 20_000_000;

type Segment = { start: number; end: number; data: Uint8Array };
type Score = { error: number; inliers: number; texture: number };
type Match = Score & { shift: number; top: number; bottom: number };
/** Horizontal images are transposed so matching, fixed bands and history share one row algorithm. */
function transpose(frame: ScrollFrame): ScrollFrame & { data: Uint8Array<ArrayBuffer> } {
  const data = new Uint8Array(frame.data.byteLength);
  for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
    const from = (y * frame.width + x) * 4, to = (x * frame.height + y) * 4;
    data[to] = frame.data[from]; data[to + 1] = frame.data[from + 1];
    data[to + 2] = frame.data[from + 2]; data[to + 3] = frame.data[from + 3];
  }
  return { width: frame.height, height: frame.width, data };
}

/** Keeps the first/last viewport and each revealed segment, including 32 rows for seam correction. */
export class ScrollStitcher {
  constructor(private maxHeight = SCROLL_MAX_HEIGHT, private direction: ScrollDirection = 'vertical') {}
  private first?: ScrollFrame;
  private last?: ScrollFrame;
  private parts: Segment[] = [];
  private top = 0;
  private bottom = 0;
  private resultHeight = 0;
  private limited = false;
  private axis: 'vertical' | 'horizontal' = 'vertical';
  private locked = false;
  private reversedTrimmed = 0;

  private maximum(width: number) { return Math.min(this.maxHeight, Math.floor(SCROLL_MAX_PIXELS / width)); }
  private limitReason(width: number) { return this.maxHeight <= Math.floor(SCROLL_MAX_PIXELS / width) ? '已达到设置的最大长度，结果已保留' : '已达到 2000 万总像素上限，结果已保留'; }
  reset(): StitchResult {
    this.first = this.last = undefined;
    this.parts = [];
    this.top = this.bottom = this.resultHeight = this.reversedTrimmed = 0;
    this.limited = this.locked = false;
    return this.result('empty');
  }

  setDirection(direction: ScrollDirection): StitchResult {
    if (!['vertical', 'horizontal', 'auto'].includes(direction)) throw Error('无效的滚动方向');
    if (this.locked && direction !== 'auto' && direction !== this.axis) throw Error('已拼接内容，请重新开始后切换方向');
    this.direction = direction;
    if (!this.locked && this.first) {
      const axis = direction === 'horizontal' ? 'horizontal' : 'vertical';
      if (axis !== this.axis) this.initialize(transpose(this.first), axis);
    }
    return this.result(this.first ? 'ok' : 'empty');
  }

  private result(status: StitchStatus, reason?: string): StitchResult {
    let position = this.top;
    const segmentSizes = this.parts.map(part => part.end - part.start);
    const seams = segmentSizes.slice(0, -1).map(rows => { position += rows; return position; });
    const width = this.first?.width ?? 0;
    return { status, width: this.axis === 'horizontal' ? this.resultHeight : width,
      height: this.axis === 'horizontal' ? width : this.resultHeight,
      segments: this.parts.length, seams, segmentSizes, direction: this.locked ? this.axis : this.direction,
      reversedTrimmed: this.reversedTrimmed, canUndo: this.parts.length > 1,
      fixedTop: this.axis === 'vertical' ? this.top : 0, fixedBottom: this.axis === 'vertical' ? this.bottom : 0,
      fixedLeft: this.axis === 'horizontal' ? this.top : 0, fixedRight: this.axis === 'horizontal' ? this.bottom : 0,
      ...(reason ? { reason } : {}) };
  }

  private initialize(frame: ScrollFrame, axis: 'vertical' | 'horizontal') {
    this.axis = axis;
    const height = Math.min(frame.height, this.maximum(frame.width));
    this.first = this.last = height === frame.height ? frame : { width: frame.width, height, data: frame.data.slice(0, height * frame.width * 4) };
    this.parts = [{ start: 0, end: height, data: this.first.data }];
    this.resultHeight = height;
    this.limited = height >= this.maximum(frame.width);
  }

  add(input: ScrollFrame): StitchResult {
    const { width, height, data } = input;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width * height > SCROLL_MAX_PIXELS * 2 || data.byteLength !== width * height * 4) {
      return this.result('unreliable', '采集帧尺寸无效，已保留之前的结果');
    }
    if (this.limited) return this.result('limit', this.limitReason(this.first?.width || 1));
    if (!this.first) {
      const axis = this.direction === 'horizontal' ? 'horizontal' : 'vertical';
      const frame = axis === 'horizontal' ? transpose(input) : input;
      if (this.maximum(frame.width) < 1) return this.result('unreliable', '选区过宽，请缩小选区');
      this.initialize(frame, axis);
      return this.result(this.limited ? 'limit' : 'matched', this.limited ? this.limitReason(frame.width) : undefined);
    }
    let frame = this.axis === 'horizontal' ? transpose(input) : input;
    const previous = this.last!;
    if (frame.width !== previous.width || frame.height !== previous.height) {
      return this.result('unreliable', '采集区尺寸已变化，已保留之前的结果');
    }
    const duplicate = this.score(previous, frame, 0, 0, 0, 40);
    if (duplicate.error <= .4 && duplicate.inliers >= .995) return this.result('duplicate');
    let match = this.match(previous, frame);
    if (this.direction === 'auto' && !this.locked) {
      const horizontal = transpose(input), alternative = this.match(transpose(previous), horizontal);
      if (alternative && (!match || alternative.error < match.error)) {
        this.initialize(transpose(previous), 'horizontal'); frame = horizontal; match = alternative;
      }
    }
    if (!match) return this.result('unreliable', '未找到可靠的重叠，请回到上次采集位置并保留重叠后继续');
    const { shift, top, bottom } = match;
    if (!this.locked) {
      this.top = top; this.bottom = bottom; this.locked = true;
      this.parts[0].start = top; this.parts[0].end -= bottom;
    }
    this.last = frame;
    if (shift < 0) {
      const reversible = Math.max(0, this.resultHeight - this.first!.height);
      let remaining = Math.min(-shift, reversible);
      this.reversedTrimmed += remaining;
      this.resultHeight -= remaining;
      while (remaining > 0) {
        const part = this.parts[this.parts.length - 1], rows = part.end - part.start;
        if (remaining >= rows) { this.parts.pop(); remaining -= rows; }
        else { part.end -= remaining; part.data = part.data.slice(0, part.end * frame.width * 4); remaining = 0; }
      }
      // Passing the initial viewport begins a new origin; future forward frames remain aligned.
      if (-shift > reversible) this.replaceOrigin(frame);
      return this.result('matched');
    }
    const rows = Math.min(shift, this.maximum(frame.width) - this.resultHeight);
    if (rows > 0) {
      const end = frame.height - bottom, start = Math.max(top, end - shift - 32), stride = frame.width * 4;
      this.parts.push({ start: end - shift - start, end: end - shift - start + rows, data: frame.data.slice(start * stride, end * stride) });
      this.resultHeight += rows;
    }
    this.limited = rows < shift || this.resultHeight >= this.maximum(frame.width);
    return this.result(this.limited ? 'limit' : 'matched', this.limited ? this.limitReason(frame.width) : undefined);
  }

  private replaceOrigin(frame: ScrollFrame) {
    this.first = frame;
    this.parts = [{ start: this.top, end: frame.height - this.bottom, data: frame.data }];
    this.resultHeight = frame.height;
  }

  private match(previous: ScrollFrame, frame: ScrollFrame): Match | null {
    const top = this.locked ? this.top : this.fixedBand(previous, frame, false);
    const bottom = this.locked ? this.bottom : this.fixedBand(previous, frame, true);
    if (this.locked && (!this.bandStable(previous, frame, 0, top) || !this.bandStable(previous, frame, frame.height - bottom, frame.height))) return null;
    const content = frame.height - top - bottom, minimum = Math.max(32, Math.ceil(content * .18));
    let best: Match | null = null;
    const candidates: Array<{ shift: number; error: number }> = [];
    for (let shift = 1; shift <= content - minimum; shift++) for (const sign of [1, -1]) {
      const score = sign > 0 ? this.score(previous, frame, shift, top, bottom, 24) : this.score(frame, previous, shift, top, bottom, 24);
      if (!best || score.error < best.error) best = { shift: shift * sign, top, bottom, ...score };
      candidates.push({ shift: shift * sign, error: score.error });
    }
    if (!best || best.error > 5 || best.inliers < .94 || best.texture < 4) return null;
    if (candidates.some(candidate => Math.abs(candidate.shift - best!.shift) > 3 && candidate.error <= best!.error + Math.max(.7, best!.error * .35))) return null;
    const verified = best.shift > 0 ? this.score(previous, frame, best.shift, top, bottom, 64) : this.score(frame, previous, -best.shift, top, bottom, 64);
    return verified.error <= 5 && verified.inliers >= .94 ? { ...best, ...verified } : null;
  }

  undo(): StitchResult {
    return this.parts.length > 1 ? this.removeSegment(this.parts.length - 1) : this.result(this.first ? 'ok' : 'empty');
  }

  removeSegment(index: number): StitchResult {
    if (!Number.isInteger(index) || !this.parts[index]) throw Error('无效的分段位置');
    if (this.parts.length < 2) throw Error('至少保留一个分段');
    const [part] = this.parts.splice(index, 1);
    this.resultHeight -= part.end - part.start;
    this.limited = false;
    this.restoreLast();
    return this.snapshot();
  }

  adjustSeam(index: number, delta: number): StitchResult {
    const part = this.parts[index + 1];
    if (!Number.isInteger(index) || index < 0 || !part || !Number.isInteger(delta) || Math.abs(delta) > 32) throw Error('接缝调整需为 -32 到 32 的整数像素');
    const start = part.start + delta;
    if (start < 0 || start >= part.end) throw Error('接缝调整超出保留的重叠范围');
    if (this.resultHeight - delta > this.maximum(this.first!.width)) throw Error('接缝调整超过长图尺寸上限');
    part.start = start; this.resultHeight -= delta; this.limited = false;
    this.restoreLast();
    return this.snapshot();
  }

  private restoreLast() {
    if (!this.first || this.resultHeight < this.first.height) return;
    const combined = this.combined(), { width, height } = this.first, stride = width * 4;
    const restored = this.first.data.slice();
    restored.set(combined.subarray((this.resultHeight - height + this.top) * stride, (this.resultHeight - this.bottom) * stride), this.top * stride);
    this.last = { width, height, data: restored };
  }

  private combined(): Uint8Array<ArrayBuffer> {
    const stride = this.first!.width * 4, data = new Uint8Array(this.resultHeight * stride);
    data.set(this.first!.data.subarray(0, this.top * stride));
    let cursor = this.top * stride;
    for (const part of this.parts) { const rows = part.data.subarray(part.start * stride, part.end * stride); data.set(rows, cursor); cursor += rows.byteLength; }
    data.set(this.first!.data.subarray((this.first!.height - this.bottom) * stride), cursor);
    return data;
  }

  snapshot(): StitchResult {
    if (!this.first) return this.result('empty');
    const frame = { width: this.first.width, height: this.resultHeight, data: this.combined() };
    return { ...this.result(this.limited ? 'limit' : 'ok'), data: this.axis === 'horizontal' ? transpose(frame).data : frame.data };
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
