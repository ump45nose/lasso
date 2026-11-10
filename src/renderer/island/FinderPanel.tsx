import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { ClipboardPaste, Code2, Copy, FileCode, FileJson, FilePlus, FileText, FolderInput, FolderOpen, Image as ImageIcon, Link2, Pin, ScanText, Scissors, Search, Terminal, Trash2, X } from 'lucide-react';
import type { FinderActionReq, FinderPanelState, IslandAPI } from '../../shared/contracts';
import { useFonts } from '../fonts';
import { spring } from '../motion';
import './island.css';

declare global {
  interface Window {
    island: IslandAPI;
  }
}

const TEMPLATES: { ext: 'md' | 'txt' | 'py' | 'json' | 'sh'; label: string; name: string }[] = [
  { ext: 'md', label: 'Markdown', name: 'Untitled.md' },
  { ext: 'txt', label: '纯文本', name: 'Untitled.txt' },
  { ext: 'py', label: 'Python', name: 'Untitled.py' },
  { ext: 'json', label: 'JSON', name: 'Untitled.json' },
  { ext: 'sh', label: 'Shell', name: 'Untitled.sh' }
];

export function FinderPanel() {
  const [state, setState] = useState<FinderPanelState | null>(null);
  const [tab, setTab] = useState<'actions' | 'new' | 'move'>('actions');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moveFilter, setMoveFilter] = useState('');
  useFonts(state?.fonts);

  useEffect(() => {
    document.documentElement.classList.add('isl-html');
    document.body.classList.add('isl-body');
    const stop = window.island.onFinderState(next => { setState(next); setConfirmDelete(false); });
    void window.island.getFinderState().then(setState);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        window.island.finderClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      stop();
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  if (!state) return null;
  const cutPaths = state.cutPaths ?? [];
  const q = moveFilter.trim().toLowerCase();
  const filteredTargets = (state.moveTargets ?? []).filter(
    t => !q || t.label.toLowerCase().includes(q) || t.path.toLowerCase().includes(q) || t.kind.toLowerCase().includes(q)
  );

  async function run(req: FinderActionReq) {
    setConfirmDelete(false);
    const next = await window.island.finderAction(req);
    if (next) setState(next);
  }

  return (
    <div className="fp-stage" onPointerDown={event => { if (event.target === event.currentTarget) window.island.finderClose(); }}>
      <motion.div
        className="fp-card"
        role="dialog"
        aria-label="Finder 超级动作面板"
        initial={{ opacity: 0, scale: 0.96, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={spring}
      >
        <header className="fp-head">
          <FolderOpen size={14} className="isl-clay-icon" />
          <div className="fp-head-copy">
            <div className="fp-head-top">
              <strong>Finder 超级动作面板</strong>
              <span className="fp-sel-badge mono">{state.selection.length ? `已选 ${state.selection.length} 项` : '当前目录'}</span>
            </div>
            <span className="mono" title={state.folder}>{state.folder}</span>
          </div>
          <button type="button" className="isl-icon" aria-label="关闭面板" onClick={() => window.island.finderClose()}>
            <X size={14} />
          </button>
        </header>

        {cutPaths.length > 0 && (
          <button type="button" className="fp-cut-bar" onClick={() => void run({ kind: 'paste-move' })}>
            <ClipboardPaste size={13} />
            <span>待移 {cutPaths.length} 项 · 粘贴移入此处</span>
            <kbd className="mono">Paste</kbd>
          </button>
        )}

        <section className="fp-section">
          <div className="fp-qgrid">
            <button type="button" className={'fp-qbtn' + (tab === 'new' ? ' on' : '')} onClick={() => setTab(t => (t === 'new' ? 'actions' : 'new'))}>
              <FilePlus size={13} /><span>新建文件</span>
            </button>
            <button type="button" className="fp-qbtn" onClick={() => void run({ kind: 'copy-paths', style: 'posix' })}>
              <Copy size={13} /><span>复制路径</span>
            </button>
            <button type="button" className="fp-qbtn" onClick={() => void run({ kind: 'cut-selection' })}>
              <Scissors size={13} /><span>剪切选中</span>
            </button>
            <button type="button" className="fp-qbtn" onClick={() => void run({ kind: 'open-terminal' })}>
              <Terminal size={13} /><span>在此开终端</span>
            </button>
            <button type="button" className="fp-qbtn" onClick={() => void run({ kind: 'open-editor', app: 'Cursor' })}>
              <Code2 size={13} /><span>Cursor</span>
            </button>
            <button type="button" className="fp-qbtn" onClick={() => void run({ kind: 'open-editor', app: 'VSCode' })}>
              <Code2 size={13} /><span>VS Code</span>
            </button>
            <button
              type="button"
              className={'fp-qbtn span-2' + (confirmDelete ? ' armed' : '')}
              onClick={() => (confirmDelete ? void run({ kind: 'delete-permanent' }) : setConfirmDelete(true))}
            >
              <Trash2 size={13} /><span>{confirmDelete ? '确认彻底删除？' : '彻底删除'}</span>
            </button>
          </div>

          {tab === 'new' && (
            <div className="fp-tpl-strip" role="group" aria-label="新建文件模板">
              {TEMPLATES.map(item => (
                <button key={item.ext} type="button" className="fp-tpl-btn" onClick={() => void run({ kind: 'new-file', name: item.name })}>
                  {item.ext === 'json' ? <FileJson size={12} /> : item.ext === 'py' || item.ext === 'sh' ? <FileCode size={12} /> : <FileText size={12} />}
                  <span>{item.label}</span>
                  <kbd className="mono">.{item.ext}</kbd>
                </button>
              ))}
            </div>
          )}
        </section>

        {state.hasImageSelection && (
          <section className="fp-section" aria-label="选中图片专属动作">
            <div className="fp-sec-label">
              <span>选中图片专属动作</span>
              <span className="mono">IMAGE · OCR</span>
            </div>
            <div className="fp-img-grid">
              <button type="button" className="fp-qbtn" onClick={() => void run({ kind: 'convert-webp' })}><ImageIcon size={13} /><span>原地转 .webp</span></button>
              <button type="button" className="fp-qbtn" onClick={() => void run({ kind: 'ocr-copy' })}><ScanText size={13} /><span>OCR 复制文字</span></button>
              <button type="button" className="fp-qbtn" onClick={() => void run({ kind: 'ocr-pin' })}><Pin size={13} /><span>OCR 钉为贴图</span></button>
              <button type="button" className="fp-qbtn" onClick={() => void run({ kind: 'pin-image' })}><Pin size={13} /><span>原图钉为贴图</span></button>
            </div>
          </section>
        )}

        <section className="fp-section fp-move-sec" aria-label="移动到或软链到仓库与 Worktree">
          <div className="fp-sec-label">
            <span>移动到 / 软链到仓库或 Worktree</span>
            <span className="mono">{filteredTargets.length} 处</span>
          </div>
          <div className="fp-filter-wrap">
            <Search size={12} className="fp-filter-icon" />
            <input
              type="search"
              className="fp-filter-input"
              aria-label="搜索目标仓库或 Worktree"
              placeholder="过滤 common / repo / worktree 目标…"
              value={moveFilter}
              onFocus={() => setTab('move')}
              onChange={e => { setTab('move'); setMoveFilter(e.target.value); }}
            />
          </div>
          <div className="fp-target-list">
            {filteredTargets.map(target => (
              <div key={target.id} className="fp-target-row">
                <div className="fp-target-info" title={target.path}>
                  <span className={`fp-target-tag mono kind-${target.kind}`}>{target.kind}</span>
                  <span className="fp-target-label">{target.label}</span>
                </div>
                <div className="fp-target-actions">
                  <button type="button" className="fp-mini-btn" aria-label={`移入 ${target.label}`} onClick={() => void run({ kind: 'move-to-target', targetDir: target.path })}>
                    <FolderInput size={11} /><span>移入</span>
                  </button>
                  <button type="button" className="fp-mini-btn" aria-label={`软链到 ${target.label}`} onClick={() => void run({ kind: 'symlink-to-target', targetDir: target.path })}>
                    <Link2 size={11} /><span>软链</span>
                  </button>
                </div>
              </div>
            ))}
            {filteredTargets.length === 0 && <div className="fp-target-empty">无匹配的目标目录</div>}
          </div>
        </section>
      </motion.div>
    </div>
  );
}
