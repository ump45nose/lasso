import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bell, Check, Clock, Coffee, Columns2, Crop, FileText, Flame, FolderOpen, LayoutGrid, Maximize2, PanelLeft, PanelRight, Pause, Play, RotateCcw, Settings2, Sparkles, Square, X } from 'lucide-react';
import type { IslandAPI, IslandState } from '../../shared/contracts';
import { BrandMark } from '../BrandMark';
import { useFonts } from '../fonts';
import { spring } from '../motion';
import './island.css';

declare global {
  interface Window {
    island: IslandAPI;
  }
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export function NotchIsland() {
  const [state, setState] = useState<IslandState | null>(null);
  useFonts(state?.fonts);

  useEffect(() => {
    document.documentElement.classList.add('isl-html');
    document.body.classList.add('isl-body');
    const stop = window.island.onState(setState);
    void window.island.getState().then(setState);
    return () => stop();
  }, []);

  if (!state) return null;
  const { mode, pomodoro, toast, alerts, nookTasks, glow } = state;

  function enterShell() {
    window.island.hit(true);
    if (mode === 'focus') window.island.setMode('focus-hover');
  }

  function leaveShell() {
    if (mode === 'focus-hover') window.island.setMode('focus');
    window.island.hit(false);
  }

  return (
    <div
      className="isl-stage"
      onPointerDown={event => {
        if (event.target === event.currentTarget && (mode === 'board' || mode === 'focus-hover')) {
          window.island.setMode(pomodoro?.active ? (pomodoro.kind === 'slacking' ? 'slacking' : 'focus') : alerts.length ? 'nook-alert' : 'idle');
          window.island.hit(false);
        }
      }}
    >
      <motion.div
        layout
        transition={spring}
        className={`isl-shell mode-${mode}${glow ? ' glow-on' : ''}`}
        role="region"
        aria-label="Lasso 刘海岛"
        onPointerEnter={enterShell}
        onPointerLeave={leaveShell}
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {mode === 'idle' && (
            <motion.button
              key="idle"
              type="button"
              className="isl-pill-btn"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => window.island.setMode('board')}
            >
              <BrandMark size={14} ink="var(--on-ink)" draw="once" />
              <span className="isl-idle-title">Lasso</span>
              <span className="isl-idle-sub mono">{nookTasks.length} 项待办</span>
            </motion.button>
          )}

          {mode === 'toast' && toast && (
            <motion.div key="toast" className="isl-row" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <span className="dot complete" />
              <span className="isl-toast-text">{toast.text}</span>
              {toast.badge && <kbd className="isl-kbd mono">{toast.badge}</kbd>}
            </motion.div>
          )}

          {mode === 'focus' && pomodoro && (
            <motion.button
              key="focus"
              type="button"
              className="isl-pill-btn"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => window.island.setMode('board')}
            >
              <span className="dot running" />
              <span className="isl-focus-task">{pomodoro.taskTitle}</span>
              <span className="isl-clock mono">{formatClock(pomodoro.remainingSeconds)}</span>
            </motion.button>
          )}

          {mode === 'focus-hover' && pomodoro && (
            <motion.div key="focus-hover" className="isl-focus-card" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="isl-focus-main">
                <span className="dot running" />
                <div className="isl-focus-copy">
                  <strong>{pomodoro.taskTitle}</strong>
                  <small>Nook 联动番茄钟 · {pomodoro.paused ? '已暂停' : '专注中'}</small>
                </div>
                <span className="isl-clock-lg mono">{formatClock(pomodoro.remainingSeconds)}</span>
              </div>
              <div className="isl-actions">
                <button type="button" className="isl-btn" onClick={() => void window.island.togglePausePomodoro()}>
                  {pomodoro.paused ? <Play size={12} /> : <Pause size={12} />}
                  {pomodoro.paused ? '继续' : '暂停'}
                </button>
                {pomodoro.taskId && (
                  <button type="button" className="isl-btn primary" onClick={() => void window.island.completeTask(pomodoro.taskId!)}>
                    <Check size={12} />完成任务
                  </button>
                )}
                <button type="button" className="isl-btn" onClick={() => void window.island.stopPomodoro()}>
                  <Square size={11} />结束
                </button>
                <button type="button" className="isl-icon push" aria-label="展开工作台" onClick={() => window.island.setMode('board')}>
                  <LayoutGrid size={13} />
                </button>
              </div>
            </motion.div>
          )}

          {mode === 'slacking' && (
            <motion.div key="slacking" className="isl-focus-card slacking" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="isl-focus-main">
                <Coffee size={15} className="isl-clay-icon" />
                <div className="isl-focus-copy">
                  <strong>{pomodoro?.taskTitle || '摸鱼提醒 · 起身活动喝水'}</strong>
                  <small>已连续专注一轮，放松眼睛与肩颈 5 分钟</small>
                </div>
                <span className="isl-clock-lg mono">{formatClock(pomodoro?.remainingSeconds ?? 300)}</span>
              </div>
              <div className="isl-actions">
                <button
                  type="button"
                  className="isl-btn primary"
                  onClick={() => void window.island.startPomodoro(nookTasks[0] ? { id: nookTasks[0].id, title: nookTasks[0].title } : undefined, 25, 'focus')}
                >
                  <Flame size={12} />开始下一轮 25m
                </button>
                <button type="button" className="isl-btn" onClick={() => void window.island.stopPomodoro()}>
                  <Check size={12} />结束休息
                </button>
                <button type="button" className="isl-icon push" aria-label="切换四边呼吸光" onClick={() => void window.island.setGlow(!glow)}>
                  <Sparkles size={13} />
                </button>
              </div>
            </motion.div>
          )}

          {mode === 'nook-alert' && (
            <motion.div key="nook-alert" className="isl-alert-card" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="isl-card-head">
                <Bell size={13} className="isl-clay-icon" />
                <strong>Nook 提醒与守护告警</strong>
                <span className="isl-tag mono">{alerts.length} 条</span>
                <button type="button" className="isl-icon push" aria-label="打开工作台" onClick={() => window.island.setMode('board')}>
                  <LayoutGrid size={13} />
                </button>
              </div>
              <ul className="isl-alert-list">
                {alerts.map(item => (
                  <li key={item.id} className="isl-alert-item">
                    <div className="isl-alert-copy">
                      <strong>{item.title}</strong>
                      <small>{item.subtitle}</small>
                    </div>
                    <div className="isl-alert-btns">
                      {item.kind === 'task' && item.target && (
                        <button type="button" className="isl-btn primary" onClick={() => void window.island.completeTask(item.target!)}>
                          <Check size={12} />完成
                        </button>
                      )}
                      {item.kind === 'launchd' && item.target && (
                        <button type="button" className="isl-btn primary" onClick={() => void window.island.restartService(item.target!)}>
                          <RotateCcw size={12} />重启
                        </button>
                      )}
                      <button type="button" className="isl-btn" onClick={() => void window.island.snoozeAlert(item.id, 10)}>
                        <Clock size={12} />10m
                      </button>
                      <button type="button" className="isl-icon" aria-label="关闭提醒" onClick={() => void window.island.dismissAlert(item.id)}>
                        <X size={13} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </motion.div>
          )}

          {mode === 'board' && (
            <motion.div key="board" className="isl-board" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="isl-card-head">
                <BrandMark size={14} ink="var(--on-ink)" draw="once" />
                <strong>Lasso × Nook 顶部工作台</strong>
                <button
                  type="button"
                  className={'isl-chip' + (glow ? ' active' : '')}
                  onClick={() => void window.island.setGlow(!glow)}
                >
                  <Sparkles size={11} />四边呼吸光
                </button>
                <button
                  type="button"
                  className="isl-icon push"
                  aria-label="收起刘海岛"
                  onClick={() => window.island.setMode(pomodoro?.active ? (pomodoro.kind === 'slacking' ? 'slacking' : 'focus') : 'idle')}
                >
                  <X size={14} />
                </button>
              </div>

              <div className="isl-pomo-strip">
                {pomodoro?.active ? (
                  <>
                    <div className="isl-focus-copy">
                      <strong>{pomodoro.taskTitle}</strong>
                      <small>{pomodoro.kind === 'slacking' ? '摸鱼休息倒计时' : '专注番茄钟进行中'}</small>
                    </div>
                    <span className="isl-clock-lg mono">{formatClock(pomodoro.remainingSeconds)}</span>
                    <button type="button" className="isl-btn" onClick={() => void window.island.togglePausePomodoro()}>
                      {pomodoro.paused ? <Play size={12} /> : <Pause size={12} />}
                    </button>
                    <button type="button" className="isl-btn" onClick={() => void window.island.stopPomodoro()}>
                      <Square size={11} />
                    </button>
                  </>
                ) : (
                  <>
                    <div className="isl-focus-copy">
                      <strong>番茄钟与摸鱼提醒</strong>
                      <small>选择一个 Nook 待办开始 25m 专注，或直接启动</small>
                    </div>
                    <button
                      type="button"
                      className="isl-btn primary"
                      onClick={() => void window.island.startPomodoro(nookTasks[0] ? { id: nookTasks[0].id, title: nookTasks[0].title } : undefined, 25, 'focus')}
                    >
                      <Flame size={12} />25m 专注
                    </button>
                    <button
                      type="button"
                      className="isl-btn"
                      onClick={() => void window.island.startPomodoro({ id: null, title: '摸鱼提醒 · 起身活动喝水' }, 5, 'slacking')}
                    >
                      <Coffee size={12} />5m 摸鱼
                    </button>
                  </>
                )}
              </div>

              <div className="isl-sec-head">
                <span>Nook 待办联动</span>
                <span className="mono">{nookTasks.length} OPEN</span>
              </div>
              {nookTasks.length === 0 && <p className="isl-task-empty">暂无 Nook 待办，可直接开始 25m 专注</p>}
              <ul className="isl-task-list">
                {nookTasks.slice(0, 4).map(task => (
                  <li key={task.id} className="isl-task-row">
                    <button
                      type="button"
                      className="isl-task-check"
                      aria-label={`完成 ${task.title}`}
                      onClick={() => void window.island.completeTask(task.id)}
                    >
                      <Check size={11} />
                    </button>
                    <div className="isl-task-copy">
                      <span>{task.title}</span>
                      <small>{task.listTitle}</small>
                    </div>
                    <button
                      type="button"
                      className="isl-btn"
                      onClick={() => void window.island.startPomodoro({ id: task.id, title: task.title }, 25, 'focus')}
                    >
                      <Play size={11} />专注
                    </button>
                  </li>
                ))}
              </ul>

              <div className="isl-sec-head">
                <span>窗口分屏与工作区排布</span>
                <span className="mono">⌃⌥ SNAP</span>
              </div>
              <div className="isl-snap-grid">
                <button type="button" className="isl-btn" onClick={() => void window.island.snapWindow('left-half')}>
                  <PanelLeft size={12} />左半屏
                </button>
                <button type="button" className="isl-btn" onClick={() => void window.island.snapWindow('right-half')}>
                  <PanelRight size={12} />右半屏
                </button>
                <button type="button" className="isl-btn" onClick={() => void window.island.snapWindow('maximize')}>
                  <Maximize2 size={12} />最大化
                </button>
                <button type="button" className="isl-btn primary" onClick={() => void window.island.snapWindow('coding-ai')}>
                  <Columns2 size={12} />2/3 研发双栏
                </button>
              </div>

              <div className="isl-quick-bar">
                <button type="button" className="isl-btn" onClick={() => void window.island.quickAction('screenshot-area')}>
                  <Crop size={12} />区域截图
                </button>
                <button type="button" className="isl-btn" onClick={() => void window.island.quickAction('toggle-notes')}>
                  <FileText size={12} />边缘便签
                </button>
                <button type="button" className="isl-btn" onClick={() => void window.island.quickAction('open-finder-panel')}>
                  <FolderOpen size={12} />Finder 动作
                </button>
                <button type="button" className="isl-btn push" onClick={() => void window.island.quickAction('open-settings')}>
                  <Settings2 size={12} />设置
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
