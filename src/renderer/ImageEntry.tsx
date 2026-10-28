import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { presetTargetLabels as targetLabels, type ImagePreview, type LaunchOptions, type Preset, type Target } from '../shared/contracts';
import { targets } from './targets';
import { Segmented } from './motion';

/** Shared by pending image and text: pick an optional one-off target, then run a preset with the input. */
export function PresetPicker({ presets, input }: { presets: Preset[]; input: Pick<LaunchOptions, 'imageId' | 'textId' | 'imagePrompt'> }) {
  const [target, setTarget] = useState<Target | ''>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function run(preset: Preset) {
    setBusy(true);
    try { setError((await window.desktop.runPreset(preset.id, { ...input, ...(preset.kind !== 'image' ? { imagePrompt: undefined } : {}), ...(target && (preset.kind !== 'image' || ['chatgpt', 'gemini'].includes(target)) ? { target } : {}) })).error || ''); }
    finally { setBusy(false); }
  }
  return <>
    <Segmented label="发送到" value={target} onChange={setTarget} options={[['', '沿用预设目标'], ...targets.map(id => [id, targetLabels[id]] as const)]} />
    <div className="l-list">
      {presets.filter(p => p.enabled).map(p => <button key={p.id} className="l-list-row" disabled={busy} onClick={() => void run(p)}>
        {p.name}<small>{targetLabels[target && (p.kind !== 'image' || ['chatgpt', 'gemini'].includes(target)) ? target : p.target]} · {p.mode === 'edit' ? '先编辑' : '直接发送'}</small><ChevronRight size={14} className="l-row-chev" /></button>)}
    </div>
    {error && <p className="l-field-help error" role="alert">{error}</p>}
  </>;
}

export function ImageEntry({ image, presets, initialPrompt = '' }: { image: ImagePreview; presets: Preset[]; initialPrompt?: string }) {
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState(initialPrompt);
  const replace = () => void window.desktop.readImage(); // A failure shows as the app notice row.
  return <div className="l-image" onPaste={e => { if ([...e.clipboardData.items].some(i => i.type.startsWith('image/'))) { e.preventDefault(); replace(); } }}>
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
    {presets.some(p => p.enabled && p.kind === 'image') && <div className="l-field"><label htmlFor="image-prompt">生图／改图描述</label><textarea id="image-prompt" className="l-textarea" rows={3} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="补充画面或修改要求，可留空使用预设" /></div>}
    <PresetPicker key={image.id} presets={presets} input={{ imageId: image.id, imagePrompt: prompt }} />
  </div>;
}
