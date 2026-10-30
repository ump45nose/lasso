export interface WebEffortPosition { min: number; max: number; value: number }

export function webEffortId(position: WebEffortPosition) {
  return `slider:${position.min}:${position.max}:${position.value}`;
}

export function webEffortIndex(id: string, range: Pick<WebEffortPosition, 'min' | 'max'>): number | null {
  const match = /^slider:(-?\d+):(-?\d+):(-?\d+)$/.exec(id);
  if (!match || Number(match[1]) !== range.min || Number(match[2]) !== range.max) return null;
  const index = Number(match[3]);
  return index >= range.min && index <= range.max ? index : null;
}

// Compatibility for presets saved with the website's older, localized labels.
// Available levels and their positions still come entirely from the native UI.
export function sameWebEffortLabel(left: string, right: string, model = '') {
  const normalize = (label: string) => {
    let value = label.replace(/\s+/g, '').toLowerCase();
    const prefix = model.replace(/\s+/g, '').toLowerCase();
    if (prefix && value.startsWith(prefix)) value = value.slice(prefix.length);
    const aliases: Record<string, string> = { extrahigh: 'extra-high', 极高: 'extra-high', 極高: 'extra-high', instant: 'instant', 即时: 'instant', 即時: 'instant', medium: 'medium', 中: 'medium', high: 'high', 高: 'high' };
    return value.replace(/(?:extrahigh|极高|極高|instant|即时|即時|medium|中|high|高)$/, match => ':' + aliases[match]);
  };
  return Boolean(left && right) && normalize(left) === normalize(right);
}
