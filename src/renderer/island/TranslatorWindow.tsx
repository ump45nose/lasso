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
  Languages,
  Lock,
  LockOpen,
  NotebookPen,
  Pin,
  RotateCcw,
  Square,
  X
} from 'lucide-react';
import type { IslandAPI, TranslatorWindowState } from '../../shared/contracts';
import type { TranslationLang } from '../../shared/media';
import { useFonts } from '../fonts';
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

function formatMarkdownBreaks(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let inFence = false;
  const isBlockLine = (line: string) =>
    /^\s*(?:$|#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\||`{3,}|~{3,}|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line);
  return lines
    .map((line, idx) => {
      if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || idx === lines.length - 1) return line;
      const next = lines[idx + 1];
      if (!isBlockLine(line) && !isBlockLine(next) && !line.endsWith('  ')) {
        return `${line}  `;
      }
      return line;
    })
    .join('\n');
}

export function TranslatorWindow() {
  const [state, setState] = useState<TranslatorWindowState | null>(null);
  const [draft, setDraft] = useState('');
  const [sourceExpanded, setSourceExpanded] = useState(true);
  const [langMenuOpen, setLangMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceRef = useRef<string | null>(null);
  const modeKeyRef = useRef<string>('');
  const langRef = useRef<TranslationLang>('auto');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
        setSourceExpanded(!(next.fromSelection && next.sourceText.trim()));
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
    if (state?.open && sourceExpanded) {
      setTimeout(() => textareaRef.current?.focus(), 20);
    }
  }, [state?.open, sourceExpanded]);

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
        if (langMenuOpen) {
          setLangMenuOpen(false);
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
        document.activeElement !== textareaRef.current &&
        state?.translatedText.trim()
      ) {
        event.preventDefault();
        void runAct('copy', '已复制译文');
      } else if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.isComposing &&
        document.activeElement !== textareaRef.current &&
        state?.canReplace &&
        state?.translatedText.trim()
      ) {
        event.preventDefault();
        void runAct('replace', '已替换选区');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearDebounce, langMenuOpen, runAct, state?.canReplace, state?.translatedText]);

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

  async function onPasteSource() {
    clearDebounce();
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      setDraft(text);
      setSourceExpanded(true);
      await submitTranslate(text, langRef.current);
    } catch (error) {
      setActError(error instanceof Error ? error.message : '读取剪贴板失败');
    }
  }

  return (
    <div className="sw-stage" onClick={() => langMenuOpen && setLangMenuOpen(false)}>
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
              onClick={() => setLangMenuOpen(v => !v)}
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

        {!sourceExpanded && draft.trim() ? (
          <div className="sw-src-fold">
            <span className="sw-src-tag mono">{detectSourceTag(draft)}</span>
            <span className="sw-src-trunc">{draft.replace(/\s+/g, ' ')}</span>
            <button
              type="button"
              className="sw-link-btn"
              onClick={() => {
                setSourceExpanded(true);
                setTimeout(() => textareaRef.current?.focus(), 20);
              }}
            >
              <span>原文</span>
              <ChevronDown size={13} />
            </button>
          </div>
        ) : (
          <div className="sw-src-box">
            <textarea
              ref={textareaRef}
              className="sw-src-textarea"
              aria-label="翻译原文"
              rows={3}
              value={draft}
              placeholder="输入或粘贴要翻译的文本…"
              onChange={e => {
                const next = e.target.value;
                setDraft(next);
                setActError(null);
                clearDebounce();
                debounceRef.current = setTimeout(() => void submitTranslate(next, langRef.current), 420);
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submitTranslate(draft, state.targetLang);
                }
              }}
            />
            <div className="sw-src-tools">
              <button type="button" className="sw-btn ghost sm" onClick={() => void onPasteSource()}>
                <ClipboardPaste size={13} />
                <span>粘贴原文</span>
              </button>
              {state.fromSelection && draft.trim() && (
                <button type="button" className="sw-btn ghost sm" onClick={() => setSourceExpanded(false)}>
                  <span>折叠</span>
                  <ChevronUp size={12} />
                </button>
              )}
              <span className="grow" />
              <span className="sw-keyhint">
                <kbd className="sw-kbd">↵</kbd>翻译
              </span>
              <span className="sw-keyhint">
                <kbd className="sw-kbd">⇧↵</kbd>换行
              </span>
            </div>
          </div>
        )}

        <div className="sw-engine">
          <span className={'dot ' + dotClass} />
          <span className="sw-engine-meta mono" title={engineMeta}>
            {engineMeta}
          </span>
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
