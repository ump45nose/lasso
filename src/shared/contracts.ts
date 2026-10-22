export interface Settings {
  /** Empty means no global shortcut. */
  shortcut: string;
  selectionEnabled: boolean;
  clipboardFallback: boolean;
}
export interface Preset {
  id: string;
  name: string;
  template: string;
  target: 'chatgpt';
  mode: 'edit' | 'send';
  needsSelection: boolean;
  enabled: boolean;
}
export interface SelectionContext {
  text: string;
  sourceApp: string;
  anchor: { x: number; y: number; width: number; height: number };
}
export interface CaptureStatus { status: 'active' | 'paused' | 'permission' | 'error'; message: string }
export interface DeliveryStatus {
  phase: 'waiting' | 'login' | 'filling' | 'editing' | 'sending' | 'sent' | 'error';
  message: string;
  canCopy: boolean;
}
export type TaskActivity = 'idle' | 'loading' | 'running' | 'waiting' | 'draft' | 'complete' | 'unknown' | 'error';
export interface TaskSummary {
  id: string;
  title: string;
  activity: TaskActivity;
  residency: 'resident' | 'released';
  retainedReason: string | null;
}
export const taskActivityLabels: Record<TaskActivity, string> = {
  idle: '新对话', loading: '加载中', running: '进行中', waiting: '等待处理',
  draft: '有草稿', complete: '已完成', unknown: '状态待确认', error: '页面异常'
};
export interface ShellState {
  tasks: TaskSummary[];
  activeTaskId: string | null;
  pinned: boolean;
  expanded: boolean;
  settingsOpen: boolean;
  hasPage: boolean;
  title: string;
  hostname: string;
  loading: boolean;
  pageError: string | null;
  shortcutError: string | null;
  settings: Settings;
  presets: Preset[];
  capture: CaptureStatus;
  selection: { length: number; sourceApp: string } | null;
  delivery: DeliveryStatus | null;
}
export type Action = 'open-chat' | 'pin' | 'expand' | 'hide' | 'settings' | 'close-settings' | 'reload' | 'quit'
  | 'new-task' | 'presets' | 'selection-permission' | 'refresh-capture' | 'dismiss-delivery' | 'copy-pending' | 'cancel-delivery';
export interface DesktopAPI {
  getState(): Promise<ShellState>;
  act(action: Action): Promise<void>;
  saveShortcut(shortcut: string): Promise<{ error: string | null }>;
  saveCapture(options: Pick<Settings, 'selectionEnabled' | 'clipboardFallback'>): Promise<{ error: string | null }>;
  savePresets(presets: Preset[]): Promise<{ error: string | null }>;
  runPreset(id: string): Promise<{ error: string | null }>;
  selectTask(id: string): Promise<void>;
  closeTask(id: string): Promise<void>;
  taskOverflow(visibleIds: string[], x: number): Promise<void>;
  onState(callback: (state: ShellState) => void): () => void;
}
export interface ActionBarState { presets: Pick<Preset, 'id' | 'name'>[]; busy: boolean }
export interface ActionBarAPI {
  getState(): Promise<ActionBarState>;
  runPreset(id: string): Promise<void>;
  more(): void;
  resize(width: number): void;
  onState(callback: (state: ActionBarState) => void): () => void;
}
