import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { migrateScreenshotSettings, screenshotDefaults } from '../shared/screenshot-settings';
import {
  defaultFonts,
  type ActionBarConfig,
  type GeneralSettings,
  type NookReminderPrefs,
  type Preset,
  type Settings,
  type SuiteSettings
} from '../shared/contracts';
import { memoryDefaults, validMemorySettings } from '../shared/memory';
import { captureModes } from '../shared/capture';
import { defaultEditorShortcuts, globalActionIds, type GlobalActionId } from '../shared/shortcuts';
import { normalizeVisionConfig, visionDefaults } from '../shared/intelligence';
import { normalizeTranslationSettings, translationDefaults } from '../shared/media';
import type { MediaService } from './media-service';
import { writePresets } from './presets';
import { writeFileAtomic } from './files';

const DEFAULT_SUITE_SHORTCUTS: Partial<Record<GlobalActionId, string>> = {
  'open-clipboard-history': 'Alt+V',
  'open-translator': 'Alt+T',
  'toggle-notes': 'Alt+N',
  'open-finder-panel': 'Control+Alt+F',
  'snap-left-half': 'Control+Alt+Left',
  'snap-right-half': 'Control+Alt+Right',
  'snap-maximize': 'Control+Alt+Up',
  'snap-center': 'Control+Alt+Down',
  'snap-coding-ai': 'Control+Alt+Enter',
  'snap-prev-display': 'Command+Control+Alt+Left',
  'snap-next-display': 'Command+Control+Alt+Right'
};

export function defaultActionBarConfig(hideLegacyTranslatePreset = false): ActionBarConfig {
  return {
    order: ['translate', 'preset:explain', 'preset:summarize', 'preset:ask', 'note', 'preset:today'],
    hidden: hideLegacyTranslatePreset ? ['preset:translate'] : [],
    inlineCount: 5
  };
}

export function defaultNookPrefs(): NookReminderPrefs {
  return { enabled: true, tasks: true, hubAttention: true, aiResets: true, localAndCustom: true };
}

/** Absent entries initialize from defaults; explicit empty strings ('') stay unbound across restarts. */
function syncActionShortcuts(settings: Settings): Settings {
  const raw = settings.actionShortcuts ?? {};
  const actionShortcuts: Partial<Record<GlobalActionId, string>> = {};
  for (const id of globalActionIds) {
    if (typeof raw[id] === 'string') actionShortcuts[id] = raw[id];
  }
  actionShortcuts['open-launcher'] ??= settings.shortcut ?? '';
  for (const mode of captureModes) actionShortcuts[mode] ??= settings.captureShortcuts?.[mode] ?? '';
  for (const [id, fallback] of Object.entries(DEFAULT_SUITE_SHORTCUTS) as [GlobalActionId, string][]) {
    actionShortcuts[id] ??= fallback;
  }
  for (const id of globalActionIds) actionShortcuts[id] ??= '';
  settings.actionShortcuts = actionShortcuts;
  settings.shortcut = actionShortcuts['open-launcher'] ?? '';
  settings.captureShortcuts = Object.fromEntries(captureModes.map(mode => [mode, actionShortcuts[mode] ?? ''])) as Settings['captureShortcuts'];
  return settings;
}

export function normalizeActionBarConfig(value: unknown, hideLegacyTranslate = false): ActionBarConfig {
  const base = defaultActionBarConfig(hideLegacyTranslate);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
  const raw = value as Partial<ActionBarConfig>;
  const validItem = (item: unknown): item is string =>
    typeof item === 'string' && (item === 'translate' || item === 'note' || /^preset:[a-zA-Z0-9_-]{1,128}$/.test(item));
  const order = Array.isArray(raw.order) ? [...new Set(raw.order.filter(validItem))] : base.order;
  const hidden = Array.isArray(raw.hidden) ? [...new Set(raw.hidden.filter(validItem))] : base.hidden;
  const inlineCount = typeof raw.inlineCount === 'number' && Number.isInteger(raw.inlineCount)
    ? Math.max(1, Math.min(12, raw.inlineCount))
    : base.inlineCount;
  return { order, hidden, inlineCount };
}

