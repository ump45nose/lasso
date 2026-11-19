import { clipboard, ClipboardItem } from 'electron';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import type { NativeAx } from './native-ax';
import { normalizeTranslationMarkdown } from '../shared/translation-markdown';

const converter = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
converter.use(gfm);
converter.remove(['script', 'style', 'iframe', 'object']);

export function selectionMarkdown(text: string, html: string): string {
  const raw = html.trim() ? converter.turndown(html) || text : text;
  return normalizeTranslationMarkdown(raw);
}

const HTML_MIME_TYPES = [
  'text/html',
  'electron application/osclipboard;format="public.html"',
  'electron application/osclipboard;format="Apple HTML pasteboard type"'
];

async function readClipboardItemText(items: ClipboardItem[], types: string | readonly string[]): Promise<string> {
  const candidates = typeof types === 'string' ? [types] : types;
  for (const type of candidates) {
    const item = items.find(entry => entry.types.includes(type));
    if (!item) continue;
    try {
      const data = await item.getType(type);
      if (data && 'text' in data) {
        const text = await data.text();
        if (text) return text;
      }
    } catch {
      // Try next candidate representation.
    }
  }
  return '';
}

/** Read current clipboard as Markdown when rich HTML is available. */
export async function readClipboardMarkdown(): Promise<string> {
  const items = await clipboard.read();
  const [text, html] = await Promise.all([
    readClipboardItemText(items, 'text/plain'),
    readClipboardItemText(items, HTML_MIME_TYPES)
  ]);
  return selectionMarkdown(text, html);
}

async function snapshotClipboard(items: ClipboardItem[]): Promise<ClipboardItem[]> {
  const snapshot: ClipboardItem[] = [];
  for (const item of items) {
    const entries: [string, unknown][] = [];
    for (const type of item.types) {
      try {
        entries.push([type, await item.getType(type)]);
      } catch {
        // Ignore unreadable pasteboard representations instead of aborting rich copy.
      }
    }
    if (!entries.length) continue;
    try {
      snapshot.push(new ClipboardItem(Object.fromEntries(entries) as Record<string, string | Blob>));
    } catch {
      const safe = entries.filter(([type]) => type === 'text/plain' || type === 'text/html' || type.startsWith('image/'));
      if (safe.length) {
        try {
          snapshot.push(new ClipboardItem(Object.fromEntries(safe) as Record<string, string | Blob>));
        } catch {
          // Best-effort snapshot fallback.
        }
      }
    }
  }
  return snapshot;
}

/** Explicit translation only: copy the selected rich text and restore every clipboard format. */
export async function readSelectionMarkdown(pid: number, ax: Partial<NativeAx>): Promise<string | null> {
  const before = ax.pasteboardMeta?.();
  if (!before || before.concealed || !ax.copySelectionToProcess || ax.frontmostApp?.().pid !== pid) return null;
  const items = await clipboard.read();
  const snapshot = await snapshotClipboard(items);
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
        const [text, html] = await Promise.all([
          readClipboardItemText(copied, 'text/plain'),
          readClipboardItemText(copied, HTML_MIME_TYPES)
        ]);
        if (ax.pasteboardMeta?.().changeCount !== copiedCount) return null;
        return selectionMarkdown(text, html) || null;
      }
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    return null;
  } finally {
    // Another user copy wins over restoration of our earlier snapshot.
    if (copiedCount !== null && ax.pasteboardMeta?.().changeCount === copiedCount) {
      try {
        if (snapshot.length) await clipboard.write(snapshot);
        else clipboard.clear();
      } catch {
        // Never discard an extracted Markdown result if clipboard restoration rejects.
      }
    }
  }
}
