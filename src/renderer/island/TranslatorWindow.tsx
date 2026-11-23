import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Copy,
  CornerDownLeft,
  Eye,
  KeyRound,
  Languages,
  Lock,
  LockOpen,
  NotebookPen,
  Pencil,
  Pin,
  RotateCcw,
  Square,
  X
} from '../icons';
import type { EditorView } from '@codemirror/view';
import type { IslandAPI, TranslatorEngineOption, TranslatorWindowState } from '../../shared/contracts';
import type { TranslationLang } from '../../shared/media';
import { formatMarkdownBreaks } from '../../shared/translation-markdown';
import { useAppearance } from '../fonts';
import { dropdown, ease, fade, useSurfaceReveal } from '../motion';
import { NoteEditor } from './NoteEditor';
import './suite-windows.css';

declare global {
  interface Window {
    island: IslandAPI;
  }
}

const LANG_OPTIONS: readonly [TranslationLang, string, string][] = [
  ['auto', '中 ⇄ 英 自动互译', '中 ⇄ 英 · 自动'],
  ['zh', '简体中文', '简体中文'],
  ['en', 'English', 'English'],
  ['ja', '日本語', '日本語'],
  ['ko', '한국어', '한국어'],
  ['fr', 'Français', 'Français'],
  ['de', 'Deutsch', 'Deutsch']
];

function detectSourceTag(text: string): string {
  const sample = text.trim().slice(0, 120);
  if (!sample) return 'SRC';
  if (/[぀-ヿ]/.test(sample)) return 'JA';
  if (/[가-힯]/.test(sample)) return 'KO';
  if (/[一-鿿]/.test(sample)) return 'ZH';
  return 'EN';
}