export function normalizeSuiteSettings(value: Partial<Settings>, defaults: Settings): Pick<
  Settings,
  'notchIslandEnabled' | 'windowDragSnap' | 'snapDwellMs' | 'finderTriggers' | 'finderTerminal' | 'finderEditor' | 'clipboardMaxItems' | 'nookPrefs'
> {
  const rawNook: Partial<NookReminderPrefs> = value.nookPrefs && typeof value.nookPrefs === 'object' ? value.nookPrefs : {};
  const nookPrefs: NookReminderPrefs = {
    enabled: typeof rawNook.enabled === 'boolean' ? rawNook.enabled : defaults.nookPrefs.enabled,
    tasks: typeof rawNook.tasks === 'boolean' ? rawNook.tasks : defaults.nookPrefs.tasks,
    hubAttention: typeof rawNook.hubAttention === 'boolean' ? rawNook.hubAttention : defaults.nookPrefs.hubAttention,
    aiResets: typeof rawNook.aiResets === 'boolean' ? rawNook.aiResets : defaults.nookPrefs.aiResets,
    localAndCustom: typeof rawNook.localAndCustom === 'boolean' ? rawNook.localAndCustom : defaults.nookPrefs.localAndCustom
  };
  const rawFinder: Partial<Settings['finderTriggers']> = value.finderTriggers && typeof value.finderTriggers === 'object' ? value.finderTriggers : {};
  return {
    notchIslandEnabled: typeof value.notchIslandEnabled === 'boolean' ? value.notchIslandEnabled : defaults.notchIslandEnabled,
    windowDragSnap: typeof value.windowDragSnap === 'boolean' ? value.windowDragSnap : defaults.windowDragSnap,
    snapDwellMs: typeof value.snapDwellMs === 'number' && Number.isFinite(value.snapDwellMs)
      ? Math.max(80, Math.min(1200, Math.round(value.snapDwellMs)))
      : defaults.snapDwellMs,
    finderTriggers: {
      middleClick: typeof rawFinder.middleClick === 'boolean' ? rawFinder.middleClick : defaults.finderTriggers.middleClick,
      rightHold: typeof rawFinder.rightHold === 'boolean' ? rawFinder.rightHold : defaults.finderTriggers.rightHold
    },
    finderTerminal: ['Terminal', 'Ghostty', 'Warp', 'iTerm'].includes(value.finderTerminal as string)
      ? value.finderTerminal!
      : defaults.finderTerminal,
    finderEditor: ['Cursor', 'VSCode', 'Zed'].includes(value.finderEditor as string)
      ? value.finderEditor!
      : defaults.finderEditor,
    clipboardMaxItems: typeof value.clipboardMaxItems === 'number' && Number.isInteger(value.clipboardMaxItems)
      ? Math.max(20, Math.min(1000, value.clipboardMaxItems))
      : defaults.clipboardMaxItems,
    nookPrefs
  };
}

export function defaultSettings(): Settings {
  return syncActionShortcuts({
    launchAtLogin: false,
    themeMode: 'paper',
    toolbarTools: [],
    mouseActions: { doubleClick: 'copy', rightClick: 'cancel', middleClick: 'pin' },
    autoCheckUpdates: true,
    memory: memoryDefaults(),
    vision: visionDefaults(),
    translation: translationDefaults(),
    notchIslandEnabled: true,
    windowDragSnap: true,
    snapDwellMs: 250,
    finderTriggers: { middleClick: true, rightHold: true },
    finderTerminal: 'Ghostty',
    finderEditor: 'Cursor',
    clipboardMaxItems: 200,
    nookPrefs: defaultNookPrefs(),
    actionBar: defaultActionBarConfig(false),
    defaultApiChat: { connectionId: '', model: '' },
    screenshot: screenshotDefaults(join(app.getPath('pictures'), 'Lasso')),
    shortcut: '',
    captureShortcuts: { rect: '', area: '', window: '', screen: '', front: '' },
    actionShortcuts: {},
    editorShortcuts: defaultEditorShortcuts(),
    ignoredApps: [],
    lastTarget: 'chatgpt',
    selectionEnabled: true,
    clipboardFallback: false,
    appPrompts: [],
    fonts: { ...defaultFonts },
    importedFonts: []
  });
}

