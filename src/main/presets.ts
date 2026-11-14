import { join } from 'node:path';
import { defaultImageOptions, validImageOptions, imagePromptOptions, type ApiConnection } from '../shared/media';
import { questionTemplate, questionWithoutContext, explanationTemplate, summaryTemplate } from '../shared/prompt-templates';
import { existsSync, readFileSync } from 'node:fs';
import type { Preset, SelectionContext, AppPrompt } from '../shared/contracts';
import { writeFileAtomic } from './files';

const legacyTranslationTemplate = '请翻译以下内容：外文译为中文，中文译为英文。保留原意与格式，只输出译文。\n\n{{selection}}';

export const defaultPresets: Preset[] = [
  { id: 'ask', name: '问 AI', template: questionTemplate, target: 'chatgpt', mode: 'edit', needsSelection: false, enabled: true },
  { id: 'explain', name: '解释', template: explanationTemplate, target: 'chatgpt', mode: 'send', needsSelection: true, enabled: true },
  { id: 'summarize', name: '总结', template: summaryTemplate, target: 'chatgpt', mode: 'send', needsSelection: true, enabled: true },
  { id: 'today', name: '整理今天待办', template: '请使用你已连接的工具，整理我今天的待办和日程，按优先级列出，并注明信息来源。无法访问的信息请直接说明，不要猜测。', target: 'chatgpt', mode: 'edit', needsSelection: false, enabled: true }
];

/** Migrate legacy CLI preset targets ('codex' | 'pi') to 'chatgpt' before validation. */
export function sanitizeLegacyPresetTargets(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map(item => {
    if (!item || typeof item !== 'object') return item;
    const preset = item as Record<string, unknown>;
    if (preset.target === 'codex' || preset.target === 'pi') {
      const { model: _m, effort: _e, ...rest } = preset;
      return { ...rest, target: 'chatgpt' };
    }
    return item;
  });
}

export function validatePresets(value: unknown, connections?: readonly ApiConnection[]): asserts value is Preset[] {
  if (!Array.isArray(value)) throw new Error('预设必须是一个列表');
  const ids = new Set<string>();
  for (const p of value) {
    if (!p || typeof p.id !== 'string' || !p.id || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || typeof p.template !== 'string' || !p.template.trim()
      || !['chatgpt', 'gemini', 'api'].includes(p.target) || !['edit', 'send'].includes(p.mode) || typeof p.needsSelection !== 'boolean' || typeof p.enabled !== 'boolean') {
      throw new Error('请填写名称和提示词，并选择有效的发送方式');
    }
    if ((p.model !== undefined && typeof p.model !== 'string') || (p.effort !== undefined && typeof p.effort !== 'string')) throw new Error('模型与思考强度必须是有效选项');
    if (p.connectionId !== undefined && (typeof p.connectionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(p.connectionId))) throw Error('预设 API 连接标识无效');
    if (p.target === 'api' && p.kind !== 'image' && (!p.connectionId?.trim() || !p.model?.trim())) throw Error(`预设「${p.name}」需要选择 API 连接并填写模型名称`);
    if (p.target === 'api' && connections && !connections.some(connection => connection.id === p.connectionId)) throw Error(`预设「${p.name}」的 API 连接不存在，请重新选择连接`);
    if (p.temporaryChat !== undefined && typeof p.temporaryChat !== 'boolean') throw new Error('网页会话方式无效');
    if (p.kind !== undefined && !['chat', 'image'].includes(p.kind)) throw Error('预设类型无效');
    if (p.kind === 'image' ? !['chatgpt', 'gemini', 'api'].includes(p.image ? p.target : '') || !validImageOptions(p.image!) : p.image !== undefined) throw Error('生图预设配置无效');
    ids.add(p.id);
  }
}

export function readPresets(path: string): Preset[] {
  if (!existsSync(path)) return defaultPresets.map(p => ({ ...p }));
  const value = sanitizeLegacyPresetTargets(JSON.parse(readFileSync(path, 'utf8')));
  validatePresets(value);
  const previous: Record<string, string> = {
    ask: '请结合以下内容回答我的问题：\n\n{{selection}}\n\n我的问题是：',
    explain: '请用通俗的语言解释以下内容，并给出一个简短例子：\n\n{{selection}}',
    summarize: '请总结以下内容，保留重要事实和结论，用简洁的要点呈现：\n\n{{selection}}',
    translate: legacyTranslationTemplate
  };
  return value.map(p => {
    const replacement = defaultPresets.find(item => item.id === p.id);
    if (replacement && p.template === previous[p.id]) return { ...p, template: replacement.template };
    if (p.kind === 'image' && p.id.startsWith('image-preset-') && legacyImageTemplates.includes(p.template)) return { ...p, template: imageTemplate(p.template) };
    return p;
  });
}

export function writePresets(path: string, presets: Preset[], connections?: readonly ApiConnection[]) {
  validatePresets(presets, connections);
  writeFileAtomic(path, JSON.stringify(presets, null, 2) + '\n');
}

