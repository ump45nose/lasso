import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { defaultFonts, type Settings } from '../shared/contracts';
export function defaultSettings(): Settings {
  const executable = (name: string) => ['/opt/homebrew/bin/', '/usr/local/bin/'].map(p => p + name).find(existsSync) || '';
  return { shortcut: '', captureShortcuts: { area: '', window: '', screen: '', front: '' }, lastTarget: 'chatgpt', selectionEnabled: true, clipboardFallback: false, appPrompts: [], local: {
    codex: { executable: executable('codex'), cwd: homedir() }, pi: { executable: executable('pi'), cwd: homedir() }
  }, fonts: { ...defaultFonts }, importedFonts: [] };
}
export function readSettings(path: string): Settings {
  if (!existsSync(path)) return defaultSettings();
  // Before capture modes existed, the area shortcut was stored as `screenshotShortcut`.
  const { screenshotShortcut, ...settings } = JSON.parse(readFileSync(path, 'utf8')) as Pick<Settings, 'shortcut'> & Partial<Omit<Settings, 'shortcut'>> & { screenshotShortcut?: string };
  if (typeof settings.shortcut !== 'string') throw new Error('设置文件中的 shortcut 必须是字符串');
  const defaults = defaultSettings();
  return { ...defaults, ...settings, captureShortcuts: { ...defaults.captureShortcuts, ...(typeof screenshotShortcut === 'string' ? { area: screenshotShortcut } : {}), ...settings.captureShortcuts }, fonts: { ...defaults.fonts, ...settings.fonts }, lastTarget: ['chatgpt', 'gemini', 'codex', 'pi'].includes(settings.lastTarget || '') ? settings.lastTarget! : 'chatgpt' };
}
export function writeSettings(path: string, settings: Settings) {
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
}
