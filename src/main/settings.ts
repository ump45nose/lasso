import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Settings } from '../shared/contracts';
export const defaultFonts: Settings['fonts'] = { display: 'Anthropic Serif Text', text: 'Anthropic Serif Text', ui: 'Anthropic Serif Text', mono: 'JetBrains Mono' };
export function defaultSettings(): Settings {
  const executable = (name: string) => ['/opt/homebrew/bin/', '/usr/local/bin/'].map(p => p + name).find(existsSync) || '';
  return { shortcut: '', screenshotShortcut: '', lastTarget: 'chatgpt', selectionEnabled: true, clipboardFallback: false, appPrompts: [], local: {
    codex: { executable: executable('codex'), cwd: homedir() }, pi: { executable: executable('pi'), cwd: homedir() }
  }, fonts: { ...defaultFonts }, importedFonts: [] };
}
export function readSettings(path: string): Settings {
  if (!existsSync(path)) return defaultSettings();
  const settings = JSON.parse(readFileSync(path, 'utf8')) as Pick<Settings, 'shortcut'> & Partial<Omit<Settings, 'shortcut'>>;
  if (typeof settings.shortcut !== 'string') throw new Error('设置文件中的 shortcut 必须是字符串');
  const defaults = defaultSettings();
  return { ...defaults, ...settings, fonts: { ...defaults.fonts, ...settings.fonts }, lastTarget: ['chatgpt', 'gemini', 'codex', 'pi'].includes(settings.lastTarget || '') ? settings.lastTarget! : 'chatgpt' };
}
export function writeSettings(path: string, settings: Settings) {
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
}
