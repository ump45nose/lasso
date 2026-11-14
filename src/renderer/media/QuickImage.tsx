import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  ImagePlus,
  Loader2,
  Lock,
  LockOpen,
  Pencil,
  PenLine,
  Pin,
  Sparkles,
  Trash2,
  X
} from 'lucide-react';
import type { MediaAPI, MediaJob, MediaOutputAction, MediaState } from '../../shared/media';
import { imageOptionsSummary } from '../../shared/media';
import { BrandMark } from '../BrandMark';
import { useFonts } from '../fonts';
import './quick-image.css';

declare global {
  interface Window {
    media: MediaAPI;
  }
}

const statusLabels: Record<MediaJob['status'], string> = {
  running: '生成中',
  succeeded: '已生成',
  'handed-off': '历史网页任务',
  failed: '生成失败',
  interrupted: '已中断'
};

export function QuickImage() {
  const [state, setState] = useState<MediaState | null>(null);
  const [prompt, setPrompt] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [selectedImageId, setSelectedImageId] = useState('');
  const [presetMenuOpen, setPresetMenuOpen] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteId, setDeleteId] = useState('');
  const draftId = useRef<string | null>(null);
  const newestJobId = useRef<string | null>(null);
  const guard = useRef(false);
  const pending = useRef<{ id: string; input: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useFonts(state || undefined);

  const accept = useCallback((next: MediaState) => {
    setState(next);
    const newest = next.jobs[0]?.id || null;
    const added = newest !== newestJobId.current;
    newestJobId.current = newest;
    setSelectedId(id => (!added && next.jobs.some(job => job.id === id) ? id : newest || ''));
    if (next.draft && draftId.current !== next.draft.id) {
      draftId.current = next.draft.id;
      setPrompt(next.draft.prompt);
      pending.current = { id: next.draft.id, input: JSON.stringify([next.draft.prompt.trim(), next.reference?.id || null]) };
    }
  }, []);

  useEffect(() => {
    let active = true;
    const stop = window.media.onState(next => {
      if (active) accept(next);
    });
    void window.media.state().then(
      next => {
        if (active) accept(next);
      },
      reason => {
        if (active) setError(String(reason));
      }
    );
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        void window.media.hide();
      } else if (event.key === 'Escape' && presetMenuOpen) {
        event.preventDefault();
        setPresetMenuOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      active = false;
      stop();
      window.removeEventListener('keydown', onKey);
    };
  }, [accept, presetMenuOpen]);

  const draft = state?.draft;
  const jobs = state?.jobs || [];
  const presets = state?.presets || [];
  const reference = state?.reference;
  const running = jobs.some(job => job.status === 'running');
  const selected = jobs.find(job => job.id === selectedId) || jobs[0];
  const selectedIdx = selected ? jobs.findIndex(job => job.id === selected.id) : -1;
  const versionNumber = selectedIdx >= 0 ? jobs.length - selectedIdx : 0;
  const selectedImage = selected?.images?.find(image => image.id === selectedImageId) || selected?.images?.[0];
  const currentInput = JSON.stringify([prompt.trim(), reference?.id || null]);
  const submitted = pending.current?.input === currentInput ? jobs.find(job => job.requestId === pending.current?.id && job.status === 'running') : undefined;

  async function act(operation: () => Promise<void>) {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }

  async function generate() {
    if (!draft || !prompt.trim() || running || submitted) return;
    await act(async () => {
      pending.current = { id: crypto.randomUUID(), input: currentInput };
      const next = await window.media.generate({ requestId: pending.current.id, draftId: draft.id, prompt: prompt.trim() });
      accept(next);
      const job = next.jobs.find(item => item.requestId === pending.current?.id);
      if (job) setSelectedId(job.id);
    });
  }

  async function output(action: MediaOutputAction) {
    if (!selected || !selectedImage) return;
    const result = await window.media.output(selected.id, action, selectedImage.id);
    if (result.error) throw Error(result.error);
    if (action === 'copy') setMessage('已复制图片');
    else if (action === 'pin') setMessage('已钉为贴图');
  }

  async function attachFile(file: File) {
    if (!file.type.startsWith('image/')) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    await act(async () => {
      const res = await window.media.addReferenceBytes(buf);
      if (res.error) throw Error(res.error);
      accept(res.state);
    });
  }

  const activeModel = draft
    ? reference
      ? draft.options.editModel || draft.options.generationModel || '未选改图模型'
      : draft.options.generationModel || '未选生成模型'
    : '';
  const qualityLabel =
    draft?.options.quality === 'high' ? '高清' : draft?.options.quality === 'medium' ? '标准' : draft?.options.quality === 'low' ? '快速' : '';
  const metaSummary = draft ? [activeModel, imageOptionsSummary(draft.options), qualityLabel].filter(Boolean).join(' · ') : '';

  return (
    <div
      className="l-app qi-win"
      onClick={() => presetMenuOpen && setPresetMenuOpen(false)}
      onPaste={event => {
        const imgItem = [...event.clipboardData.items].find(i => i.type.startsWith('image/'));
        const file = imgItem?.getAsFile();
        if (file) {
          event.preventDefault();
          void attachFile(file);
        }
      }}
      onDragOver={e => {
        if ([...e.dataTransfer.items].some(i => i.type.startsWith('image/'))) e.preventDefault();
      }}
      onDrop={e => {
        const file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
        if (file) {
          e.preventDefault();
          void attachFile(file);
        }
      }}
    >
      <header className="qi-wbar">
        <span className="qi-title">
          <BrandMark size={18} />
          <span>AI 生图</span>
        </span>
        <span className="grow" />
        <button
          type="button"
          className={'l-icon' + (state?.pinnedOnTop ? ' on' : '')}
          aria-label={state?.pinnedOnTop ? '取消置顶' : '置顶'}
          aria-pressed={state?.pinnedOnTop}
          title={state?.pinnedOnTop ? '已置顶' : '置顶'}
          onClick={() => state && void window.media.setPinned(!state.pinnedOnTop).then(accept)}
        >
          {state?.pinnedOnTop ? <Lock size={14} /> : <LockOpen size={14} />}
        </button>
        <button type="button" className="l-icon" aria-label="关闭 AI 生图" onClick={() => void window.media.hide()}>
          <X size={15} />
        </button>
      </header>

      {/* Upper Creation Section (B8F) */}
      <section className="qi-top" aria-label="生图输入">
        <div className="qi-preset-row">
          <div className="qi-preset-wrap" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              className="l-btn small"
              aria-haspopup="listbox"
              aria-expanded={presetMenuOpen}
              onClick={() => setPresetMenuOpen(v => !v)}
            >
              <span>{draft?.presetName || '选择生图预设'}</span>
              {presetMenuOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            {presetMenuOpen && (
              <div className="l-menu qi-preset-menu" role="listbox">
                {presets.length === 0 ? (
                  <div className="l-menu-empty">可在设置「AI 预设与生图」中添加生图预设</div>
                ) : (
                  presets.map(p => {
                    const isCurrent = p.id === draft?.presetId;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="option"
                        aria-selected={isCurrent}
                        className={'l-menu-item' + (isCurrent ? ' active' : '')}
                        onClick={() => {
                          setPresetMenuOpen(false);
                          void window.media.selectPreset(p.id).then(accept);
                        }}
                      >
                        <span className="trunc">{p.name}</span>
                        {isCurrent && <Check size={13} className="l-menu-right clay" />}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
          {metaSummary && <span className="l-chip mono trunc">{metaSummary}</span>}
        </div>

        <textarea
          ref={textareaRef}
          className="qi-prompt"
          aria-label="生图提示词"
          value={prompt}
          disabled={!draft}
          placeholder={reference ? '描述要基于参考图修改的细节…' : '描述你想生成的画面、风格与构图…'}
          onChange={event => {
            const text = event.target.value;
            setPrompt(text);
            if (draft) void window.media.saveDraft(draft.id, text).catch(reason => setError(String(reason)));
          }}
          onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void generate();
            }
          }}
        />

        <div className="qi-refs">
          {reference && (
            <div className="qi-ref" title={`参考图 ${reference.width}×${reference.height}`}>
              <img src={reference.thumbnail} alt="当前参考图" />
              <button
                type="button"
                className="qi-ref-rm"
                aria-label="移除参考图"
                disabled={busy || running}
                onClick={() => void act(async () => accept(await window.media.setReference(null)))}
              >
                <X size={10} />
              </button>
            </div>
          )}

          <button
            type="button"
            className="qi-ref add"
            aria-label="选择参考图"
            disabled={busy || running}
            onClick={() =>
              void act(async () => {
                const res = await window.media.pickReference();
                if (res.error) throw Error(res.error);
                accept(res.state);
              })
            }
          >
            <ImagePlus size={15} />
            <span>参考图</span>
          </button>

          <span className="qi-ref-hint">
            拖入、粘贴、截图，
            <br />
            或从下方版本带入
          </span>

          <span className="grow" />
          <span className="l-kbd">⌘↵</span>
          <button
            type="button"
            className="l-btn primary"
            disabled={!draft || !prompt.trim() || running || busy}
            onClick={() => void generate()}
          >
            {running || busy ? <Loader2 size={15} className="l-spin" /> : <Sparkles size={15} />}
            <span>{running ? '正在生成…' : reference ? '生成新版本' : '开始生成'}</span>
          </button>
        </div>

        {(error || message) && (
          <div className={'qi-banner' + (error ? ' err' : ' ok')} role={error ? 'alert' : 'status'}>
            <span className="grow">{error || message}</span>
            <button
              type="button"
              className="l-icon tiny"
              aria-label="关闭提示"
              onClick={() => {
                setError('');
                setMessage('');
              }}
            >
              <X size={12} />
            </button>
          </div>
        )}
      </section>

      {/* Lower Result & Horizontal Version Strip Section (B8F) */}
      <section className="qi-hist" aria-label="生成结果与版本历史">
        {selected ? (
          <>
            <div className="qi-hist-head">
              <span className="l-label">版本</span>
              <span className="qi-ver-meta mono">
                v{versionNumber}
                {selectedImage ? ` · ${selectedImage.width} × ${selectedImage.height}` : ''}
                {` · ${statusLabels[selected.status]}`}
              </span>
              {(selected.images?.length || 0) > 1 && (
                <div className="qi-subimgs" role="group" aria-label="同批图片切换">
                  {selected.images!.map((img, i) => (
                    <button
                      key={img.id}
                      type="button"
                      className={'qi-subimg-btn mono' + (img.id === selectedImage?.id ? ' on' : '')}
                      onClick={() => setSelectedImageId(img.id)}
                    >
                      #{i + 1}
                    </button>
                  ))}
                </div>
              )}
              <span className="grow" />
            </div>

            <div className="qi-stage">
              {selectedImage ? (
                <img className="qi-stage-img" src={selectedImage.thumbnail} alt={selected.prompt} />
              ) : selected.status === 'running' ? (
                <div className="qi-stage-empty">
                  <Loader2 size={20} className="l-spin" />
                  <span>正在生成图像，隐藏窗口也会继续完成…</span>
                </div>
              ) : (
                <div className="qi-stage-empty">
                  <span>{selected.error || statusLabels[selected.status]}</span>
                  {(selected.status === 'failed' || selected.status === 'interrupted') && (
                    <button
                      type="button"
                      className="l-btn small"
                      disabled={busy || running}
                      onClick={() =>
                        void act(async () => {
                          accept(await window.media.restore(selected.id, false));
                          setMessage('已恢复输入，点击开始生成重新请求');
                        })
                      }
                    >
                      恢复这次提示词
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="qi-actions">
              <button
                type="button"
                className="l-btn small"
                disabled={!selectedImage || busy || running}
                onClick={() =>
                  selectedImage &&
                  void act(async () => {
                    accept(await window.media.restore(selected.id, true, selectedImage.id));
                    setMessage('已带入上方参考图，输入修改要求即可');
                    textareaRef.current?.focus();
                  })
                }
              >
                <Pencil size={13} />
                <span>基于此图继续改</span>
              </button>
              <button type="button" className="l-ghost small" disabled={!selectedImage || busy} onClick={() => void act(() => output('copy'))}>
                <Copy size={13} />
                <span>复制</span>
              </button>
              <button type="button" className="l-ghost small" disabled={!selectedImage || busy} onClick={() => void act(() => output('save'))}>
                <Download size={13} />
                <span>另存</span>
              </button>
              <button type="button" className="l-ghost small" disabled={!selectedImage || busy} onClick={() => void act(() => output('pin'))}>
                <Pin size={13} />
                <span>贴图</span>
              </button>
              <button type="button" className="l-ghost small" disabled={!selectedImage || busy} onClick={() => void act(() => output('edit'))}>
                <PenLine size={13} />
                <span>标注</span>
              </button>
              <span className="grow" />
              {deleteId === selected.id ? (
                <button
                  type="button"
                  className="l-btn danger-solid small"
                  disabled={busy || running}
                  onClick={() =>
                    void act(async () => {
                      accept(await window.media.remove(selected.id));
                      setDeleteId('');
                    })
                  }
                >
                  <Trash2 size={13} />
                  <span>确认删除</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="l-icon small danger"
                  aria-label="删除此版本"
                  title="删除此版本"
                  disabled={busy || running}
                  onClick={() => setDeleteId(selected.id)}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>

            <div className="qi-vers" role="list" aria-label="版本缩略条">
              {jobs.map((job, idx) => {
                const vNum = jobs.length - idx;
                const isSel = job.id === selected.id;
                return (
                  <button
                    key={job.id}
                    type="button"
                    role="listitem"
                    aria-label={`版本 v${vNum}`}
                    aria-pressed={isSel}
                    className={'qi-ver' + (isSel ? ' sel' : '') + (job.status === 'running' ? ' run' : '')}
                    onClick={() => {
                      setSelectedId(job.id);
                      setSelectedImageId('');
                      setDeleteId('');
                    }}
                  >
                    {job.status === 'running' ? (
                      <span className="qi-ver-bar">
                        <i />
                      </span>
                    ) : job.images?.[0] ? (
                      <img src={job.images[0].thumbnail} alt="" />
                    ) : (
                      <span className="qi-ver-err mono">!</span>
                    )}
                    <span className="qi-vn mono">v{vNum}</span>
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <div className="qi-empty">
            <p className="qi-empty-title">把想法画在纸上</p>
            <p className="qi-empty-sub">在上方输入提示词，或粘贴一张参考图后按 ⌘↵ 开始生成。</p>
          </div>
        )}
      </section>
    </div>
  );
}
