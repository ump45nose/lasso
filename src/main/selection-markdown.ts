import { clipboard, ClipboardItem } from 'electron';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import type { NativeAx } from './native-ax';
import { normalizeTranslationMarkdown } from '../shared/translation-markdown';

const converter = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
converter.use(gfm);
converter.remove(['script', 'style', 'iframe', 'object']);

export function selectionMarkdown(text: string, html: string): string {
  return normalizeTranslationMarkdown(html.trim() ? converter.turndown(html) || text : text);
}

/** Explicit translation only: copy the selected rich text and restore every clipboard format. */
export async function readSelectionMarkdown(pid: number, ax: Partial<NativeAx>): Promise<string | null> {
  const before = ax.pasteboardMeta?.();
  if (!before || before.concealed || !ax.copySelectionToProcess || ax.frontmostApp?.().pid !== pid) return null;
  const items = await clipboard.read();
  const snapshot = await Promise.all(items.map(async item => new ClipboardItem(Object.fromEntries(
    await Promise.all(item.types.map(async type => [type, await item.getType(type)]))
  ))));
  if (ax.pasteboardMeta?.().changeCount !== before.changeCount || ax.frontmostApp?.().pid !== pid) return null;

  let copiedCount: number | null = null;
  try {
    if (!ax.copySelectionToProcess(pid)) return null;
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      const current = ax.pasteboardMeta?.();
      if (current && current.changeCount !== before.changeCount) {
        copiedCount = current.changeCount;
        if (current.concealed || ax.frontmostApp?.().pid !== pid) return null;
        const copied = await clipboard.read();
        const read = async (type: string) => {
          const item = copied.find(item => item.types.includes(type));
          const data = item ? await item.getType(type) : null;
          return data && 'text' in data ? data.text() : '';
        };
        const [text, html] = await Promise.all([read('text/plain'), read('text/html')]);
        if (ax.pasteboardMeta?.().changeCount !== copiedCount) return null;
        return selectionMarkdown(text, html) || null;
      }
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    return null;
  } finally {
    // Another user copy wins over restoration of our earlier snapshot.
    if (copiedCount !== null && ax.pasteboardMeta?.().changeCount === copiedCount) {
      if (snapshot.length) await clipboard.write(snapshot);
      else clipboard.clear();
    }
  }
}
