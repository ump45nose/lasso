import type { Tool } from './annotations';
import { canonicalShortcut, defaultEditorShortcuts, editorActionIds, type EditorShortcutMap } from '../../shared/shortcuts';

export const toolKeys = Object.fromEntries(Object.entries({...defaultEditorShortcuts(),spotlight:'',magnifier:'',watermark:'','auto-mosaic':'',inpaint:''}).filter(([id])=>!['copy','save','quick-save','pin'].includes(id))) as Record<Tool,string>;
export const toolForKey = (key: string, shortcuts: EditorShortcutMap=defaultEditorShortcuts()) => (Object.keys(toolKeys) as Tool[]).find(tool => (shortcuts as Partial<Record<Tool,string>>)[tool]&&canonicalShortcut((shortcuts as Partial<Record<Tool,string>>)[tool]!)===canonicalShortcut(key));
export function editorActionForEvent(event: Pick<KeyboardEvent,'key'|'metaKey'|'ctrlKey'|'altKey'|'shiftKey'> & Partial<Pick<KeyboardEvent,'code'>>, shortcuts:EditorShortcutMap=defaultEditorShortcuts()) {
  const code=(event.code||event.key).replace(/^(Key|Digit|Arrow)/,'').replace(/^Backquote$/,'Backtick').replace(/^NumpadEnter$/,'Enter');
  const key=canonicalShortcut([event.metaKey?'Command':'',event.ctrlKey?'Control':'',event.altKey?'Alt':'',event.shiftKey?'Shift':'',code===' '?'Space':code].filter(Boolean).join('+'));
  return editorActionIds.find(action=>shortcuts[action]&&canonicalShortcut(shortcuts[action])===key);
}
