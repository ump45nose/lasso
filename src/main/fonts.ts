import { protocol } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { FontRole, ImportedFont, Settings } from '../shared/contracts';

export const FONT_SCHEME = 'lasso-font';
const types: Record<string, string> = { '.otf': 'font/otf', '.ttf': 'font/ttf', '.ttc': 'font/collection', '.woff': 'font/woff', '.woff2': 'font/woff2' };
export const fontExtensions = Object.keys(types).map(ext => ext.slice(1));

/** Must run before app ready so imported fonts load like any secure web font. */
export function registerFontScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: FONT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
}
/** Serves only files directly inside the imported fonts directory. */
export function serveFonts(dir: string) {
  protocol.handle(FONT_SCHEME, async request => {
    const name = decodeURIComponent(new URL(request.url).pathname.slice(1));
    const type = types[extname(name).toLowerCase()];
    if (!type || basename(name) !== name) return new Response(null, { status: 404 });
    try { return new Response(await readFile(join(dir, name)), { headers: { 'content-type': type, 'access-control-allow-origin': '*' } }); }
    catch { return new Response(null, { status: 404 }); }
  });
}

/** Reads the family from an OpenType/TrueType name table; compressed WOFF files have none to read. */
export function readFamily(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;
  const base = buffer.readUInt32BE(0) === 0x74746366 ? buffer.readUInt32BE(12) : 0;
  const signature = buffer.readUInt32BE(base);
  if (signature !== 0x00010000 && signature !== 0x4F54544F && signature !== 0x74727565) return null;
  const tables = buffer.readUInt16BE(base + 4);
  for (let i = 0; i < tables; i++) {
    const record = base + 12 + 16 * i;
    if (buffer.readUInt32BE(record) !== 0x6E616D65) continue;
    const offset = buffer.readUInt32BE(record + 8), count = buffer.readUInt16BE(offset + 2), strings = offset + buffer.readUInt16BE(offset + 4);
    const names: Record<number, string> = {};
    for (let j = 0; j < count; j++) {
      const entry = offset + 6 + 12 * j, platform = buffer.readUInt16BE(entry), id = buffer.readUInt16BE(entry + 6);
      if ((platform !== 0 && platform !== 3) || names[id]) continue;
      const length = buffer.readUInt16BE(entry + 8), start = strings + buffer.readUInt16BE(entry + 10);
      let text = '';
      for (let k = 0; k < length; k += 2) text += String.fromCharCode(buffer.readUInt16BE(start + k));
      names[id] = text;
    }
    return (names[16] || names[1] || '').trim() || null;
  }
  return null;
}

/** Copies a font into the app's fonts directory without overwriting an earlier import. */
export function importFont(dir: string, source: string): ImportedFont {
  const ext = extname(source).toLowerCase();
  if (!types[ext]) throw new Error('只支持 .otf、.ttf、.ttc、.woff、.woff2 字体文件。');
  let family: string | null = null;
  try { family = readFamily(readFileSync(source)); } catch { /* A malformed name table falls back to the file name. */ }
  family ||= basename(source, extname(source));
  mkdirSync(dir, { recursive: true });
  const stem = basename(source, extname(source)).replace(/[^\w.-]+/g, '-') || 'font';
  let file = stem + ext;
  for (let n = 2; existsSync(join(dir, file)); n++) file = `${stem}-${n}${ext}`;
  copyFileSync(source, join(dir, file));
  return { family, file };
}
export function removeFont(dir: string, file: string) {
  if (basename(file) !== file || !types[extname(file).toLowerCase()]) throw new Error('无效的字体文件名。');
  rmSync(join(dir, file), { force: true });
}
export function validateFonts(value: unknown): asserts value is Settings['fonts'] {
  const roles: FontRole[] = ['display', 'text', 'ui', 'mono'];
  if (!value || typeof value !== 'object' || roles.some(role => {
    const family = (value as Record<string, unknown>)[role];
    return typeof family !== 'string' || !family.trim() || family.length > 120 || /["'\\;{}\n]/.test(family);
  })) throw new Error('字体名称无效。');
}
