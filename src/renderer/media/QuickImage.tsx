import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Copy, Download, ImagePlus, Loader2, Minus, Pencil, Pin, Trash2, X } from 'lucide-react';
import type { MediaAPI, MediaJob, MediaOutputAction, MediaState } from '../../shared/media';
import { imageOptionsSummary } from '../../shared/media';
import { BrandMark } from '../BrandMark';
import { rise } from '../motion';
import { useFonts } from '../fonts';
import './quick-image.css';

declare global { interface Window { media: MediaAPI } }
const statusLabels: Record<MediaJob['status'], string> = { running: '生成中', succeeded: '已生成', 'handed-off': '已交给网页', failed: '失败', interrupted: '结果未知' };

/** API drafts and durable results. Presets and connections are edited in the main settings. */
export function QuickImage() {
  const [state, setState] = useState<MediaState | null>(null);
  const [prompt, setPrompt] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [selectedImageId, setSelectedImageId] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteId, setDeleteId] = useState('');
  const [requestRevision, setRequestRevision] = useState(0);
  const draftId = useRef<string | null>(null);
  const newestJobId = useRef<string | null>(null);
  const guard = useRef(false);
  const pending = useRef<{ id: string; input: string } | null>(null);
  useFonts(state || undefined);
  const accept = useCallback((next: MediaState) => {
    setState(next);
    const newest = next.jobs[0]?.id || null;
    const added = newest !== newestJobId.current;
    newestJobId.current = newest;
    setSelectedId(id => !added && next.jobs.some(job => job.id === id) ? id : newest || '');
    if (next.draft && draftId.current !== next.draft.id) {
      draftId.current = next.draft.id; setPrompt(next.draft.prompt);
      pending.current = { id: next.draft.id, input: JSON.stringify([next.draft.prompt.trim(), next.reference?.id || null]) };
    }
  }, []);
  useEffect(() => { let active = true; const stop = window.media.onState(next => { if (active) accept(next); }); void window.media.state().then(next => { if (active) accept(next); }, reason => { if (active) setError(String(reason)); }); return () => { active = false; stop(); }; }, [accept]);
  const draft = state?.draft, jobs = state?.jobs || [], reference = state?.reference;
  const running = jobs.some(job => job.status === 'running');
  const selected = jobs.find(job => job.id === selectedId);
  const selectedImage = selected?.images?.find(image => image.id === selectedImageId) || selected?.images?.[0];
  const currentInput = JSON.stringify([prompt.trim(), reference?.id || null]);
  const submitted = pending.current?.input === currentInput ? jobs.find(job => job.requestId === pending.current?.id) : undefined;
  void requestRevision;
  async function act(operation: () => Promise<void>) {
    if (guard.current) return;
    guard.current = true; setBusy(true); setError(''); setMessage('');
    try { await operation(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { guard.current = false; setBusy(false); }
  }
  async function generate() {
    if (!draft || !prompt.trim() || running || submitted) return;
    await act(async () => {
      if (pending.current?.input !== currentInput) pending.current = { id: crypto.randomUUID(), input: currentInput };
      const next = await window.media.generate({ requestId: pending.current.id, draftId: draft.id, prompt: prompt.trim() });
      accept(next); const job = next.jobs.find(item => item.requestId === pending.current?.id); if (job) setSelectedId(job.id);
    });
  }
  async function output(action: MediaOutputAction) { if (!selected || !selectedImage) return; const result = await window.media.output(selected.id, action, selectedImage.id); if (result.error) throw Error(result.error); }
  return <div className="l-app qi-app">
    <header className="l-bar"><div className="l-wordmark"><BrandMark size={19} /><span>图片生成</span></div><span className="push" />
      <button className="l-ghost" onClick={() => void window.media.choosePreset()}>选择预设</button><button className="l-icon" aria-label="隐藏图片生成" onClick={() => void window.media.hide()}><Minus size={16} /></button>
    </header>
    <main className="qi-body">
      {draft ? <section className="qi-input" aria-label="生成图片">
        <div className="l-image-head"><span className="l-small">New API · {draft.presetName}</span><h2>{reference ? '这张图，怎么改？' : '这次，想画什么？'}</h2></div>
        <label className="l-field" htmlFor="qi-prompt"><span className="l-field-label">提示词</span><textarea id="qi-prompt" className="l-textarea" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述画面或修改要求…" /></label>
        {reference && <figure className="qi-reference"><img src={reference.thumbnail} alt="本次使用的参考图" /><figcaption><span className="mono">{reference.width} × {reference.height} px</span></figcaption><button className="l-icon" aria-label="移除参考图" disabled={busy || running} onClick={() => void act(async () => accept(await window.media.setReference(null)))}><X size={15} /></button></figure>}
        <p className="l-field-help">{imageOptionsSummary(draft.options)} · {reference ? draft.options.editModel || '尚未配置改图模型' : draft.options.generationModel || '尚未配置生成模型'}</p>
        <div className="qi-row qi-generate-row"><button className="l-btn primary" disabled={!prompt.trim() || running || busy || !!submitted} onClick={() => void generate()}>{running || busy ? <Loader2 size={15} className="l-spin" /> : <ImagePlus size={15} />}{running ? '正在生成' : submitted ? '已提交' : reference ? '生成新版本' : draft.options.count ? `生成 ${draft.options.count} 张` : '生成图片'}</button></div>
        {running && <p className="qi-progress" role="status">隐藏窗口后继续生成；不会自动重试。</p>}
        {submitted && !running && <button className="l-ghost" onClick={() => { pending.current = null; setRequestRevision(value => value + 1); }}>准备再次生成</button>}
      </section> : <section className="qi-input"><p className="l-field-help">从划词动作条或统一预设开始生成图片。</p><button className="l-btn" onClick={() => void window.media.choosePreset()}>选择生图预设</button></section>}
      {error && <div className="l-banner qi-notice" role="alert"><span>{error}</span></div>}{message && <p className="qi-message" role="status">{message}</p>}
      {jobs.length > 0 && <section className="qi-results" aria-label="已保存的结果和版本">
        <div className="qi-section-head"><span className="l-small">结果与版本</span></div>
        <div className="qi-versions" role="list" aria-label="选择一个版本">{jobs.map((job, index) => <button key={job.id} className="qi-version" role="listitem" aria-label={`选择版本 ${jobs.length - index}，${statusLabels[job.status]}`} aria-pressed={selectedId === job.id} onClick={() => { setSelectedId(job.id); setDeleteId(''); }}>
          {job.images?.[0] ? <img src={job.images[0].thumbnail} alt="" /> : <span className="qi-version-placeholder"><ImagePlus size={16} /></span>}<span>版本 {jobs.length - index}</span><small>{statusLabels[job.status]}{(job.images?.length || 0) > 1 && ` · ${job.images!.length} 张`}</small>
        </button>)}</div>
        {selected && <motion.div key={selected.id} className="qi-selected" {...rise}>
          <div className="qi-section-head"><span className={`qi-result-status${selected.error ? ' error' : ''}`}>{statusLabels[selected.status]}{selected.parentId && ' · 派生版本'}</span><button className="l-ghost qi-delete" disabled={busy || running} onClick={() => { if (deleteId !== selected.id) { setDeleteId(selected.id); return; } void act(async () => { accept(await window.media.remove(selected.id)); setDeleteId(''); }); }}><Trash2 size={13} />{deleteId === selected.id ? '再点一次删除此结果' : '删除此结果'}</button></div>
          {(selected.images?.length || 0) > 1 && <div className="qi-versions qi-images" role="group" aria-label="选择生成图片">{selected.images!.map((image, index) => <button key={image.id} className="qi-version" aria-label={`选择第 ${index + 1} 张图片`} aria-pressed={image.id === selectedImage?.id} onClick={() => setSelectedImageId(image.id)}><img src={image.thumbnail} alt="" /><span>第 {index + 1} 张</span></button>)}</div>}
          {selectedImage && <figure className="l-image-fig"><div className="l-print"><img className="qi-result-image" src={selectedImage.thumbnail} alt="所选生成结果预览" /></div><figcaption><span className="mono">{selectedImage.width} × {selectedImage.height} px</span><span>输出为原尺寸 PNG</span></figcaption></figure>}
          <p className="qi-prompt-preview">{selected.prompt}</p>
          {selected.reference && <div className="qi-used-reference"><img src={selected.reference.thumbnail} alt="这个版本使用的参考图" /><span>这个版本的参考图</span></div>}
          {selected.error && <p className="l-field-help error" role="alert">{selected.error}</p>}
          {selected.status === 'handed-off' && <p className="l-field-help">历史网页任务，请在原网页对话中查看结果。</p>}
          {(selected.status === 'failed' || selected.status === 'interrupted') && (!selected.destination || selected.destination === 'api') && <button className="l-btn small" disabled={busy || running} onClick={() => void act(async () => { accept(await window.media.restore(selected.id, false)); setMessage('已恢复输入，点击生成才会重新发送。'); })}><Pencil size={14} />恢复这次输入</button>}
          {selectedImage && <div className="qi-result-actions">
            <button className="l-btn small" disabled={busy || running} onClick={() => void act(async () => { accept(await window.media.restore(selected.id, true, selectedImage.id)); setMessage('输入修改描述，只发送所选图片。'); })}><Pencil size={14} />基于此版本再改</button>
            <button className="l-btn small" disabled={busy} onClick={() => void act(() => output('copy'))}><Copy size={14} />复制</button><button className="l-btn small" disabled={busy} onClick={() => void act(() => output('save'))}><Download size={14} />另存</button><button className="l-btn small" disabled={busy} onClick={() => void act(() => output('pin'))}><Pin size={14} />贴图</button><button className="l-btn small" disabled={busy} onClick={() => void act(() => output('edit'))}><Pencil size={14} />编辑</button>
          </div>}
        </motion.div>}
      </section>}
    </main>
  </div>;
}