export function TranslatorWindow() {
  const [state, setState] = useState<TranslatorWindowState | null>(null);
  const [draft, setDraft] = useState('');
  const [sourceFolded, setSourceFolded] = useState(false);
  const [sourceEditing, setSourceEditing] = useState(true);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [engineMenuOpen, setEngineMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceRef = useRef<string | null>(null);
  const modeKeyRef = useRef<string>('');
  const langRef = useRef<TranslationLang>('auto');
  const editorRef = useRef<EditorView | null>(null);
  const winRef = useRef<HTMLElement | null>(null);
  const lastSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });

  useAppearance(state?.fonts);
  const { controls } = useSurfaceReveal(winRef, { active: state?.open });

  const clearDebounce = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  const flashNotice = useCallback((msg: string) => {
    setActError(null);
    setNotice(msg);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 1500);
  }, []);

  const submitTranslate = useCallback(
    async (text: string, targetLang: TranslationLang) => {
      clearDebounce();
      sourceRef.current = text;
      setActError(null);
      const res = await window.island.translateInput({ text, targetLang });
      if (res?.error) setActError(res.error);
    },
    [clearDebounce]
  );

  useEffect(() => {
    document.documentElement.classList.add('sw-html');
    document.body.classList.add('sw-body');
    const sync = (next: TranslatorWindowState) => {
      langRef.current = next.targetLang;
      const nextModeKey = `${next.open}:${next.fromSelection}:${next.sourceText.slice(0, 48)}`;
      if (next.sourceText !== sourceRef.current) {
        clearDebounce();
        sourceRef.current = next.sourceText;
        setDraft(next.sourceText);
      }
      if (nextModeKey !== modeKeyRef.current) {
        modeKeyRef.current = nextModeKey;
        const hasSource = Boolean(next.sourceText.trim());
        setSourceFolded(false);
        setSourceEditing(!hasSource);
      }
      setState(next);
    };
    const stop = window.island.onTranslatorState(sync);
    void window.island.getTranslatorState().then(sync);
    return () => {
      clearDebounce();
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      stop();
    };
  }, [clearDebounce]);

  useEffect(() => {
    if (state?.open && !sourceFolded && sourceEditing) {
      setTimeout(() => editorRef.current?.focus(), 20);
    }
  }, [state?.open, sourceFolded, sourceEditing]);

  useLayoutEffect(() => {
    if (!state?.open) return;
    const fitWindow = () => {
      const winEl = winRef.current;
      if (!winEl) return;
      const barH = winEl.querySelector<HTMLElement>('.sw-wbar')?.offsetHeight ?? 44;
      const srcEl = winEl.querySelector<HTMLElement>('.sw-src-box, .sw-src-fold');
      const srcH = srcEl ? srcEl.offsetHeight + 12 : 0;
      const engineH = winEl.querySelector<HTMLElement>('.sw-engine')?.offsetHeight ?? 34;
      const footH = winEl.querySelector<HTMLElement>('.sw-wfoot')?.offsetHeight ?? 50;
      const contentEl = winEl.querySelector<HTMLElement>('.sw-tr-out .sw-tr-prose, .sw-tr-out .sw-tr-error, .sw-tr-out .sw-tr-placeholder');
      const contentH = contentEl ? Math.ceil(contentEl.scrollHeight) : 64;
      const combined = `${draft}\n${state.translatedText || ''}`;
      const maxLen = Math.max(draft.trim().length, (state.translatedText || '').trim().length);
      const lineCount = Math.max(draft.split('\n').length, (state.translatedText || '').split('\n').length);
      const hasWideBlock = /```|\n\s*\|.+\|/.test(combined);
      const width = hasWideBlock || maxLen > 340 ? 660 : maxLen > 140 || lineCount >= 4 ? 580 : 520;
      // 28px stage padding + 26px .sw-tr-out vertical padding + 6px border/breathing room
      const height = Math.max(340, barH + srcH + engineH + Math.max(92, contentH) + footH + 60);
      const prev = lastSizeRef.current;
      if (Math.abs(width - prev.width) >= 6 || Math.abs(height - prev.height) >= 6) {
        lastSizeRef.current = { width, height };
        window.island.resizeTranslator?.({ width, height });
      }
    };
    const raf = requestAnimationFrame(fitWindow);
    const proseEl = winRef.current?.querySelector<HTMLElement>('.sw-tr-out .sw-tr-prose');
    const ro = proseEl && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fitWindow) : null;
    if (proseEl && ro) ro.observe(proseEl);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [state?.open, state?.translatedText, state?.status, state?.error, draft, sourceFolded, sourceEditing]);

  const runAct = useCallback(
    async (action: 'copy' | 'replace' | 'pin' | 'note', okMsg: string) => {
      if (!state?.translatedText.trim()) return;
      setActError(null);
      const res = await window.island.translatorAct(action, state.translatedText);
      if (res.error) setActError(res.error);
      else flashNotice(okMsg);
    },
    [flashNotice, state?.translatedText]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (langMenuOpen || engineMenuOpen) {
          setLangMenuOpen(false);
          setEngineMenuOpen(false);
        } else {
          clearDebounce();
          window.island.closeTranslator();
        }
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        clearDebounce();
        window.island.closeTranslator();
      } else if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === 'c' &&
        !window.getSelection()?.toString() &&
        !editorRef.current?.hasFocus &&
        state?.translatedText.trim()
      ) {
        event.preventDefault();
        void runAct('copy', '已复制译文');
      } else if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.isComposing &&
        !editorRef.current?.hasFocus &&
        state?.canReplace &&
        state?.translatedText.trim()
      ) {
        event.preventDefault();
        void runAct('replace', '已替换选区');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearDebounce, engineMenuOpen, langMenuOpen, runAct, state?.canReplace, state?.translatedText]);

  if (!state) return null;

  const hasResult = Boolean(state.translatedText.trim());
  const dotClass =
    state.status === 'streaming'
      ? 'running'
      : state.status === 'error'
        ? 'error'
        : state.status === 'done'
          ? 'olive'
          : 'idle';

  const latencyLabel =
    state.firstTokenMs !== null
      ? state.connectionName.includes('极速') || !state.model
        ? `${state.firstTokenMs}ms`
        : `首字 ${state.firstTokenMs}ms`
      : null;
  const engineMeta = [state.connectionName || '未配置引擎', state.model || null, latencyLabel].filter(Boolean).join(' · ');
  const currentLangChip = LANG_OPTIONS.find(([id]) => id === state.targetLang)?.[2] ?? state.targetLang;

  async function onSelectLang(lang: TranslationLang) {
    setLangMenuOpen(false);
    clearDebounce();
    langRef.current = lang;
    setActError(null);
    await window.island.setTranslatorLang(lang);
  }

  async function onSelectEngine(option: TranslatorEngineOption) {
    setEngineMenuOpen(false);
    clearDebounce();
    setActError(null);
    const res = await window.island.setTranslatorEngine({
      provider: option.provider,
      connectionId: option.connectionId,
      model: option.model
    });
    if (res?.error) setActError(res.error);
  }

  async function onPasteSource() {
    clearDebounce();
    try {
      const text = (await window.island.readTranslatorClipboard()) || (await navigator.clipboard.readText());
      if (!text) return;
      setDraft(text);
      setSourceFolded(false);
      setSourceEditing(false);
      await submitTranslate(text, langRef.current);
    } catch (error) {
      setActError(error instanceof Error ? error.message : '读取剪贴板失败');
    }
  }

  const activeEngineId = state.provider === 'llm' ? `llm:${state.connectionId}` : state.provider;
  const outKey = state.status === 'error' ? 'error' : state.translatedText || state.status === 'streaming' ? 'result' : 'empty';
  const srcKey = sourceFolded && draft.trim() ? 'folded' : !sourceEditing && draft.trim() ? 'preview' : 'edit';

  return (
    <div
      className="sw-stage"
      onClick={() => {
        if (langMenuOpen) setLangMenuOpen(false);
        if (engineMenuOpen) setEngineMenuOpen(false);
      }}
    >
      <motion.section ref={winRef} className="sw-win sw-tr sk-draw" role="dialog" aria-label="翻译浮窗" animate={controls}>
        <header className="sw-wbar">
          <span className="sw-wbar-title">
            <Languages size={15} className="sw-muted-ic" />
            <span>翻译</span>
          </span>

          <div className="sw-lang-wrap" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              className={'sw-lang' + (langMenuOpen ? ' open' : '')}
              aria-label="目标语言"
              aria-haspopup="listbox"
              aria-expanded={langMenuOpen}
              onClick={() => {
                setEngineMenuOpen(false);
                setLangMenuOpen(v => !v);
              }}
            >
              <span>{currentLangChip}</span>
              <ChevronDown size={13} className="sw-caret-ic" />
            </button>

            <AnimatePresence>
              {langMenuOpen && (
                <motion.div
                  key="lang-menu"
                  className="sw-menu"
                  role="listbox"
                  aria-label="选择目标语言"
                  style={{ transformOrigin: 'top left' }}
                  {...dropdown()}
                >
                  {LANG_OPTIONS.map(([id, fullLabel]) => {
                    const selected = id === state.targetLang;
                    return (
                      <button
                        key={id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={'sw-mi' + (selected ? ' active' : '')}
                        onClick={() => void onSelectLang(id)}
                      >
                        <span>{fullLabel}</span>
                        {selected && <Check size={14} className="sw-mi-r clay" />}
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <span className="grow" />
          <button
            type="button"
            className={'sw-ib' + (state.pinnedOnTop ? ' on' : '')}
            aria-label={state.pinnedOnTop ? '取消置顶' : '置顶'}
            aria-pressed={state.pinnedOnTop}
            title={state.pinnedOnTop ? '已置顶' : '置顶'}
            onClick={() => void window.island.setTranslatorPinned(!state.pinnedOnTop)}
          >
            {state.pinnedOnTop ? <Lock size={14} /> : <LockOpen size={14} />}
          </button>
          <button type="button" className="sw-ib" aria-label="关闭翻译" onClick={() => window.island.closeTranslator()}>
            <X size={15} />
          </button>
        </header>

        {srcKey === 'folded' ? (
          <motion.div
            key="src-folded"
            className="sw-src-fold"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.16, ease } }}
          >
            <span className="sw-src-tag mono">{detectSourceTag(draft)}</span>
            <span className="sw-src-trunc">{draft.replace(/\s+/g, ' ')}</span>
            <button
              type="button"
              className="sw-link-btn"
              onClick={() => {
                setSourceFolded(false);
                setSourceEditing(false);
              }}
            >
              <span>原文</span>
              <ChevronDown size={13} />
            </button>
          </motion.div>
        ) : (
          <motion.div
            key="src-open"
            className={'sw-src-box' + (!sourceEditing && draft.trim() ? ' preview' : '')}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.16, ease } }}
          >
            {srcKey === 'preview' ? (
              <motion.div
                key="src-preview"
                className="sw-src-preview sw-tr-prose sw-src-prose"
                role="region"
                aria-label="翻译原文预览"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: 0.14, ease } }}
                onClick={event => {
                  if ((event.target as HTMLElement | null)?.closest('a')) return;
                  if (window.getSelection()?.toString()) return;
                  setSourceEditing(true);
                }}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{formatMarkdownBreaks(draft)}</ReactMarkdown>
              </motion.div>
            ) : (
              <motion.div
                key="src-edit"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: { duration: 0.14, ease } }}
              >
                <NoteEditor
                  className="sw-src-editor"
                  ariaLabel="翻译原文"
                  placeholderText="输入或粘贴要翻译的文本（支持 Markdown）…"
                  value={draft}
                  editorRef={editorRef}
                  onChange={next => {
                    setDraft(next);
                    setActError(null);
                    clearDebounce();
                    debounceRef.current = setTimeout(() => void submitTranslate(next, langRef.current), 420);
                  }}
                  onSubmit={text => {
                    if (text.trim()) setSourceEditing(false);
                    void submitTranslate(text, langRef.current);
                  }}
                  onPasteHtml={(plain, html) => window.island.htmlToMarkdown(plain, html)}
                />
              </motion.div>
            )}
            <div className="sw-src-tools">
              <button type="button" className="sw-btn ghost sm sk-wiggle" onClick={() => void onPasteSource()}>
                <ClipboardPaste size={13} />
                <span>粘贴原文</span>
              </button>
              {draft.trim() && (
                <button
                  type="button"
                  className="sw-btn ghost sm sk-wiggle"
                  onClick={() => setSourceEditing(v => !v)}
                >
                  {sourceEditing ? <Eye size={13} /> : <Pencil size={12} />}
                  <span>{sourceEditing ? '预览' : '编辑'}</span>
                </button>
              )}
              {draft.trim() && (
                <button type="button" className="sw-btn ghost sm" onClick={() => setSourceFolded(true)}>
                  <span>折叠</span>
                  <ChevronUp size={12} />
                </button>
              )}
              <span className="grow" />
              {sourceEditing ? (
                <>
                  <span className="sw-keyhint">
                    <kbd className="sw-kbd">↵</kbd>翻译
                  </span>
                  <span className="sw-keyhint">
                    <kbd className="sw-kbd">⇧↵</kbd>换行
                  </span>
                </>
              ) : (
                <span className="sw-src-tag mono">{detectSourceTag(draft)} · Markdown</span>
              )}
            </div>
          </motion.div>
        )}

        <div className="sw-engine">
          <div className="sw-engine-wrap" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              className={'sw-engine-btn' + (engineMenuOpen ? ' open' : '')}
              aria-label="切换翻译引擎"
              aria-haspopup="listbox"
              aria-expanded={engineMenuOpen}
              title={engineMeta}
              onClick={() => {
                setLangMenuOpen(false);
                setEngineMenuOpen(v => !v);
              }}
            >
              <span className={'dot ' + dotClass} />
              <span className="sw-engine-meta mono">{engineMeta}</span>
              <ChevronDown size={12} className="sw-caret-ic" />
            </button>

            <AnimatePresence>
              {engineMenuOpen && (
                <motion.div
                  key="engine-menu"
                  className="sw-menu sw-engine-menu"
                  role="listbox"
                  aria-label="选择翻译引擎"
                  style={{ transformOrigin: 'top left' }}
                  {...dropdown()}
                >
                  {(state.engines ?? []).map(option => {
                    const selected = option.id === activeEngineId;
                    return (
                      <button
                        key={option.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={'sw-mi' + (selected ? ' active' : '')}
                        onClick={() => void onSelectEngine(option)}
                      >
                        <span>{option.label}</span>
                        {option.detail && (
                          <span className={'sw-mi-sub mono' + (option.needsKey ? ' warn' : '')}>
                            {option.detail}
                          </span>
                        )}
                        {selected && <Check size={14} className="sw-mi-r clay" />}
                      </button>
                    );
                  })}
                  <div className="sw-menu-sep" role="separator" />
                  <button
                    type="button"
                    className="sw-mi"
                    onClick={() => {
                      setEngineMenuOpen(false);
                      void window.island.openTranslatorSettings('connections');
                    }}
                  >
                    <KeyRound size={13} className="sw-muted-ic" />
                    <span>配置 API 连接与密钥…</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <span className="grow" />
          {state.status === 'streaming' ? (
            <button type="button" className="sw-ib sm" aria-label="停止翻译" title="停止" onClick={() => window.island.cancelTranslation()}>
              <Square size={12} />
            </button>
          ) : (
            <button
              type="button"
              className="sw-ib sm"
              aria-label="重新翻译"
              title="重新翻译"
              disabled={!draft.trim()}
              onClick={() => void submitTranslate(draft, state.targetLang)}
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>

        <div className="sw-tr-out" role="region" aria-label="译文" aria-live="polite">
          {outKey === 'error' ? (
            <motion.div
              key="error"
              className="sw-tr-error"
              role="alert"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.14, ease } }}
            >
              {state.error || '翻译失败'}
            </motion.div>
          ) : outKey === 'result' ? (
            <motion.div
              key="result"
              className="sw-tr-prose"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.14, ease } }}
            >
              {state.translatedText ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{formatMarkdownBreaks(state.translatedText)}</ReactMarkdown>
              ) : null}
              {state.status === 'streaming' && <span className="sw-caret" />}
            </motion.div>
          ) : (
            <motion.div
              key="empty"
              className="sw-tr-placeholder"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.14, ease } }}
            >
              输入或粘贴原文后自动展示译文…
            </motion.div>
          )}
        </div>

        <footer className="sw-wfoot">
          <button
            type="button"
            className="sw-btn ghost sm sk-wiggle"
            disabled={!hasResult || !state.canReplace}
            onClick={() => void runAct('replace', '已替换选区')}
          >
            <CornerDownLeft size={14} />
            <span>替换原选区</span>
          </button>
          <button type="button" className="sw-btn ghost sm sk-wiggle" disabled={!hasResult} onClick={() => void runAct('note', '已存入便签')}>
            <NotebookPen size={14} />
            <span>存入便签</span>
          </button>
          <button
            type="button"
            className="sw-ib sm"
            aria-label="钉为贴图"
            title="钉为贴图"
            disabled={!hasResult || state.status === 'streaming'}
            onClick={() => void runAct('pin', '已钉为贴图')}
          >
            <Pin size={14} />
          </button>
          <AnimatePresence mode="wait" initial={false}>
            {actError ? (
              <motion.span key={'err-' + actError} className="sw-foot-msg err" role="alert" {...fade}>
                {actError}
              </motion.span>
            ) : notice ? (
              <motion.span key={'ok-' + notice} className="sw-foot-msg ok" {...fade}>
                {notice}
              </motion.span>
            ) : null}
          </AnimatePresence>
          <span className="grow" />
          <button type="button" className="sw-btn pri sm sk-wiggle" disabled={!hasResult} onClick={() => void runAct('copy', '已复制译文')}>
            <Copy size={14} />
            <span>复制译文</span>
            <kbd className="sw-kbd">⌘C</kbd>
          </button>
        </footer>
      </motion.section>
    </div>
  );
}
