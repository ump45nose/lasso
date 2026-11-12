import type { RecordingAction, RecordingSessionState } from './recording';
import type { CustomCaptureRequest, RegionConfiguration, RegionPreset } from './capture-regions';
import type { ScreenshotSettings } from './screenshot-settings';
import type { MemorySettings } from './memory';
import type { ApiConnection, ApiConnectionInput, ImageOptions, MediaConfig, MediaConfigInput, TranslationLang, TranslationSettings } from './media';
import type { CaptureMode } from './capture';
import type { VisionServiceConfig, VisionServiceInput } from './intelligence';
import type { CaptureDelay, CaptureEfficiencyState, EfficiencyCaptureMode } from './capture-efficiency';
import type { EditorShortcutMap, GlobalActionId, IgnoredAppRule } from './shortcuts';
import type { CaptureHistoryState, PinArrangeMode, PinKind, PinWorkspaceSettings, PinWorkspaceState, WebDavConfig, WebDavConfigInput, WebDavSyncDirection } from './history-sync';
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
export interface ExecutionCatalog { models: AgentModel[]; efforts: string[]; effortOptions?: { id: string; label: string }[] }
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
export interface ScriptAction { id: string; name: string; enabled: boolean; code: string }
export type GeneralSettings = Pick<Settings, 'launchAtLogin' | 'themeMode' | 'toolbarTools' | 'mouseActions' | 'scriptActions' | 'autoCheckUpdates'>;
export interface Settings {
  launchAtLogin: boolean;
  themeMode: 'paper' | 'system';
  /** Empty displays every tool. */
  toolbarTools: string[];
  mouseActions: { doubleClick: 'copy' | 'save' | 'pin' | 'none'; rightClick: 'reselect' | 'cancel'; middleClick: 'pin' | 'quick-save' | 'none' };
  scriptActions: ScriptAction[];
  autoCheckUpdates: boolean;
  vision: Omit<VisionServiceConfig, 'hasCredential'>;
  translation: TranslationSettings;
  windowDragSnap: boolean;
  memory: MemorySettings;
  screenshot: ScreenshotSettings;
  /** Empty means no global shortcut. */
  shortcut: string;
  /** Empty means unbound, per capture mode. */
  captureShortcuts: Record<CaptureMode, string>;
  actionShortcuts: Partial<Record<GlobalActionId, string>>;
  editorShortcuts: EditorShortcutMap;
  ignoredApps: IgnoredAppRule[];
  lastTarget: Target;
  selectionEnabled: boolean;
  clipboardFallback: boolean;
  appPrompts: AppPrompt[];
  local: Record<LocalTarget, LocalConfig>;
  fonts: Record<FontRole, string>;
  importedFonts: ImportedFont[];
}
export type PresetTarget = Target | 'api';
export const presetTargetLabels = { ...targetLabels, api: 'API' };
export interface Preset extends ExecutionProfile {
  kind?: 'chat' | 'image';
  image?: ImageOptions;
  id: string;
  name: string;
  template: string;
  target: PresetTarget;
  connectionId?: string;
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
  customCaptureOpen?:boolean;
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
export type Action = 'custom-capture'|'close-custom-capture'| 'dismiss-notice' | 'pin' | 'expand' | 'hide' | 'settings' | 'close-settings' | 'reload' | 'quit'
  | 'selection-permission' | 'refresh-capture' | 'dismiss-delivery' | 'copy-pending' | 'cancel-delivery' | 'show-input' | 'retry-delivery'
  | 'open-island-board' | 'toggle-edge-notes' | 'open-finder-panel' | 'snap-coding-ai' | 'snap-equal-split';
export type PaletteScope = 'all' | 'tasks' | 'new' | 'images';
export interface PaletteEvent { scope: PaletteScope | null; backdrop: string | null }
export interface DesktopAPI {
  saveGeneral(options: GeneralSettings): Promise<{ error: string | null }>;
  runScriptAction(id: string, input?: { text?: string }): Promise<{ output: string; error: string | null }>;
  recordingPanel(open: boolean): Promise<void>;
  onRecordingClose(callback: () => void): () => void;
  recordingState(): Promise<RecordingSessionState | null>;
  recordingAction(action: RecordingAction): Promise<{ state: RecordingSessionState | null; path?: string | null; error: string | null }>;
  onRecording(callback: (state: RecordingSessionState | null) => void): () => void;
  captureHistory(query?: string): Promise<CaptureHistoryState>;
  actCaptureHistory(id: string, action: 'edit' | 'pin' | 'copy' | 'delete'): Promise<{ error: string | null }>;
  clearCaptureHistory(): Promise<{ error: string | null }>;
  pinWorkspace(): Promise<PinWorkspaceState>;
  savePinWorkspace(settings: PinWorkspaceSettings): Promise<{ error: string | null }>;
  createPin(input: { kind: PinKind; text?: string; color?: string; filePath?: string; groupId?: string }): Promise<{ error: string | null }>;
  pinClipboard(): Promise<{ error: string | null }>;
  reopenClosedPin(): Promise<{ error: string | null }>;
  arrangePins(mode: PinArrangeMode, groupId?: string): Promise<{ error: string | null }>;
  actPin(id: string, action: 'focus' | 'toggle-visible' | 'toggle-lock' | 'close', groupId?: string): Promise<{ error: string | null }>;
  exportConfig(): Promise<{ path: string | null; error: string | null }>;
  importConfig(): Promise<{ error: string | null }>;
  webdavConfig(): Promise<WebDavConfig>;
  saveWebdavConfig(input: WebDavConfigInput): Promise<WebDavConfig>;
  syncWebdav(direction: WebDavSyncDirection): Promise<{ state: WebDavConfig; error: string | null }>;
  saveMemory(options: MemorySettings): Promise<{ error: string | null }>;
  captureRegions():Promise<RegionConfiguration>;
  customScreenshot(request:CustomCaptureRequest):Promise<{error:string|null}>;
  saveRegionPreset(preset:RegionPreset):Promise<void>;
  deleteRegionPreset(id:string):Promise<void>;
  mediaConfig(): Promise<MediaConfig>;
  visionConfig(): Promise<VisionServiceConfig>;
  saveVisionConfig(input: VisionServiceInput): Promise<VisionServiceConfig>;
  saveMediaConfig(input: MediaConfigInput): Promise<MediaConfig>;
  mediaModels(): Promise<string[]>;
  apiConnections(): Promise<ApiConnection[]>;
  saveApiConnection(input: ApiConnectionInput): Promise<{ connections: ApiConnection[]; connection?: ApiConnection; error: string | null }>;
  deleteApiConnection(id: string): Promise<{ connections: ApiConnection[]; error: string | null }>;
  fetchApiConnectionModels(id: string): Promise<{ models: string[]; error: string | null }>;
  saveTranslationSettings(input: TranslationSettings): Promise<{ error: string | null }>;
  saveWindowDragSnap(enabled: boolean): Promise<{ error: string | null }>;
  attachImage(prompt?: string): Promise<{ error: string | null }>;
  openLink(url: string): Promise<void>;
  getState(): Promise<ShellState>;
  act(action: Action): Promise<void>;
  screenshot(mode: EfficiencyCaptureMode, delay?: CaptureDelay): Promise<void>;
  cancelScreenshot(): Promise<void>;
  openLocalImage(): Promise<{ error: string | null }>;
  saveActionShortcut(action: GlobalActionId, shortcut: string): Promise<{ error: string | null }>;
  saveEditorShortcuts(shortcuts: EditorShortcutMap): Promise<{ error: string | null }>;
  saveIgnoredApps(rules: IgnoredAppRule[]): Promise<{ error: string | null }>;
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
export interface FastApiCardState {
  presetId: string;
  presetName: string;
  model: string;
  status: 'streaming' | 'done' | 'error';
  text: string;
  error: string | null;
  firstTokenMs: number | null;
  isTranslation: boolean;
  targetLang: 'auto' | 'zh' | 'en';
}
/** `presets` fill the capsule; `more` are the remaining enabled presets and `scripts` the enabled script actions, both listed in the ··· menu. */
export interface ActionBarState {
  presets: Pick<Preset, 'id' | 'name' | 'target' | 'mode'>[];
  more: Pick<Preset, 'id' | 'name' | 'target' | 'mode'>[];
  scripts: Pick<ScriptAction, 'id' | 'name'>[];
  busy: boolean;
  fonts: Pick<Settings, 'fonts' | 'importedFonts'>;
  fastCard?: FastApiCardState | null;
}
/** A side of the capsule, away from the selection when the screen allows. */
export type ActionBarTip = 'above' | 'below';
/** Where the hover tip and the ··· menu open; the capsule stays anchored to the other edge. */
export interface ActionBarLayout { tip: ActionBarTip; menu: ActionBarTip }
/** ··· menu metrics, shared by main (window growth) and the renderer (row sizes). */
export const BAR_MENU = { width: 232, row: 32, pad: 5, sep: 9, gap: 6 };
/** The overflow presets and the scripts each end with a separator when present; the settings row comes last. */
export const barMenuHeight = ({ more, scripts }: Pick<ActionBarState, 'more' | 'scripts'>) => BAR_MENU.pad * 2 + (more.length + scripts.length + 1) * BAR_MENU.row + [more, scripts].filter(rows => rows.length).length * BAR_MENU.sep;
export interface ActionBarAPI {
  getState(): Promise<ActionBarState>;
  runPreset(id: string): Promise<void>;
  runScript(id: string): Promise<void>;
  /** Grows the window on the menu side while the ··· menu is open. */
  menu(open: boolean): void;
  settings(): void;
  /** Width of the capsule itself; main adds the transparent margins. */
  resize(width: number): void;
  /** Height of the inline fast-API result card when open (0 when closed). */
  cardHeight(height: number): void;
  closeFastCard(): void;
  retryFastCard(targetLang?: 'auto' | 'zh' | 'en'): Promise<void>;
  copyFastResult(text: string): Promise<void>;
  replaceSelection(text: string): Promise<void>;
  pinFastResult(text: string): Promise<void>;
  appendNote(): Promise<void>;
  /** The pointer entered or left the capsule; outside it the window lets clicks through. */
  hit(inside: boolean): void;
  onState(callback: (state: ActionBarState) => void): () => void;
  /** Fired on every show so the capsule can replay its entrance. */
  onEnter(callback: (layout: ActionBarLayout) => void): () => void;
}

export type IslandMode = 'idle' | 'focus' | 'focus-hover' | 'slacking' | 'nook-alert' | 'toast' | 'board';
export interface IslandAlertItem {
  id: string;
  kind: 'task' | 'reset' | 'launchd' | 'custom';
  title: string;
  subtitle: string;
  target?: string;
}
export interface IslandTaskItem {
  id: string;
  title: string;
  listTitle: string;
}
export type IslandCliTask = {
  id: string;
  target: 'codex' | 'pi';
  title: string;
  activity: 'running' | 'waiting';
};
export interface IslandState {
  mode: IslandMode;
  glow: boolean;
  notch?: { hasNotch: boolean; width: number; height: number; menuBarHeight: number; leftSafeWidth?: number; rightSafeWidth?: number; anchorX?: number };
  nookPrefs: NookReminderPrefs;
  copyTranslateEnabled: boolean;
  pomodoro: {
    active: boolean;
    paused: boolean;
    kind: 'focus' | 'slacking';
    taskId: string | null;
    taskTitle: string;
    remainingSeconds: number;
    totalSeconds: number;
  } | null;
  toast: { id: string; text: string; badge?: string } | null;
  alerts: IslandAlertItem[];
  nookTasks: IslandTaskItem[];
  cliTasks: IslandCliTask[];
  fonts: Pick<Settings, 'fonts' | 'importedFonts'>;
}
export type SnapSlot =
  | 'left-half'
  | 'right-half'
  | 'top-half'
  | 'bottom-half'
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'maximize'
  | 'center'
  | 'prev-display'
  | 'next-display'
  | 'coding-ai'
  | 'equal-split';

export interface NookReminderPrefs {
  enabled: boolean;
  tasks: boolean;
  hubAttention: boolean;
  aiResets: boolean;
  localAndCustom: boolean;
}
export type IslandQuickAction = 'screenshot-area' | 'open-settings' | 'toggle-notes' | 'open-finder-panel' | 'open-translator' | 'open-clipboard';
export interface TranslatorWindowState {
  open: boolean;
  pinnedOnTop: boolean;
  sourceText: string;
  translatedText: string;
  status: 'idle' | 'streaming' | 'done' | 'error';
  error: string | null;
  targetLang: TranslationLang;
  connectionName: string;
  model: string;
  firstTokenMs: number | null;
  canReplace: boolean;
  fonts: Pick<Settings, 'fonts' | 'importedFonts'>;
}
export interface ClipboardEntry {
  id: string;
  kind: 'text' | 'image' | 'files';
  text: string;
  preview: string;
  charCount: number;
  lineCount: number;
  imageThumbnail?: string;
  imagePath?: string;
  imageWidth?: number;
  imageHeight?: number;
  files?: string[];
  sourceBundleId: string;
  sourceAppName: string;
  sourceAppIcon: string | null;
  createdAt: number;
  favorite: boolean;
}
export interface ClipboardWindowState { entries: ClipboardEntry[]; pinnedOnTop: boolean; fonts: Pick<Settings, 'fonts' | 'importedFonts'> }

export interface EdgeNoteItem {
  fileName: string;
  content: string;
}

export type EdgeNotesState = {
  open: boolean;
  pinnedOnTop: boolean;
  activeFile: string;
  content: string;
  files: string[];
  notesDir: string;
  notes: EdgeNoteItem[];
  fonts: Pick<Settings, 'fonts' | 'importedFonts'>;
};

export type FinderMoveTarget = {
  id: string;
  label: string;
  path: string;
  kind: 'common' | 'repo' | 'worktree';
};
export type FinderPanelState = {
  folder: string;
  selection: string[];
  hasImageSelection: boolean;
  cutPaths: string[];
  moveTargets: FinderMoveTarget[];
  fonts: Pick<Settings, 'fonts' | 'importedFonts'>;
};
export type FinderActionReq =
  | { kind: 'new-file'; name: string; content?: string }
  | { kind: 'copy-paths'; style: 'posix' | 'quoted' | 'filename' }
  | { kind: 'open-terminal'; app?: 'Terminal' | 'Warp' | 'Ghostty' }
  | { kind: 'open-editor'; app: 'Cursor' | 'VSCode' | 'Zed' }
  | { kind: 'cut-selection' }
  | { kind: 'paste-move' }
  | { kind: 'delete-permanent' }
  | { kind: 'convert-webp' }
  | { kind: 'ocr-copy' }
  | { kind: 'ocr-pin' }
  | { kind: 'pin-image' }
  | { kind: 'move-to-target'; targetDir: string }
  | { kind: 'symlink-to-target'; targetDir: string };

export interface IslandAPI {
  getState(): Promise<IslandState>;
  setMode(mode: IslandMode): void;
  hit(inside: boolean): void;
  startPomodoro(task?: { id: string | null; title: string }, minutes?: number, kind?: 'focus' | 'slacking'): Promise<void>;
  togglePausePomodoro(): Promise<void>;
  stopPomodoro(): Promise<void>;
  completeTask(taskId: string): Promise<void>;
  snoozeAlert(alertId: string, minutes?: number): Promise<void>;
  dismissAlert(alertId?: string): Promise<void>;
  restartService(label: string): Promise<void>;
  quickAction(action: IslandQuickAction): Promise<void>;
  setGlow(enabled: boolean): Promise<void>;
  setNookReminderPrefs(patch: Partial<NookReminderPrefs>): Promise<void>;
  setCopyTranslate(enabled: boolean): Promise<void>;
  getTranslatorState(): Promise<TranslatorWindowState>;
  translateInput(req: { text: string; targetLang: TranslationLang }): Promise<{ error: string | null }>;
  cancelTranslation(): void;
  setTranslatorLang(lang: TranslationLang): Promise<void>;
  setTranslatorPinned(pinned: boolean): Promise<void>;
  translatorAct(action: 'copy' | 'replace' | 'pin' | 'note', text: string): Promise<{ error: string | null }>;
  closeTranslator(): void;
  onTranslatorState(callback: (state: TranslatorWindowState) => void): () => void;
  getClipboardState(): Promise<ClipboardWindowState>;
  clipboardAct(req: { action: 'paste' | 'copy' | 'toggle-fav' | 'pin' | 'note' | 'delete' | 'clear-all'; id?: string }): Promise<{ error: string | null }>;
  closeClipboard(): void;
  onClipboardState(callback: (state: ClipboardWindowState) => void): () => void;
  snapWindow(slot: SnapSlot): Promise<void>;
  focusTask(taskId: string): Promise<void>;
  onState(callback: (state: IslandState) => void): () => void;
  // EdgeNotes surface API
  getNotesState(): Promise<EdgeNotesState>;
  setNotesOpen(open: boolean): void;
  selectNote(id: string): Promise<void>;
  saveNote(id: string, content: string): Promise<void>;
  createNote(title?: string): Promise<void>;
  deleteNote(name: string): Promise<EdgeNotesState>;
  setNotesPinned(pinned: boolean): Promise<EdgeNotesState>;
  pinNoteToDesktop(id: string): Promise<void>;
  onNotesState(callback: (state: EdgeNotesState) => void): () => void;
  // Finder Super Action Panel surface API
  getFinderState(): Promise<FinderPanelState>;
  finderAction(req: FinderActionReq): Promise<FinderPanelState>;
  finderClose(): void;
  onFinderState(callback: (state: FinderPanelState) => void): () => void;
}
