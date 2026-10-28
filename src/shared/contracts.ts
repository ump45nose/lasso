import type { ScreenshotSettings } from './screenshot-settings';
import type { ImageOptions, MediaConfig, MediaConfigInput } from './media';
import type { CaptureMode } from './capture';
import type { CaptureDelay, CaptureEfficiencyState, EfficiencyCaptureMode } from './capture-efficiency';
export type Target = 'chatgpt' | 'gemini' | 'codex' | 'pi';
/** Native web views are placed below the title bar and above any footer rows. */
export const HEADER_HEIGHT = 44;
export const FOOTER_ROW = 48;
export type LocalTarget = 'codex' | 'pi';
export const targetLabels: Record<Target, string> = { chatgpt: 'ChatGPT', gemini: 'Gemini', codex: 'Codex', pi: 'Pi' };
export interface AppPrompt { bundleId: string; name: string; prompt: string; enabled: boolean }
export interface LocalConfig { executable: string; cwd: string }
export interface ImagePreview { id: string; thumbnail: string; width: number; height: number }
export interface ExecutionProfile { model?: string; effort?: string }
export interface ExecutionCatalog { models: AgentModel[]; efforts: string[]; currentModel: string; currentEffort: string }
export interface LaunchOptions { target?: Target; cwd?: string; imageId?: string; textId?: string; imagePrompt?: string }
export interface ChatMessage { id: string; role: 'user' | 'assistant' | 'tool' | 'notice'; text: string; title?: string; running?: boolean; image?: string }
export interface AgentModel { id: string; label: string; images?: boolean; efforts?: string[]; defaultEffort?: string }
export interface AgentQuestion { id: string; question: string; options?: string[]; secret?: boolean }
export interface AgentRequest { id: string; title: string; detail?: string; kind: 'confirm' | 'select' | 'input' | 'editor' | 'questions' | 'json'; options?: string[]; prefill?: string; questions?: AgentQuestion[] }
export interface AgentAnswer { cancelled?: boolean; confirmed?: boolean; value?: string; answers?: Record<string, string> }
export interface AgentState { revision: number; effort: string; efforts: string[]; modelsLoading: boolean; controlsBusy: boolean; modelsError: string | null; taskId: string; target: LocalTarget; cwd: string; messages: ChatMessage[]; requests: AgentRequest[]; models: AgentModel[]; model: string; draft: string; draftRevision: number; image: ImagePreview | null; activity: TaskActivity; error: string | null; resident: boolean; status: string }
export type AgentEvent = { taskId: string; revision: number; patch: Partial<Omit<AgentState, 'messages'>>; messages: ChatMessage[]; order?: string[] };
export type FontRole = 'display' | 'text' | 'ui' | 'mono';
export interface ImportedFont { family: string; file: string }
export const defaultFonts: Record<FontRole, string> = { display: 'Anthropic Serif Text', text: 'Anthropic Serif Text', ui: 'Anthropic Serif Text', mono: 'JetBrains Mono' };
export interface Settings {
  screenshot: ScreenshotSettings;
  /** Empty means no global shortcut. */
  shortcut: string;
  /** Empty means unbound, per capture mode. */
  captureShortcuts: Record<CaptureMode, string>;
  lastTarget: Target;
  selectionEnabled: boolean;
  clipboardFallback: boolean;
  appPrompts: AppPrompt[];
  local: Record<LocalTarget, LocalConfig>;
  fonts: Record<FontRole, string>;
  importedFonts: ImportedFont[];
}
export type PresetTarget = Target | 'api';
export const presetTargetLabels = { ...targetLabels, api: 'New API' };
export interface Preset extends ExecutionProfile {
  kind?: 'chat' | 'image';
  image?: ImageOptions;
  id: string;
  name: string;
  template: string;
  target: PresetTarget;
  mode: 'edit' | 'send';
  /** Web presets can start a temporary chat in the same signed-in account. */
  temporaryChat?: boolean;
  needsSelection: boolean;
  enabled: boolean;
}
export interface SelectionContext {
  text: string;
  sourceApp: string;
  anchor: { x: number; y: number; width: number; height: number };
}
export interface CaptureStatus { status: 'active' | 'paused' | 'permission' | 'error'; message: string }
export type DeliveryStep = 'open' | 'model' | 'fill' | 'upload' | 'send' | 'edit';
export interface DeliveryStatus {
  phase: 'waiting' | 'login' | 'filling' | 'editing' | 'sending' | 'sent' | 'error';
  message: string;
  canCopy: boolean;
  /** Planned preset steps; empty for restore and new-chat preparation. */
  steps: DeliveryStep[];
  step: DeliveryStep | null;
}
export type TaskActivity = 'idle' | 'loading' | 'running' | 'waiting' | 'draft' | 'complete' | 'unknown' | 'error';
export interface TaskSummary {
  target: Target;
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
  activeTarget: Target | null;
  inputImage: ImagePreview | null;
  inputImagePrompt?: string;
  /** OCR or handed-off text waiting for a preset; replaces any pending image. */
  inputText: { id: string; text: string } | null;
  /** The pending image or text is shown as a temporary tab in front of the tasks. */
  inputOpen: boolean;
  title: string;
  hostname: string;
  loading: boolean;
  pageError: string | null;
  shortcutError: string | null;
  /** App-level failure not owned by a task, such as screenshot or clipboard image errors. */
  notice: string | null;
  settings: Settings;
  presets: Preset[];
  capture: CaptureStatus;
  captureEfficiency: CaptureEfficiencyState;
  selection: { length: number; sourceApp: string } | null;
  delivery: DeliveryStatus | null;
}
export type Action = 'dismiss-notice' | 'pin' | 'expand' | 'hide' | 'settings' | 'close-settings' | 'reload' | 'quit'
  | 'selection-permission' | 'refresh-capture' | 'dismiss-delivery' | 'copy-pending' | 'cancel-delivery' | 'show-input' | 'retry-delivery';
