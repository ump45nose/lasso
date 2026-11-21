import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronUp, FileText, Lock, LockOpen, Pin, Plus, Search, Trash2, X } from '../icons';
import type { EdgeNotesState, IslandAPI } from '../../shared/contracts';
import { useAppearance } from '../fonts';
import { NoteEditor } from './NoteEditor';
import type { EditorView } from '@codemirror/view';
import { shortcutLabel } from '../targets';
import './island.css';

declare global {
  interface Window {
    island: IslandAPI;
  }
}

const SCRATCHPAD = 'Scratchpad.md';
function formatShortDate(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function EdgeNotes() {
  const [state, setState] = useState<EdgeNotesState | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const activeFileRef = useRef(SCRATCHPAD);
  const fileRequestRef = useRef(0);
  const savedContentRef = useRef({ file: SCRATCHPAD, content: '' });
  const pendingRef = useRef<{ file: string; content: string } | null>(null);
  const savesRef = useRef<{ file: string; content: string; done: Promise<void> }[]>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const editorRef = useRef<EditorView | null>(null);

  useAppearance(state?.fonts);

  const flushSave = useCallback(async function savePending() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current) {
      const { file, content } = pendingRef.current;
      const existing = savesRef.current.find(save => save.file === file && save.content === content);
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
        if (appended) {
          pending.content += appended;
          setDraft(pending.content);
        }
      }
      if (currentFile) savedContentRef.current = { file: nextFile, content: nextContent };
      if (ownSave && pending?.file === nextFile && pending.content === nextContent) {
        pendingRef.current = null;
        setSaving(false);
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      } else if (currentFile && pending?.file === nextFile && (!next.open || !timerRef.current)) {
        void flushSave();
      }
      if (!currentFile && activeFileRef.current !== SCRATCHPAD) return;
      activeFileRef.current = nextFile;
      setState(next);
      if (!pendingRef.current || pendingRef.current.file !== nextFile) setDraft(nextContent);
    };
    const stop = window.island.onNotesState(sync);
    void window.island.getNotesState().then(initial => {
      activeFileRef.current = initial.activeFile;
      savedContentRef.current = { file: initial.activeFile, content: initial.content };
      setState(initial);
      setDraft(initial.content);
    });
    return () => {
      void flushSave();
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
        await flushSave();
        setPickerOpen(true);
        setTimeout(() => searchInputRef.current?.focus(), 20);
      } else if (event.key === 'Escape' && pickerOpen) {
        event.preventDefault();
        setPickerOpen(false);
        setConfirmDelete(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pickerOpen, flushSave]);

  if (!state) return null;
  const activeFile = state.activeFile;
  const q = query.trim().toLowerCase();
  const otherNotes = state.notes.filter(n => n.fileName !== SCRATCHPAD && (!q || n.fileName.toLowerCase().includes(q)));
  const showScratchpad = !q || SCRATCHPAD.toLowerCase().includes(q) || '随手记'.includes(q);
  const lineCount = draft ? draft.split('\n').length : 1;
  const hotkeyLabel = state.shortcut ? shortcutLabel(state.shortcut) : '';

  function applyNote(next: EdgeNotesState) {
    activeFileRef.current = next.activeFile;
    savedContentRef.current = { file: activeFileRef.current, content: next.content };
    setState(next);
    setDraft(next.content);
  }

  function onEdit(nextContent: string) {
    setDraft(nextContent);
    pendingRef.current = { file: activeFileRef.current, content: nextContent };
    setSaving(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flushSave, 400);
  }

  function pickNote(fileName: string) {
    void flushSave();
    fileRequestRef.current++;
    activeFileRef.current = fileName;
    const found = state?.notes.find(n => n.fileName === fileName);
    if (found && state) applyNote({ ...state, activeFile: fileName, content: found.content });
    setConfirmDelete(null);
    setPickerOpen(false);
    setQuery('');
    void window.island.selectNote(fileName);
  }

  async function handleCreateNote(customTitle?: string) {
    const request = ++fileRequestRef.current;
    await flushSave();
    if (request !== fileRequestRef.current) return;
    const title = (customTitle ?? query).trim();
    setQuery('');
    setPickerOpen(false);
    await window.island.createNote(title || undefined);
    const next = await window.island.getNotesState();
    if (request === fileRequestRef.current) {
      applyNote(next);
      setTimeout(() => editorRef.current?.focus(), 20);
    }
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
    <div className="en-stage" onClick={() => pickerOpen && setPickerOpen(false)}>
      <section className={'en-win' + (!state.focused ? ' blurred' : '')} aria-label="浮动便签">
        <header className="en-wbar">
          <div className="en-picker-wrap" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              className={'en-switch' + (pickerOpen ? ' open' : '')}
              aria-label="切换或搜索笔记"
              aria-expanded={pickerOpen}
              onClick={() => {
                setPickerOpen(o => !o);
                setConfirmDelete(null);
                setTimeout(() => searchInputRef.current?.focus(), 20);
              }}
            >
              <FileText size={15} />
              <span className="trunc">{activeFile}</span>
              {pickerOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>

            {pickerOpen && (
              <div className="en-menu" role="menu" aria-label="本地笔记列表">
                <label className="en-menu-search">
                  <Search size={14} />
                  <input
                    ref={searchInputRef}
                    type="search"
                    aria-label="搜索或新建笔记"
                    placeholder="搜索或新建笔记"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && query.trim() && otherNotes.length === 0 && !showScratchpad) {
                        e.preventDefault();
                        void handleCreateNote(query);
                      }
                    }}
                  />
                </label>

                <div className="en-menu-list">
                  {showScratchpad && (
                    <div
                      role="menuitem"
                      tabIndex={0}
                      className={'en-mi' + (activeFile === SCRATCHPAD ? ' active' : '')}
                      onClick={() => pickNote(SCRATCHPAD)}
                    >
                      <Pin size={14} className="en-mi-ic" />
                      <span className="trunc">{SCRATCHPAD}</span>
                      <span className="en-mi-sub">随手记</span>
                      {activeFile === SCRATCHPAD && <Check size={14} className="en-mi-r clay" />}
                    </div>
                  )}

                  {otherNotes.map(note => {
                    const selected = activeFile === note.fileName;
                    const armed = confirmDelete === note.fileName;
                    return (
                      <div
                        key={note.fileName}
                        role="menuitem"
                        tabIndex={0}
                        className={'en-mi' + (selected ? ' active' : '')}
                        onClick={() => pickNote(note.fileName)}
                      >
                        <FileText size={14} className="en-mi-ic" />
                        <span className="trunc grow">{note.fileName}</span>
                        {!armed && note.updatedAt && <span className="en-mi-date mono">{formatShortDate(note.updatedAt)}</span>}
                        <button
                          type="button"
                          className={'en-mi-del' + (armed ? ' armed' : '')}
                          aria-label={armed ? `确认删除 ${note.fileName}` : `删除 ${note.fileName}`}
                          onClick={e => void onDelete(e, note.fileName)}
                        >
                          <Trash2 size={13} />
                          {armed && <span>确认删除？</span>}
                        </button>
                      </div>
                    );
                  })}
                </div>

                <div className="en-msep" />
                <button type="button" className="en-mi" onClick={() => void handleCreateNote()}>
                  <Plus size={14} className="en-mi-ic" />
                  <span>{query.trim() ? `新建「${query.trim()}」` : '新建笔记'}</span>
                  <kbd className="en-kbd en-mi-r">⌘N</kbd>
                </button>
              </div>
            )}
          </div>

          <span className="grow" />

          <button
            type="button"
            className="en-ib"
            aria-label="新建笔记"
            title="新建笔记 ⌘N"
            onClick={() => void handleCreateNote('')}
          >
            <Plus size={15} />
          </button>

          <button
            type="button"
            className="en-ib"
            aria-label="钉为桌面贴图"
            title="钉为桌面贴图"
            onClick={() => {
              void flushSave();
              void window.island.pinNoteToDesktop(activeFile);
            }}
          >
            <Pin size={14} />
          </button>

          <button
            type="button"
            className={'en-ib' + (state.pinnedOnTop ? ' on' : '')}
            aria-label={state.pinnedOnTop ? '取消置顶' : '置顶'}
            aria-pressed={state.pinnedOnTop}
            title={state.pinnedOnTop ? '已置顶' : '置顶'}
            onClick={() => void window.island.setNotesPinned(!state.pinnedOnTop).then(next => next && setState(next))}
          >
            {state.pinnedOnTop ? <Lock size={14} /> : <LockOpen size={14} />}
          </button>

          <button
            type="button"
            className="en-ib"
            aria-label="关闭便签"
            onClick={() => {
              void flushSave();
              setPickerOpen(false);
              window.island.setNotesOpen(false);
            }}
          >
            <X size={15} />
          </button>
        </header>

        <div className="en-body">
          <NoteEditor key={activeFile} value={draft} onChange={onEdit} onBlur={() => void flushSave()} editorRef={editorRef} />
        </div>

        <footer className="en-foot">
          <span className="mono">
            {draft.length} 字 · {lineCount} 行
          </span>
          <span className={'en-saved' + (saving ? ' saving' : '')}>
            {!saving && <Check size={12} />}
            <span>{saving ? '保存中…' : '已保存'}</span>
          </span>
          <span className="grow" />
          <span className="en-foot-path mono trunc" title={`${state.notesDir}/${activeFile}`}>
            ~/Documents/LassoNotes/{activeFile}
          </span>
          {hotkeyLabel && <kbd className="en-kbd">{hotkeyLabel}</kbd>}
        </footer>
      </section>
    </div>
  );
}
