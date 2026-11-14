import type { RecordingAction, RecordingSessionState } from './recording';
import type { RegionConfiguration, RegionPreset } from './capture-regions';
import type { ScreenshotSettings } from './screenshot-settings';
import type { MemorySettings } from './memory';
import type { ApiConnection, ApiConnectionInput, ImageOptions, MediaConfig, MediaConfigInput, TranslationLang, TranslationSettings } from './media';
import type { CaptureMode } from './capture';
import type { VisionServiceConfig, VisionServiceInput } from './intelligence';
import type { CaptureDelay, CaptureEfficiencyState, EfficiencyCaptureMode } from './capture-efficiency';
import type { EditorShortcutMap, GlobalActionId, IgnoredAppRule } from './shortcuts';
import type { CaptureHistoryState, PinArrangeMode, PinKind, PinWorkspaceSettings, PinWorkspaceState, WebDavConfig, WebDavConfigInput, WebDavSyncDirection } from './history-sync';

export type Target = 'chatgpt' | 'gemini' | 'api';
export type WebTarget = 'chatgpt' | 'gemini';
/** Native web views are placed below the title bar and above any footer rows. */
export const HEADER_HEIGHT = 44;
export const FOOTER_ROW = 48;
export const targetLabels: Record<Target, string> = { chatgpt: 'ChatGPT', gemini: 'Gemini', api: 'API' };
export type PresetTarget = Target;
export const presetTargetLabels = targetLabels;

export interface AppPrompt { bundleId: string; name: string; prompt: string; enabled: boolean }
export interface ImagePreview { id: string; thumbnail: string; width: number; height: number }
export interface ExecutionProfile { model?: string; effort?: string }
export interface AgentModel { id: string; label: string; images?: boolean; efforts?: string[]; defaultEffort?: string }
export interface ExecutionCatalog { models: AgentModel[]; efforts: string[]; effortOptions?: { id: string; label: string }[] }
export interface LaunchOptions { target?: Target; connectionId?: string; model?: string; imageId?: string; prompt?: string; autoSend?: boolean }

export interface ApiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  image?: ImagePreview;
  streaming?: boolean;
  firstTokenMs?: number | null;
  error?: string | null;
}
export interface ApiChatState {
  revision: number;
  taskId: string;
  connectionId: string;
  model: string;
  messages: ApiChatMessage[];
  draft: string;
  image: ImagePreview | null;
  running: boolean;
  error: string | null;
}
export interface ApiChatEvent {
  taskId: string;
  state: ApiChatState;
}

export type FontRole = 'display' | 'text' | 'ui' | 'mono';
export interface ImportedFont { family: string; file: string }
export const defaultFonts: Record<FontRole, string> = {
  display: 'Anthropic Serif Text',
  text: 'Anthropic Serif Text',
  ui: 'Anthropic Sans',
  mono: 'JetBrains Mono'
};

export type FinderTerminalApp = 'Terminal' | 'Ghostty' | 'Warp' | 'iTerm';
export type FinderEditorApp = 'Cursor' | 'VSCode' | 'Zed';

export interface ActionBarConfig {
  /** Ordered item IDs ('translate', 'note', or `preset:<id>`). */
  order: string[];
  /** Hidden item IDs disabled from the action bar. */
  hidden: string[];
  /** Number of enabled items shown directly in the capsule before folding into ···. */
  inlineCount: number;
}

export interface SuiteSettings {
  notchIslandEnabled: boolean;
  windowDragSnap: boolean;
  snapDwellMs: number;
  finderTriggers: { middleClick: boolean; rightHold: boolean };
  finderTerminal: FinderTerminalApp;
  finderEditor: FinderEditorApp;
  clipboardMaxItems: number;
  nookPrefs: NookReminderPrefs;
}

export type GeneralSettings = Pick<Settings, 'launchAtLogin' | 'themeMode' | 'toolbarTools' | 'mouseActions' | 'autoCheckUpdates'>;

export interface Settings {
  launchAtLogin: boolean;
  themeMode: 'paper' | 'system';
  /** Empty displays every tool. */
  toolbarTools: string[];
  mouseActions: { doubleClick: 'copy' | 'save' | 'pin' | 'none'; rightClick: 'reselect' | 'cancel'; middleClick: 'pin' | 'quick-save' | 'none' };
  autoCheckUpdates: boolean;
  vision: Omit<VisionServiceConfig, 'hasCredential'>;
  translation: TranslationSettings;
  notchIslandEnabled: boolean;
  windowDragSnap: boolean;
  snapDwellMs: number;
  finderTriggers: { middleClick: boolean; rightHold: boolean };
  finderTerminal: FinderTerminalApp;
  finderEditor: FinderEditorApp;
  clipboardMaxItems: number;
  nookPrefs: NookReminderPrefs;
  actionBar: ActionBarConfig;
  defaultApiChat: { connectionId: string; model: string };
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
  fonts: Record<FontRole, string>;
  importedFonts: ImportedFont[];
}

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
  idle: '新对话', loading: '加载中', running: '生成中', waiting: '等待处理',
  draft: '有草稿', complete: '已完成', unknown: '状态待确认', error: '异常'
};

