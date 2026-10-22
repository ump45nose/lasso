import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Settings } from '../shared/contracts';
export function readSettings(path: string): Settings {
  if (!existsSync(path)) return { shortcut: '', selectionEnabled: true, clipboardFallback: false };
  const settings = JSON.parse(readFileSync(path, 'utf8')) as Pick<Settings, 'shortcut'> & Partial<Omit<Settings, 'shortcut'>>;
  if (typeof settings.shortcut !== 'string') throw new Error('设置文件中的 shortcut 必须是字符串');
  return { selectionEnabled: true, clipboardFallback: false, ...settings };
}
export function writeSettings(path: string, settings: Settings) {
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
}
