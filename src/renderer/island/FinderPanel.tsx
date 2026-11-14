import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  ChevronDown,
  ClipboardPaste,
  CodeXml,
  Copy,
  Download,
  FileImage,
  FilePlus,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Monitor,
  NotebookPen,
  Pin,
  ScanText,
  Scissors,
  Search,
  Sparkles,
  SquareTerminal,
  TextSelect,
  Trash2,
  X
} from 'lucide-react';
import type { FinderActionReq, FinderEditorApp, FinderPanelState, FinderTerminalApp, IslandAPI } from '../../shared/contracts';
import { useFonts } from '../fonts';
import { spring } from '../motion';
import './island.css';

declare global {
  interface Window {
    island: IslandAPI;
  }
}

const TEMPLATES: { ext: 'md' | 'txt' | 'py' | 'json' | 'sh'; name: string }[] = [
  { ext: 'md', name: 'Untitled.md' },
  { ext: 'txt', name: 'Untitled.txt' },
  { ext: 'py', name: 'Untitled.py' },
  { ext: 'json', name: 'Untitled.json' },
  { ext: 'sh', name: 'Untitled.sh' }
];

const PATH_STYLES: readonly ['posix' | 'quoted' | 'filename', string][] = [
  ['posix', 'POSIX'],
  ['quoted', 'Shell'],
  ['filename', '文件名']
];

const EDITORS: readonly [FinderEditorApp, string][] = [
  ['Cursor', 'Cursor'],
  ['VSCode', 'VS Code'],
  ['Zed', 'Zed']
];

const TERMINALS: readonly FinderTerminalApp[] = ['Ghostty', 'Terminal', 'Warp', 'iTerm'];

function shortenHome(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~');
}

