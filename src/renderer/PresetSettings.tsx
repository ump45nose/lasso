import { defaultImageOptions } from '../shared/media';
import { ImageOptionsFields } from './ImageOptionsFields';
import { promptSources } from '../shared/prompt-templates';
import { Fragment, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { Check, ChevronLeft, GripVertical, Plus, Trash2 } from 'lucide-react';
import { ExecutionFields } from './ExecutionFields';
import { presetTargetLabels as targetLabels } from '../shared/contracts';
import type { Preset } from '../shared/contracts';
import { targets } from './targets';
import { Segmented, rise, spring } from './motion';

const BAR_SIZE = 4;
const preview = (template: string) => template.replace(/\s+/g, ' ').split('{{selection}}');

/** Order and on/off save immediately; content edits go through the editor's save bar. */
export function PresetSettings({ presets }: { presets: Preset[] }) {
  const [editing, setEditing] = useState<Preset | null>(null);
  const [error, setError] = useState('');
  const drag = useRef<string | null>(null);
  const [drop, setDrop] = useState<string | null>(null);
  async function save(next: Preset[]) { const r = await window.desktop.savePresets(next); setError(r.error || ''); return !r.error; }
  function move(id: string, to: number) {
    const from = presets.findIndex(p => p.id === id);
    if (from < 0 || to < 0 || to >= presets.length || from === to) return;
    const next = [...presets]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); void save(next);
  }
  const bar: Preset[] = [], more: Preset[] = [];
  for (const preset of presets) (preset.enabled && bar.length < BAR_SIZE ? bar : more).push(preset);
  const row = (preset: Preset) => <motion.li key={preset.id} layout="position" layoutId={preset.id} transition={spring} className={'l-preset-row' + (preset.enabled ? '' : ' l-off')} data-drop={drop === preset.id} draggable onDragStart={() => { drag.current = preset.id; }} onDragOver={e => { e.preventDefault(); if (drag.current !== preset.id) setDrop(preset.id); }} onDragLeave={() => setDrop(null)} onDragEnd={() => { drag.current = null; setDrop(null); }}
    onDrop={() => { if (drag.current) move(drag.current, presets.indexOf(preset)); drag.current = null; setDrop(null); }}>
    <span className="l-grip" aria-hidden="true"><GripVertical size={14} /></span>
    <button className="l-preset" aria-label={`编辑 ${preset.name}，⌥↑↓ 调整顺序`} onClick={() => setEditing(preset)}
      onKeyDown={e => { if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(preset.id, presets.indexOf(preset) + (e.key === 'ArrowUp' ? -1 : 1)); } }}>
      <strong>{preset.name || '未命名'}{!preset.needsSelection && <span className="tag">无需选区</span>}{!preset.enabled && <span className="tag">已停用</span>}</strong>
      <span>{preview(preset.template).map((part, i) => <Fragment key={i}>{i > 0 && <span className="l-placeholder-chip">选区</span>}{part}</Fragment>)}</span>
    </button>
    <span className="l-row-meta">{targetLabels[preset.target]} · {preset.mode === 'edit' ? '先编辑' : '直接发送'}</span>
    <button className="l-switch" role="switch" aria-checked={preset.enabled} aria-label={'启用 ' + preset.name} onClick={() => void save(presets.map(p => p.id === preset.id ? { ...p, enabled: !p.enabled } : p))}><span /></button>
  </motion.li>;
  return <AnimatePresence mode="wait" initial={false}>{editing ? <motion.div key={editing.id} className="l-view" {...rise}><PresetEditor key={editing.id} preset={editing} isNew={!presets.some(p => p.id === editing.id)} back={() => setEditing(null)}
    save={preset => save(presets.some(p => p.id === preset.id) ? presets.map(p => p.id === preset.id ? preset : p) : [...presets, preset])}
    remove={async id => { if (await save(presets.filter(p => p.id !== id))) setEditing(null); }} error={error} /></motion.div> : <motion.div key="presets" className="l-view" {...rise}><LayoutGroup id="preset-order"><div className="l-set-body">
    <div className="l-set-row-head"><h3>动作条 · 前 {BAR_SIZE} 个</h3><span>拖动或 ⌥↑↓ 调整顺序，点开编辑</span></div>
    {bar.length ? <ul className="l-group">{bar.map(row)}</ul> : <p className="l-field-help">启用一个预设后，它会出现在动作条上。</p>}
    {more.length > 0 && <><div className="l-set-row-head l-gap"><h3>更多菜单</h3><span>动作条「···」与指令面板</span></div><ul className="l-group">{more.map(row)}</ul></>}
    {error && <p className="l-field-help error" role="alert">{error}</p>}
    <button className="l-add" onClick={() => setEditing({ id: crypto.randomUUID(), name: '新预设', template: '{{selection}}', target: 'chatgpt', mode: 'edit', needsSelection: true, enabled: true })}><Plus size={14} />新建预设</button>
  </div></LayoutGroup></motion.div>}</AnimatePresence>;
}

