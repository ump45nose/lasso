import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import { targetLabels, taskActivityLabels } from '../shared/contracts';
import type { TaskSummary } from '../shared/contracts';

export function TaskTabs({ tasks, activeId }: { tasks: TaskSummary[]; activeId: string | null }) {
  const row = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(520);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(row.current!);
    return () => observer.disconnect();
  }, []);
  // Leave room for a new-tab button and a draggable area. Reserve the menu only on overflow.
  let capacity = Math.max(1, Math.floor((width - 64) / 126));
  if (tasks.length > capacity) capacity = Math.max(1, Math.floor((width - 108) / 126));
  const visible = tasks.slice(0, capacity);
  const active = tasks.find(task => task.id === activeId);
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
  return <div className="tabs-row" ref={row}>
    <div className="task-tab-space" role="tablist" aria-label="本次任务">
      {!tasks.length && <span className="empty-tab-title">Lasso</span>}
      {visible.map(task => {
        const status = task.residency === 'released' ? '已释放 · 点击恢复' : task.retainedReason || taskActivityLabels[task.activity];
        return <div key={task.id} className={'task-tab ' + (task.id === activeId ? 'active' : '')}>
          <button id={'tab-' + task.id} role="tab" aria-selected={task.id === activeId} tabIndex={task.id === activeId ? 0 : -1}
            className="task-tab-select" title={`${targetLabels[task.target]} · ${task.title} · ${status}`} onClick={() => void window.desktop.selectTask(task.id)} onKeyDown={event => navigate(event, task.id)}>
            <span aria-label={status} className={`status-dot ${task.residency === 'released' ? 'released' : task.activity}`} />
            <span className="target-mark" aria-label={targetLabels[task.target]}>{task.target === 'chatgpt' ? '✳' : task.target === 'gemini' ? '✦' : task.target === 'codex' ? 'C' : 'π'}</span><span className="tab-title">{task.title}</span>
          </button>
          <button className="tab-close" aria-label={`关闭 ${task.title}`} title="关闭任务" onClick={() => void window.desktop.closeTask(task.id)}><X size={12} /></button>
        </div>;
      })}
    </div>
    {overflow > 0 && <button className="tab-overflow" aria-label={`另外 ${overflow} 个任务`} title="更多任务" onClick={event => void window.desktop.taskOverflow(visible.map(task => task.id), event.currentTarget.getBoundingClientRect().x)}><ChevronDown size={13} /><span>{overflow}</span></button>}
    <button className="new-task" aria-label="新对话" title="新对话" onClick={() => void window.desktop.act('new-task')}><Plus size={16} /></button>
    <div className="tab-drag-space" />
  </div>;
}
