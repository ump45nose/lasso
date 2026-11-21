import { useEffect } from 'react';
import type { Appearance, FontRole, Settings } from '../shared/contracts';
import { setIconStyle } from './icons';

export const fontRoles: FontRole[] = ['display', 'text', 'ui', 'mono'];
/** Bundled faces always available behind the configured family. */
export const builtinFonts = ['Anthropic Sans', 'Anthropic Serif Text', 'Newsreader Variable', 'JetBrains Mono'];
const fallback = (role: FontRole) => role === 'mono' ? 'var(--mono-fallback)' : role === 'ui' ? 'var(--sans-fallback)' : 'var(--serif-fallback)';
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
/** Applies the shared look (font roles + icon style) to this window. */
export function useAppearance(value: Appearance | undefined) {
  const key = value && JSON.stringify([value.fonts, value.importedFonts, value.iconStyle]);
  useEffect(() => {
    if (!value) return;
    setIconStyle(value.iconStyle);
    void loadImported(value.importedFonts);
    for (const role of fontRoles) if (value.fonts[role]) document.documentElement.style.setProperty('--font-' + role, fontStack(role, value.fonts[role]));
  }, [key]);
}
