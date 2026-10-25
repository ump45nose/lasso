import type { CaptureRect } from '../../shared/capture';

type Point = { x: number; y: number };
/** Constrain in image coordinates, then shorten at the crop edge without changing the angle. */
export function constrainedEnd(start: Point, end: Point, crop: CaptureRect, kind: 'square' | 'angle'): Point {
  let dx = end.x - start.x, dy = end.y - start.y;
  if (kind === 'square') {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * side; dy = (dy < 0 ? -1 : 1) * side;
  } else {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, length = Math.hypot(dx, dy);
    dx = Math.cos(angle) * length; dy = Math.sin(angle) * length;
    if (Math.abs(dx) < 1e-10) dx = 0;
    if (Math.abs(dy) < 1e-10) dy = 0;
  }
  const fit = Math.min(1, dx > 0 ? (crop.x + crop.width - start.x) / dx : dx < 0 ? (crop.x - start.x) / dx : 1,
    dy > 0 ? (crop.y + crop.height - start.y) / dy : dy < 0 ? (crop.y - start.y) / dy : 1);
  return { x: start.x + dx * fit, y: start.y + dy * fit };
}
