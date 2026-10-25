import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { targetLabels, type ImagePreview, type LaunchOptions, type Preset, type Target } from '../shared/contracts';
import { targets } from './targets';

/** Shared by pending image and text: pick an optional one-off target, then run a preset with the input. */
export function PresetPicker({ presets, input }: { presets: Preset[]; input: Pick<LaunchOptions, 'imageId' | 'textId'> }) {
  const [target, setTarget] = useState<Target | ''>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function run(preset: Preset) {
    setBusy(true);
    try { setError((await window.desktop.runPreset(preset.id, { ...input, ...(target ? { target } : {}) })).error || ''); }
    finally { setBusy(false); }
  }
  return <>
    <div className="l-seg" role="radiogroup" aria-label="发送到">
      {(['', ...targets] as const).map(id => <button key={id || 'preset'} role="radio" aria-checked={target === id} onClick={() => setTarget(id)}>{id ? targetLabels[id] : '沿用预设目标'}</button>)}
    </div>
    <div className="l-list">
      {presets.filter(p => p.enabled).map(p => <button key={p.id} className="l-list-row" disabled={busy} onClick={() => void run(p)}>
        {p.name}<small>{targetLabels[target || p.target]} · {p.mode === 'edit' ? '先编辑' : '直接发送'}</small><ChevronRight size={14} className="l-row-chev" /></button>)}
    </div>
    {error && <p className="l-field-help error" role="alert">{error}</p>}
  </>;
}

export function ImageEntry({ image, presets }: { image: ImagePreview; presets: Preset[] }) {
  const [error, setError] = useState('');
  const replace = () => void window.desktop.readImage(); // A failure shows as the app notice row.
  return <div className="l-image l-surface-enter" onPaste={e => { if ([...e.clipboardData.items].some(i => i.type.startsWith('image/'))) { e.preventDefault(); replace(); } }}>
    <div className="l-image-head"><span className="l-small">待处理图片</span><h2>这张图，想问什么？</h2></div>
    <figure className="l-image-fig">
      <div className="l-print"><img className="l-shot" src={image.thumbnail} alt="待处理图片预览" /></div>
      <figcaption>
        <span className="mono">{image.width} × {image.height} px · 原尺寸发送</span>
        <button className="l-text-btn push" title="标注、裁剪或识别文字" onClick={() => void window.desktop.editImage(image.id).then(r => setError(r.error || ''))}>编辑</button>
        <button className="l-text-btn" title="用剪贴板里的图片替换" onClick={replace}>替换</button>
        <button className="l-text-btn" onClick={() => void window.desktop.removeImage()}>移除</button>
      </figcaption>
    </figure>
    {error && <p className="l-field-help error" role="alert">{error}</p>}
    <PresetPicker key={image.id} presets={presets} input={{ imageId: image.id }} />
  </div>;
}
