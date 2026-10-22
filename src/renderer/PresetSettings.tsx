import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, Check } from 'lucide-react';
import type { Preset } from '../shared/contracts';
export function PresetSettings({ presets }: { presets: Preset[] }) {
  const [items, setItems] = useState(() => presets.map(p => ({ ...p })));
  const [selected, setSelected] = useState(presets[0]?.id || '');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const savedPresets = JSON.stringify(presets);
  useEffect(() => { setItems(JSON.parse(savedPresets) as Preset[]); }, [savedPresets]);
  const preset = items.find(p => p.id === selected);
  const index = items.findIndex(p => p.id === selected);
  const update = (changes: Partial<Preset>) => { setItems(items.map(p => p.id === selected ? { ...p, ...changes } : p)); setMessage(''); setError(''); };
  const move = (direction: number) => {
    const next = [...items]; [next[index], next[index + direction]] = [next[index + direction], next[index]];
    setItems(next); setMessage('');
  };
  async function save() {
    const result = await window.desktop.savePresets(items);
    setError(result.error || ''); setMessage(result.error ? '' : '已保存');
  }
  return <section className="preset-settings">
    <div className="preset-list" aria-label="预设列表">
      {items.map(p => <button key={p.id} className={p.id === selected ? 'selected' : ''} onClick={() => setSelected(p.id)}>{p.name || '未命名'}{!p.enabled && <small> · 已停用</small>}</button>)}
      <button className="add-preset" onClick={() => {
        const p: Preset = { id: crypto.randomUUID(), name: '新预设', template: '{{selection}}', mode: 'edit', target: 'chatgpt', enabled: true, needsSelection: true };
        setItems([...items, p]); setSelected(p.id); setMessage('');
      }}><Plus size={14} /> 新建</button>
    </div>
    {preset ? <div className="preset-form">
      <div className="preset-heading"><span className="eyebrow">ChatGPT 网页</span><div className="preset-tools">
        <button title="前移" aria-label="前移预设" disabled={index === 0} onClick={() => move(-1)}><ArrowUp size={15} /></button>
        <button title="后移" aria-label="后移预设" disabled={index === items.length - 1} onClick={() => move(1)}><ArrowDown size={15} /></button>
        <button title="删除" aria-label="删除预设" onClick={() => { const rest = items.filter(p => p.id !== selected); setItems(rest); setSelected(rest[0]?.id || ''); setMessage(''); }}><Trash2 size={15} /></button>
      </div></div>
      <label htmlFor="preset-name">名称</label>
      <input id="preset-name" value={preset.name} onChange={e => update({ name: e.target.value })} />
      <label htmlFor="preset-template">提示词</label>
      <textarea id="preset-template" rows={7} value={preset.template} onChange={e => update({ template: e.target.value })} spellCheck={false} />
      <p className="hint"><code>{'{{selection}}'}</code> 代表选中文字；没有占位符时，选中文字附在末尾。</p>
      <label htmlFor="preset-mode">执行方式</label>
      <select id="preset-mode" value={preset.mode} onChange={e => update({ mode: e.target.value as Preset['mode'] })}><option value="edit">先填入，在网页里编辑</option><option value="send">填入后直接发送</option></select>
      <label className="check-label"><input type="checkbox" checked={preset.needsSelection} onChange={e => update({ needsSelection: e.target.checked })} /> 必须有选中文字</label>
      <label className="check-label"><input type="checkbox" checked={preset.enabled} onChange={e => update({ enabled: e.target.checked })} /> 启用这个预设</label>
    </div> : <p className="description">新建一个预设，定义常用的提问方式。</p>}
    {error && <p className="error" role="alert">{error}</p>}
    <div className="save-row"><button className="primary" onClick={() => void save()}>保存预设</button>{message && <span className="saved"><Check size={15} />{message}</span>}</div>
  </section>;
}
