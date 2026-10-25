import { useLayoutEffect, useRef, useState } from 'react';
import { Image, Pin, TextQuote, PinOff, Plus, Search, X } from 'lucide-react';
import { targetLabels } from '../shared/contracts';
import type { ShellState } from '../shared/contracts';
import { BrandMark } from './BrandMark';
import { Badge, taskDot, taskStatus } from './targets';

const TAB_WIDTH = 124, MORE_WIDTH = 36, INPUT_WIDTH = 120;

/** One 44px row: tasks first, overflow after, then new task, pin and the command palette. */
export function TitleBar({ state }: { state: ShellState }) {
  const { tasks, activeTaskId, inputOpen } = state;
  const input = state.inputText ? 'text' : state.inputImage ? 'image' : null;
  const row = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(360);
  useLayoutEffect(() => {
    if (!row.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(row.current);
    return () => observer.disconnect();
  }, [Boolean(tasks.length || input)]);
  const room = width - (input ? INPUT_WIDTH : 0);
  let capacity = Math.max(1, Math.floor(room / TAB_WIDTH));
  if (tasks.length > capacity) capacity = Math.max(1, Math.floor((room - MORE_WIDTH) / TAB_WIDTH));
  const visible = tasks.slice(0, capacity);
  const active = tasks.find(task => task.id === activeTaskId);
  if (active && !visible.includes(active)) visible[visible.length - 1] = active;
  const overflow = tasks.length - visible.length;
  function navigate(event: React.KeyboardEvent, id: string) {
    const index = tasks.findIndex(task => task.id === id);
    const target = event.key === 'ArrowRight' ? tasks[(index + 1) % tasks.length]
      : event.key === 'ArrowLeft' ? tasks[(index - 1 + tasks.length) % tasks.length]
      : event.key === 'Home' ? tasks[0] : event.key === 'End' ? tasks.at(-1) : null;
    if (!target) return;
    event.preventDefault();
    void window.desktop.selectTask(target.id).then(() => requestAnimationFrame(() => document.getElementById('tab-' + target.id)?.focus()));
  }
  return <header className="l-bar">
    {!tasks.length && !input ? <div className="l-wordmark"><BrandMark size={18} /><span>Lasso</span></div> : <div className="l-tabs" ref={row} role="tablist" aria-label="本次任务">
      {input && <div className={'l-tab image' + (inputOpen ? ' active' : '')}>
        <button role="tab" className="l-tab-select" aria-selected={inputOpen} onClick={() => void window.desktop.act('show-input')}>{input === 'text' ? <TextQuote size={14} /> : <Image size={14} />}<span className="l-tab-title">{input === 'text' ? '待处理文字' : '待处理图片'}</span></button>
      </div>}
      {visible.map(task => {
        const selected = !inputOpen && task.id === activeTaskId, status = taskStatus(task);
        return <div key={task.id} className={'l-tab' + (selected ? ' active' : '')}>
          <button id={'tab-' + task.id} role="tab" className="l-tab-select" aria-selected={selected} tabIndex={task.id === activeTaskId ? 0 : -1}
            title={`${targetLabels[task.target]} · ${task.title} · ${status}`} onClick={() => void window.desktop.selectTask(task.id)} onKeyDown={event => navigate(event, task.id)}>
            <span className={'dot ' + taskDot(task)} aria-label={status} /><Badge target={task.target} /><span className="l-tab-title">{task.title}</span>
          </button>
          <button className="l-tab-close" aria-label={`关闭 ${task.title}`} title="关闭任务" onClick={() => void window.desktop.closeTask(task.id)}><X size={12} /></button>
        </div>;
      })}
      {overflow > 0 && <button className="l-more" aria-label={`另外 ${overflow} 个任务`} title="全部任务" onClick={() => void window.desktop.openPalette('tasks')}>+{overflow}</button>}
    </div>}
    <button className="l-icon" aria-label="新任务" title="新任务 ⌘N" onClick={() => void window.desktop.openPalette('new')}><Plus size={16} /></button>
    <span className="l-sep" />
    <button className="l-icon" aria-label={state.pinned ? '取消置顶' : '置顶'} title={state.pinned ? '已置顶：点击窗外不隐藏' : '置顶'} aria-pressed={state.pinned} onClick={() => void window.desktop.act('pin')}>{state.pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
    <button className="l-cmd" aria-label="打开指令面板" title="指令面板 ⌘K" onClick={() => void window.desktop.openPalette('all')}><Search size={14} /><span className="l-kbd">⌘K</span></button>
    {state.loading && !state.settingsOpen && <div className="l-loading-line" aria-label="网页加载中" />}
  </header>;
}
