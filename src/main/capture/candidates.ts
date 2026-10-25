import type { CaptureRect, RegionCandidate } from '../../shared/capture';
import { sameRegion } from '../../shared/capture';
export const contains = (r: CaptureRect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
export function clip(r: CaptureRect, bounds: CaptureRect): CaptureRect | null {
  const x = Math.max(r.x, bounds.x), y = Math.max(r.y, bounds.y);
  const width = Math.min(r.x + r.width, bounds.x + bounds.width) - x, height = Math.min(r.y + r.height, bounds.y + bounds.height) - y;
  return width >= 2 && height >= 2 ? { x, y, width, height } : null;
}
export function rank(candidates: RegionCandidate[], x: number, y: number) {
  const priority = { color: 0, element: 1, edge: 2, window: 3, screen: 4 };
  const output: RegionCandidate[] = [];
  for (const r of candidates.filter(r => contains(r, x, y) && r.width >= 12 && r.height >= 12).sort((a,b) => { const preferred=(r:RegionCandidate)=>r.source==='color'&&r.height>=30&&r.width*r.height<800000?0:1; return preferred(a)-preferred(b)||a.width*a.height-b.width*b.height||priority[a.source]-priority[b.source]; })) {
    if (!output.some(a => sameRegion(a,r))) output.push(r);
  }
  return output.slice(0, 16);
}