export function migrateSettings(value: Record<string, unknown>, defaults: Settings): Settings {
  const { screenshotShortcut, local: _local, scriptActions: _scripts, ...raw } = value;
  const settings = raw as Partial<Settings>;
  if (settings.shortcut !== undefined && typeof settings.shortcut !== 'string') throw new Error('设置文件中的 shortcut 必须是字符串');
  const isPreV4 = !Object.hasOwn(value, 'actionBar');
  const mergedFonts = { ...defaults.fonts, ...(settings.fonts || {}) };
  if (isPreV4 && mergedFonts.ui === 'Anthropic Serif Text') {
    mergedFonts.ui = 'Anthropic Sans';
  }
  const rawDefaultApi: Partial<Settings['defaultApiChat']> = settings.defaultApiChat && typeof settings.defaultApiChat === 'object' ? settings.defaultApiChat : {};

  return syncActionShortcuts({
    ...defaults,
    ...settings,
    memory: validMemorySettings(settings.memory!) ? settings.memory! : defaults.memory,
    mouseActions: { ...defaults.mouseActions, ...settings.mouseActions },
    vision: normalizeVisionConfig(settings.vision ?? defaults.vision),
    translation: normalizeTranslationSettings(settings.translation ?? defaults.translation),
    ...normalizeSuiteSettings(settings, defaults),
    actionBar: normalizeActionBarConfig(settings.actionBar, isPreV4),
    defaultApiChat: {
      connectionId: typeof rawDefaultApi.connectionId === 'string' ? rawDefaultApi.connectionId : '',
      model: typeof rawDefaultApi.model === 'string' ? rawDefaultApi.model : ''
    },
    screenshot: migrateScreenshotSettings(settings.screenshot, defaults.screenshot.directory),
    captureShortcuts: {
      ...defaults.captureShortcuts,
      ...(typeof screenshotShortcut === 'string' ? { area: screenshotShortcut } : {}),
      ...settings.captureShortcuts
    },
    actionShortcuts: { ...settings.actionShortcuts },
    editorShortcuts: { ...defaults.editorShortcuts, ...settings.editorShortcuts },
    ignoredApps: Array.isArray(settings.ignoredApps) ? settings.ignoredApps : defaults.ignoredApps,
    appPrompts: Array.isArray(settings.appPrompts) ? settings.appPrompts : defaults.appPrompts,
    fonts: mergedFonts,
    importedFonts: Array.isArray(settings.importedFonts) ? settings.importedFonts : defaults.importedFonts,
    lastTarget: ['chatgpt', 'gemini', 'api'].includes(settings.lastTarget as string) ? settings.lastTarget! : 'chatgpt'
  });
}

export function readSettings(path: string): Settings {
  return existsSync(path) ? migrateSettings(JSON.parse(readFileSync(path, 'utf8')), defaultSettings()) : defaultSettings();
}

export function writeSettings(path: string, settings: Settings) {
  writeFileAtomic(path, JSON.stringify(syncActionShortcuts(settings), null, 2) + '\n');
}