export function renderPrompt(preset: Preset, selection: string, appPrompt = '') {
  let template = !selection && preset.template === questionTemplate ? questionWithoutContext : preset.template;
  if (preset.kind === 'image') {
    if (!preset.image!.aspect || preset.image!.customSize) template = template.replace(/(?:，|,)?\s*(?:宽高比|图片比例)\s*\{\{aspect\}\}[。.]?/g, '');
    template = template.replaceAll('{{aspect}}', preset.image!.customSize ? '' : preset.image!.aspect);
  }
  const rendered = template.replaceAll('{{selection}}', () => selection);
  let content = selection && !preset.template.includes('{{selection}}') ? `${rendered}\n\n${selection}` : rendered;
  if (preset.kind === 'image') {
    const options = imagePromptOptions(preset.image!, !preset.template.includes('{{aspect}}'));
    if (options) content += '\n\n' + options;
  }
  return appPrompt.trim() ? `${appPrompt.trim()}\n\n${content}` : content;
}

const legacyImageTemplates = [
  '请直接生成一张图片，宽高比 {{aspect}}。有参考图时结合参考图完成。\n\n{{selection}}',
  '请根据以下内容生成一张清晰、重点突出的配图，宽高比 {{aspect}}。避免添加无关文字。\n\n{{selection}}',
  '请直接修改附带的参考图，保留未要求更改的主体和细节，宽高比 {{aspect}}。修改要求：\n\n{{selection}}'
];
const imageTemplate = (template: string) => template.replace('生成一张', '生成').replace('，宽高比 {{aspect}}', '');

export function composePrompt(preset: Preset, selection: SelectionContext | null, rules: AppPrompt[]) {
  const background = selection?.text ? rules.find(rule => rule.enabled && rule.bundleId === selection.sourceApp)?.prompt || '' : '';
  return renderPrompt(preset, selection?.text || '', background);
}

/** Migrate once, writing the unified presets before retiring the old configuration. */
export function migrateImagePresets(path: string, directory: string): Preset[] {
  const presets = readPresets(path), configPath = join(directory, 'config.json');
  const legacy = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
  if (legacy.schemaVersion === 2 || legacy.schemaVersion === 3) return presets;
  const defaults = [
    { id: 'draw', name: '自由作图', template: '请直接生成一张图片，宽高比 {{aspect}}。有参考图时结合参考图完成。\n\n{{prompt}}' },
    { id: 'illustration', name: '内容配图', template: '请根据以下内容生成一张清晰、重点突出的配图，宽高比 {{aspect}}。避免添加无关文字。\n\n{{prompt}}' },
    { id: 'edit', name: '修改参考图', template: '请直接修改附带的参考图，保留未要求更改的主体和细节，宽高比 {{aspect}}。修改要求：\n\n{{prompt}}' }
  ];
  const options = { ...defaultImageOptions(), ...Object.fromEntries(['generationModel', 'editModel', 'quality', 'background', 'outputFormat'].filter(key => legacy[key] !== undefined).map(key => [key, legacy[key]])) };
  const incoming: Preset[] = (legacy.presets || defaults).map((item: { id: string; name: string; template: string }) => ({
    id: 'image-preset-' + item.id, name: item.name, template: legacyImageTemplates.includes(item.template.replaceAll('{{prompt}}', '{{selection}}')) ? imageTemplate(item.template.replaceAll('{{prompt}}', '{{selection}}')) : item.template.replaceAll('{{prompt}}', '{{selection}}'),
    kind: 'image', target: legacy.destination || 'api', mode: legacy.webMode || 'send', needsSelection: true, enabled: true, image: { ...options }
  }));
  const next = [...presets];
  for (const preset of incoming) {
    const existing = next.find(item => item.id === preset.id);
    if (!existing) next.push(preset);
    else if (existing.kind !== 'image') throw Error('生图预设迁移遇到同名标识，请调整预设标识后重试');
  }
  writePresets(path, next);
  const resultsPath = join(directory, 'results.json');
  if (existsSync(resultsPath)) {
    const saved = JSON.parse(readFileSync(resultsPath, 'utf8'));
    for (const job of saved.jobs || []) if (!job.destination || job.destination === 'api') {
      job.generationModel ??= options.generationModel; job.editModel ??= options.editModel;
      job.connectionId ??= 'conn-legacy-media';
      if (job.presetId && !job.presetId.startsWith('image-preset-')) job.presetId = 'image-preset-' + job.presetId;
    }
    writeFileAtomic(resultsPath, JSON.stringify(saved, null, 2) + '\n');
  }
  const connection = { schemaVersion: 2, baseURL: legacy.baseURL || '', ...(legacy.credential ? { credential: legacy.credential } : {}) };
  writeFileAtomic(configPath, JSON.stringify(connection, null, 2) + '\n');
  return next;
}
