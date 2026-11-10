import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowLeftToLine, ArrowRightToLine, Bell, Check, Clock, Coffee, Columns2, Crop, FileText, Flame, FolderOpen, LayoutGrid, Maximize2, PanelLeft, PanelRight, Pause, Play, RotateCcw, Settings2, Sparkles, Square, Terminal, X } from 'lucide-react';
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
  const [isHovered, setIsHovered] = useState(false);
  useFonts(state?.fonts);

  useEffect(() => {
    document.documentElement.classList.add('isl-html');
    document.body.classList.add('isl-body');
    const stop = window.island.onState(setState);
    void window.island.getState().then(setState);
    return () => stop();
  }, []);

  if (!state) return null;
  const { mode, pomodoro, toast, alerts, nookTasks, cliTasks = [], glow, notch } = state;
  const firstCli = cliTasks[0] ?? null;
  const notchW = notch?.hasNotch === false ? 0 : (notch?.width ?? 156);
  const notchH = notch?.hasNotch === false ? 24 : (notch?.height ?? 28);
  const compactMode = mode === 'idle' || mode === 'focus';
  const isIdleCollapsed = mode === 'idle' && !firstCli && !isHovered;

  function enterShell() {
    setIsHovered(true);
    window.island.hit(true);
    if (mode === 'focus') window.island.setMode('focus-hover');
  }

  function leaveShell() {
    setIsHovered(false);
    if (mode === 'focus-hover') window.island.setMode('focus');
    window.island.hit(false);
  }

  function startFocus() {
    void window.island.startPomodoro(nookTasks[0] ? { id: nookTasks[0].id, title: nookTasks[0].title } : undefined, 25, 'focus');
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
        style={{ '--notch-w': `${notchW}px`, '--notch-h': `${notchH}px` } as React.CSSProperties}
        className={`isl-shell mode-${mode}${glow ? ' glow-on' : ''}${notch?.hasNotch === false ? ' no-notch' : ''}${compactMode && firstCli ? ' has-cli' : ''}${isIdleCollapsed ? ' idle-collapsed' : ''}`}
        role="region"
        aria-label="Lasso 刘海岛"
        onPointerEnter={enterShell}
        onPointerLeave={leaveShell}
      >
        {!compactMode && (
          <div className="isl-notch-cap" aria-hidden="true">
            <span className="isl-cap-ear left">
              <BrandMark size={11} ink="var(--on-ink)" />
              <span className="mono">LASSO</span>
            </span>
            <span className="isl-notch-cutout">
              <span className="isl-cam-lens" />
            </span>
            <span className="isl-cap-ear right mono">
              {pomodoro?.active ? formatClock(pomodoro.remainingSeconds) : `${nookTasks.length} OPEN`}
            </span>
          </div>
        )}
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
              <span className="isl-wing left">
                <BrandMark size={13} ink="var(--on-ink)" draw="once" />
                <span className="isl-idle-title">Lasso</span>
              </span>
              <span className="isl-notch-cutout" aria-hidden="true">
                <span className="isl-cam-lens" />
              </span>
              <span className="isl-wing right">
                <span className="dot complete" />
                <span className="isl-idle-sub mono">{nookTasks.length} 项待办</span>
              </span>
            </motion.button>
          )}

          {mode === 'toast' && toast && (
            <motion.div key="toast" className="isl-row" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <span className="dot complete" />
              <span className="isl-toast-text">{toast.text}</span>
              {toast.badge && <kbd className="isl-kbd mono">{toast.badge}</kbd>}
              <button
                type="button"
                className="isl-icon isl-toast-close"
                aria-label="关闭提示"
                onClick={() => window.island.setMode(pomodoro?.active ? (pomodoro.kind === 'slacking' ? 'slacking' : 'focus') : 'idle')}
              >
                <X size={12} />
              </button>
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
              <span className="isl-wing left">
                <span className="dot running" />
                <span className="isl-focus-task">{pomodoro.taskTitle}</span>
              </span>
              <span className="isl-notch-cutout" aria-hidden="true">
                <span className="isl-cam-lens" />
              </span>
              <span className="isl-wing right">
                <span className="isl-clock mono">{formatClock(pomodoro.remainingSeconds)}</span>
              </span>
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
                  <strong>{pomodoro?.taskTitle || '休息提醒 · 起身活动喝水'}</strong>
                  <small>已连续专注一轮，放松眼睛与肩颈 5 分钟</small>
                </div>
                <span className="isl-clock-lg mono">{formatClock(pomodoro?.remainingSeconds ?? 300)}</span>
              </div>
              <div className="isl-actions">
                <button type="button" className="isl-btn primary" onClick={startFocus}>
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
                <button type="button" className="isl-icon" aria-label="全部关闭" onClick={() => void window.island.dismissAlert('*')}>
                  <X size={13} />
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
                      <small>{pomodoro.kind === 'slacking' ? '休息休息倒计时' : '专注番茄钟进行中'}</small>
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
                      <strong>番茄钟与休息提醒</strong>
                      <small>选择一个 Nook 待办开始 25m 专注，或直接启动</small>
                    </div>
                    <button type="button" className="isl-btn primary" onClick={startFocus}>
                      <Flame size={12} />25m 专注
                    </button>
                    <button
                      type="button"
                      className="isl-btn"
                      onClick={() => void window.island.startPomodoro({ id: null, title: '休息提醒 · 起身活动喝水' }, 5, 'slacking')}
                    >
                      <Coffee size={12} />5m 休息
                    </button>
                  </>
                )}
              </div>

              <div className="isl-board-tasks">
              {cliTasks.length > 0 && (
                <>
                  <div className="isl-sec-head">
                    <span>活跃 CLI 任务</span>
                    <span className="mono">{cliTasks.length} ACTIVE</span>
                  </div>
                  <div className="isl-cli-list" role="list" aria-label="活跃 CLI 任务">
                    {cliTasks.map(task => (
                      <button key={task.id} type="button" className={`isl-cli-row ${task.activity}`} onClick={() => void window.island.focusTask(task.id)}>
                        <span className={`dot ${task.activity}`} />
                        <Terminal size={12} className="isl-clay-icon" />
                        <span className="isl-cli-title">{task.target === 'codex' ? 'Codex' : 'Pi'} · {task.title}</span>
                        <span className="isl-cli-state mono">{task.activity === 'waiting' ? '待审批 →' : '运行中 →'}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}

              <div className="isl-sec-head">
                <span>Nook 待办联动</span>
                <span className="mono">{nookTasks.length} OPEN</span>
              </div>
              {nookTasks.length === 0 && <p className="isl-task-empty">暂无 Nook 待办，可直接开始 25m 专注</p>}
              <ul className="isl-task-list">
                {nookTasks.slice(0, cliTasks.length > 0 ? 2 : 4).map(task => (
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
              </div>

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
                  <Columns2 size={12} />2:1 双栏布局
                </button>
                <button type="button" className="isl-btn" onClick={() => void window.island.snapWindow('prev-display')}>
                  <ArrowLeftToLine size={12} />移至左屏 <kbd className="isl-kbd mono">⌃⌥⌘←</kbd>
                </button>
                <button type="button" className="isl-btn" onClick={() => void window.island.snapWindow('next-display')}>
                  <ArrowRightToLine size={12} />移至右屏 <kbd className="isl-kbd mono">⌃⌥⌘→</kbd>
                </button>
              </div>

              <div className="isl-quick-bar">
                <button type="button" className="isl-btn" onClick={() => void window.island.quickAction('screenshot-area')}>
                  <Crop size={12} />区域截图
                </button>
                <button type="button" className="isl-btn" onClick={() => void window.island.quickAction('toggle-notes')}>
                  <FileText size={12} />浮动便签 <kbd className="isl-kbd mono">⌥N</kbd>
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
        {compactMode && firstCli && (
          <button
            type="button"
            className={`ni-pill ${firstCli.activity}`}
            aria-label={`切换到 CLI 任务 ${firstCli.title}`}
            onClick={() => void window.island.focusTask(firstCli.id)}
          >
            <span className={`dot ${firstCli.activity}`} />
            <span className="ni-pill-title">{firstCli.target === 'codex' ? 'Codex' : 'Pi'} · {firstCli.title}</span>
            <span className="ni-pill-state mono">{firstCli.activity === 'waiting' ? '待审批' : '运行中'}</span>
          </button>
        )}
      </motion.div>
    </div>
  );
}