/** Pool writes happen before settings/presets acquire a connection binding; interrupted migrations can be retried. */
export function migrateApiConnectionSettings(
  service: MediaService,
  settingsPath: string,
  presetsPath: string,
  settings: Settings,
  presets: Preset[],
  visionDirectory: string
): { settings: Settings; presets: Preset[] } {
  const visionPath = join(visionDirectory, 'config.json');
  const legacyVision = existsSync(visionPath) ? JSON.parse(readFileSync(visionPath, 'utf8')) : {};
  const next = service.migrateLegacyBindings(settings, presets, legacyVision);
  if (JSON.stringify(next.settings) !== JSON.stringify(settings)) writeSettings(settingsPath, next.settings);
  if (JSON.stringify(next.presets) !== JSON.stringify(presets)) writePresets(presetsPath, next.presets, service.connections());
  return next;
}

export function validateGeneralSettings(value: GeneralSettings): void {
  if (
    !value ||
    typeof value.launchAtLogin !== 'boolean' ||
    !['paper', 'system'].includes(value.themeMode) ||
    typeof value.autoCheckUpdates !== 'boolean' ||
    !Array.isArray(value.toolbarTools) ||
    value.toolbarTools.length > 50 ||
    value.toolbarTools.some(id => typeof id !== 'string' || !/^[a-z][a-z-]*$/.test(id)) ||
    new Set(value.toolbarTools).size !== value.toolbarTools.length ||
    !value.mouseActions ||
    !['copy', 'save', 'pin', 'none'].includes(value.mouseActions.doubleClick) ||
    !['reselect', 'cancel'].includes(value.mouseActions.rightClick) ||
    !['pin', 'quick-save', 'none'].includes(value.mouseActions.middleClick)
  ) {
    throw Error('常规设置无效');
  }
}

export function validateActionBarConfig(value: ActionBarConfig): ActionBarConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('动作条设置无效');
  return normalizeActionBarConfig(value, false);
}

export function validateSuitePatch(current: Settings, patch: Partial<SuiteSettings>): Settings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw Error('桌面套件设置无效');
  const next = { ...current };
  if (patch.windowDragSnap !== undefined) {
    if (typeof patch.windowDragSnap !== 'boolean') throw Error('拖拽分屏开关无效');
    next.windowDragSnap = patch.windowDragSnap;
  }
  if (patch.snapDwellMs !== undefined) {
    if (typeof patch.snapDwellMs !== 'number' || !Number.isFinite(patch.snapDwellMs)) throw Error('边缘停顿时间无效');
    next.snapDwellMs = Math.max(80, Math.min(1200, Math.round(patch.snapDwellMs)));
  }
  if (patch.finderTriggers !== undefined) {
    if (!patch.finderTriggers || typeof patch.finderTriggers.middleClick !== 'boolean' || typeof patch.finderTriggers.rightHold !== 'boolean') {
      throw Error('访达鼠标触发设置无效');
    }
    next.finderTriggers = { middleClick: patch.finderTriggers.middleClick, rightHold: patch.finderTriggers.rightHold };
  }
  if (patch.finderTerminal !== undefined) {
    if (!['Terminal', 'Ghostty', 'Warp', 'iTerm'].includes(patch.finderTerminal)) throw Error('终端应用选项无效');
    next.finderTerminal = patch.finderTerminal;
  }
  if (patch.finderEditor !== undefined) {
    if (!['Cursor', 'VSCode', 'Zed'].includes(patch.finderEditor)) throw Error('编辑器选项无效');
    next.finderEditor = patch.finderEditor;
  }
  if (patch.clipboardMaxItems !== undefined) {
    if (typeof patch.clipboardMaxItems !== 'number' || !Number.isInteger(patch.clipboardMaxItems) || patch.clipboardMaxItems < 20 || patch.clipboardMaxItems > 1000) {
      throw Error('剪贴板保留条数需在 20–1000 之间');
    }
    next.clipboardMaxItems = patch.clipboardMaxItems;
  }
  if (patch.nookPrefs !== undefined) {
    const p = patch.nookPrefs;
    if (!p || [p.enabled, p.tasks, p.hubAttention, p.aiResets, p.localAndCustom].some(v => typeof v !== 'boolean')) {
      throw Error('Nook 提醒设置无效');
    }
    next.nookPrefs = { ...p };
  }
  return next;
}