export type PaletteScope = 'all' | 'tasks' | 'new' | 'images';
export interface PaletteEvent { scope: PaletteScope | null; backdrop: string | null }
export interface DesktopAPI {
  mediaConfig(): Promise<MediaConfig>;
  saveMediaConfig(input: MediaConfigInput): Promise<MediaConfig>;
  mediaModels(): Promise<string[]>;
  openImagePresets(): Promise<void>;
  attachImage(prompt?: string): Promise<{ error: string | null }>;
  openLink(url: string): Promise<void>;
  getState(): Promise<ShellState>;
  act(action: Action): Promise<void>;
  screenshot(mode: EfficiencyCaptureMode, delay?: CaptureDelay): Promise<void>;
  cancelScreenshot(): Promise<void>;
  openLocalImage(): Promise<{ error: string | null }>;
  saveCaptureShortcut(mode: CaptureMode, shortcut: string): Promise<{ error: string | null }>;
  saveShortcut(shortcut: string): Promise<{ error: string | null }>;
  saveScreenshot(options: ScreenshotSettings): Promise<{ error: string | null }>;
  ocrLanguages(): Promise<string[]>;
  saveCapture(options: Pick<Settings, 'selectionEnabled' | 'clipboardFallback'>): Promise<{ error: string | null }>;
  savePresets(presets: Preset[]): Promise<{ error: string | null }>;
  runPreset(id: string, options?: LaunchOptions): Promise<{ error: string | null }>;
  newTask(options: LaunchOptions): Promise<void>;
  saveIntegrations(settings: Pick<Settings, 'local' | 'appPrompts'>): Promise<{ error: string | null }>;
  choosePath(kind: 'directory' | 'executable' | 'application'): Promise<{ path: string; bundleId?: string; name?: string } | null>;
  appIcon(bundleId: string): Promise<string | null>;
  readImage(taskId?: string): Promise<{ error: string | null }>;
  removeImage(taskId?: string): Promise<void>;
  editImage(imageId: string): Promise<{error:string|null}>;
  removeText(): Promise<void>;
  getAgent(taskId: string): Promise<AgentState | null>;
  agentDraft(taskId: string, text: string): Promise<void>;
  agentSend(taskId: string): Promise<{ error: string | null }>;
  agentStop(taskId: string): Promise<{ error: string | null }>;
  executionCatalog(target: Target, model?: string, refresh?: boolean): Promise<{ catalog: ExecutionCatalog | null; error: string | null }>;
  agentEffort(taskId: string, effort: string): Promise<{ error: string | null }>;
  agentRefreshModels(taskId: string): Promise<{ error: string | null }>;
  agentModel(taskId: string, model: string): Promise<{ error: string | null }>;
  agentAnswer(taskId: string, requestId: string, answer: AgentAnswer): Promise<{ error: string | null }>;
  onAgent(callback: (event: AgentEvent) => void): () => void;
  selectTask(id: string): Promise<void>;
  closeTask(id: string): Promise<void>;
  openPalette(scope: PaletteScope): Promise<void>;
  closePalette(): Promise<void>;
  onPalette(callback: (event: PaletteEvent) => void): () => void;
  saveFonts(fonts: Settings['fonts']): Promise<{ error: string | null }>;
  importFont(): Promise<{ font: ImportedFont | null; error: string | null }>;
  removeFont(file: string): Promise<{ error: string | null }>;
  onState(callback: (state: ShellState) => void): () => void;
}
/** `presets` fill the capsule; `more` are the remaining enabled presets, listed in the ··· menu. */
export interface ActionBarState { presets: Pick<Preset, 'id' | 'name' | 'target' | 'mode'>[]; more: Pick<Preset, 'id' | 'name' | 'target' | 'mode'>[]; busy: boolean; fonts: Pick<Settings, 'fonts' | 'importedFonts'> }
/** A side of the capsule, away from the selection when the screen allows. */
export type ActionBarTip = 'above' | 'below';
/** Where the hover tip and the ··· menu open; the capsule stays anchored to the other edge. */
export interface ActionBarLayout { tip: ActionBarTip; menu: ActionBarTip }
/** ··· menu metrics, shared by main (window growth) and the renderer (row sizes). */
export const BAR_MENU = { width: 232, row: 32, pad: 5, sep: 9, gap: 6 };
export const barMenuHeight = (more: number) => BAR_MENU.pad * 2 + (more + 1) * BAR_MENU.row + (more ? BAR_MENU.sep : 0);
export interface ActionBarAPI {
  getState(): Promise<ActionBarState>;
  runPreset(id: string): Promise<void>;
  /** Grows the window on the menu side while the ··· menu is open. */
  menu(open: boolean): void;
  settings(): void;
  /** Width of the capsule itself; main adds the transparent margins. */
  resize(width: number): void;
  /** The pointer entered or left the capsule; outside it the window lets clicks through. */
  hit(inside: boolean): void;
  onState(callback: (state: ActionBarState) => void): () => void;
  /** Fired on every show so the capsule can replay its entrance. */
  onEnter(callback: (layout: ActionBarLayout) => void): () => void;
}
