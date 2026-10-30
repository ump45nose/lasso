import { useEffect, useRef, useState } from 'react';
import { Camera, Lock, Save, Trash2, Unlock, X } from 'lucide-react';
import { validateCustomCapture, validateRegionPreset, type RegionConfiguration, type RegionPreset } from '../shared/capture-regions';
import { Segmented } from './motion';
import './styles/custom-capture.css';

const initial = { width: '800', height: '600', delay: '0', ratio: null as number | null };
export function CustomCapture() {
  const [config, setConfig] = useState<RegionConfiguration>({ presets: [], displays: [] });
  const [id, setId] = useState(''), [name, setName] = useState('');
  const [width, setWidth] = useState(initial.width), [height, setHeight] = useState(initial.height);
  const [display, setDisplay] = useState(''), [delay, setDelay] = useState(initial.delay);
  const [ratio, setRatio] = useState<number | null>(null), [customRatio, setCustomRatio] = useState('');
  const [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false);
  const inFlight = useRef(false), loaded = useRef(false), feedback = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error || status) feedback.current?.scrollIntoView({ block: 'nearest' }); }, [error, status]);

  const refresh = async () => {
    const next = await window.desktop.captureRegions();
    setConfig(next);
    const first = !loaded.current;
    setDisplay(current => {
      if (next.displays.some(d => String(d.id) === current)) return current;
      return first ? String(next.displays[0]?.id ?? '') : '';
    });
    loaded.current = true;
  };
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, []);
  const edited = () => { setError(''); setStatus(''); };
  function select(nextId: string) {
    edited(); setId(nextId);
    const preset = config.presets.find(p => p.id === nextId);
    setName(preset?.name ?? '');
    setWidth(preset ? String(preset.width) : initial.width);
    setHeight(preset ? String(preset.height) : initial.height);
    setDelay(preset ? String(preset.delay) : initial.delay);
    setRatio(preset?.ratio ?? null); setCustomRatio('');
    const boundDisplay = nextId ? config.presetDisplayIds?.[nextId] : undefined;
    if (boundDisplay !== undefined && config.displays.some(d => d.id === boundDisplay)) setDisplay(String(boundDisplay));
  }
  function dimensions(axis: 'width' | 'height', text: string) {
    edited();
    if (axis === 'width') setWidth(text); else setHeight(text);
    const n = Number(text);
    if (ratio && Number.isSafeInteger(n) && n >= 2) {
      if (axis === 'width') setHeight(String(Math.round(n / ratio)));
      else setWidth(String(Math.round(n * ratio)));
    }
  }
  function constrain(next: number | null) {
    if (next === null) { setRatio(null); edited(); return; }
    const w = Number(width), h = Math.round(w / next);
    if (!Number.isFinite(next) || next <= 0 || ![w, h].every(n => Number.isSafeInteger(n) && n >= 2 && n <= 100000)) {
      setError('此比例下尺寸需为 2 至 100000 像素，请先编辑宽度'); return;
    }
    setRatio(next); setWidth(String(w)); setHeight(String(h)); edited();
  }
  const value = (): RegionPreset => ({ id: id || crypto.randomUUID(), name: name.trim(), width: Number(width), height: Number(height), ratio, delay: Number(delay) as 0 | 3 | 5 | 10 });
  async function perform(job: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setStatus('');
    try { await job(); } catch (e) { setError((e as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const save = () => perform(async () => {
    const preset = value(); validateRegionPreset(preset);
    await window.desktop.saveRegionPreset(preset);
    setId(preset.id); // A second save updates this preset instead of creating a duplicate.
    setName(preset.name); await refresh(); setStatus('已保存预设');
  });
  const remove = () => perform(async () => {
    await window.desktop.deleteRegionPreset(id);
    select(''); await refresh(); setStatus('已删除预设');
  });
  const start = () => perform(async () => {
    const stored = config.presets.find(p => p.id === id);
    const reusePosition = stored && stored.width === Number(width) && stored.height === Number(height);
    const request = { displayId: Number(display), width: Number(width), height: Number(height), ratio, delay: Number(delay) as 0 | 3 | 5 | 10, ...(reusePosition ? { presetId: id } : {}) };
    if (!display) throw Error('请选择目标显示器');
    validateCustomCapture(request);
    const target = config.displays.find(d => d.id === request.displayId);
    if (!target) throw Error('显示器已变化，请重新选择');
    if (request.width > Math.round(target.bounds.width * target.scaleFactor) || request.height > Math.round(target.bounds.height * target.scaleFactor)) throw Error('此显示器放不下目标尺寸，请换显示器或编辑尺寸');
    const result = await window.desktop.customScreenshot(request);
    if (result.error) { await refresh(); throw Error(result.error); }
  });
  const preset = config.presets.find(p => p.id === id);
  const presetChanged = Boolean(preset && (preset.name !== name.trim() || preset.width !== Number(width) || preset.height !== Number(height) || preset.ratio !== ratio || preset.delay !== Number(delay)));

  return <section className="custom-capture" aria-label="自定义截图" onKeyDown={e => { if (e.key === 'Escape') void window.desktop.act('close-custom-capture'); }}>
    <header><h2>自定义截图</h2><button className="l-icon" aria-label="关闭自定义截图" onClick={() => void window.desktop.act('close-custom-capture')}><X /></button></header>
    <fieldset className="custom-fields" disabled={busy}>
      <label>区域预设<select className="l-input" aria-label="选择区域预设" value={id} onChange={e => select(e.target.value)}><option value="">新区域</option>{config.presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <div className="custom-size"><label>宽<input className="l-input mono" inputMode="numeric" aria-label="截图宽度" value={width} onChange={e => dimensions('width', e.target.value)} /></label><span>×</span><label>高<input className="l-input mono" inputMode="numeric" aria-label="截图高度" value={height} onChange={e => dimensions('height', e.target.value)} /></label><span>px</span></div>
      <div className="custom-ratio"><button className="l-btn" aria-label="锁定当前宽高比" aria-pressed={ratio !== null} onClick={() => constrain(ratio === null ? Number(width) / Number(height) : null)}>{ratio === null ? <Unlock /> : <Lock />}{ratio === null ? '锁定当前比例' : '已锁定比例'}</button><Segmented label="自定义截图比例" value={String(ratio)} onChange={v => constrain(v === 'null' ? null : Number(v))} options={ [['null', '自由'], ['1', '1:1'], [String(4 / 3), '4:3'], [String(16 / 9), '16:9']] } /></div>
      <div className="custom-ratio"><input className="l-input mono" aria-label="自定义截图宽高比" placeholder="宽:高" value={customRatio} onChange={e => setCustomRatio(e.target.value)} /><button className="l-btn" onClick={() => { const parts = customRatio.split(':'); const [w, h] = parts.map(Number); if (parts.length !== 2 || !(w > 0 && h > 0)) setError('比例请填写为宽:高'); else constrain(w / h); }}>应用比例</button></div>
      <label>显示器<select className="l-input" aria-label="目标显示器" value={display} onChange={e => { setDisplay(e.target.value); edited(); }}><option value="" disabled>请选择显示器</option>{config.displays.map(d => <option key={d.id} value={d.id}>{d.label} · {Math.round(d.bounds.width * d.scaleFactor)} × {Math.round(d.bounds.height * d.scaleFactor)} px</option>)}</select></label>
      <div className="custom-delay"><span>延时</span><Segmented label="自定义截图延时" value={delay} onChange={v => { setDelay(v); edited(); }} options={ [['0', '立即'], ['3', '3秒'], ['5', '5秒'], ['10', '10秒']] } /></div>
      <label>预设名称<input className="l-input" aria-label="自定义区域名称" value={name} onChange={e => { setName(e.target.value); edited(); }} maxLength={80} /></label>
      <div className="custom-actions"><button className="l-btn" onClick={() => void save()}><Save />{id ? '更新预设' : '保存预设'}</button>{id && <button className="l-btn" onClick={() => void remove()}><Trash2 />删除</button>}{presetChanged && <span className="custom-status">预设有未保存更改</span>}</div>
      <button className="l-btn primary" onClick={() => void start()}><Camera />{busy ? '正在处理…' : '开始截图'}</button>
    </fieldset>
    {(error || status) && <div ref={feedback}>{error && <p className="l-banner" role="alert">{error}</p>}{status && <p className="custom-status" role="status">{status}</p>}</div>}
  </section>;
}
