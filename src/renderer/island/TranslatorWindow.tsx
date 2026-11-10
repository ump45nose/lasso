import { useCallback, useEffect, useRef, useState } from 'react';
import { ClipboardPaste, Copy, CornerDownLeft, Lock, Pin, RotateCcw, StickyNote, Unlock, X } from 'lucide-react';
import type { IslandAPI, TranslatorWindowState } from '../../shared/contracts';
import type { TranslationLang } from '../../shared/media';
import { useFonts } from '../fonts';
import './suite-windows.css';

declare global { interface Window { island: IslandAPI } }

const LANG_OPTIONS: readonly [TranslationLang, string][] = [
  ['auto', '中 ⇄ 英自动互译'], ['zh', '简体中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch']
];

export function TranslatorWindow() {
  const [state, setState] = useState<TranslatorWindowState | null>(null);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceRef = useRef<string | null>(null);
  const langRef = useRef<TranslationLang>('auto');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useFonts(state?.fonts);

  const clearDebounce = useCallback(() => {
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
  }, []);

  const flashNotice = useCallback((msg: string) => {
    setActError(null); setNotice(msg);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 1600);
  }, []);

  const submitTranslate = useCallback(async (text: string, targetLang: TranslationLang) => {
    clearDebounce(); sourceRef.current = text; setActError(null);
    const res = await window.island.translateInput({ text, targetLang });
    if (res?.error) setActError(res.error);
  }, [clearDebounce]);

  useEffect(() => {
    document.documentElement.classList.add('sw-html');
    document.body.classList.add('sw-body');
    const sync = (next: TranslatorWindowState) => {
      langRef.current = next.targetLang;
      if (next.sourceText !== sourceRef.current) {
        clearDebounce();
        sourceRef.current = next.sourceText;
        setDraft(next.sourceText);
      }
      setState(next);
    };
    const stop = window.island.onTranslatorState(sync);
    void window.island.getTranslatorState().then(sync);
    return () => { clearDebounce(); if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current); stop(); };
  }, [clearDebounce]);

  useEffect(() => { if (state?.open) textareaRef.current?.focus(); }, [state?.open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w')) {
        event.preventDefault(); clearDebounce(); window.island.closeTranslator();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && !window.getSelection()?.toString() && document.activeElement !== textareaRef.current && state?.translatedText.trim()) {
        event.preventDefault();
        void window.island.translatorAct('copy', state.translatedText).then(res => (res.error ? setActError(res.error) : flashNotice('已复制译文')));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearDebounce, flashNotice, state?.translatedText]);

  if (!state) return null;

  const hasResult = Boolean(state.translatedText.trim());
  const dotClass = state.status === 'streaming' ? 'running' : state.status === 'error' ? 'error' : state.status === 'done' ? 'complete' : 'idle';
  const modelMeta = [state.connectionName || '未选连接', state.model || '未选模型', state.firstTokenMs !== null ? `首字 ${state.firstTokenMs}ms` : null].filter(Boolean).join(' · ');
  const currentLangLabel = LANG_OPTIONS.find(([id]) => id === state.targetLang)?.[1] ?? state.targetLang;

  async function onLangChange(lang: TranslationLang) {
    clearDebounce(); langRef.current = lang; setActError(null);
    await window.island.setTranslatorLang(lang);
  }

  async function onPasteSource() {
    clearDebounce();
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      setDraft(text); await submitTranslate(text, langRef.current);
    } catch (error) { setActError(error instanceof Error ? error.message : '读取剪贴板失败'); }
  }

  async function runAct(action: 'copy' | 'replace' | 'pin' | 'note', okMsg: string) {
    if (!state?.translatedText.trim()) return;
    setActError(null);
    const res = await window.island.translatorAct(action, state.translatedText);
    if (res.error) setActError(res.error);
    else flashNotice(okMsg);
  }

  return (
    <div className="sw-stage">
      <section className="sw-win" role="dialog" aria-label="输入翻译">
        <header className="sw-topbar">
          <div className="sw-title-group">
            <span className="sw-clay-dot" />
            <strong className="sw-title">输入翻译</strong>
            <select className="sw-lang-select" aria-label="目标语言" value={state.targetLang}
              onChange={e => void onLangChange(e.target.value as TranslationLang)}>
              {LANG_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </div>
          <div className="sw-top-actions">
            <button type="button" className="sw-btn" aria-label="粘贴原文" onClick={() => void onPasteSource()}><ClipboardPaste size={13} /><span>粘贴原文</span></button>
            <button type="button" className={'sw-btn' + (state.pinnedOnTop ? ' active' : '')} aria-label="置顶" aria-pressed={state.pinnedOnTop}
              onClick={() => void window.island.setTranslatorPinned(!state.pinnedOnTop)}>
              {state.pinnedOnTop ? <Lock size={12} /> : <Unlock size={12} />}<span>置顶</span>
            </button>
            <button type="button" className="sw-icon-btn" aria-label="关闭输入翻译" onClick={() => window.island.closeTranslator()}><X size={14} /></button>
          </div>
        </header>

        <div className="sw-trans-pane">
          <textarea ref={textareaRef} className="sw-trans-source" aria-label="翻译原文" value={draft}
            placeholder="输入或粘贴要翻译的文本（停顿 450ms 自动翻译，Enter 立即翻译，Shift+Enter 换行）…"
            onChange={e => {
              const next = e.target.value;
              setDraft(next); setActError(null); clearDebounce();
              debounceRef.current = setTimeout(() => void submitTranslate(next, langRef.current), 450);
            }}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submitTranslate(draft, state.targetLang); } }}
          />
          <div className="sw-trans-meta">
            <div className="sw-trans-meta-left"><span className={'dot ' + dotClass} /><span className="sw-trans-meta-text mono" title={modelMeta}>{modelMeta}</span></div>
            {state.status === 'streaming'
              ? <button type="button" className="sw-trans-meta-btn" aria-label="停止翻译" onClick={() => window.island.cancelTranslation()}><span>停止</span></button>
              : <button type="button" className="sw-trans-meta-btn" aria-label="立即重译" disabled={!draft.trim()} onClick={() => void submitTranslate(draft, state.targetLang)}><RotateCcw size={11} /><span>↵ 立即翻译</span></button>}
          </div>
          <div className="sw-trans-result" role="region" aria-label="流式译文" aria-live="polite">
            {state.status === 'error' ? <div className="sw-trans-error" role="alert">{state.error || '翻译失败'}</div>
              : state.translatedText || state.status === 'streaming' ? <>{state.translatedText}{state.status === 'streaming' && <span className="l-caret" />}</>
              : <span className="sw-trans-placeholder">译文将在此流式展示…</span>}
          </div>
          <div className="sw-trans-actions">
            <button type="button" className="sw-btn" disabled={!hasResult} onClick={() => void runAct('note', '已入便签')}><StickyNote size={13} /><span>入便签</span></button>
            <button type="button" className="sw-btn" disabled={!hasResult || state.status === 'streaming'} onClick={() => void runAct('pin', '已钉为贴图')}><Pin size={13} /><span>钉为贴图</span></button>
            <button type="button" className="sw-btn" disabled={!hasResult || !state.canReplace} onClick={() => void runAct('replace', '已替换选区')}><CornerDownLeft size={13} /><span>替换原选区</span></button>
            <button type="button" className="sw-btn primary" disabled={!hasResult} onClick={() => void runAct('copy', '已复制译文')}><Copy size={13} /><span>复制译文</span></button>
          </div>
        </div>

        <footer className="sw-footer">
          {actError ? <span className="sw-footer-hint sw-footer-error" role="alert">{actError}</span>
            : notice ? <span className="sw-footer-hint sw-footer-notice">{notice}</span>
            : <span className="sw-footer-hint">目标语种：{currentLangLabel}</span>}
          <span className="mono">⌘W 关闭</span>
        </footer>
      </section>
    </div>
  );
}
