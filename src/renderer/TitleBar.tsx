import { useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Maximize2, Minimize2, Pin, Plus, Search, X } from 'lucide-react';
import { targetLabels, type ShellState } from '../shared/contracts';
import { BrandMark } from './BrandMark';
import { Badge, taskDot, taskStatus } from './targets';
import { Glide, pop } from './motion';

const TAB_WIDTH = 132, MORE_WIDTH = 38;

/** One 44px sunken tab row: open conversations, overflow count, new task, expand, pin, and ⌘K. */
export function TitleBar({ state }: { state: ShellState }) {
  const { tasks, activeTaskId } = state;
  const row = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(340);

  useLayoutEffect(() => {
    if (!row.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(row.current);
    return () => observer.disconnect();
  }, [Boolean(tasks.length)]);

  let capacity = Math.max(1, Math.floor(width / TAB_WIDTH));
  if (tasks.length > capacity) capacity = Math.max(1, Math.floor((width - MORE_WIDTH) / TAB_WIDTH));
  const visible = tasks.slice(0, capacity);
  const active = tasks.find(task => task.id === activeTaskId);
  if (active && !visible.includes(active)) visible[visible.length - 1] = active;
  const overflow = tasks.length - visible.length;

  function navigate(event: React.KeyboardEvent, id: string) {
    const index = tasks.findIndex(task => task.id === id);
    const target =
      event.key === 'ArrowRight'
        ? tasks[(index + 1) % tasks.length]
        : event.key === 'ArrowLeft'
          ? tasks[(index - 1 + tasks.length) % tasks.length]
          : event.key === 'Home'
            ? tasks[0]
            : event.key === 'End'
              ? tasks.at(-1)
              : null;
    if (!target) return;
    event.preventDefault();
    void window.desktop.selectTask(target.id).then(() => requestAnimationFrame(() => document.getElementById('tab-' + target.id)?.focus()));
  }

  return (
    <header className="l-bar">
      {!tasks.length ? (
        <div className="l-wordmark">
          <BrandMark size={18} />
          <span>Lasso</span>
        </div>
      ) : (
        <div className="l-tabs" ref={row} role="tablist" aria-label="对话标签">
          <AnimatePresence initial={false} mode="popLayout">
            {visible.map(task => {
              const selected = task.id === activeTaskId;
              const status = taskStatus(task);
              return (
                <motion.div key={task.id} layout="position" {...pop} className={'l-tab' + (selected ? ' active' : '')}>
                  {selected && <Glide id="tab-active" className="l-tab-bg" />}
                  <button
                    id={'tab-' + task.id}
                    type="button"
                    role="tab"
                    className="l-tab-select"
                    aria-selected={selected}
                    tabIndex={selected ? 0 : -1}
                    title={`${targetLabels[task.target]} · ${task.title} · ${status}`}
                    onClick={() => void window.desktop.selectTask(task.id)}
                    onKeyDown={event => navigate(event, task.id)}
                  >
                    <span className={'dot ' + taskDot(task)} aria-label={status} />
                    <Badge target={task.target} />
                    <span className="l-tab-title">{task.title}</span>
                  </button>
                  <button
                    type="button"
                    className="l-tab-close"
                    aria-label={`关闭 ${task.title}`}
                    title="关闭标签"
                    onClick={() => void window.desktop.closeTask(task.id)}
                  >
                    <X size={12} />
                  </button>
                </motion.div>
              );
            })}
            {overflow > 0 && (
              <motion.button
                key="more"
                type="button"
                layout="position"
                {...pop}
                className="l-more"
                aria-label={`另外 ${overflow} 个对话`}
                title="全部对话"
                onClick={() => void window.desktop.openPalette('tasks')}
              >
                +{overflow}
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      )}
      <button type="button" className="l-icon" aria-label="新对话" title="新对话 ⌘N" onClick={() => void window.desktop.openPalette('new')}>
        <Plus size={16} />
      </button>
      <button
        type="button"
        className="l-icon"
        aria-label={state.expanded ? '还原小窗' : '放大到工作区'}
        title={state.expanded ? '还原小窗' : '放大到工作区'}
        aria-pressed={state.expanded}
        onClick={() => void window.desktop.act('expand')}
      >
        {state.expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </button>
      <button
        type="button"
        className="l-icon"
        aria-label={state.pinned ? '取消置顶' : '置顶'}
        title={state.pinned ? '已置顶：点击窗外不隐藏' : '置顶'}
        aria-pressed={state.pinned}
        onClick={() => void window.desktop.act('pin')}
      >
        <Pin size={14} />
      </button>
      <button type="button" className="l-cmd" aria-label="打开指令面板" title="指令面板 ⌘K" onClick={() => void window.desktop.openPalette('all')}>
        <Search size={14} />
        <span className="l-kbd">⌘K</span>
      </button>
      {state.loading && <div className="l-loading-line" aria-label="网页加载中" />}
    </header>
  );
}
