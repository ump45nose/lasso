import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, Eye, FileText, Lock, PenLine, Pin, Plus, Search, Trash2, Unlock, X } from 'lucide-react';
import type { EdgeNotesState, IslandAPI } from '../../shared/contracts';
import { useFonts } from '../fonts';
import './island.css';

declare global {
  interface Window {
    island: IslandAPI;
  }
}

const SCRATCHPAD = 'Scratchpad.md';

export function EdgeNotes() {
  const [state, setState] = useState<EdgeNotesState | null>(null);
  const [draft, setDraft] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const activeFileRef = useRef(SCRATCHPAD);
  const fileRequestRef = useRef(0);
  const savedContentRef = useRef({ file: SCRATCHPAD, content: '' });
  const pendingRef = useRef<{ file: string; content: string } | null>(null);
  const savesRef = useRef<{ file: string; content: string; done: Promise<void> }[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useFonts(state?.fonts);

  useEffect(() => {
    if (isEditing) {
      textareaRef.current?.focus();
    }
  }, [isEditing]);

  const flushSave = useCallback(async function savePending() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current) {
      const { file, content } = pendingRef.current;
      const existing = savesRef.current.find(save => save.file === file && save.content === content);
      // Keep the draft until its state echo confirms this exact content was saved.
      const done = existing?.done ?? window.island.saveNote(file, content);
      if (!existing) savesRef.current.push({ file, content, done });
      await done;
      const pending = pendingRef.current;
      if (pending && (pending.file !== file || pending.content !== content)) await savePending();
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('isl-html');
    document.body.classList.add('isl-body');
    const sync = (next: EdgeNotesState) => {
      const nextFile = next.activeFile;
      const nextContent = next.content;
      const currentFile = nextFile === activeFileRef.current;
      const previous = savedContentRef.current;
      const pending = pendingRef.current;
      const savedIndex = savesRef.current.findIndex(save => save.file === nextFile && save.content === nextContent);
      const ownSave = savedIndex >= 0;
      if (ownSave) savesRef.current.splice(savedIndex, 1);
      if (currentFile && pending?.file === nextFile && !ownSave && previous.file === nextFile && nextContent.startsWith(previous.content)) {
        const appended = nextContent.slice(previous.content.length);
        if (appended) { pending.content += appended; setDraft(pending.content); }
      }
      if (currentFile) savedContentRef.current = { file: nextFile, content: nextContent };
      if (ownSave && pending?.file === nextFile && pending.content === nextContent) {
        pendingRef.current = null;
        setSaving(false);
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      } else if (currentFile && pending?.file === nextFile && (!next.open || !timerRef.current)) {
        // A late append can arrive after flush; resend the merged draft immediately.
        void flushSave();
      }
      if (!currentFile) return;
      setState(next);
      if (!pendingRef.current || pendingRef.current.file !== nextFile) setDraft(nextContent);
    };
    const stop = window.island.onNotesState(sync);
    void window.island.getNotesState().then(sync);
    return () => {
      flushSave();
      stop();
    };
  }, [flushSave]);

  useEffect(() => {
    const onKeyDown = async (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        await flushSave();
        setPickerOpen(false);
        window.island.setNotesOpen(false);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        flushSave();
        setPickerOpen(true);
        setCreating(true);
        setTimeout(() => newInputRef.current?.focus(), 20);
      } else if (event.key === 'Escape' && pickerOpen) {
        event.preventDefault();
        setPickerOpen(false);
        setCreating(false);
        setConfirmDelete(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pickerOpen, flushSave]);

  if (!state) return null;
  let checkboxCounter = 0;
  const activeFile = state.activeFile;
  const q = query.trim().toLowerCase();
  const files = state.files.filter(f => f !== SCRATCHPAD && (!q || f.toLowerCase().includes(q)));
  const showScratchpad = !q || SCRATCHPAD.toLowerCase().includes(q) || '随手记'.includes(q);
  const lineCount = draft ? draft.split('\n').length : 1;

  function applyNote(next: EdgeNotesState) {
    activeFileRef.current = next.activeFile;
    savedContentRef.current = { file: activeFileRef.current, content: next.content };
    setState(next); setDraft(next.content);
  }

  function onEdit(nextContent: string) {
    setDraft(nextContent);
    pendingRef.current = { file: activeFileRef.current, content: nextContent };
    setSaving(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flushSave, 400);
  }

  function toggleTaskCheckbox(targetIdx: number) {
    let count = 0;
    const next = draft.replace(/^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/gm, (match, prefix, checkState, suffix) => {
      if (count === targetIdx) {
        count++;
        const nextState = checkState.trim() ? ' ' : 'x';
        return `${prefix}${nextState}${suffix}`;
      }
      count++;
      return match;
    });
    if (next !== draft) {
      onEdit(next);
    }
  }

  function pickNote(fileName: string) {
    flushSave();
    fileRequestRef.current++;
    activeFileRef.current = fileName;
    const found = state?.notes.find(n => n.fileName === fileName);
    if (found && state) applyNote({ ...state, activeFile: fileName, content: found.content });
    setConfirmDelete(null);
    setPickerOpen(false);
    setCreating(false);
    setIsEditing(false);
    void window.island.selectNote(fileName);
  }

  async function submitCreate(event?: React.FormEvent) {
    event?.preventDefault();
    const request = ++fileRequestRef.current;
    await flushSave();
    if (request !== fileRequestRef.current) return;
    const title = newName.trim();
    setNewName('');
    setCreating(false);
    setPickerOpen(false);
    await window.island.createNote(title || undefined);
    const next = await window.island.getNotesState();
    if (request === fileRequestRef.current) applyNote(next);
  }

  async function onDelete(event: React.MouseEvent, fileName: string) {
    event.stopPropagation();
    if (confirmDelete !== fileName) {
      setConfirmDelete(fileName);
      return;
    }
    const request = ++fileRequestRef.current;
    await flushSave();
    if (request !== fileRequestRef.current) return;
    setConfirmDelete(null);
    const next = await window.island.deleteNote(fileName);
    if (next && request === fileRequestRef.current) applyNote(next);
  }

  return (
    <div className="en-stage">
      <section className="en-raycast-win" aria-label="Raycast 风格浮动便签">
        <header className="en-topbar">
          <button
            type="button"
            className={'en-picker-btn' + (pickerOpen ? ' open' : '')}
            aria-label="切换或搜索便签"
            aria-expanded={pickerOpen}
            onClick={() => { setPickerOpen(o => !o); setConfirmDelete(null); }}
          >
            <span className="en-clay-dot" />
            <span className="en-picker-name">{activeFile === SCRATCHPAD ? `${SCRATCHPAD} · 随手记` : activeFile}</span>
            <ChevronDown size={13} />
          </button>

          <div className="en-actions">
            <button
              type="button"
              className={'en-icon-btn' + (isEditing ? ' active' : '')}
              aria-label={isEditing ? '切到预览 (Esc / ⌘Enter)' : '编辑源码'}
              data-tip={isEditing ? '切到预览 (Esc / ⌘Enter)' : '编辑源码'}
              onClick={() => {
                if (isEditing) {
                  void flushSave();
                  setIsEditing(false);
                } else {
                  setIsEditing(true);
                }
              }}
            >
              {isEditing ? <Eye size={13} /> : <PenLine size={13} />}
              <span>{isEditing ? '预览' : '编辑'}</span>
            </button>
            <button
              type="button"
              className={'en-icon-btn' + (creating ? ' active' : '')}
              aria-label="新建笔记"
              data-tip="新建笔记 (⌘N)"
              onClick={() => {
                if (pickerOpen && creating && newName.trim()) void submitCreate();
                else { flushSave(); setPickerOpen(true); setCreating(true); setTimeout(() => newInputRef.current?.focus(), 20); }
              }}
            >
              <Plus size={14} />
            </button>
            <button
              type="button"
              className="en-icon-btn"
              aria-label="撕下为贴图"
              data-tip="撕下为贴图"
              onClick={() => { flushSave(); void window.island.pinNoteToDesktop(activeFile); }}
            >
              <Pin size={14} />
            </button>
            <button
              type="button"
              className={'en-icon-btn' + (state.pinnedOnTop ? ' active' : '')}
              aria-label="置顶常驻开关"
              aria-pressed={state.pinnedOnTop}
              onClick={() => void window.island.setNotesPinned(!state.pinnedOnTop).then(next => next && setState(next))}
            >
              {state.pinnedOnTop ? <Lock size={13} /> : <Unlock size={13} />}
              <span>{state.pinnedOnTop ? '已置顶' : '置顶'}</span>
            </button>
            <button
              type="button"
              className="en-icon-btn"
              aria-label="关闭便签"
              onClick={() => { flushSave(); setPickerOpen(false); window.island.setNotesOpen(false); }}
            >
              <X size={14} />
            </button>
          </div>
        </header>

        {pickerOpen && (
          <div className="en-dropdown" role="menu" aria-label="本地笔记列表">
            <div className="en-search-wrap">
              <Search size={13} className="en-search-icon" />
              <input
                type="search"
                className="en-search"
                aria-label="搜索笔记"
                placeholder="搜索本地 .md 笔记…"
                value={query}
                onChange={e => setQuery(e.target.value)}
              />
            </div>

            <div className="en-note-list">
              {showScratchpad && (
                <div role="menuitem" tabIndex={0} className={'en-note-row' + (activeFile === SCRATCHPAD ? ' active' : '')} onClick={() => pickNote(SCRATCHPAD)}>
                  <span className="en-note-row-main"><FileText size={13} /><span>{SCRATCHPAD}</span></span>
                  <span className="en-note-pin-badge mono">置顶</span>
                </div>
              )}
              {files.map(file => (
                <div key={file} role="menuitem" tabIndex={0} className={'en-note-row' + (activeFile === file ? ' active' : '')} onClick={() => pickNote(file)}>
                  <span className="en-note-row-main"><FileText size={13} /><span>{file}</span></span>
                  <button
                    type="button"
                    className={'en-del-btn mono' + (confirmDelete === file ? ' armed' : '')}
                    aria-label={confirmDelete === file ? `确认删除 ${file}` : `删除 ${file}`}
                    onClick={e => void onDelete(e, file)}
                  >
                    <Trash2 size={12} />
                    <span>{confirmDelete === file ? '确认删除？' : '删除'}</span>
                  </button>
                </div>
              ))}
            </div>

            <form className={'en-create-row' + (creating ? ' active' : '')} onSubmit={e => void submitCreate(e)}>
              <input
                ref={newInputRef}
                type="text"
                className="en-new-input"
                aria-label="新建笔记名称"
                placeholder="输入新笔记名称，回车创建…"
                value={newName}
                onFocus={() => setCreating(true)}
                onChange={e => { setCreating(true); setNewName(e.target.value); }}
              />
              <button type="submit" className="en-new-submit" aria-label="确认新建笔记">
                <Plus size={13} /><span>新建</span>
              </button>
            </form>
          </div>
        )}

        <div className="en-body" onPointerDown={() => pickerOpen && setPickerOpen(false)}>
          {isEditing ? (
            <textarea
              ref={textareaRef}
              className="en-editor"
              aria-label="便签 Markdown 内容"
              value={draft}
              onChange={e => onEdit(e.target.value)}
              onBlur={() => {
                void flushSave();
                setIsEditing(false);
              }}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  void flushSave();
                  setIsEditing(false);
                } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void flushSave();
                  setIsEditing(false);
                }
              }}
              placeholder="随手记录灵感、命令片段或待办… 自动保存为本地 Markdown"
            />
          ) : (
            <div
              className="en-markdown-preview"
              role="region"
              aria-label="Markdown 预览正文"
              onClick={e => {
                const target = e.target as HTMLElement;
                if (target.tagName.toLowerCase() === 'input' || target.closest('a')) return;
                setIsEditing(true);
              }}
            >
              {draft.trim() ? (
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    input: ({ node, ...props }) => {
                      if (props.type === 'checkbox') {
                        const idx = checkboxCounter++;
                        return (
                          <input
                            type="checkbox"
                            checked={Boolean(props.checked)}
                            className="en-md-checkbox"
                            aria-label="切换待办任务状态"
                            onClick={e => e.stopPropagation()}
                            onChange={e => {
                              e.stopPropagation();
                              toggleTaskCheckbox(idx);
                            }}
                          />
                        );
                      }
                      return <input {...props} />;
                    },
                    a: ({ node, href, children, ...props }) => {
                      return (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer"
                          onClick={e => {
                            e.stopPropagation();
                          }}
                          {...props}
                        >
                          {children}
                        </a>
                      );
                    }
                  }}
                >
                  {draft}
                </Markdown>
              ) : (
                <p className="en-empty-placeholder">点击此处开始记录灵感或待办… 支持 Markdown 格式</p>
              )}
            </div>
          )}
        </div>

        <footer className="en-footer">
          <span className="en-footer-stat mono">{draft.length} 字 · {lineCount} 行<br />{saving ? '保存中…' : '自动保存'}</span>
          <span className="en-footer-meta mono">
            <span className="en-footer-path">~/Documents/LassoNotes/{activeFile}</span>
            <span>⌥N 显隐</span>
          </span>
        </footer>
      </section>
    </div>
  );
}