export type SettingsSection = 'general' | 'selection' | 'presets' | 'translation' | 'connections' | 'capture' | 'suite' | 'shortcuts';

export interface ShellState {
  tasks: TaskSummary[];
  activeTaskId: string | null;
  pinned: boolean;
  expanded: boolean;
  hasPage: boolean;
  activeTarget: Target | null;
  hostname: string;
  loading: boolean;
  pageError: string | null;
  shortcutError: string | null;
  /** App-level failure not owned by a task, such as screenshot or clipboard image errors. */
  notice: string | null;
  settings: Settings;
  presets: Preset[];
  connections: ApiConnection[];
  settingsSection?: SettingsSection;
  capture: CaptureStatus;
  captureEfficiency: CaptureEfficiencyState;
  selection: { length: number; sourceApp: string } | null;
  delivery: DeliveryStatus | null;
}

export type Action =
  | 'dismiss-notice'
  | 'pin'
  | 'expand'
  | 'hide'
  | 'settings'
  | 'open-quick-image'
  | 'reload'
  | 'quit'
  | 'selection-permission'
  | 'refresh-capture'
  | 'dismiss-delivery'
  | 'copy-pending'
  | 'cancel-delivery'
  | 'retry-delivery'
  | 'open-island-board'
  | 'toggle-edge-notes'
  | 'open-finder-panel'
  | 'snap-coding-ai'
  | 'snap-equal-split';

export type PaletteScope = 'all' | 'tasks' | 'new';
export interface PaletteEvent { scope: PaletteScope | null; backdrop: string | null }

export interface DesktopAPI {
  saveGeneral(options: GeneralSettings): Promise<{ error: string | null }>;
  saveActionBarConfig(config: ActionBarConfig): Promise<{ error: string | null }>;
  saveSuiteSettings(patch: Partial<SuiteSettings>): Promise<{ error: string | null }>;
  saveAppPrompts(rules: AppPrompt[]): Promise<{ error: string | null }>;
  saveDefaultApiChat(config: { connectionId: string; model: string }): Promise<{ error: string | null }>;
  openSettings(section?: SettingsSection): Promise<void>;
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
  captureRegions(): Promise<RegionConfiguration>;
  saveRegionPreset(preset: RegionPreset): Promise<void>;
  deleteRegionPreset(id: string): Promise<void>;
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
  choosePath(kind: 'directory' | 'executable' | 'application'): Promise<{ path: string; bundleId?: string; name?: string } | null>;
  appIcon(bundleId: string): Promise<string | null>;
  readImage(taskId?: string): Promise<{ error: string | null }>;
  pickChatImage(taskId: string): Promise<{ error: string | null }>;
  removeImage(taskId?: string): Promise<void>;
  editImage(taskId: string, imageId: string): Promise<{ error: string | null }>;
  getApiChat(taskId: string): Promise<ApiChatState | null>;
  apiChatDraft(taskId: string, text: string): Promise<void>;
  apiChatSend(taskId: string): Promise<{ error: string | null }>;
  apiChatStop(taskId: string): Promise<{ error: string | null }>;
  apiChatRegenerate(taskId: string, messageId?: string): Promise<{ error: string | null }>;
  apiChatClear(taskId: string): Promise<void>;
  apiChatModel(taskId: string, connectionId: string, model: string): Promise<{ error: string | null }>;
  apiChatPin(taskId: string): Promise<{ error: string | null }>;
  onApiChat(callback: (event: ApiChatEvent) => void): () => void;
  executionCatalog(target: WebTarget, model?: string, refresh?: boolean): Promise<{ catalog: ExecutionCatalog | null; error: string | null }>;
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
  connectionId: string;
  model: string;
  status: 'streaming' | 'done' | 'error';
  text: string;
  error: string | null;
  firstTokenMs: number | null;
}

export interface ActionBarItem {
  id: string;
  kind: 'translate' | 'note' | 'preset';
  name: string;
  target?: Target;
  mode?: 'edit' | 'send';
}

