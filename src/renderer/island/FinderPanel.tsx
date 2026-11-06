import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Code2, Copy, FileCode, FileJson, FilePlus, FileText, FolderOpen, Sparkles, Terminal, X } from 'lucide-react';
import type { FinderPanelState, IslandAPI } from '../../shared/contracts';
import { useFonts } from '../fonts';
import { spring } from '../motion';
import './island.css';

declare global {
  interface Window {
    island: IslandAPI;
  }
}

const TEMPLATES: { ext: 'md' | 'txt' | 'py' | 'json' | 'sh'; label: string; desc: string }[] = [
  { ext: 'md', label: 'Markdown 笔记', desc: '.md' },
  { ext: 'txt', label: '纯文本文件', desc: '.txt' },
  { ext: 'py', label: 'Python 脚本', desc: '.py' },
  { ext: 'json', label: 'JSON 配置', desc: '.json' },
  { ext: 'sh', label: 'Shell 脚本', desc: '.sh' }
];

export function FinderPanel() {
  const [state, setState] = useState<FinderPanelState | null>(null);
  useFonts(state?.fonts);

  useEffect(() => {
    document.documentElement.classList.add('isl-html');
    document.body.classList.add('isl-body');
    const stop = window.island.onFinderState(setState);
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

  return (
    <div
      className="fp-stage"
      onPointerDown={event => {
        if (event.target === event.currentTarget) window.island.finderClose();
      }}
    >
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
            <strong>Finder 超级动作面板</strong>
            <span className="mono" title={state.folder}>{state.folder}</span>
          </div>
          <button type="button" className="isl-icon" aria-label="关闭面板" onClick={() => window.island.finderClose()}>
            <X size={14} />
          </button>
        </header>

        <section className="fp-section">
          <div className="fp-sec-label">
            <span>在此目录新建文件</span>
            <span className="mono">NEW FILE</span>
          </div>
          <div className="fp-grid">
            {TEMPLATES.map(item => (
              <button
                key={item.ext}
                type="button"
                className="fp-tile"
                onClick={() => void window.island.finderCreateFile(item.ext)}
              >
                {item.ext === 'json' ? <FileJson size={14} /> : item.ext === 'py' || item.ext === 'sh' ? <FileCode size={14} /> : item.ext === 'md' ? <FilePlus size={14} /> : <FileText size={14} />}
                <span>{item.label}</span>
                <kbd className="mono">{item.desc}</kbd>
              </button>
            ))}
          </div>
        </section>

        <section className="fp-section">
          <div className="fp-sec-label">
            <span>目录与选中项动作</span>
            <span className="mono">{state.selection.length ? `已选 ${state.selection.length} 项` : '当前目录'}</span>
          </div>
          <div className="fp-list">
            <button type="button" className="fp-row" onClick={() => void window.island.finderRunAction('copy-path')}>
              <Copy size={14} />
              <span>复制完整 POSIX 路径</span>
              <kbd className="mono">⌘C</kbd>
            </button>
            <button type="button" className="fp-row" onClick={() => void window.island.finderRunAction('open-terminal')}>
              <Terminal size={14} />
              <span>在此处打开终端 (Terminal)</span>
              <kbd className="mono">↵</kbd>
            </button>
            <button type="button" className="fp-row" onClick={() => void window.island.finderRunAction('open-cursor')}>
              <Code2 size={14} />
              <span>用 Cursor 打开当前目录</span>
              <kbd className="mono">Cursor</kbd>
            </button>
            <button type="button" className="fp-row" onClick={() => void window.island.finderRunAction('open-vscode')}>
              <Code2 size={14} />
              <span>用 VS Code 打开当前目录</span>
              <kbd className="mono">Code</kbd>
            </button>
            <button type="button" className="fp-row highlight" onClick={() => void window.island.finderRunAction('send-to-lasso')}>
              <Sparkles size={14} />
              <span>发送选中文件或路径到 Lasso AI</span>
              <kbd className="mono">AI</kbd>
            </button>
          </div>
        </section>
      </motion.div>
    </div>
  );
}
