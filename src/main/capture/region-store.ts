import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import type { SuccessfulCaptureArea } from '../../shared/capture-efficiency';
import { validCaptureArea } from './efficiency-control';

/** Device geometry is local state, separate from portable preset definitions. */
export class RegionStore {
  last: SuccessfulCaptureArea | null = null;
  placements: Record<string, SuccessfulCaptureArea> = Object.create(null);

  constructor(private path: string, private persistent: () => boolean) {
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
      (data.last != null && !validCaptureArea(data.last)) ||
      !data.placements || typeof data.placements !== 'object' || Array.isArray(data.placements)) throw Error('本机截图区域记录无效');
    for (const [id, area] of Object.entries(data.placements)) {
      if (!id.trim() || id.length > 100 || !validCaptureArea(area)) throw Error('本机区域预设位置无效');
      this.placements[id] = structuredClone(area);
    }
    if (persistent()) this.last = data.last ? structuredClone(data.last) : null;
    // A disabled preference must not revive an older on-disk last area after re-enabling.
    else if (data.last) this.save();
  }
  remember(area: SuccessfulCaptureArea) {
    if (!validCaptureArea(area)) throw Error('无效的截图区域或显示器');
    this.last = structuredClone(area);
    this.save();
  }
  place(id: string, area: SuccessfulCaptureArea) {
    if (typeof id !== 'string' || !id.trim() || id.length > 100 || !validCaptureArea(area)) throw Error('无效的区域预设位置');
    this.placements[id] = structuredClone(area);
    this.save();
  }
  /** Call after the persistence preference changes; in-memory repeat stays available. */
  save() {
    const tmp = this.path + '.tmp';
    writeFileSync(tmp, JSON.stringify({ last: this.persistent() ? this.last : null, placements: this.placements }) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