/** `items` fill the capsule; `more` are the remaining enabled actions listed in the ··· menu. */
export interface ActionBarState {
  items: ActionBarItem[];
  more: ActionBarItem[];
  busy: boolean;
  fonts: Pick<Settings, 'fonts' | 'importedFonts'>;
  fastCard?: FastApiCardState | null;
}

export type ActionBarTip = 'above' | 'below';
export interface ActionBarLayout { tip: ActionBarTip; menu: ActionBarTip }
export const BAR_MENU = { width: 232, row: 32, pad: 5, sep: 9, gap: 6 };
export const barMenuHeight = ({ more }: Pick<ActionBarState, 'more'>) =>
  BAR_MENU.pad * 2 + (more.length + 1) * BAR_MENU.row + (more.length > 0 ? BAR_MENU.sep : 0);

export interface ActionBarAPI {
  getState(): Promise<ActionBarState>;
  runItem(id: string): Promise<void>;
  menu(open: boolean): void;
  settings(): void;
  resize(width: number): void;
  cardHeight(height: number): void;
  closeFastCard(): void;
  retryFastCard(): Promise<void>;
  continueFastInChat(): Promise<void>;
  copyFastResult(text: string): Promise<void>;
  replaceSelection(text: string): Promise<void>;
  noteFastResult(text: string): Promise<void>;
  pinFastResult(text: string): Promise<void>;
  hit(inside: boolean): void;
  onState(callback: (state: ActionBarState) => void): () => void;
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
  completed?: boolean;
  dueLabel?: string;
  overdue?: boolean;
}
export interface NookFocusReview {
  mainGoal: string;
  items: string[];
}
export interface IslandState {
  mode: IslandMode;
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
  nookReview: NookFocusReview | null;
  nookTasks: IslandTaskItem[];
  nookCompletedCount: number;
  nookTotalCount: number;
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
  | 'left-third'
  | 'center-third'
  | 'right-third'
  | 'left-two-thirds'
  | 'right-two-thirds'
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
  fromSelection: boolean;
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
  imageBytes?: number;
  files?: string[];
  sourceBundleId: string;
  sourceAppName: string;
  sourceAppIcon: string | null;
  createdAt: number;
  favorite: boolean;
}
export interface ClipboardWindowState {
  entries: ClipboardEntry[];
  pinnedOnTop: boolean;
  fonts: Pick<Settings, 'fonts' | 'importedFonts'>;
}

export interface EdgeNoteItem {
  fileName: string;
  content: string;
  updatedAt?: number;
}
export type EdgeNotesState = {
  open: boolean;
  focused: boolean;
  pinnedOnTop: boolean;
  activeFile: string;
  content: string;
  files: string[];
  notesDir: string;
  shortcut: string;
  notes: EdgeNoteItem[];
  fonts: Pick<Settings, 'fonts' | 'importedFonts'>;
};

export type FinderMoveTarget = {
  id: string;
  label: string;
  group?: string;
  path: string;
  kind: 'common' | 'repo' | 'worktree';
};
export type FinderPanelState = {
  folder: string;
  selection: string[];
  imageCount: number;
  hasImageSelection: boolean;
  cutPaths: string[];
  moveTargets: FinderMoveTarget[];
  defaultTerminal: FinderTerminalApp;
  defaultEditor: FinderEditorApp;
  fonts: Pick<Settings, 'fonts' | 'importedFonts'>;
};
export type FinderActionReq =
  | { kind: 'new-file'; name: string; content?: string }
  | { kind: 'copy-paths'; style: 'posix' | 'quoted' | 'filename' }
  | { kind: 'open-terminal'; app?: FinderTerminalApp }
  | { kind: 'open-editor'; app?: FinderEditorApp }
  | { kind: 'send-to-ai' }
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
  openNook(): Promise<void>;
  snoozeAlert(alertId: string, minutes?: number): Promise<void>;
  dismissAlert(alertId?: string): Promise<void>;
  restartService(label: string): Promise<void>;
  quickAction(action: IslandQuickAction): Promise<void>;
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
  clipboardAct(req: { action: 'paste' | 'paste-plain' | 'copy' | 'toggle-fav' | 'pin' | 'note' | 'translate' | 'ask-ai' | 'delete' | 'clear-all' | 'set-pinned'; id?: string; pinned?: boolean }): Promise<{ error: string | null }>;
  closeClipboard(): void;
  onClipboardState(callback: (state: ClipboardWindowState) => void): () => void;
  snapWindow(slot: SnapSlot): Promise<void>;
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
