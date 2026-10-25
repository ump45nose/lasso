import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, Clipboard, Copy, Download, ImagePlus, Loader2, Minus, Pencil, Pin, Settings2, Trash2, X } from 'lucide-react';
import type { MediaAPI, MediaAspect, MediaConfigInput, MediaJob, MediaOutputAction, MediaState } from '../../shared/media';
import { BrandMark } from '../BrandMark';
import { collapse, rise, Segmented } from '../motion';
import { useFonts } from '../fonts';
import './quick-image.css';

declare global { interface Window { media: MediaAPI } }

const statusLabels: Record<MediaJob['status'], string> = { running: '正在生成', succeeded: '已保存', failed: '生成失败', interrupted: '中断 · 结果未知' };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const newest = (jobs: MediaJob[]) => [...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/** A separate local surface: the generation continues in main when this window is hidden. */
export function QuickImage() {
  const [state, setState] = useState<MediaState | null>(null);
  useFonts(state ? { fonts: state.fonts, importedFonts: state.importedFonts } : undefined);
  const [prompt, setPrompt] = useState('');
  const [aspect, setAspect] = useState<MediaAspect>('1:1');
  const [selectedId, setSelectedId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [config, setConfig] = useState<MediaConfigInput>({ baseURL: '', generationModel: '', editModel: '' });
  const [credential, setCredential] = useState('');
  const [clearCredential, setClearCredential] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [deleteId, setDeleteId] = useState('');
  const initialized = useRef(false);
  const submittingRef = useRef(false);
  const busyRef = useRef(false);
  const pendingRequest = useRef<{ id: string; input: string } | null>(null);

  const acceptState = useCallback((next: MediaState) => {
    setState(next);
    setSelectedId(id => next.jobs.some(job => job.id === id) ? id : newest(next.jobs)[0]?.id || '');
    if (!initialized.current) {
      initialized.current = true;
      const latest = newest(next.jobs)[0];
      if (latest) { setPrompt(latest.prompt); setAspect(latest.aspect); }
      setConfig({ baseURL: next.config.baseURL, generationModel: next.config.generationModel, editModel: next.config.editModel });
    }
  }, []);

  useEffect(() => {
    let active = true;
    const stop = window.media.onState(next => { if (active) acceptState(next); });
    void window.media.state().then(next => { if (active) acceptState(next); }, reason => { if (active) setError(errorText(reason)); });
    return () => { active = false; stop(); };
  }, [acceptState]);

  const jobs = state ? newest(state.jobs) : [];
  const selected = jobs.find(job => job.id === selectedId);
  const running = jobs.find(job => job.status === 'running');
  const reference = state?.reference;
  const parent = reference && jobs.find(job => job.status === 'succeeded' && job.image?.id === reference.id);
  const currentInput = JSON.stringify({ prompt: prompt.trim(), aspect, referenceId: reference?.id });
  const submitted = pendingRequest.current?.input === currentInput ? jobs.find(job => job.requestId === pendingRequest.current?.id) : undefined;

  async function act(operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setMessage('');
    try { await operation(); } catch (reason) { setError(errorText(reason)); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function generate() {
    if (!state || !prompt.trim() || running || submittingRef.current) return;
    submittingRef.current = true; setSubmitting(true); setError(''); setMessage('');
    const input = JSON.stringify({ prompt: prompt.trim(), aspect, referenceId: reference?.id });
    if (pendingRequest.current?.input !== input) pendingRequest.current = { id: crypto.randomUUID(), input };
    const requestId = pendingRequest.current.id;
    try {
      const next = await window.media.generate({ requestId, prompt: prompt.trim(), aspect, ...(reference ? { referenceId: reference.id } : {}), ...(parent ? { parentId: parent.id } : {}) });
      acceptState(next);
      const job = next.jobs.find(item => item.requestId === requestId);
      if (job) setSelectedId(job.id);
    } catch (reason) { setError(errorText(reason)); }
    finally { submittingRef.current = false; setSubmitting(false); }
  }

  function toggleSettings() {
    if (!settingsOpen && state) {
      setConfig({ baseURL: state.config.baseURL, generationModel: state.config.generationModel, editModel: state.config.editModel });
      setCredential(''); setClearCredential(false);
    }
    setSettingsOpen(value => !value);
  }

  async function output(action: MediaOutputAction) {
    if (!selected) return;
    const result = await window.media.output(selected.id, action);
    if (result.error) throw Error(result.error);
    if (action === 'copy') setMessage('已复制原尺寸 PNG。');
    if (action === 'pin') setMessage('已打开贴图。');
  }

  return <div className="l-app qi-app">
    <header className="l-bar">
      <div className="l-wordmark"><BrandMark size={19} /><span>图片生成</span></div>
      <button className="l-icon" aria-label="生图连接设置" aria-expanded={settingsOpen} aria-pressed={settingsOpen} onClick={toggleSettings}><Settings2 size={15} /></button>
      <button className="l-icon" aria-label="隐藏生图窗口，后台继续" onClick={() => void act(() => window.media.hide())}><Minus size={16} /></button>
    </header>
    <main className="qi-body" onPaste={event => {
      if ([...event.clipboardData.items].some(item => item.type.startsWith('image/'))) {
        event.preventDefault();
        void act(async () => { const result = await window.media.prepareReference(); if (result.error) throw Error(result.error); });
      }
    }}>
      <AnimatePresence initial={false}>{settingsOpen && <motion.section key="settings" className="qi-settings" {...collapse} aria-label="生图连接设置">
        <div className="qi-settings-inner">
          <div className="l-field"><label htmlFor="qi-base">服务地址</label><input id="qi-base" className="l-input mono" value={config.baseURL} placeholder="https://…/v1" onChange={event => setConfig(value => ({ ...value, baseURL: event.target.value }))} /></div>
          <div className="l-pair">
            <div className="l-field"><label htmlFor="qi-generation-model">生成模型</label><input id="qi-generation-model" className="l-input mono" value={config.generationModel} onChange={event => setConfig(value => ({ ...value, generationModel: event.target.value }))} /></div>
            <div className="l-field"><label htmlFor="qi-edit-model">改图模型</label><input id="qi-edit-model" className="l-input mono" value={config.editModel} onChange={event => setConfig(value => ({ ...value, editModel: event.target.value }))} /></div>
          </div>
          <div className="l-field"><label htmlFor="qi-credential">凭据</label><input id="qi-credential" type="password" autoComplete="off" className="l-input mono" value={credential} placeholder={state?.config.hasCredential ? '已安全保存，留空保留' : '输入服务凭据'} onChange={event => { setCredential(event.target.value); setClearCredential(false); }} />
            {state?.config.hasCredential && <button className="l-ghost qi-clear-key" aria-pressed={clearCredential} onClick={() => { setClearCredential(value => !value); setCredential(''); }}>{clearCredential ? '保存时将清除凭据 · 撤销' : '清除已存凭据'}</button>}
          </div>
          <p className="l-field-help">填写此服务支持的生成和改图模型。连接检测仅检查服务连接。</p>
          <div className="qi-row">
            <button className="l-btn small" disabled={busy || !!running} onClick={() => void act(async () => {
              const next = await window.media.configure({ ...config, ...(clearCredential ? { credential: '' } : credential ? { credential } : {}) });
              acceptState(next); setCredential(''); setClearCredential(false); setMessage('连接设置已保存。');
            })}>保存设置</button>
            <button className="l-btn small" disabled={busy || !!running} onClick={() => void act(async () => setMessage((await window.media.checkConnection()).message))}>检测已保存连接</button>
          </div>
        </div>
      </motion.section>}</AnimatePresence>
      <section className="qi-input" aria-label="生成图片">
        <div className="l-image-head"><span className="l-small">{reference ? '单张参考图改图' : '文字生图'}</span><h2>这次，想画什么？</h2></div>
        <label className="l-field" htmlFor="qi-prompt"><span className="l-field-label">描述</span><textarea id="qi-prompt" className="l-textarea" value={prompt} placeholder={reference ? '描述想保留或改变的内容…' : '描述画面、细节和风格…'} onChange={event => setPrompt(event.target.value)} /></label>
        {reference ? <figure className="qi-reference">
          <img src={reference.thumbnail} alt="本次改图采用的最终参考图" />
          <figcaption><span>{parent ? '将只发送这个版本' : '已处理的参考图'}</span><span className="mono">{reference.width} × {reference.height} px</span></figcaption>
          <button className="l-icon" aria-label="移除参考图，切换文字生图" disabled={busy || submitting} onClick={() => void act(async () => acceptState(await window.media.setReference(null)))}><X size={15} /></button>
        </figure> : <button className="l-ghost dashed qi-reference-add" disabled={busy || submitting} onClick={() => void act(async () => {
          const result = await window.media.prepareReference(); if (result.error) throw Error(result.error);
        })}><Clipboard size={15} />从剪贴板添加参考图</button>}
        <p className="l-field-help">截图或剪贴板图片先在编辑器裁剪、处理隐私，再点「用于生图」。</p>
        <div className="qi-row qi-generate-row">
          <Segmented label="生成比例" value={aspect} onChange={setAspect} options={[['1:1', '1:1'], ['3:2', '3:2'], ['2:3', '2:3']]} />
          <button className="l-btn primary" disabled={!state || !prompt.trim() || !!running || submitting || busy || !!submitted} onClick={() => void generate()}>{running || submitting ? <Loader2 size={15} className="l-spin" /> : <ImagePlus size={15} />}{running || submitting ? '正在生成' : submitted ? '已提交' : reference ? '生成一个新版本' : '生成一张'}</button>
        </div>
        {(running || submitting) && <p className="qi-progress" role="status">隐藏窗口后继续生成。此次请求不会自动重试。</p>}
        {submitted && !running && !submitting && <div className="qi-row"><span className="l-field-help">此输入已提交。再次生成需要新请求。</span><button className="l-ghost" disabled={busy} onClick={() => {
          pendingRequest.current = null; setMessage('已准备新请求。点击生成才会再次发送。');
        }}>准备{ submitted.status === 'failed' || submitted.status === 'interrupted' ? '重新生成' : '再生成一张' }</button></div>}
      </section>
      {error && <div className="l-banner qi-notice" role="alert"><span>{error}</span></div>}
      {message && <p className="qi-message" role="status"><Check size={14} />{message}</p>}
      {jobs.length > 0 && <section className="qi-results" aria-label="已保存的结果和版本">
        <div className="qi-section-head"><span className="l-small">结果与版本</span><span className="l-field-help">成功结果会保留，可在重启后打开</span></div>
        <div className="qi-versions" role="list" aria-label="选择一个版本">
          {jobs.map((job, index) => <button key={job.id} className="qi-version" role="listitem" aria-label={`选择版本 ${jobs.length - index}，${statusLabels[job.status]}`} aria-pressed={selectedId === job.id} onClick={() => { setSelectedId(job.id); setDeleteId(''); }}>
            {job.image ? <img src={job.image.thumbnail} alt="" /> : <span className="qi-version-placeholder">{job.status === 'running' ? <Loader2 size={16} className="l-spin" /> : <ImagePlus size={16} />}</span>}
            <span>版本 {jobs.length - index}</span><small>{statusLabels[job.status]}</small>
          </button>)}
        </div>
        {selected && <motion.div key={selected.id} className="qi-selected" {...rise}>
          <div className="qi-section-head"><span className={`qi-result-status${selected.status === 'failed' || selected.status === 'interrupted' ? ' error' : ''}`}>{statusLabels[selected.status]}{selected.parentId && ' · 派生版本'}</span>
            <button className="l-ghost qi-delete" disabled={busy || selected.status === 'running'} onClick={() => {
              if (deleteId !== selected.id) { setDeleteId(selected.id); return; }
              void act(async () => { acceptState(await window.media.remove(selected.id)); if (pendingRequest.current?.id === selected.requestId) pendingRequest.current = null; setDeleteId(''); });
            }}><Trash2 size={13} />{deleteId === selected.id ? '再点一次删除此结果' : '删除此结果'}</button>
          </div>
          {selected.image && <figure className="l-image-fig"><div className="l-print"><img className="qi-result-image" src={selected.image.thumbnail} alt="所选生成结果预览" /></div><figcaption><span className="mono">{selected.image.width} × {selected.image.height} px</span><span>输出为原尺寸 PNG</span></figcaption></figure>}
          <p className="qi-prompt-preview">{selected.prompt}</p>
          {selected.reference && <div className="qi-used-reference"><img src={selected.reference.thumbnail} alt="这个版本使用的参考图" /><span>这个版本的参考图</span></div>}
          {selected.error && <p className="l-field-help error" role="alert">{selected.error}</p>}
          {selected.status === 'interrupted' && <p className="l-field-help">应用在生成期间退出，上游结果未知。描述和参考图已保留，未自动重发。</p>}
          {(selected.status === 'failed' || selected.status === 'interrupted') && <div className="qi-result-actions"><button className="l-btn small" disabled={busy || submitting || !!running} onClick={() => void act(async () => {
            acceptState(await window.media.setReference(selected.referenceId || null)); pendingRequest.current = null; setPrompt(selected.prompt); setAspect(selected.aspect); setMessage('已恢复描述和参考图，点击生成才会重新发送。'); document.getElementById('qi-prompt')?.focus();
          })}><Pencil size={14} />恢复这次输入</button></div>}
          {selected.status === 'succeeded' && <div className="qi-result-actions">
            <button className="l-btn small" disabled={busy || submitting} onClick={() => void act(async () => {
              acceptState(await window.media.setReference(selected.id)); setPrompt(''); setAspect(selected.aspect); setMessage('已选为参考图。输入修改描述后，只发送这个版本。'); document.getElementById('qi-prompt')?.focus();
            })}><Pencil size={14} />基于此版本再改</button>
            <button className="l-btn small" disabled={busy} onClick={() => void act(() => output('copy'))}><Copy size={14} />复制</button>
            <button className="l-btn small" disabled={busy} onClick={() => void act(() => output('save'))}><Download size={14} />另存</button>
            <button className="l-btn small" disabled={busy} onClick={() => void act(() => output('pin'))}><Pin size={14} />贴图</button>
            <button className="l-btn small" disabled={busy} onClick={() => void act(() => output('edit'))}><Pencil size={14} />编辑</button>
          </div>}
        </motion.div>}
      </section>}
      {!state && !error && <p className="l-field-help" role="status">正在读取生图记录…</p>}
    </main>
  </div>;
}
