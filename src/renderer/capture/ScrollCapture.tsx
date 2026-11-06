import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowDown, ArrowRight, Check, Pause, Play, ScanLine, Square, Trash2, Undo2, X } from 'lucide-react';
import type { ScreenshotState, ScrollCaptureAction } from '../../shared/capture';
import { rise, Segmented } from '../motion';
import './scroll-capture.css';
import { CapturePixels } from './pixels';

function useScrollAction() {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false);
  async function act(action: ScrollCaptureAction) {
    if (pending.current && (typeof action === 'string' ? action : action.type) !== 'cancel') return;
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
    <div className="scroll-direction-row">
      <fieldset disabled={busy}><Segmented label="滚动方向" value={scroll.direction || 'vertical'} options={[["vertical", '纵向'], ["horizontal", '横向'], ["auto", '自动']]} onChange={direction => void act({ type: 'direction', direction })} /></fieldset>
      <span>首次有效滚动后锁轴，换轴需重新采集</span>
    </div>
    <p className={'scroll-controls-message' + (error ? ' error' : '')} role={error ? 'alert' : 'status'}>{!!scroll.reversedTrimmed && <span className="scroll-trimmed">反向滚动已自动裁剪 {scroll.reversedTrimmed}px。 </span>}{error || scroll.message || (paused ? '回到最后一次匹配的位置，再沿当前方向慢滚；也可结束并保留已匹配结果。' : '将鼠标移入选区，沿当前方向慢滚；每次保留至少半屏重叠。')}</p>
  </motion.div>;
}

/** Review a long image in a normal desk window before entering the shared image editor. */
export function ScrollReview({ state }: { state: ScreenshotState }) {
  const scroll = state.scroll!, { busy, error, act } = useScrollAction();
  const [zoom, setZoom] = useState<'width' | 'detail'>('width'), [selected, setSelected] = useState<{ type: 'segment' | 'seam'; index: number } | null>(null), [available, setAvailable] = useState({ width: 600, height: 500 });
  const viewport = useRef<HTMLDivElement>(null);
  const horizontal = scroll.direction === 'horizontal', axisLength = horizontal ? scroll.width : scroll.height, AxisIcon = horizontal ? ArrowRight : ArrowDown;
  const scale = zoom === 'detail' ? 1 : Math.min(1, Math.max(1, horizontal ? available.height - 48 : available.width - 64) / (horizontal ? scroll.height : scroll.width));
  const start = selected?.type === 'segment' ? scroll.seams[selected.index - 1] || 0 : 0;
  const end = selected?.type === 'segment' ? scroll.seams[selected.index] ?? axisLength : 0;
  const position = selected ? selected.type === 'seam' ? scroll.seams[selected.index] : (start + end) / 2 : null;
  useEffect(() => {
    const node = viewport.current; if (!node) return;
    const update = () => setAvailable({ width: node.clientWidth, height: node.clientHeight });
    update(); const observer = new ResizeObserver(update); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!selected) return;
    const count = selected.type === 'segment' ? scroll.segments : scroll.seams.length;
    if (selected.index >= count) setSelected(count ? { ...selected, index: count - 1 } : null);
  }, [scroll.segments, scroll.seams.length, selected]);
  useEffect(() => {
    const node = viewport.current;
    if (node && position != null) node.scrollTo(horizontal ? { left: Math.max(0, position * scale + 32 - node.clientWidth / 2), top: 0 } : { top: Math.max(0, position * scale + 24 - node.clientHeight / 2), left: 0 });
  }, [position, horizontal, scale, state.imageFrame]);
  return <div className="scroll-review">
    <header className="scroll-review-header"><ScanLine /><strong>检查滚动截图</strong><span className="mono">{scroll.width} × {scroll.height} · {scroll.segments} 段 · {horizontal ? '横向' : '纵向'}</span></header>
    <div className="scroll-review-body">
      <aside className="scroll-overview">
        <span className="scroll-label">总览</span>
        <div className="scroll-thumbnail">{state.imageFrame&&<CapturePixels state={state} frameId={state.imageFrame} className="scroll-preview-pixels"/>}</div>
        <span className="scroll-label">分段 <span className="mono">{scroll.segments}</span></span>
        <div className="scroll-segments" aria-label="拼接分段">{Array.from({ length: scroll.segments }, (_, index) => <button key={index} aria-label={`选择分段 ${index + 1}`} aria-pressed={selected?.type === 'segment' && selected.index === index} onClick={() => setSelected({ type: 'segment', index })}><AxisIcon /><span>第 {index + 1} 段</span><span className="mono">{scroll.segmentSizes?.[index] ?? (scroll.seams[index] ?? axisLength) - (scroll.seams[index - 1] || 0)}px</span></button>)}</div>
        <span className="scroll-label">接缝定位 <span className="mono">{scroll.seams.length}</span></span>
        <div className="scroll-seams" aria-label="拼接接缝">{scroll.seams.length ? scroll.seams.map((position, index) => <button key={index} aria-label={`选择接缝 ${index + 1}`} aria-pressed={selected?.type === 'seam' && selected.index === index} onClick={() => setSelected({ type: 'seam', index })}><AxisIcon /><span>接缝 {index + 1}</span><span className="mono">{position}px</span></button>) : <p>当前只有一段</p>}</div>
      </aside>
      <div className="scroll-detail">
        <div className="scroll-detail-tools"><span>逐段检查内容与接缝</span><Segmented label="检查缩放" value={zoom} options={[["width", horizontal ? '适合高度' : '适合宽度'], ["detail", '放大检查']]} onChange={setZoom} /></div>
        <div className="scroll-correction">
          <span>{selected ? `${selected.type === 'segment' ? '分段' : '接缝'} ${selected.index + 1}` : '选择左侧分段或接缝进行修正'}</span>
          {selected?.type === 'segment' && <button className="l-btn small" aria-label="删除所选分段" disabled={busy || scroll.segments <= 1} onClick={() => void act({ type: 'remove-segment', index: selected.index })}><Trash2 />删除所选分段</button>}
          {selected?.type === 'seam' && <><span className="scroll-seam-help">正值增加重叠</span><div className="scroll-seam-adjust" role="group" aria-label="接缝微调">{[-5, -1, 1, 5].map(delta => <button className="l-btn small mono" key={delta} aria-label={`接缝微调 ${delta > 0 ? '+' : ''}${delta}px`} disabled={busy} onClick={() => void act({ type: 'adjust-seam', index: selected.index, delta })}>{delta > 0 ? '+' : ''}{delta}px</button>)}</div></>}
        </div>
        <div className="scroll-detail-viewport" ref={viewport}>
          <div className={'scroll-detail-image' + (horizontal ? ' horizontal' : '')} style={{ width: scroll.width * scale, height: scroll.height * scale }}>
            {state.imageFrame&&<CapturePixels state={state} frameId={state.imageFrame} className="scroll-preview-pixels"/>}
            {selected?.type === 'segment' && <div className="scroll-segment-highlight" style={horizontal ? { left: `${start / axisLength * 100}%`, width: `${(end - start) / axisLength * 100}%` } : { top: `${start / axisLength * 100}%`, height: `${(end - start) / axisLength * 100}%` }} />}
            {scroll.seams.map((position, index) => <i key={index} className={'scroll-seam-line' + (selected?.type === 'seam' && selected.index === index ? ' selected' : '')} style={horizontal ? { left: `${position / axisLength * 100}%` } : { top: `${position / axisLength * 100}%` }}><span className="mono">{position}px</span></i>)}
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
