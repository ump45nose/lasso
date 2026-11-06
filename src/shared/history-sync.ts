export interface CaptureHistoryPolicy { enabled: boolean; maxItems: number; maxDays: number; maxBytesMB: number }
export interface CaptureHistoryItem {
  id: string;
  createdAt: number;
  width: number;
  height: number;
  byteSize: number;
  captureKind: string;
  pixelScale?: { x: number; y: number };
  ocrSnippet: string;
  thumbnailDataUrl: string;
  hasAnnotations: boolean;
}
export interface CaptureHistoryState { items: CaptureHistoryItem[]; totalBytes: number }
export type PinKind = 'image' | 'text' | 'color' | 'file';
export type PinWheelAction = 'zoom' | 'opacity';
export type PinArrangeMode = 'grid' | 'horizontal' | 'vertical' | 'align-left' | 'align-top';
export interface PinGroup { id: string; name: string; color: string; visible: boolean }
export interface PinWorkspaceSettings {
  restoreOnLaunch: boolean;
  floatingToolbar: boolean;
  wheelAction: PinWheelAction;
  activeGroupId: string;
  groups: PinGroup[];
}
export interface PinContentPayload { kind: PinKind; frames?: string[]; frameDelayMs?: number; loop?: boolean; text?: string; colorHex?: string; colorRgb?: string; filePath?: string; fileName?: string; fileSize?: number }
export interface PinSummary {
  id: string;
  title: string;
  kind: PinKind;
  groupId: string;
  locked: boolean;
  thumbnail: boolean;
  visible: boolean;
  opacity: number;
}
export interface PinWorkspaceState { settings: PinWorkspaceSettings; pins: PinSummary[]; closedCount: number }
export interface PortableConfigBundle { schemaVersion: 1; exportedAt: string; settings: Record<string, unknown>; presets: unknown[] }
export interface WebDavConfig {
  enabled: boolean;
  url: string;
  remotePath: string;
  username: string;
  autoSync: boolean;
  hasPassword?: boolean;
  lastSyncedAt?: number;
  lastEtag?: string;
  lastContentHash?: string;
  status?: 'idle' | 'syncing' | 'synced' | 'conflict' | 'offline' | 'error';
  message?: string;
}
export interface WebDavConfigInput extends Omit<WebDavConfig, 'hasPassword' | 'status' | 'message'> { password?: string; clearPassword?: boolean }
export type WebDavSyncDirection = 'push' | 'pull' | 'auto';

export const captureHistoryDefaults = (): CaptureHistoryPolicy => ({ enabled: true, maxItems: 50, maxDays: 30, maxBytesMB: 512 });
export const pinWorkspaceDefaults = (): PinWorkspaceSettings => ({
  restoreOnLaunch: true, floatingToolbar: false, wheelAction: 'zoom', activeGroupId: 'default',
  groups: [{ id: 'default', name: '默认分组', color: '#bd7658', visible: true }]
});
export function validateCaptureHistoryPolicy(value: CaptureHistoryPolicy): void {
  if (!value || typeof value.enabled !== 'boolean' ||
    ![value.maxItems, value.maxDays, value.maxBytesMB].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw Error('历史保留条数、天数和容量需为正整数');
  }
}
export function validatePinWorkspaceSettings(value: PinWorkspaceSettings): void {
  if (!value || typeof value.restoreOnLaunch !== 'boolean' || typeof value.floatingToolbar !== 'boolean' ||
    !['zoom', 'opacity'].includes(value.wheelAction) || typeof value.activeGroupId !== 'string' ||
    !Array.isArray(value.groups) || !value.groups.length || value.groups.some(group =>
      !group || typeof group.id !== 'string' || !group.id.trim() || typeof group.name !== 'string' || !group.name.trim() ||
      typeof group.color !== 'string' || !/^#[\da-f]{6}$/i.test(group.color) || typeof group.visible !== 'boolean') ||
    new Set(value.groups.map(group => group.id)).size !== value.groups.length || !value.groups.some(group => group.id === value.activeGroupId)) {
    throw Error('贴图工作空间需要有效滚轮动作、分组和当前分组');
  }
}
