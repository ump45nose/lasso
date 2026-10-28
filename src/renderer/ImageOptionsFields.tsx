import { useEffect, useState } from 'react';
import { imagePixels, mediaAspects, type ImageOptions, type MediaAspect, type MediaConfig, type MediaResolution } from '../shared/media';
import { Segmented } from './motion';

export function ImageOptionsFields({ value, update, api }: { value: ImageOptions; update(value: ImageOptions): void; api: boolean }) {
  const set = (patch: Partial<ImageOptions>) => update({ ...value, ...patch });
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [direction, setDirection] = useState('all');
  const custom = !!value.customSize, pixels = imagePixels(value);
  const orientation = (aspect: MediaAspect) => { const [w, h] = aspect.split(':').map(Number); return w === h ? 'square' : w > h ? 'landscape' : 'portrait'; };
  const activeDirection = direction;
  return <>
    <div className="l-image-options">
      <div className="l-field"><span className="l-field-label">尺寸模式</span><Segmented label="尺寸模式" value={custom ? 'custom' : 'preset'} onChange={mode => set({ customSize: mode === 'custom' ? pixels || { width: 1024, height: 1024 } : undefined, aspect: '', resolution: undefined })} options={ [['preset', '预设尺寸'], ['custom', '自定义尺寸']] } /></div>
      {custom ? <div className="l-pair">
        {(['width', 'height'] as const).map(key => <div className="l-field" key={key}><label htmlFor={'image-' + key}>{key === 'width' ? '宽度' : '高度'} · px</label><input id={'image-' + key} className="l-input mono" type="number" min={64} max={8192} step={1} value={value.customSize![key] || ''} onChange={event => set({ customSize: { ...value.customSize!, [key]: Number(event.target.value) } })} /></div>)}
      </div> : <>
        <div className="l-pair">
          <div className="l-field"><span className="l-field-label">方向</span><Segmented label="图片方向" value={activeDirection} onChange={next => { setDirection(next); if (value.aspect && next !== 'all' && orientation(value.aspect) !== next) set({ aspect: '' }); }} options={ [['all', '全部'], ['square', '方形'], ['portrait', '竖图'], ['landscape', '横图']] } /></div>
          <div className="l-field"><span className="l-field-label">分辨率</span><Segmented label="图片分辨率" value={value.resolution || ''} onChange={resolution => set({ resolution: resolution as MediaResolution || undefined })} options={ [['', '不指定'], ['1K', '1K'], ['2K', '2K'], ['4K', '4K']] } /></div>
        </div>
        <div className="l-field"><span className="l-field-label">图片比例</span><div className="l-aspect-grid" role="radiogroup" aria-label="图片比例">
          {(['', ...mediaAspects] as const).filter(aspect => !aspect || activeDirection === 'all' || orientation(aspect) === activeDirection).map(aspect => <button type="button" className="l-btn small mono" role="radio" aria-checked={value.aspect === aspect} key={aspect || 'auto'} onClick={() => set({ aspect })}>{aspect || '不指定'}</button>)}
        </div></div>
      </>}
      <div className="l-field"><span className="l-field-label">数量</span><Segmented label="图片数量" value={value.count ? String(value.count) : ''} onChange={count => set({ count: count ? Number(count) : undefined })} options={ [['', '不指定'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']] } /></div>
      <p className="l-field-help mono">{pixels ? `${api ? '请求尺寸' : '参考尺寸'}：${pixels.width} × ${pixels.height} px` : '尺寸跟随模型'}{api && ' · 以模型支持的尺寸为准'}</p>
    </div>
    {api && <>
      <ImageConnection onModels={setModels} />
      <div className="l-field"><label htmlFor="image-generation-model">生成模型</label><input id="image-generation-model" className="l-input mono" value={value.generationModel} onChange={event => set({ generationModel: event.target.value })} /></div>
      <div className="l-field"><label htmlFor="image-edit-model">改图模型</label><input id="image-edit-model" className="l-input mono" value={value.editModel} onChange={event => set({ editModel: event.target.value })} /></div>
      {models.length > 0 && <ModelChoices models={models} choose={model => set(model)} />}
      <div className="l-field"><span className="l-field-label">质量</span><Segmented label="图片质量" value={value.quality} onChange={quality => set({ quality })} options={ [['auto', '默认'], ['low', '低'], ['medium', '中'], ['high', '高']] } /></div>
      <div className="l-field"><span className="l-field-label">背景</span><Segmented label="图片背景" value={value.background} onChange={background => { setError(''); set({ background, ...(background === 'transparent' && value.outputFormat === 'jpeg' ? { outputFormat: 'png' } : {}) }); }} options={ [['auto', '默认'], ['opaque', '不透明'], ['transparent', '透明']] } /></div>
      <div className="l-field"><span className="l-field-label">格式</span><Segmented label="图片格式" value={value.outputFormat} onChange={outputFormat => { if (outputFormat === 'jpeg' && value.background === 'transparent') { setError('透明背景请选择 PNG 或 WebP'); return; } setError(''); set({ outputFormat }); }} options={ [['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP']] } /></div>
      {error && <p className="l-field-help error" role="alert">{error}</p>}
    </>}
  </>;
}

function ImageConnection({ onModels }: { onModels(models: string[]): void }) {
  const [config, setConfig] = useState<MediaConfig | null>(null);
  const [baseURL, setBaseURL] = useState('');
  const [credential, setCredential] = useState('');
  const [clear, setClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => { let active = true; void window.desktop.mediaConfig().then(value => { if (active) { setConfig(value); setBaseURL(value.baseURL); } }, reason => { if (active) setError(String(reason)); }); return () => { active = false; }; }, []);
  async function save() {
    setBusy(true); setError(''); setMessage('');
    try { const next = await window.desktop.saveMediaConfig({ baseURL, ...(clear ? { credential: '' } : credential ? { credential } : {}) }); setConfig(next); setBaseURL(next.baseURL); setCredential(''); setClear(false); setMessage('连接已保存，供所有 API 生图预设使用。'); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }
  return <>
    <div className="l-field"><label htmlFor="image-api-base">New API 地址 · 所有生图预设共用</label><input id="image-api-base" className="l-input mono" value={baseURL} onChange={event => setBaseURL(event.target.value)} placeholder="https://…/v1" /></div>
    <div className="l-field"><label htmlFor="image-api-key">凭据</label><input id="image-api-key" type="password" autoComplete="off" className="l-input mono" value={credential} placeholder={config?.hasCredential ? '已安全保存，留空保留' : '输入 New API 凭据'} onChange={event => { setCredential(event.target.value); setClear(false); }} />
      {config?.hasCredential && <button className="l-text-btn" aria-pressed={clear} onClick={() => setClear(!clear)}>{clear ? '保存时清除凭据 · 撤销' : '清除已存凭据'}</button>}
    </div>
    <div className="l-field-row">
      <button className="l-btn small" disabled={!config || busy} onClick={() => void save()}>保存连接</button>
      <button className="l-btn small" disabled={!config?.baseURL || busy || baseURL !== config.baseURL || !!credential || clear} onClick={async () => { setBusy(true); setError(''); setMessage(''); try { onModels(await window.desktop.mediaModels()); setMessage('已读取模型；生图能力以实际请求为准。'); } catch (reason) { setError(String(reason)); } finally { setBusy(false); } }}>读取模型</button>
    </div>
    {error && <p className="l-field-help error" role="alert">{error}</p>}{message && <p className="l-field-help" role="status">{message}</p>}
  </>;
}

function ModelChoices({ models, choose }: { models: string[]; choose(patch: Partial<ImageOptions>): void }) {
  const [open, setOpen] = useState(false);
  return <div className="l-field"><button className="l-text-btn" aria-expanded={open} onClick={() => setOpen(!open)}>从服务模型列表选择</button>
    {open && <div className="l-image-model-list">{models.map(model => <div className="l-field-row" key={model}><span className="mono">{model}</span><button className="l-btn small" onClick={() => { choose({ generationModel: model }); setOpen(false); }}>用于生成</button><button className="l-btn small" onClick={() => { choose({ editModel: model }); setOpen(false); }}>用于改图</button></div>)}</div>}
  </div>;
}
