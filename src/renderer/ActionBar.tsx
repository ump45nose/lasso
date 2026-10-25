import { useEffect, useRef, useState } from 'react';
import { Ellipsis } from 'lucide-react';
import { targetLabels, type ActionBarAPI, type ActionBarState } from '../shared/contracts';
import { BrandMark } from './BrandMark';
import { useFonts } from './fonts';
declare global { interface Window { actionBar: ActionBarAPI } }

/** The non-focusable window is the capsule. A press shows "handing off" locally; main's fade-out hides the window. */
export function ActionBar() {
  const [state, setState] = useState<ActionBarState | null>(null);
  const [pressed, setPressed] = useState<string | null>(null);
  const [sending, setSending] = useState<{ target: string; width: number } | null>(null);
  useFonts(state?.fonts);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stop = window.actionBar.onState(setState);
    void window.actionBar.getState().then(setState);
    document.body.classList.add('ab-body');
    const observer = new ResizeObserver(() => window.actionBar.resize(content.current!.scrollWidth));
    observer.observe(content.current!);
    return () => { stop(); observer.disconnect(); };
  }, []);
  function run(preset: ActionBarState['presets'][number]) {
    const width = content.current!.scrollWidth;
    setPressed(preset.id);
    setTimeout(() => { setPressed(null); setSending({ target: targetLabels[preset.target], width }); }, 120);
    // The bar hides as the run starts; clear the label once it has faded so the next selection starts fresh.
    void window.actionBar.runPreset(preset.id).finally(() => setTimeout(() => setSending(null), 400));
  }
  if (sending) return <div className="ab-bar sending" ref={content} role="status" style={{ minWidth: sending.width }}><BrandMark size={16} ink="var(--on-ink)" />正在交给 {sending.target}…</div>;
  return <div className="ab-bar" ref={content} role="toolbar" aria-label="Lasso 动作条">
    <span className="ab-mark"><BrandMark size={16} ink="var(--on-ink)" /></span>
    {state?.presets.map(preset => <button key={preset.id} className={pressed === preset.id ? 'pressed' : ''} disabled={state.busy || Boolean(pressed)}
      title={`${targetLabels[preset.target]} · ${preset.mode === 'edit' ? '先编辑' : '直接发送'}`} onClick={() => run(preset)}>{preset.name}</button>)}
    <span className="ab-sep" /><button aria-label="更多预设" title="更多预设与设置" onClick={() => window.actionBar.more()}><Ellipsis size={16} /></button>
  </div>;
}
