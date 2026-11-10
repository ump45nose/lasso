import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pin, Search, Star, StickyNote, Trash2, X } from 'lucide-react';
import type { ClipboardEntry, ClipboardWindowState, IslandAPI } from '../../shared/contracts';
import { useFonts } from '../fonts';
import { Segmented } from '../motion';
import './suite-windows.css';

declare global { interface Window { island: IslandAPI } }

type ClipFilter = 'all' | 'text' | 'image' | 'fav';
const FILTER_OPTIONS: readonly (readonly [ClipFilter, string])[] = [['all', '全部'], ['text', '文本'], ['image', '图片'], ['fav', '收藏']];

function formatRelativeTime(createdAt: number): string {
  const sec = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
  if (sec < 45) return '刚刚';
  if (sec < 3600) return `${Math.floor(sec / 60)} 分钟前`;
  return sec < 86400 ? `${Math.floor(sec / 3600)} 小时前` : `${Math.floor(sec / 86400)} 天前`;
}

function formatEntryMeta(entry: ClipboardEntry): string {
  const app = entry.sourceAppName || '未知应用';
  const detail = entry.kind === 'image' ? (entry.imageWidth && entry.imageHeight ? `图片 ${entry.imageWidth}×${entry.imageHeight}` : '图片')
    : entry.kind === 'files' ? `文件 · ${entry.lineCount} 项` : `${entry.lineCount} 行 ${entry.charCount} 字符`;
  return `${app} · ${detail} · ${formatRelativeTime(entry.createdAt)}`;
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
    setActError(null); setNotice(msg);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 1600);
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('sw-html');
    document.body.classList.add('sw-body');
    const sync = (next: ClipboardWindowState) => { setState(next); setConfirmClear(false); };
    const stop = window.island.onClipboardState(sync);
    void window.island.getClipboardState().then(sync);
    setTimeout(() => searchInputRef.current?.focus(), 20);
    return () => { if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current); stop(); };
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (state?.entries ?? [])
      .filter(entry => {
        if ((filter === 'text' && entry.kind !== 'text') || (filter === 'image' && entry.kind !== 'image') || (filter === 'fav' && !entry.favorite)) return false;
        return !q || [entry.text, entry.preview, entry.sourceAppName, entry.sourceBundleId].some(s => s.toLowerCase().includes(q));
      })
      .sort((a, b) => Number(b.favorite) - Number(a.favorite));
  }, [state?.entries, query, filter]);

  const activeId = filtered.length ? (selectedId && filtered.some(item => item.id === selectedId) ? selectedId : filtered[0].id) : null;
  const selected = filtered.find(item => item.id === activeId) ?? null;

  const runAct = useCallback(async (req: Parameters<IslandAPI['clipboardAct']>[0], okMsg?: string) => {
    setActError(null); setConfirmClear(false);
    const res = await window.island.clipboardAct(req);
    if (res.error) setActError(res.error);
    else if (okMsg) flashNotice(okMsg);
  }, [flashNotice]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (confirmClear) setConfirmClear(false); else window.island.closeClipboard();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
        event.preventDefault(); window.island.closeClipboard();
      } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && filtered.length) {
        event.preventDefault();
        const idx = filtered.findIndex(item => item.id === activeId);
        const nextIdx = event.key === 'ArrowDown' ? Math.min(filtered.length - 1, idx < 0 ? 0 : idx + 1) : Math.max(0, idx <= 0 ? 0 : idx - 1);
        const nextId = filtered[nextIdx].id;
        setSelectedId(nextId);
        listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${nextId}"]`)?.scrollIntoView({ block: 'nearest' });
      } else if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && selected) {
        if (document.activeElement?.tagName.toLowerCase() === 'button' && !document.activeElement?.classList.contains('sw-clip-row')) return;
        event.preventDefault(); void runAct({ action: 'paste', id: selected.id }, '已粘贴到原窗口');
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && selected) {
        const input = searchInputRef.current;
        if ((input && document.activeElement === input && input.selectionStart !== input.selectionEnd) || window.getSelection()?.toString()) return;
        event.preventDefault(); void runAct({ action: 'copy', id: selected.id }, '已复制到剪贴板');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeId, confirmClear, filtered, runAct, selected]);

  if (!state) return null;

  return (
    <div className="sw-stage">
      <section className="sw-win" role="dialog" aria-label="剪贴板历史">
        <header className="sw-topbar">
          <div className="sw-search-wrap">
            <Search size={13} className="sw-search-icon" />
            <input ref={searchInputRef} type="search" className="sw-search-input" aria-label="搜索剪贴板历史"
              placeholder="搜索剪贴板历史… (支持文本、应用名)" value={query}
              onChange={e => { setQuery(e.target.value); setConfirmClear(false); }} />
          </div>
          <div className="sw-top-actions">
            <button type="button" className={'sw-btn' + (confirmClear ? ' armed' : ' danger')}
              aria-label={confirmClear ? '确认清空剪贴板历史' : '清空剪贴板历史'} disabled={state.entries.length === 0}
              onClick={() => (confirmClear ? void runAct({ action: 'clear-all' }, '已清空历史') : setConfirmClear(true))}>
              <Trash2 size={12} /><span>{confirmClear ? '确认清空？' : '清空'}</span>
            </button>
            <button type="button" className="sw-icon-btn" aria-label="关闭剪贴板历史" onClick={() => window.island.closeClipboard()}><X size={14} /></button>
          </div>
        </header>

        <div className="sw-filter-bar" onPointerDown={() => confirmClear && setConfirmClear(false)}>
          <Segmented label="剪贴板分类筛选" value={filter} options={FILTER_OPTIONS} onChange={next => { setFilter(next); setConfirmClear(false); }} />
          <span className="sw-filter-count mono">{filtered.length} 条</span>
        </div>

        <div ref={listRef} className="sw-clip-list" role="listbox" aria-label="剪贴板历史列表" onPointerDown={() => confirmClear && setConfirmClear(false)}>
          {filtered.map(entry => {
            const isSelected = entry.id === activeId;
            return (
              <div key={entry.id} role="option" tabIndex={0} aria-selected={isSelected} data-entry-id={entry.id}
                className={'sw-clip-row' + (isSelected ? ' selected' : '')}
                onClick={() => setSelectedId(entry.id)}
                onDoubleClick={() => void runAct({ action: 'paste', id: entry.id }, '已粘贴到原窗口')}>
                <div className="sw-app-icon" title={`来源：${entry.sourceAppName || '未知应用'}`}>
                  {entry.sourceAppIcon
                    ? <img className="sw-app-icon-img" src={entry.sourceAppIcon} width={28} height={28} alt={entry.sourceAppName || '来源应用'} />
                    : <span className="sw-app-icon-fallback mono">{(entry.sourceAppName || '?').trim().slice(0, 1).toUpperCase()}</span>}
                </div>
                <div className="sw-clip-body">
                  <div className="sw-clip-text">{entry.kind === 'image' ? `[图片] ${entry.preview}` : (entry.preview || entry.text)}</div>
                  <div className="sw-clip-meta"><span>{formatEntryMeta(entry)}</span>{entry.favorite && <span className="sw-clip-pin-tag"> · ★ 已置顶</span>}</div>
                </div>
                {entry.kind === 'image' && entry.imageThumbnail && <img className="sw-clip-thumb" src={entry.imageThumbnail} alt={entry.preview} />}
                <button type="button" className={'sw-fav-btn' + (entry.favorite ? ' active' : '')}
                  aria-label={entry.favorite ? '取消置顶收藏' : '置顶收藏'} aria-pressed={entry.favorite}
                  onClick={e => { e.stopPropagation(); void runAct({ action: 'toggle-fav', id: entry.id }); }}>
                  <Star size={13} />
                </button>
              </div>
            );
          })}
          {filtered.length === 0 && <div className="sw-clip-empty">{query.trim() || filter !== 'all' ? '没有匹配的剪贴板记录' : '暂无剪贴板历史记录'}</div>}
        </div>

        <footer className="sw-footer">
          {actError ? <span className="sw-footer-hint sw-footer-error" role="alert">{actError}</span>
            : notice ? <span className="sw-footer-hint sw-footer-notice">{notice}</span>
            : <span className="sw-footer-hint"><strong className="mono">↵</strong> 粘贴到原窗口 · <strong className="mono">⌘C</strong> 仅复制</span>}
          <div className="sw-footer-actions">
            <button type="button" className="sw-btn" disabled={!selected} onClick={() => selected && void runAct({ action: 'note', id: selected.id }, '已入便签')}><StickyNote size={12} /><span>入便签</span></button>
            <button type="button" className="sw-btn" disabled={!selected} onClick={() => selected && void runAct({ action: 'pin', id: selected.id }, '已钉为贴图')}><Pin size={12} /><span>钉为贴图</span></button>
            <button type="button" className="sw-btn danger" disabled={!selected} onClick={() => selected && void runAct({ action: 'delete', id: selected.id }, '已删除')}><Trash2 size={12} /><span>删除</span></button>
          </div>
        </footer>
      </section>
    </div>
  );
}
