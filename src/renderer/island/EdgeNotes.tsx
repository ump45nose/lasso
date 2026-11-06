import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { FilePlus2, FileText, FolderOpen, Pin, Sparkles, X } from 'lucide-react';
import type { EdgeNotesState, IslandAPI } from '../../shared/contracts';
import { useFonts } from '../fonts';
import { spring } from '../motion';
import './island.css';

declare global {
  interface Window {
    island: IslandAPI;
  }
}

export function EdgeNotes() {
  const [state, setState] = useState<EdgeNotesState | null>(null);
  const [draft, setDraft] = useState('');
  useFonts(state?.fonts);

  useEffect(() => {
    document.documentElement.classList.add('isl-html');
    document.body.classList.add('isl-body');
    const stop = window.island.onNotesState(next => {
      setState(next);
      const active = next.notes.find(n => n.id === next.activeId) || next.notes[0];
      if (active) setDraft(active.content);
    });
    void window.island.getNotesState().then(next => {
      setState(next);
      const active = next.notes.find(n => n.id === next.activeId) || next.notes[0];
      if (active) setDraft(active.content);
    });
    return () => stop();
  }, []);

  if (!state) return null;
  const active = state.notes.find(n => n.id === state.activeId) || state.notes[0];

  function select(id: string) {
    const found = state?.notes.find(n => n.id === id);
    if (found) setDraft(found.content);
    void window.island.selectNote(id);
  }

  function changeContent(next: string) {
    setDraft(next);
    if (active) void window.island.saveNote(active.id, next);
  }

  return (
    <div
      className="en-stage"
      onPointerDown={event => {
        if (event.target === event.currentTarget && state.open) {
          window.island.setNotesOpen(false);
          window.island.notesHit(false);
        }
      }}
    >
      <AnimatePresence mode="wait" initial={false}>
        {!state.open ? (
          <motion.button
            key="handle"
            type="button"
            className="en-handle"
            aria-label="展开边缘便签"
            initial={{ opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 8 }}
            transition={spring}
            onPointerEnter={() => {
              window.island.notesHit(true);
              window.island.setNotesOpen(true);
            }}
            onClick={() => window.island.setNotesOpen(true)}
          >
            <span className="en-handle-bar" />
          </motion.button>
        ) : (
          <motion.aside
            key="drawer"
            className="en-drawer"
            aria-label="EdgeNotes 边缘便签"
            initial={{ opacity: 0, x: 28 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 28 }}
            transition={spring}
            onPointerEnter={() => window.island.notesHit(true)}
            onPointerLeave={() => window.island.notesHit(false)}
          >
            <header className="en-head">
              <div className="en-head-title">
                <Sparkles size={13} className="isl-clay-icon" />
                <strong>EdgeNotes 边缘便签</strong>
                <span className="en-badge mono">MD</span>
              </div>
              <div className="en-head-actions">
                <button type="button" className="en-icon-btn" title="新建便签" aria-label="新建便签" onClick={() => void window.island.createNote()}>
                  <FilePlus2 size={14} />
                </button>
                <button
                  type="button"
                  className="en-icon-btn"
                  title="收起抽屉"
                  aria-label="收起抽屉"
                  onClick={() => {
                    window.island.setNotesOpen(false);
                    window.island.notesHit(false);
                  }}
                >
                  <X size={14} />
                </button>
              </div>
            </header>

            <div className="en-tabs" role="tablist" aria-label="便签列表">
              {state.notes.map(note => (
                <button
                  key={note.id}
                  type="button"
                  role="tab"
                  aria-selected={note.id === active?.id}
                  className={'en-tab' + (note.id === active?.id ? ' active' : '')}
                  onClick={() => select(note.id)}
                >
                  <FileText size={12} />
                  <span>{note.title}</span>
                  {note.pinned && <em className="mono">顶</em>}
                </button>
              ))}
            </div>

            {active && (
              <div className="en-editor-card">
                <div className="en-meta-row">
                  <span className="mono">{active.fileName}</span>
                  <span className="mono">{active.updatedAt}</span>
                </div>
                <textarea
                  className="en-textarea"
                  aria-label="便签 Markdown 内容"
                  value={draft}
                  onChange={event => changeContent(event.target.value)}
                  placeholder="随手记录灵感、命令片段或待办… 自动保存为本地 Markdown"
                />
              </div>
            )}

            <footer className="en-foot">
              <span className="en-folder mono" title={state.folder}>
                <FolderOpen size={12} />
                ~/Documents/LassoNotes
              </span>
              {active && (
                <button
                  type="button"
                  className="en-pin-btn"
                  onClick={() => void window.island.pinNoteToDesktop(active.id)}
                >
                  <Pin size={12} />撕下为贴图
                </button>
              )}
            </footer>
          </motion.aside>
        )}
      </AnimatePresence>
    </div>
  );
}