export function FinderPanel() {
  const [state, setState] = useState<FinderPanelState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moveFilter, setMoveFilter] = useState('');
  const [pathStyle, setPathStyle] = useState<'posix' | 'quoted' | 'filename'>('posix');
  const [openMenu, setOpenMenu] = useState<'path' | 'editor' | 'terminal' | null>(null);
  useFonts(state?.fonts);

  useEffect(() => {
    document.documentElement.classList.add('isl-html');
    document.body.classList.add('isl-body');
    const stop = window.island.onFinderState(next => {
      setState(next);
      setConfirmDelete(false);
    });
    void window.island.getFinderState().then(setState);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (openMenu) setOpenMenu(null);
        else if (confirmDelete) setConfirmDelete(false);
        else window.island.finderClose();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') {
        setState(curr => {
          if (curr?.cutPaths?.length) {
            event.preventDefault();
            void window.island.finderAction({ kind: 'paste-move' }).then(next => next && setState(next));
          }
          return curr;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      stop();
      window.removeEventListener('keydown', onKey);
    };
  }, [confirmDelete, openMenu]);

  if (!state) return null;
  const cutPaths = state.cutPaths ?? [];
  const q = moveFilter.trim().toLowerCase();
  const filteredTargets = (state.moveTargets ?? []).filter(
    t => !q || t.label.toLowerCase().includes(q) || t.path.toLowerCase().includes(q) || (t.group ?? '').toLowerCase().includes(q)
  );
  const commonTargets = filteredTargets.filter(t => t.kind === 'common');
  const repoTargets = filteredTargets.filter(t => t.kind === 'repo');
  const worktreeTargets = filteredTargets.filter(t => t.kind === 'worktree');
  const selCount = state.selection.length;
  const pathStyleLabel = PATH_STYLES.find(([id]) => id === pathStyle)?.[1] ?? 'POSIX';

  async function run(req: FinderActionReq) {
    setConfirmDelete(false);
    setOpenMenu(null);
    const next = await window.island.finderAction(req);
    if (next) setState(next);
  }

  function renderCommonIcon(label: string) {
    if (label.includes('桌面') || label.toLowerCase().includes('desktop')) return <Monitor size={15} />;
    if (label.includes('下载') || label.toLowerCase().includes('download')) return <Download size={15} />;
    return <NotebookPen size={15} />;
  }

  return (
    <div
      className="fp-stage"
      onClick={() => openMenu && setOpenMenu(null)}
      onPointerDown={event => {
        if (event.target === event.currentTarget) window.island.finderClose();
      }}
    >
      <motion.div
        className="fp-card"
        role="dialog"
        aria-label="访达动作面板"
        initial={{ opacity: 0, scale: 0.96, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={spring}
      >
        <header className="fp-head">
          <FolderOpen size={15} className="fp-head-ic" />
          <span className="fp-path mono trunc grow" title={state.folder}>
            {shortenHome(state.folder)}
          </span>
          <span className="fp-chip">{selCount ? `已选 ${selCount} 项` : '当前目录'}</span>
          <button type="button" className="isl-ib sm" aria-label="关闭面板" onClick={() => window.island.finderClose()}>
            <X size={14} />
          </button>
        </header>

        {cutPaths.length > 0 && (
          <button type="button" className="fp-cutbar" onClick={() => void run({ kind: 'paste-move' })}>
            <ClipboardPaste size={15} />
            <span className="fp-cut-strong">待移 {cutPaths.length} 项</span>
            <span className="fp-cut-sub">· 点击粘贴到此目录</span>
            <span className="grow" />
            <kbd className="mono">⌘V</kbd>
          </button>
        )}

        <section className="fp-sec">
          <div className="fp-new-head">
            <FilePlus size={15} />
            <span>新建文件</span>
            <span className="r">选模板后直接改名</span>
          </div>
          <div className="fp-tpl" role="group" aria-label="新建文件模板">
            {TEMPLATES.map((item, idx) => (
              <button
                key={item.ext}
                type="button"
                className={'fp-tpl-pill mono' + (idx === 0 ? ' on' : '')}
                onClick={() => void run({ kind: 'new-file', name: item.name })}
              >
                .{item.ext}
              </button>
            ))}
          </div>

          <div className="fp-grid">
            <div className="fp-act-wrap" onClick={e => e.stopPropagation()}>
              <button type="button" className="fp-act" onClick={() => void run({ kind: 'copy-paths', style: pathStyle })}>
                <Copy size={15} />
                <span>复制路径</span>
                <span
                  className="r"
                  onClick={e => {
                    e.stopPropagation();
                    setOpenMenu(m => (m === 'path' ? null : 'path'));
                  }}
                >
                  {pathStyleLabel}
                  <ChevronDown size={11} />
                </span>
              </button>
              {openMenu === 'path' && (
                <div className="fp-pop-menu" role="menu">
                  {PATH_STYLES.map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className="fp-pop-mi"
                      onClick={() => {
                        setPathStyle(id);
                        void run({ kind: 'copy-paths', style: id });
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button type="button" className="fp-act" onClick={() => void run({ kind: 'cut-selection' })}>
              <Scissors size={15} />
              <span>剪切选中</span>
            </button>

            <button type="button" className="fp-act" onClick={() => void run({ kind: 'send-to-ai' })}>
              <Sparkles size={15} />
              <span>发给 AI</span>
            </button>

            <div className="fp-act-wrap" onClick={e => e.stopPropagation()}>
              <button type="button" className="fp-act" onClick={() => void run({ kind: 'open-terminal', app: state.defaultTerminal })}>
                <SquareTerminal size={15} />
                <span>在此开终端</span>
                <span
                  className="r"
                  onClick={e => {
                    e.stopPropagation();
                    setOpenMenu(m => (m === 'terminal' ? null : 'terminal'));
                  }}
                >
                  {state.defaultTerminal}
                  <ChevronDown size={11} />
                </span>
              </button>
              {openMenu === 'terminal' && (
                <div className="fp-pop-menu" role="menu">
                  {TERMINALS.map(app => (
                    <button key={app} type="button" className="fp-pop-mi" onClick={() => void run({ kind: 'open-terminal', app })}>
                      {app}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="fp-act-wrap" onClick={e => e.stopPropagation()}>
              <button type="button" className="fp-act" onClick={() => void run({ kind: 'open-editor', app: state.defaultEditor })}>
                <CodeXml size={15} />
                <span>用编辑器打开</span>
                <span
                  className="r"
                  onClick={e => {
                    e.stopPropagation();
                    setOpenMenu(m => (m === 'editor' ? null : 'editor'));
                  }}
                >
                  {state.defaultEditor === 'VSCode' ? 'VS Code' : state.defaultEditor}
                  <ChevronDown size={11} />
                </span>
              </button>
              {openMenu === 'editor' && (
                <div className="fp-pop-menu" role="menu">
                  {EDITORS.map(([id, label]) => (
                    <button key={id} type="button" className="fp-pop-mi" onClick={() => void run({ kind: 'open-editor', app: id })}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              className={'fp-act ' + (confirmDelete ? 'confirm' : 'warn')}
              disabled={selCount === 0}
              onClick={() => (confirmDelete ? void run({ kind: 'delete-permanent' }) : setConfirmDelete(true))}
            >
              <Trash2 size={15} />
              <span>{confirmDelete ? `确认彻底删除 ${selCount} 项？` : '彻底删除'}</span>
            </button>
          </div>
        </section>

        {state.hasImageSelection && (
          <section className="fp-sec" aria-label="选中图片动作">
            <div className="fp-lbl">选中图片 · {state.imageCount || 1} 张</div>
            <div className="fp-grid">
              <button type="button" className="fp-act" onClick={() => void run({ kind: 'convert-webp' })}>
                <FileImage size={15} />
                <span>原地转 .webp</span>
              </button>
              <button type="button" className="fp-act" onClick={() => void run({ kind: 'ocr-copy' })}>
                <ScanText size={15} />
                <span>识别文字并复制</span>
              </button>
              <button type="button" className="fp-act" onClick={() => void run({ kind: 'ocr-pin' })}>
                <TextSelect size={15} />
                <span>识别文字钉为贴图</span>
              </button>
              <button type="button" className="fp-act" onClick={() => void run({ kind: 'pin-image' })}>
                <Pin size={15} />
                <span>原图钉为贴图</span>
              </button>
            </div>
          </section>
        )}

        <section className="fp-sec fp-dest-sec" aria-label="目标目录">
          <label className="fp-input">
            <Search size={14} />
            <input
              type="search"
              aria-label="过滤目录、仓库或 worktree"
              placeholder="过滤目录、仓库或 worktree"
              value={moveFilter}
              onChange={e => setMoveFilter(e.target.value)}
            />
          </label>

          <div className="fp-dest-scroll">
            {commonTargets.length > 0 && (
              <>
                <div className="fp-lbl">常用</div>
                {commonTargets.map(target => (
                  <div key={target.id} className="fp-dest" title={target.path}>
                    {renderCommonIcon(target.label)}
                    <span className="trunc">{target.label}</span>
                    <span className="fp-dest-acts">
                      <button type="button" className="fp-mini" onClick={() => void run({ kind: 'move-to-target', targetDir: target.path })}>
                        移入
                      </button>
                      <button type="button" className="fp-mini" onClick={() => void run({ kind: 'symlink-to-target', targetDir: target.path })}>
                        软链
                      </button>
                    </span>
                  </div>
                ))}
              </>
            )}

            {repoTargets.length > 0 && (
              <>
                <div className="fp-lbl">
                  <span>仓库</span>
                  <span className="r mono">~/Developer/Repos</span>
                </div>
                {repoTargets.map(target => (
                  <div key={target.id} className="fp-dest" title={target.path}>
                    <FolderGit2 size={15} />
                    <span className="trunc">{target.label}</span>
                    {target.group && <span className="p mono">{target.group}</span>}
                    <span className="fp-dest-acts">
                      <button type="button" className="fp-mini" onClick={() => void run({ kind: 'move-to-target', targetDir: target.path })}>
                        移入
                      </button>
                      <button type="button" className="fp-mini" onClick={() => void run({ kind: 'symlink-to-target', targetDir: target.path })}>
                        软链
                      </button>
                    </span>
                  </div>
                ))}
              </>
            )}

            {worktreeTargets.length > 0 && (
              <>
                <div className="fp-lbl">Worktree</div>
                {worktreeTargets.map(target => (
                  <div key={target.id} className="fp-dest" title={target.path}>
                    <GitBranch size={15} />
                    <span className="trunc">{target.label}</span>
                    {target.group && <span className="p mono">{target.group}</span>}
                    <span className="fp-dest-acts">
                      <button type="button" className="fp-mini" onClick={() => void run({ kind: 'move-to-target', targetDir: target.path })}>
                        移入
                      </button>
                      <button type="button" className="fp-mini" onClick={() => void run({ kind: 'symlink-to-target', targetDir: target.path })}>
                        软链
                      </button>
                    </span>
                  </div>
                ))}
              </>
            )}

            {filteredTargets.length === 0 && <div className="fp-empty">无匹配的目标目录</div>}
          </div>
        </section>
      </motion.div>
    </div>
  );
}
