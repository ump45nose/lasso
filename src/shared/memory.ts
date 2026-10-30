export interface MemorySettings { enabled: boolean; idleMinutes: number }
export const memoryDefaults = (): MemorySettings => ({ enabled: true, idleMinutes: 30 });
export function validMemorySettings(value: MemorySettings): boolean {
  return !!value && typeof value.enabled === 'boolean' && Number.isInteger(value.idleMinutes) && value.idleMinutes >= 1 && value.idleMinutes <= 1440;
}
export const idleMilliseconds = (value: MemorySettings) => value.enabled ? value.idleMinutes * 60_000 : Infinity;
