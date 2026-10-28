import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowDown, Check, Pause, Play, ScanLine, Square, Undo2, X } from 'lucide-react';
import type { ScreenshotState, ScrollCaptureAction } from '../../shared/capture';
import { rise, Segmented } from '../motion';
import './scroll-capture.css';
import { CapturePixels } from './pixels';

function useScrollAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false);
  async function act(action: ScrollCaptureAction) {
    if (pending.current && action !== 'cancel') return;
    pending.current = true; setBusy(true); setError('');
    try { const result = await window.screenshot.scrollAction(action); setError(result.error || ''); }
    catch (e) { setError((e as Error).message); }
    finally { pending.current = false; setBusy(false); }
  }
  return { busy, error, act };
}

/** A compact window outside the capture region; the real application keeps receiving the wheel. */
export function ScrollControls({ state }: { state: ScreenshotState }) {
  const scroll = state.scroll!, { busy, error, act } = useScrollAction(), paused = scroll.status === 'paused';
  return <motion.div className="scroll-controls" {...rise}>
    <div className="scroll-controls-row">
      <span className={'scroll-indicator' + (paused ? ' paused' : '')} />
      <strong>{paused ? '已暂停' : '滚动截图'}</strong>
      <span className="scroll-measure mono">{scroll.width} × {scroll.height} · {scroll.segments} 段</span>
      <div className="scroll-controls-actions">
        <button className="l-btn small" disabled={busy} onClick={() => void act(paused ? 'resume' : 'pause')}>{paused ? <Play /> : <Pause />}{paused ? '继续' : '暂停'}</button>
        <button className="l-btn small" disabled={busy || !scroll.segments} onClick={() => void act('finish')}><Square />结束</button>
        <button className="l-btn small" onClick={() => void act('cancel')}><X />取消</button>
      </div>
    </div>
    <p className={'scroll-controls-message' + (error ? ' error' : '')} role={error ? 'alert' : 'status'}>{error || scroll.message || (paused ? '回到最后一次匹配的位置，再继续向下慢滚；也可结束并保留已匹配结果。' : '将鼠标移入选区，手动向下慢滚；每次保留至少半屏重叠。')}</p>
  </motion.div>;
}

/** Review a long image in a normal desk window before entering the shared image editor. */
export function ScrollReview({ state }: { state: ScreenshotState }) {
  const scroll = state.scroll!, { busy, error, act } = useScrollAction();
  const [zoom, setZoom] = useState<'width' | 'detail'>('width'), [selected, setSelected] = useState<number | null>(null), [availableWidth, setAvailableWidth] = useState(600);
  const viewport = useRef<HTMLDivElement>(null);
  const scale = (zoom === 'detail' ? scroll.width : Math.min(scroll.width, Math.max(1, availableWidth - 64))) / scroll.width;
  useEffect(() => {
    const node = viewport.current; if (!node) return;
    const update = () => setAvailableWidth(node.clientWidth);
    update(); const observer = new ResizeObserver(update); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (selected !== null && !scroll.seams.includes(selected)) setSelected(null); }, [scroll.seams, selected]);
  function locate(y: number) {
    setSelected(y);
    const node = viewport.current;
    if (node) node.scrollTo({ top: Math.max(0, (scroll.height * scale) * y / scroll.height + 24 - node.clientHeight / 2), left: 0 });
  }
  return <div className="scroll-review">
    <header className="scroll-review-header"><ScanLine /><strong>检查滚动截图</strong><span className="mono">{scroll.width} × {scroll.height} · {scroll.segments} 段</span></header>
    <div className="scroll-review-body">
      <aside className="scroll-overview">
        <span className="scroll-label">总览</span>
        <div className="scroll-thumbnail">{state.imageFrame&&<CapturePixels state={state} frameId={state.imageFrame} className="scroll-preview-pixels"/>}</div>
        <span className="scroll-label">接缝定位 <span className="mono">{scroll.seams.length}</span></span>
        <div className="scroll-seams" aria-label="拼接接缝">{scroll.seams.length ? scroll.seams.map((y, i) => <button key={y} aria-pressed={selected === y} onClick={() => locate(y)}><ArrowDown /><span>接缝 {i + 1}</span><span className="mono">{y}px</span></button>) : <p>当前只有一段</p>}</div>
      </aside>
      <div className="scroll-detail">
        <div className="scroll-detail-tools"><span>逐段检查内容与接缝</span><Segmented label="检查缩放" value={zoom} options={[["width", '适合宽度'], ["detail", '放大检查']]} onChange={setZoom} /></div>
        <div className="scroll-detail-viewport" ref={viewport}>
          <div className="scroll-detail-image" style={{ width: scroll.width * scale, height: scroll.height * scale }}>
            {state.imageFrame&&<CapturePixels state={state} frameId={state.imageFrame} className="scroll-preview-pixels"/>}
            {scroll.seams.map(y => <i key={y} className={'scroll-seam-line' + (selected === y ? ' selected' : '')} style={{ top: `${y / scroll.height * 100}%` }}><span className="mono">{y}px</span></i>)}
          </div>
        </div>
      </div>
    </div>
    <footer className="scroll-review-footer">
      <div className="scroll-review-note" role={error ? 'alert' : 'status'}>{error || scroll.message || '确认内容连续后进入编辑，可标注、复制、保存、贴图或发送图片。'}</div>
      <div className="scroll-review-actions"><button className="l-btn" onClick={() => void act('cancel')}><X />取消</button><button className="l-btn" disabled={busy || scroll.segments <= 1} onClick={() => void act('undo')}><Undo2 />撤回末段</button><button className="l-btn primary" disabled={busy || !state.imageFrame} onClick={() => void act('edit')}><Check />检查通过，进入编辑</button></div>
    </footer>
  </div>;
}
