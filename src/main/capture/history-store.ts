import { nativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateCaptureHistoryPolicy, type CaptureHistoryItem, type CaptureHistoryPolicy, type CaptureHistoryState } from '../../shared/history-sync';
import { validateAnnotations, type PinnedDocument } from './document';
import { writeFileAtomic } from '../files';

type Entry = Omit<CaptureHistoryItem, 'thumbnailDataUrl'> & { storage: string };
interface HistoryMeta { id?: string; captureKind?: string; ocrSnippet?: string; createdAt?: number }
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,128}$/.test(id);

/** Immutable image revisions become visible together through one atomic index replacement. */
export class CaptureHistoryStore {
  private entries: Entry[] = [];
  constructor(private directory: string, private policy: () => CaptureHistoryPolicy) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'index.json');
    if (existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.items) || !saved.items.every((item: Entry) => validId(item.id) && validId(item.storage) && Number.isFinite(item.createdAt) && Number.isSafeInteger(item.byteSize) && item.byteSize > 0)) throw Error('截图历史索引无效');
      this.entries = saved.items;
    } else this.commit([]);
    this.pruneNow();
    this.cleanOrphans();
  }
  private index(items = this.entries): string { return JSON.stringify({ version: 1, items }) + '\n'; }
  private bytes(items = this.entries): number { return items.reduce((sum, item) => sum + item.byteSize, Buffer.byteLength(this.index(items))); }
  private commit(items: Entry[]) {
    writeFileAtomic(join(this.directory, 'index.json'), this.index(items));
    const previous = this.entries;
    this.entries = items;
    for (const item of previous) if (!items.some(next => next.storage === item.storage)) rmSync(join(this.directory, item.storage), { recursive: true, force: true });
  }
  private cleanOrphans() {
    const live = new Set(this.entries.map(item => item.storage));
    for (const name of readdirSync(this.directory)) if (name !== 'index.json' && !live.has(name)) rmSync(join(this.directory, name), { recursive: true, force: true });
  }
  private retained(items: Entry[]): Entry[] {
    const policy = this.policy(); validateCaptureHistoryPolicy(policy);
    const cutoff = Date.now() - policy.maxDays * 86400000;
    const next = items.filter(item => item.createdAt >= cutoff).sort((a, b) => b.createdAt - a.createdAt).slice(0, policy.maxItems);
    while (next.length && this.bytes(next) > policy.maxBytesMB * 1024 * 1024) next.pop();
    return next;
  }
  private pruneNow() {
    const next = this.retained(this.entries);
    if (next.length !== this.entries.length || next.some((item, index) => item !== this.entries[index])) this.commit(next);
  }
  async prune(): Promise<void> { this.pruneNow(); }
  async add(document: PinnedDocument, meta: HistoryMeta = {}): Promise<string> {
    const policy = this.policy(); validateCaptureHistoryPolicy(policy);
    if (!policy.enabled) return '';
    const id = meta.id ?? randomUUID(), storage = randomUUID();
    if (!validId(id) || document.source.isEmpty() || document.image.isEmpty()) throw Error('截图历史图片或标识无效');
    const annotations = validateAnnotations(document.annotations, document.source, document.annotations.crop);
    const { width, height } = document.image.getSize(), ratio = Math.min(1, 240 / width, 160 / height);
    const files = { 'source.png': document.source.toPNG(), 'result.png': document.image.toPNG(), 'annotations.json': Buffer.from(JSON.stringify(annotations) + '\n'), 'thumbnail.png': document.image.resize({ width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }).toPNG() };
    const now = Date.now(), previous = this.entries.find(item => item.id === id);
    const item: Entry = { id, storage, createdAt: previous?.createdAt ?? meta.createdAt ?? now, width, height, byteSize: Object.values(files).reduce((sum, data) => sum + data.length, 0), captureKind: meta.captureKind ?? 'rect', ocrSnippet: (meta.ocrSnippet ?? '').slice(0, 2000), hasAnnotations: annotations.objects.length > 0 || annotations.privacy.length > 0, pixelScale: document.pixelScale };
    if (!Number.isFinite(item.createdAt)) throw Error('截图历史时间无效');
    const pending = join(this.directory, storage + '.tmp'), complete = join(this.directory, storage);
    mkdirSync(pending, { mode: 0o700 });
    try {
      for (const [name, data] of Object.entries(files)) writeFileSync(join(pending, name), data, { mode: 0o600 });
      renameSync(pending, complete);
      this.commit(this.retained([item, ...this.entries.filter(entry => entry.id !== id)]));
      if (!this.entries.some(entry => entry.storage === storage)) rmSync(complete, { recursive: true, force: true });
    } catch (error) {
      rmSync(pending, { recursive: true, force: true });
      if (!this.entries.some(entry => entry.storage === storage)) rmSync(complete, { recursive: true, force: true });
      throw error;
    }
    return id;
  }
  state(query = ''): CaptureHistoryState {
    this.pruneNow();
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const items = this.entries.filter(item => words.every(word => `${item.ocrSnippet} ${item.captureKind} ${item.id}`.toLocaleLowerCase().includes(word))).map(({ storage, ...item }) => ({ ...item, thumbnailDataUrl: 'data:image/png;base64,' + readFileSync(join(this.directory, storage, 'thumbnail.png')).toString('base64') }));
    return structuredClone({ items, totalBytes: this.bytes() });
  }
  async load(id: string): Promise<PinnedDocument> {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) throw Error('截图历史已删除');
    const path = join(this.directory, entry.storage), source = nativeImage.createFromBuffer(readFileSync(join(path, 'source.png'))), image = nativeImage.createFromBuffer(readFileSync(join(path, 'result.png')));
    if (source.isEmpty() || image.isEmpty()) throw Error('截图历史图片损坏');
    const saved = JSON.parse(readFileSync(join(path, 'annotations.json'), 'utf8'));
    return { source, image, annotations: validateAnnotations(saved, source, saved.crop), pixelScale: entry.pixelScale };
  }
  async delete(id: string): Promise<void> { this.commit(this.entries.filter(item => item.id !== id)); }
  async clear(): Promise<void> { this.commit([]); this.cleanOrphans(); }
}
