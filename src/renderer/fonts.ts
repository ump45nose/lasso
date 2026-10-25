import { useEffect } from 'react';
import type { FontRole, Settings } from '../shared/contracts';

export const fontRoles: FontRole[] = ['display', 'text', 'ui', 'mono'];
/** Bundled faces always available behind the configured family. */
export const builtinFonts = ['Newsreader Variable', 'JetBrains Mono'];
const fallback = (role: FontRole) => role === 'mono' ? 'var(--mono-fallback)' : 'var(--serif-fallback)';
export const fontStack = (role: FontRole, family: string) => `"${family}", ${fallback(role)}`;
export const fontUrl = (file: string) => `lasso-font://fonts/${encodeURIComponent(file)}`;

const loaded = new Map<string, Promise<void>>();
/** Imported files register under their recorded family so the stack can name them. */
export function loadImported(fonts: Settings['importedFonts']) {
  return Promise.all(fonts.map(font => {
    let pending = loaded.get(font.file);
    if (!pending) {
      const face = new FontFace(font.family, `url("${fontUrl(font.file)}")`);
      pending = face.load().then(ready => { document.fonts.add(ready); }, error => { loaded.delete(font.file); console.warn('[fonts]', font.file, error); });
      loaded.set(font.file, pending);
    }
    return pending;
  }));
}
export function useFonts(value: Pick<Settings, 'fonts' | 'importedFonts'> | undefined) {
  const key = value && JSON.stringify(value);
  useEffect(() => {
    if (!value) return;
    void loadImported(value.importedFonts);
    for (const role of fontRoles) if (value.fonts[role]) document.documentElement.style.setProperty('--font-' + role, fontStack(role, value.fonts[role]));
  }, [key]);
}
