import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText,
  Folder,
  Image as ImageIcon,
  Languages,
  Lock,
  LockOpen,
  NotebookPen,
  Pin,
  Search,
  Sparkles,
  Star,
  Trash2,
  X
} from 'lucide-react';
import type { ClipboardEntry, ClipboardWindowState, IslandAPI } from '../../shared/contracts';
import { useFonts } from '../fonts';
import { Segmented } from '../motion';
import './suite-windows.css';

declare global {
  interface Window {
    island: IslandAPI;
  }
}

type ClipFilter = 'all' | 'text' | 'image' | 'files' | 'fav';
const FILTER_OPTIONS: readonly (readonly [ClipFilter, string])[] = [
  ['all', '全部'],
  ['text', '文本'],
  ['image', '图片'],
  ['files', '文件'],
  ['fav', '★ 收藏']
];

function formatRelativeTime(createdAt: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (sec < 45) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  return sec < 86400 ? `${Math.floor(sec / 3600)} 小时前` : `${Math.floor(sec / 86400)} 天前`;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return 'PNG';
  if (bytes < 1024) return `PNG · ${bytes} B`;
  if (bytes < 1024 * 1024) return `PNG · ${Math.round(bytes / 1024)} KB`;
  return `PNG · ${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function looksMono(text: string): boolean {
  const s = text.trim();
  return /^(https?:\/\/|[{~[/]|export\s|import\s|const\s|function\s|npm\s|git\s|cd\s)/.test(s) || s.includes('": ');
}

export function ClipboardWindow() {
  const [state, setState] = useState<ClipboardWindowState | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ClipFilter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actError, setActError] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useFonts(state?.fonts);

  const flashNotice = useCallback((msg: string) => {
    setActError(null);
    setNotice(msg);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 1500);
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('sw-html');
    document.body.classList.add('sw-body');
    const sync = (next: ClipboardWindowState) => {
      setState(next);
      setConfirmClear(false);
    };
    const stop = window.island.onClipboardState(sync);
    void window.island.getClipboardState().then(sync);
    setTimeout(() => searchInputRef.current?.focus(), 20);
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      stop();
    };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (state?.entries ?? [])
      .filter(entry => {
        if (filter === 'text' && entry.kind !== 'text') return false;
        if (filter === 'image' && entry.kind !== 'image') return false;
        if (filter === 'files' && entry.kind !== 'files') return false;
        if (filter === 'fav' && !entry.favorite) return false;
        return !q || [entry.text, entry.preview, entry.sourceAppName, entry.sourceBundleId].some(s => s.toLowerCase().includes(q));
      })
      .sort((a, b) => Number(b.favorite) - Number(a.favorite));
  }, [state?.entries, query, filter]);

  const activeId = filtered.length ? (selectedId && filtered.some(item => item.id === selectedId) ? selectedId : filtered[0].id) : null;
  const selected = filtered.find(item => item.id === activeId) ?? null;

  const runAct = useCallback(
    async (req: Parameters<IslandAPI['clipboardAct']>[0], okMsg?: string) => {
      setActError(null);
      setConfirmClear(false);
      const res = await window.island.clipboardAct(req);
      if (res.error) setActError(res.error);
      else if (okMsg) flashNotice(okMsg);
    },
    [flashNotice]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (confirmClear) setConfirmClear(false);
        else window.island.closeClipboard();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        window.island.closeClipboard();
      } else if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
        const idx = Number(event.key) - 1;
        const target = filtered[idx];
        if (target) {
          event.preventDefault();
          void runAct({ action: 'paste', id: target.id }, '已粘贴到原窗口');
        }
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && filtered.length) {
        event.preventDefault();
        const idx = filtered.findIndex(item => item.id === activeId);
        const nextIdx =
          event.key === 'ArrowDown' ? Math.min(filtered.length - 1, idx < 0 ? 0 : idx + 1) : Math.max(0, idx <= 0 ? 0 : idx - 1);
        const nextId = filtered[nextIdx].id;
        setSelectedId(nextId);
        listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${nextId}"]`)?.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && selected) {
        if (document.activeElement?.tagName.toLowerCase() === 'button' && !document.activeElement?.classList.contains('sw-crow')) return;
        event.preventDefault();
        if (event.metaKey || event.ctrlKey) {
          void runAct({ action: 'paste-plain', id: selected.id }, '已纯文本粘贴');
        } else {
          void runAct({ action: 'paste', id: selected.id }, '已粘贴到原窗口');
        }
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && selected) {
        const input = searchInputRef.current;
        if ((input && document.activeElement === input && input.selectionStart !== input.selectionEnd) || window.getSelection()?.toString()) {
          return;
        }
        event.preventDefault();
        void runAct({ action: 'copy', id: selected.id }, '已复制');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeId, confirmClear, filtered, runAct, selected]);

  if (!state) return null;

  const previewLines = selected && selected.kind !== 'image' ? (selected.text || selected.preview || '').split('\n') : [];

  return (
    <div className="sw-stage">
      <section className="sw-win sw-clip" role="dialog" aria-label="剪贴板历史">
        <header className="sw-wbar sw-clip-bar">
          <label className="sw-search-box">
            <Search size={14} className="sw-muted-ic" />
            <input
              ref={searchInputRef}
              type="search"
              className="sw-search-in"
              aria-label="搜索剪贴板历史"
              placeholder="搜索内容、文件名或来源应用"
              value={query}
              onChange={e => {
                setQuery(e.target.value);
                setConfirmClear(false);
              }}
            />
          </label>

          <Segmented
            label="剪贴板分类"
            value={filter}
            options={FILTER_OPTIONS}
            onChange={next => {
              setFilter(next);
              setConfirmClear(false);
            }}
          />

          <button
            type="button"
            className={'sw-ib' + (state.pinnedOnTop ? ' on' : '')}
            aria-label={state.pinnedOnTop ? '取消置顶' : '置顶'}
            aria-pressed={state.pinnedOnTop}
            title={state.pinnedOnTop ? '已置顶' : '置顶'}
            onClick={() => void runAct({ action: 'set-pinned', pinned: !state.pinnedOnTop })}
          >
            {state.pinnedOnTop ? <Lock size={14} /> : <LockOpen size={14} />}
          </button>

          {confirmClear ? (
            <button
              type="button"
              className="sw-btn danger-solid sm"
              aria-label="确认清空剪贴板历史"
              onClick={() => void runAct({ action: 'clear-all' }, '已清空历史')}
            >
              <Trash2 size={13} />
              <span>再点一次清空 {state.entries.length} 条</span>
            </button>
          ) : (
            <button
              type="button"
              className="sw-ib"
              aria-label="清空历史"
              title="清空历史"
              disabled={state.entries.length === 0}
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 size={14} />
            </button>
          )}

          <button type="button" className="sw-ib" aria-label="关闭剪贴板历史" onClick={() => window.island.closeClipboard()}>
            <X size={15} />
          </button>
        </header>

        <div className="sw-clip-body" onPointerDown={() => confirmClear && setConfirmClear(false)}>
          <div ref={listRef} className="sw-clip-list" role="listbox" aria-label="剪贴板条目">
            {filtered.map((entry, idx) => {
              const isSelected = entry.id === activeId;
              const summary = entry.preview || entry.text;
              const isMono = entry.kind === 'text' && looksMono(summary);
              return (
                <div
                  key={entry.id}
                  role="option"
                  tabIndex={0}
                  aria-selected={isSelected}
                  data-entry-id={entry.id}
                  className={'sw-crow' + (isSelected ? ' sel' : '')}
                  onClick={() => setSelectedId(entry.id)}
                  onDoubleClick={() => void runAct({ action: 'paste', id: entry.id }, '已粘贴到原窗口')}
                >
                  <span className="sw-crow-app" title={entry.sourceAppName || '来源应用'}>
                    {entry.kind === 'image' && entry.imageThumbnail ? (
                      <img src={entry.imageThumbnail} alt="" />
                    ) : entry.sourceAppIcon ? (
                      <img src={entry.sourceAppIcon} alt="" />
                    ) : entry.kind === 'files' ? (
                      <Folder size={13} />
                    ) : entry.kind === 'image' ? (
                      <ImageIcon size={13} />
                    ) : (
                      <FileText size={13} />
                    )}
                  </span>

                  <span className={'sw-crow-t' + (isMono ? ' mono' : '')}>
                    {entry.kind === 'image' ? (
                      <>
                        图片{' '}
                        {entry.imageWidth && entry.imageHeight && (
                          <span className="sw-crow-dim mono">
                            {entry.imageWidth} × {entry.imageHeight}
                          </span>
                        )}
                      </>
                    ) : (
                      summary
                    )}
                  </span>

                  <button
                    type="button"
                    className={'sw-crow-star' + (entry.favorite ? ' on' : '')}
                    aria-label={entry.favorite ? '取消收藏' : '收藏置顶'}
                    aria-pressed={entry.favorite}
                    onClick={e => {
                      e.stopPropagation();
                      void runAct({ action: 'toggle-fav', id: entry.id });
                    }}
                  >
                    <Star size={13} />
                  </button>

                  {idx < 9 && <span className="sw-crow-n mono">{idx + 1}</span>}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="sw-clip-empty">{query.trim() || filter !== 'all' ? '没有匹配的记录' : '暂无剪贴板历史'}</div>
            )}
          </div>

          <div className="sw-clip-prev">
            {selected ? (
              selected.kind === 'image' ? (
                <>
                  <div className="sw-clip-img-wrap">
                    {selected.imageThumbnail ? (
                      <img className="sw-clip-img" src={selected.imageThumbnail} alt={selected.preview} />
                    ) : (
                      <span className="sw-clip-empty">无法加载图片预览</span>
                    )}
                  </div>
                  <div className="sw-clip-meta">
                    <span>
                      来源<b>{selected.sourceAppName || '未知应用'}</b>
                    </span>
                    <span>
                      尺寸
                      <b className="mono">
                        {selected.imageWidth && selected.imageHeight ? `${selected.imageWidth} × ${selected.imageHeight}` : '未知'}
                      </b>
                    </span>
                    <span>
                      格式<b className="mono">{formatBytes(selected.imageBytes)}</b>
                    </span>
                    <span>
                      复制于<b>{formatRelativeTime(selected.createdAt)}</b>
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="sw-clip-code mono">
                    {previewLines.slice(0, 300).map((line, i) => (
                      <div key={i} className="sw-clip-line">
                        <span className="sw-ln">{i + 1}</span>
                        <span>{line || ' '}</span>
                      </div>
                    ))}
                  </div>
                  <div className="sw-clip-meta">
                    <span>
                      来源<b>{selected.sourceAppName || '未知应用'}</b>
                    </span>
                    <span>
                      复制于<b>{formatRelativeTime(selected.createdAt)}</b>
                    </span>
                    <span>
                      {selected.kind === 'files' ? '文件数' : '行数'}
                      <b className="mono">{selected.lineCount}</b>
                    </span>
                    <span>
                      字符<b className="mono">{selected.charCount}</b>
                    </span>
                  </div>
                </>
              )
            ) : (
              <div className="sw-clip-empty">选择左侧条目查看完整内容</div>
            )}
          </div>
        </div>

        <footer className="sw-wfoot sw-clip-foot">
          {actError ? (
            <span className="sw-foot-msg err" role="alert">
              {actError}
            </span>
          ) : notice ? (
            <span className="sw-foot-msg ok">{notice}</span>
          ) : (
            <>
              <span className="sw-keyhint">
                <kbd className="sw-kbd">↵</kbd>粘贴
              </span>
              <span className="sw-keyhint">
                <kbd className="sw-kbd">⌘↵</kbd>纯文本粘贴
              </span>
              <span className="sw-keyhint">
                <kbd className="sw-kbd">⌘C</kbd>仅复制
              </span>
            </>
          )}

          <span className="grow" />
          <div className="sw-foot-tools">
            <button
              type="button"
              className="sw-btn ghost sm"
              disabled={!selected || selected.kind === 'image'}
              onClick={() => selected && void runAct({ action: 'translate', id: selected.id })}
            >
              <Languages size={14} />
              <span>翻译</span>
            </button>
            <button
              type="button"
              className="sw-btn ghost sm"
              disabled={!selected}
              onClick={() => selected && void runAct({ action: 'ask-ai', id: selected.id })}
            >
              <Sparkles size={14} />
              <span>问 AI</span>
            </button>
            <button
              type="button"
              className="sw-btn ghost sm"
              disabled={!selected}
              onClick={() => selected && void runAct({ action: 'note', id: selected.id }, '已存入便签')}
            >
              <NotebookPen size={14} />
              <span>存入便签</span>
            </button>
            <button
              type="button"
              className="sw-ib sm"
              aria-label="钉为贴图"
              title="钉为贴图"
              disabled={!selected}
              onClick={() => selected && void runAct({ action: 'pin', id: selected.id }, '已钉为贴图')}
            >
              <Pin size={14} />
            </button>
            <button
              type="button"
              className="sw-ib sm danger"
              aria-label="删除"
              title="删除此条"
              disabled={!selected}
              onClick={() => selected && void runAct({ action: 'delete', id: selected.id }, '已删除')}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
