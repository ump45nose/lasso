import { useCallback, useEffect, useRef, useState } from 'react';
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
} from 'lucide-react';
import type { EditorView } from '@codemirror/view';
import type { IslandAPI, TranslatorEngineOption, TranslatorWindowState } from '../../shared/contracts';
import type { TranslationLang } from '../../shared/media';
import { formatMarkdownBreaks } from '../../shared/translation-markdown';
import { useFonts } from '../fonts';
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

  useFonts(state?.fonts);

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

  return (
    <div
      className="sw-stage"
      onClick={() => {
        if (langMenuOpen) setLangMenuOpen(false);
        if (engineMenuOpen) setEngineMenuOpen(false);
      }}
    >
      <section className="sw-win sw-tr" role="dialog" aria-label="翻译浮窗">
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
              {langMenuOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>

            {langMenuOpen && (
              <div className="sw-menu" role="listbox" aria-label="选择目标语言">
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
              </div>
            )}
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

        {sourceFolded && draft.trim() ? (
          <div className="sw-src-fold">
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
          </div>
        ) : (
          <div className={'sw-src-box' + (!sourceEditing && draft.trim() ? ' preview' : '')}>
            {!sourceEditing && draft.trim() ? (
              <div
                className="sw-src-preview sw-tr-prose sw-src-prose"
                role="region"
                aria-label="翻译原文预览"
                onClick={event => {
                  if ((event.target as HTMLElement | null)?.closest('a')) return;
                  if (window.getSelection()?.toString()) return;
                  setSourceEditing(true);
                }}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{formatMarkdownBreaks(draft)}</ReactMarkdown>
              </div>
            ) : (
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
            )}
            <div className="sw-src-tools">
              <button type="button" className="sw-btn ghost sm" onClick={() => void onPasteSource()}>
                <ClipboardPaste size={13} />
                <span>粘贴原文</span>
              </button>
              {draft.trim() && (
                <button
                  type="button"
                  className="sw-btn ghost sm"
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
          </div>
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
              {engineMenuOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>

            {engineMenuOpen && (
              <div className="sw-menu sw-engine-menu" role="listbox" aria-label="选择翻译引擎">
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
              </div>
            )}
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
          {state.status === 'error' ? (
            <div className="sw-tr-error" role="alert">
              {state.error || '翻译失败'}
            </div>
          ) : state.translatedText || state.status === 'streaming' ? (
            <div className="sw-tr-prose">
              {state.translatedText ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{formatMarkdownBreaks(state.translatedText)}</ReactMarkdown>
              ) : null}
              {state.status === 'streaming' && <span className="sw-caret" />}
            </div>
          ) : (
            <div className="sw-tr-placeholder">输入或粘贴原文后自动展示译文…</div>
          )}
        </div>

        <footer className="sw-wfoot">
          <button
            type="button"
            className="sw-btn ghost sm"
            disabled={!hasResult || !state.canReplace}
            onClick={() => void runAct('replace', '已替换选区')}
          >
            <CornerDownLeft size={14} />
            <span>替换原选区</span>
          </button>
          <button type="button" className="sw-btn ghost sm" disabled={!hasResult} onClick={() => void runAct('note', '已存入便签')}>
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
          {actError ? (
            <span className="sw-foot-msg err" role="alert">
              {actError}
            </span>
          ) : (
            notice && <span className="sw-foot-msg ok">{notice}</span>
          )}
          <span className="grow" />
          <button type="button" className="sw-btn pri sm" disabled={!hasResult} onClick={() => void runAct('copy', '已复制译文')}>
            <Copy size={14} />
            <span>复制译文</span>
            <kbd className="sw-kbd">⌘C</kbd>
          </button>
        </footer>
      </section>
    </div>
  );
}
