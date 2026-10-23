import { useState } from 'react';
import { targetLabels, type ImagePreview, type Preset, type Target } from '../shared/contracts';
export function ImageEntry({ image, presets }: { image: ImagePreview; presets: Preset[] }) {
  const [target, setTarget] = useState<Target | ''>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <section className="image-entry" onPaste={e => { if ([...e.clipboardData.items].some(i => i.type.startsWith('image/'))) { e.preventDefault(); void window.desktop.readImage().then(r => setError(r.error || '')); } }}>
    <span className="eyebrow">剪贴板图片</span><h1>这张图，想问什么？</h1>
    <img className="input-preview" src={image.thumbnail} alt="待处理图片" /><p className="hint">{image.width} × {image.height} · 按原尺寸发送</p>
    <div className="image-actions"><button className="text-button" onClick={() => void window.desktop.readImage().then(r => setError(r.error || ''))}>重新读取剪贴板</button><button className="text-button" onClick={() => void window.desktop.removeImage()}>移除</button></div>
    <label className="target-field">发送到 <select value={target} onChange={e => setTarget(e.target.value as Target | '')}><option value="">沿用预设目标</option>{Object.entries(targetLabels).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
    <div className="quick-presets">{presets.filter(p => p.enabled).map(p => <button disabled={busy} key={p.id} onClick={async () => { setBusy(true); const r = await window.desktop.runPreset(p.id, { imageId: image.id, ...(target ? { target } : {}) }); setError(r.error || ''); setBusy(false); }}>{p.name}<small> · {targetLabels[target || p.target]}{p.mode === 'edit' ? ' · 先编辑' : ''}</small></button>)}</div>
    {error && <p className="error">{error}</p>}
  </section>;
}
