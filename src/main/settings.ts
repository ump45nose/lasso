import { app } from 'electron';
import { join } from 'node:path';
import { migrateScreenshotSettings, screenshotDefaults } from '../shared/screenshot-settings';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { defaultFonts, type Settings } from '../shared/contracts';
import { memoryDefaults, validMemorySettings } from '../shared/memory';
import { captureModes } from '../shared/capture';
import { defaultEditorShortcuts } from '../shared/shortcuts';

/** New action entries win; absent entries migrate from their legacy aliases. */
function syncActionShortcuts(settings: Settings): Settings {
  const actionShortcuts = { ...settings.actionShortcuts };
  actionShortcuts['open-launcher'] ??= settings.shortcut;
  for (const mode of captureModes) actionShortcuts[mode] ??= settings.captureShortcuts[mode];
  settings.actionShortcuts = actionShortcuts;
  settings.shortcut = actionShortcuts['open-launcher'];
  settings.captureShortcuts = Object.fromEntries(captureModes.map(mode => [mode, actionShortcuts[mode]])) as Settings['captureShortcuts'];
  return settings;
}
export function defaultSettings(): Settings {
  const executable = (name: string) => ['/opt/homebrew/bin/', '/usr/local/bin/'].map(p => p + name).find(existsSync) || '';
  return syncActionShortcuts({ memory: memoryDefaults(), screenshot: screenshotDefaults(join(app.getPath('pictures'), 'Lasso')), shortcut: '', captureShortcuts: { rect: '', area: '', window: '', screen: '', front: '' }, actionShortcuts: {}, editorShortcuts: defaultEditorShortcuts(), ignoredApps: [], lastTarget: 'chatgpt', selectionEnabled: true, clipboardFallback: false, appPrompts: [], local: {
    codex: { executable: executable('codex'), cwd: homedir() }, pi: { executable: executable('pi'), cwd: homedir() }
  }, fonts: { ...defaultFonts }, importedFonts: [] });
}
export function readSettings(path: string): Settings {
  if (!existsSync(path)) return defaultSettings();
  // Before capture modes existed, the area shortcut was stored as `screenshotShortcut`.
  const { screenshotShortcut, ...settings } = JSON.parse(readFileSync(path, 'utf8')) as Partial<Settings> & { screenshotShortcut?: string };
  if (settings.shortcut !== undefined && typeof settings.shortcut !== 'string') throw new Error('设置文件中的 shortcut 必须是字符串');
  const defaults = defaultSettings();
  settings.memory = validMemorySettings(settings.memory!) ? settings.memory : defaults.memory;
  return syncActionShortcuts({
    ...defaults, ...settings,
    screenshot: migrateScreenshotSettings(settings.screenshot, defaults.screenshot.directory),
    captureShortcuts: { ...defaults.captureShortcuts, ...(typeof screenshotShortcut === 'string' ? { area: screenshotShortcut } : {}), ...settings.captureShortcuts },
    // Do not copy the defaults' alias entries before migrating a legacy file.
    actionShortcuts: { ...settings.actionShortcuts },
    editorShortcuts: { ...defaults.editorShortcuts, ...settings.editorShortcuts },
    ignoredApps: settings.ignoredApps ?? defaults.ignoredApps,
    fonts: { ...defaults.fonts, ...settings.fonts },
    lastTarget: ['chatgpt', 'gemini', 'codex', 'pi'].includes(settings.lastTarget || '') ? settings.lastTarget! : 'chatgpt'
  });
}
export function writeSettings(path: string, settings: Settings) {
  writeFileSync(path, JSON.stringify(syncActionShortcuts(settings), null, 2) + '\n');
}
