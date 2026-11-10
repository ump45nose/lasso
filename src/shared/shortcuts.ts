import { captureModeLabels, captureModes, type CaptureMode } from './capture';

export type GlobalActionId = CaptureMode | 'repeat-last' | 'custom-capture' | 'scroll-capture' | 'delay-3s' | 'delay-5s' | 'delay-10s' | 'pin-clipboard' | 'open-launcher' | 'open-clipboard-history' | 'open-translator';
export const globalActionIds: GlobalActionId[] = [...captureModes, 'repeat-last', 'custom-capture', 'scroll-capture', 'delay-3s', 'delay-5s', 'delay-10s', 'pin-clipboard', 'open-launcher', 'open-clipboard-history', 'open-translator'];
export const globalActionLabels: Record<GlobalActionId, string> = {
  ...captureModeLabels, 'repeat-last': '重复上次截图', 'custom-capture': '自定义截图', 'scroll-capture': '滚动截图',
  'delay-3s': '延时 3 秒截图', 'delay-5s': '延时 5 秒截图', 'delay-10s': '延时 10 秒截图',
  'pin-clipboard': '贴出剪贴板图片', 'open-launcher': '唤起小窗', 'open-clipboard-history': '剪贴板历史', 'open-translator': '输入翻译'
};
export type EditorActionId = 'text-select' | 'select' | 'arrow' | 'line' | 'rectangle' | 'ellipse' | 'pen' | 'highlight' | 'text' | 'number' | 'redact' | 'mosaic' | 'blur' | 'crop' | 'picker' | 'copy' | 'save' | 'quick-save' | 'pin';
export const editorActionIds: EditorActionId[] = ['text-select', 'select', 'arrow', 'line', 'rectangle', 'ellipse', 'pen', 'highlight', 'text', 'number', 'redact', 'mosaic', 'blur', 'crop', 'picker', 'copy', 'save', 'quick-save', 'pin'];
export const editorActionLabels: Record<EditorActionId, string> = {
  'text-select': '文字选择', select: '对象选择', arrow: '箭头', line: '直线', rectangle: '矩形', ellipse: '椭圆',
  pen: '画笔', highlight: '高亮', text: '文字', number: '序号', redact: '遮挡', mosaic: '马赛克', blur: '模糊',
  crop: '裁剪', picker: '取色', copy: '复制', save: '保存', 'quick-save': '快速保存', pin: '贴图'
};
export type EditorShortcutMap = Record<EditorActionId, string>;
export function defaultEditorShortcuts(): EditorShortcutMap {
  return {
    'text-select': 'O', select: 'V', arrow: 'A', line: 'L', rectangle: 'R', ellipse: 'E', pen: 'P', highlight: 'H',
    text: 'T', number: 'N', redact: 'B', mosaic: 'M', blur: 'U', crop: 'C', picker: 'I', copy: 'Enter',
    save: 'CommandOrControl+S', 'quick-save': 'CommandOrControl+Shift+S', pin: 'F3'
  };
}
export type IgnoredAppScope = 'selection' | 'shortcuts' | 'capture-candidates';
export interface IgnoredAppRule { bundleId: string; name: string; enabled: boolean; scopes: IgnoredAppScope[] }

const modifierAliases: Record<string, string> = { command: 'command', commandorcontrol: 'command', super: 'command', control: 'control', alt: 'alt', option: 'alt', shift: 'shift' };
const modifierOrder = ['command', 'control', 'alt', 'shift'];
const namedKeys = new Set(['space', 'enter', 'tab', 'escape', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right', 'plus', 'minus', 'equal', 'comma', 'period', 'slash', 'backslash', 'semicolon', 'quote', 'backtick', 'bracketleft', 'bracketright']);
const keyAliases: Record<string, string> = { return: 'enter', esc: 'escape', arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right', '-': 'minus', '=': 'equal', ',': 'comma', '.': 'period', '/': 'slash', '\\': 'backslash', ';': 'semicolon', "'": 'quote', '`': 'backtick', '[': 'bracketleft', ']': 'bracketright' };
function shortcutParts(value: string): { modifiers: string[]; key: string } | null {
  const parts = value.toLowerCase().split('+');
  const rawKey = parts.pop()!;
  const key = Object.hasOwn(keyAliases, rawKey) ? keyAliases[rawKey] : rawKey;
  const modifiers = parts.map(part => Object.hasOwn(modifierAliases, part) ? modifierAliases[part] : '');
  if (modifiers.some(part => !part) || new Set(modifiers).size !== modifiers.length ||
    !(/^[a-z0-9]$/.test(key) || /^f(?:[1-9]|1[0-9]|2[0-4])$/.test(key) || namedKeys.has(key))) return null;
  return { modifiers, key };
}
/** macOS aliases and modifier order share one identity for conflict detection. */
export function canonicalShortcut(value: string): string {
  if (!value) return '';
  const parts = shortcutParts(value);
  return parts ? [...modifierOrder.filter(modifier => parts.modifiers.includes(modifier)), parts.key].join('+') : value.toLowerCase();
}
/** Function keys can stand alone; other global keys need a modifier. Empty unbinds. */
export function isValidShortcut(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value) return true;
  const parts = shortcutParts(value);
  return !!parts && (parts.modifiers.length > 0 || /^f\d+$/.test(parts.key));
}
export function validateEditorShortcuts(map: EditorShortcutMap): string | null {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return '编辑器快捷键配置无效';
  const seen = new Map<string, EditorActionId>();
  for (const action of editorActionIds) {
    const value = map[action];
    if (typeof value !== 'string' || (value && !shortcutParts(value))) return `${editorActionLabels[action]}快捷键无效，请使用单键或修饰键组合`;
    if (!value) continue;
    const key = canonicalShortcut(value), other = seen.get(key);
    if (other) return `${editorActionLabels[action]}与${editorActionLabels[other]}快捷键重复`;
    seen.set(key, action);
  }
  return null;
}
