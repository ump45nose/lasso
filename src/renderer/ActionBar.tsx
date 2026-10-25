import { useEffect, useRef, useState } from 'react';
import type { ActionBarAPI, ActionBarState } from '../shared/contracts';
import { useFonts } from './fonts';
declare global { interface Window { actionBar: ActionBarAPI } }
export function ActionBar() {
  const [state, setState] = useState<ActionBarState | null>(null);
  useFonts(state?.fonts);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const stop = window.actionBar.onState(setState);
    void window.actionBar.getState().then(setState);
    document.body.classList.add('action-bar-body');
    const observer = new ResizeObserver(() => window.actionBar.resize(content.current!.scrollWidth + 4));
    observer.observe(content.current!);
    return () => { stop(); observer.disconnect(); };
  }, []);
  return <div className="action-bar-content" ref={content}>
    <span className="bar-dot" />
    {state?.presets.map(preset => <button key={preset.id} disabled={state.busy} onClick={() => void window.actionBar.runPreset(preset.id)}>{preset.name}</button>)}
    <span className="bar-divider" /><button aria-label="更多预设" onClick={() => window.actionBar.more()}>···</button>
  </div>;
}