function PresetEditor({ preset, isNew, save, remove, back, error }: { preset: Preset; isNew: boolean; save(preset: Preset): Promise<boolean>; remove(id: string): Promise<void>; back(): void; error: string }) {
  const [draft, setDraft] = useState(preset);
  const [base, setBase] = useState(isNew ? null : preset);
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState<'delete' | 'leave' | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);
  const source = promptSources.find(source => source.template === draft.template);
  const set = (changes: Partial<Preset>) => { setDraft(old => ({ ...old, ...changes })); setSaved(false); setConfirm(null); };
  function insert() {
    const el = area.current!, at = el.selectionStart;
    set({ template: draft.template.slice(0, at) + '{{selection}}' + draft.template.slice(el.selectionEnd) });
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(at + 13, at + 13); });
  }
  async function commit() { if (await save(draft)) { setBase(draft); setSaved(true); } }
  return <>
    <div className="l-editor-head"><button className="l-text-btn l-back" onClick={() => dirty && confirm !== 'leave' ? setConfirm('leave') : back()}><ChevronLeft size={14} />{confirm === 'leave' ? '再点一次放弃更改' : '全部预设'}</button></div>
    <div className="l-set-body l-editor">
      <div className="l-field"><span className="l-field-label">功能</span><Segmented label="预设功能" value={draft.kind || 'chat'} onChange={kind => { if (kind === (draft.kind || 'chat')) return; set({ kind, ...(kind === 'image' && isNew && draft.template === '{{selection}}' ? { name: '图片生成', template: '请直接生成图片。有参考图时结合参考图完成。\n\n{{selection}}' } : {}), image: kind === 'image' ? defaultImageOptions() : undefined, target: kind === 'image' ? (draft.target === 'gemini' ? 'gemini' : 'chatgpt') : draft.target === 'api' ? 'chatgpt' : draft.target, model: '', effort: '' }); }} options={ [['chat', '提问'], ['image', '图片生成']] } /></div>
      <div className="l-field"><label htmlFor="preset-name">名称</label><input id="preset-name" className="l-input" value={draft.name} onChange={e => set({ name: e.target.value })} /></div>
      <div className="l-field">
        <div className="l-field-row"><label htmlFor="preset-template" className="l-field-label">提示词</label><button className="l-btn small" onClick={insert}>插入选区位置</button></div>
        <textarea id="preset-template" ref={area} className="l-textarea" rows={6} value={draft.template} onChange={e => set({ template: e.target.value })} spellCheck={false} />
        {source && <button className="l-text-btn l-prompt-source" onClick={() => void window.desktop.openLink(source.url)}>来源：{source.name}</button>}
        <p className="l-field-help"><span className="mono">{'{{selection}}'}</span> 处放选中文字；没有这个位置时，选中文字附在末尾。应用背景会放在最前面。{draft.kind === 'image' && <>用 <span className="mono">{'{{aspect}}'}</span> 插入图片比例。</>}</p>
      </div>
      <div className="l-field"><span className="l-field-label">目标</span>
        <Segmented label="目标" value={draft.target} onChange={target => set({ target, model: '', effort: '', ...(['codex', 'pi', 'api'].includes(target) ? { temporaryChat: undefined } : {}) })} options={(draft.kind === 'image' ? ['chatgpt', 'gemini', 'api'] as const : targets).map(id => [id, targetLabels[id]] as const)} /></div>
      {(draft.target === 'chatgpt' || draft.target === 'gemini') && <div className="l-field">
        <span className="l-field-label">网页会话</span>
        <Segmented label="网页会话" value={draft.temporaryChat ? 'temporary' : 'normal'} onChange={mode => set({ temporaryChat: mode === 'temporary' ? true : undefined })} options={[['normal', '普通提问'], ['temporary', '临时提问']]} />
        {draft.temporaryChat && <p className="l-field-help">不进入网页历史；标签保持驻留，关闭或重载后无法恢复。{draft.target === 'gemini' && '需要个人 Google 账号，临时对话不能使用关联应用。'}</p>}
      </div>}
      {draft.target !== 'api' && <ExecutionFields key={draft.target + '-execution'} target={draft.target} profile={draft} update={set} />}
      {draft.kind === 'image' && <ImageOptionsFields key={draft.target + '-image'} value={draft.image!} update={image => set({ image })} api={draft.target === 'api'} />}
      <div className="l-field"><span className="l-field-label">执行方式</span>
        <Segmented label="执行方式" value={draft.mode} onChange={mode => set({ mode })} options={[['edit', '先填入，再编辑'], ['send', '填入后直接发送']]} /></div>
      <ul className="l-group">
        <li><div className="l-row-label"><span>需要内容</span><span>没有选中文字或图片时，这个预设不可用</span></div><button className="l-switch" role="switch" aria-checked={draft.needsSelection} aria-label="需要内容" onClick={() => set({ needsSelection: !draft.needsSelection })}><span /></button></li>
        <li><div className="l-row-label"><span>启用</span><span>停用后不出现在动作条和指令面板</span></div><button className="l-switch" role="switch" aria-checked={draft.enabled} aria-label="启用预设" onClick={() => set({ enabled: !draft.enabled })}><span /></button></li>
      </ul>
      {!isNew && <button className="l-btn danger l-quit" onClick={() => confirm === 'delete' ? void remove(preset.id) : setConfirm('delete')}><Trash2 size={14} />{confirm === 'delete' ? `再点一次删除「${preset.name}」` : '删除预设'}</button>}
    </div>
    {(dirty || saved || error) && <div className="l-save-bar" role="status">
      {error ? <span className="l-danger">{error}</span> : saved && !dirty ? <span className="l-ok"><Check size={14} />已保存</span> : isNew && !base ? '新预设尚未保存' : '有未保存的更改'}
      <span className="push" />
      {dirty && <><button className="l-btn small" onClick={() => base ? setDraft(base) : back()}>放弃</button>
        <button className="l-btn small primary" disabled={!draft.name.trim() || !draft.template.trim()} onClick={() => void commit()}>保存预设</button></>}
    </div>}
  </>;
}
