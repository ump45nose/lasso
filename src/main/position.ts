import type { Point, Rectangle } from 'electron';
export function fitToWorkArea(bounds: Rectangle, area: Rectangle): Rectangle {
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  return {
    width, height,
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height))
  };
}
// Initial launch and selection actions share screen-edge avoidance.
export function placeNear(anchor: Point | Rectangle, area: Rectangle): Rectangle {
  const bottom = anchor.y + ('height' in anchor ? anchor.height : 0);
  const right = anchor.x + ('width' in anchor ? anchor.width : 0);
  const width = Math.min(520, area.width);
  const height = Math.min(640, area.height);
  const y = bottom + 12 + height <= area.y + area.height ? bottom + 12 : anchor.y - height - 12;
  const x = anchor.x + width <= area.x + area.width ? anchor.x : right - width;
  return fitToWorkArea({ x, y, width, height }, area);
}
