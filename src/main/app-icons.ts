import { join } from 'node:path';

const icons = new Map<string, string>();
let native: { icon(bundleId: string): string | null };
export function applicationIcon(bundleId: string): string | null {
  if (typeof bundleId !== 'string' || !/^[\w-]+(?:\.[\w-]+)+$/.test(bundleId) || bundleId.length > 256) return null;
  if (icons.has(bundleId)) return icons.get(bundleId)!;
  native ||= require(join(__dirname, 'native/app-icons.node'));
  const icon = native.icon(bundleId);
  if (icon) icons.set(bundleId, icon);
  return icon;
}
