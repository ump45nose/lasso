import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Preset, SelectionContext, AppPrompt } from '../shared/contracts';
export const defaultPresets: Preset[] = [
  { id: 'ask', name: '问 AI', template: '请结合以下内容回答我的问题：\n\n{{selection}}\n\n我的问题是：', target: 'chatgpt', mode: 'edit', needsSelection: false, enabled: true },
  { id: 'explain', name: '解释', template: '请用通俗的语言解释以下内容，并给出一个简短例子：\n\n{{selection}}', target: 'chatgpt', mode: 'send', needsSelection: true, enabled: true },
  { id: 'summarize', name: '总结', template: '请总结以下内容，保留重要事实和结论，用简洁的要点呈现：\n\n{{selection}}', target: 'chatgpt', mode: 'send', needsSelection: true, enabled: true },
  { id: 'translate', name: '翻译', template: '请翻译以下内容：外文译为中文，中文译为英文。保留原意与格式，只输出译文。\n\n{{selection}}', target: 'chatgpt', mode: 'send', needsSelection: true, enabled: true },
  { id: 'today', name: '整理今天待办', template: '请使用你已连接的工具，整理我今天的待办和日程，按优先级列出，并注明信息来源。无法访问的信息请直接说明，不要猜测。', target: 'chatgpt', mode: 'edit', needsSelection: false, enabled: true }
];
export function validatePresets(value: unknown): asserts value is Preset[] {
  if (!Array.isArray(value)) throw new Error('预设必须是一个列表');
  const ids = new Set<string>();
  for (const p of value) {
    if (!p || typeof p.id !== 'string' || !p.id || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || typeof p.template !== 'string' || !p.template.trim()
      || !['chatgpt', 'gemini', 'codex', 'pi'].includes(p.target) || !['edit', 'send'].includes(p.mode) || typeof p.needsSelection !== 'boolean' || typeof p.enabled !== 'boolean') {
      throw new Error('请填写名称和提示词，并选择有效的发送方式');
    }
    if ((p.model !== undefined && typeof p.model !== 'string') || (p.effort !== undefined && typeof p.effort !== 'string')) throw new Error('模型与思考强度必须是有效选项');
    ids.add(p.id);
  }
}
export function readPresets(path: string): Preset[] {
  if (!existsSync(path)) return defaultPresets.map(p => ({ ...p }));
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  validatePresets(value);
  return value;
}
export function writePresets(path: string, presets: Preset[]) {
  validatePresets(presets);
  writeFileSync(path, JSON.stringify(presets, null, 2) + '\n');
}
export function renderPrompt(preset: Preset, selection: string, appPrompt = '') {
  const rendered = preset.template.replaceAll('{{selection}}', () => selection);
  const content = selection && !preset.template.includes('{{selection}}') ? `${rendered}\n\n${selection}` : rendered;
  return appPrompt.trim() ? `${appPrompt.trim()}\n\n${content}` : content;
}

export function composePrompt(preset: Preset, selection: SelectionContext | null, rules: AppPrompt[]) {
  const background = selection?.text ? rules.find(rule => rule.enabled && rule.bundleId === selection.sourceApp)?.prompt || '' : '';
  return renderPrompt(preset, selection?.text || '', background);
}
