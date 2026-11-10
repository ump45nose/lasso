import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Bell,
  Check,
  ClipboardList,
  Clock,
  Coffee,
  Columns2,
  Crop,
  FileText,
  Flame,
  FolderOpen,
  Languages,
  LayoutGrid,
  Maximize2,
  PanelLeft,
  PanelRight,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  Sparkles,
  Square,
  Terminal,
  X
} from 'lucide-react';
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
  const { mode, pomodoro, toast, alerts, nookTasks, cliTasks = [], glow, notch } = state;
  const nookPrefs = state.nookPrefs ?? { enabled: true, gitWaiting: true, prFeedback: true, prBlocked: false };
  const copyTranslateEnabled = Boolean(state.copyTranslateEnabled);
  const firstCli = cliTasks[0] ?? null;
  const hasNotch = notch?.hasNotch !== false;
  const notchW = hasNotch ? (notch?.width ?? 156) : 120;
  const notchH = hasNotch ? (notch?.height ?? 28) : 5;
  const menuH = notch?.menuBarHeight ?? (hasNotch ? (notch?.height ?? 28) : 24);

  const dropKind =
    mode === 'board'
      ? 'board'
      : mode === 'nook-alert'
        ? 'nook-alert'
        : mode === 'slacking'
          ? 'slacking'
          : mode === 'focus-hover' && pomodoro
            ? 'focus-hover'
            : mode === 'toast' && toast
              ? 'toast'
              : mode === 'focus' && pomodoro
                ? 'focus'
                : firstCli
                  ? 'cli'
                  : null;
  const isCapsule = dropKind === 'focus' || dropKind === 'cli' || dropKind === 'toast';

  function resolveCollapsedMode() {
    return pomodoro?.active ? (pomodoro.kind === 'slacking' ? 'slacking' : 'focus') : alerts.length ? 'nook-alert' : 'idle';
  }

  function enterCard() {
    window.island.hit(true);
    if (mode === 'focus') window.island.setMode('focus-hover');
  }

  function leaveCard() {
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
          window.island.setMode(resolveCollapsedMode());
          window.island.hit(false);
        }
      }}
    >
      <div
        style={{ '--notch-w': `${notchW}px`, '--notch-h': `${notchH}px`, '--menu-h': `${menuH}px` } as React.CSSProperties}
        className={`isl-shell mode-${mode}${glow ? ' glow-on' : ''}${!hasNotch ? ' no-notch' : ''}`}
        role="region"
        aria-label="Lasso 刘海岛"
      >
        <button
          type="button"
          className={`isl-notch-anchor${!hasNotch ? ' no-notch' : ''}${glow ? ' glow-on' : ''}`}
          aria-label="展开或收起 Lasso 刘海岛工作台"
          onPointerEnter={() => window.island.hit(true)}
          onPointerLeave={() => {
            if (mode !== 'board') window.island.hit(false);
          }}
          onClick={() => window.island.setMode(mode === 'board' ? resolveCollapsedMode() : 'board')}
        >
          {hasNotch && <span className="isl-cam-lens" aria-hidden="true" />}
        </button>

        <div className="isl-drop-wrap">
          <AnimatePresence mode="popLayout" initial={false}>
            {dropKind && (
              <motion.div
                layout
                transition={spring}
                initial={{ opacity: 0, y: -4, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.96 }}
                className={`isl-drop-card mode-${dropKind}${isCapsule ? ' is-capsule' : ''}${glow ? ' glow-on' : ''}`}
                onPointerEnter={enterCard}
                onPointerLeave={leaveCard}
              >
                {dropKind === 'focus' && pomodoro && (
                  <button
                    type="button"
                    className="isl-capsule-btn"
                    onClick={() => window.island.setMode('board')}
                  >
                    <span className="dot running" />
                    <span className="isl-focus-task">{pomodoro.taskTitle}</span>
                    <span className="isl-clock mono">{formatClock(pomodoro.remainingSeconds)}</span>
                  </button>
                )}

                {dropKind === 'cli' && firstCli && (
                  <button
                    type="button"
                    className={`isl-capsule-btn ni-pill ${firstCli.activity}`}
                    aria-label={`切换到 CLI 任务 ${firstCli.title}`}
                    onClick={() => void window.island.focusTask(firstCli.id)}
                  >
                    <span className={`dot ${firstCli.activity}`} />
                    <span className="ni-pill-title">{firstCli.target === 'codex' ? 'Codex' : 'Pi'} · {firstCli.title}</span>
                    <span className="ni-pill-state mono">{firstCli.activity === 'waiting' ? '待审批' : '运行中'}</span>
                  </button>
                )}

                {dropKind === 'toast' && toast && (
                  <div className="isl-row">
                    <span className="dot complete" />
                    <span className="isl-toast-text">{toast.text}</span>
                    {toast.badge && <kbd className="isl-kbd mono">{toast.badge}</kbd>}
                    <button
                      type="button"
                      className="isl-icon isl-toast-close"
                      aria-label="关闭提示"
                      onClick={() => window.island.setMode(resolveCollapsedMode())}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}

                {dropKind === 'focus-hover' && pomodoro && (
                  <div className="isl-focus-card">
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
                  </div>
                )}

                {dropKind === 'slacking' && (
                  <div className="isl-focus-card slacking">
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
                  </div>
                )}

                {dropKind === 'nook-alert' && (
                  <div className="isl-alert-card">
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
                            <button type="button" className="isl-btn mono" onClick={() => void window.island.snoozeAlert(item.id, 10)}>
                              <Clock size={11} />10m
                            </button>
                            <button type="button" className="isl-btn mono" onClick={() => void window.island.snoozeAlert(item.id, 30)}>
                              30m
                            </button>
                            <button type="button" className="isl-btn mono" onClick={() => void window.island.snoozeAlert(item.id, 120)}>
                              2h
                            </button>
                            <button type="button" className="isl-icon" aria-label="关闭提醒" onClick={() => void window.island.dismissAlert(item.id)}>
                              <X size={13} />
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {dropKind === 'board' && (
                  <div className="isl-board">
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
                        onClick={() => window.island.setMode(resolveCollapsedMode())}
                      >
                        <X size={14} />
                      </button>
                    </div>

                    <div className="isl-pomo-strip">
                      {pomodoro?.active ? (
                        <>
                          <div className="isl-focus-copy">
                            <strong>{pomodoro.taskTitle}</strong>
                            <small>{pomodoro.kind === 'slacking' ? '休息倒计时' : '专注番茄钟进行中'}</small>
                          </div>
                          <span className="isl-clock-lg mono">{formatClock(pomodoro.remainingSeconds)}</span>
                          <button type="button" className="isl-btn" aria-label={pomodoro.paused ? '继续番茄钟' : '暂停番茄钟'} onClick={() => void window.island.togglePausePomodoro()}>
                            {pomodoro.paused ? <Play size={12} /> : <Pause size={12} />}
                          </button>
                          <button type="button" className="isl-btn" aria-label="结束番茄钟" onClick={() => void window.island.stopPomodoro()}>
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
                        {nookTasks.slice(0, cliTasks.length > 0 ? 2 : 3).map(task => (
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
                      <span>Nook 提醒与 PR 跟进</span>
                      <span className="mono">{nookPrefs.enabled ? 'NOOK ON' : 'MUTED'}</span>
                    </div>
                    <div className="isl-toggle-grid" role="group" aria-label="Nook 提醒与 PR 跟进">
                      <button
                        type="button"
                        className={`isl-toggle-chip${nookPrefs.enabled ? ' on' : ''}`}
                        aria-pressed={nookPrefs.enabled}
                        onClick={() => void window.island.setNookReminderPrefs({ enabled: !nookPrefs.enabled })}
                      >
                        <span>提醒总开关</span>
                        <span className="mono">{nookPrefs.enabled ? '开启' : '关闭'}</span>
                      </button>
                      <button
                        type="button"
                        className={`isl-toggle-chip${nookPrefs.gitWaiting ? ' on' : ''}`}
                        aria-pressed={nookPrefs.gitWaiting}
                        onClick={() => void window.island.setNookReminderPrefs({ gitWaiting: !nookPrefs.gitWaiting })}
                      >
                        <span>等待我回复</span>
                        <span className="mono">{nookPrefs.gitWaiting ? '开启' : '关闭'}</span>
                      </button>
                      <button
                        type="button"
                        className={`isl-toggle-chip${nookPrefs.prFeedback ? ' on' : ''}`}
                        aria-pressed={nookPrefs.prFeedback}
                        onClick={() => void window.island.setNookReminderPrefs({ prFeedback: !nookPrefs.prFeedback })}
                      >
                        <span>PR 新反馈</span>
                        <span className="mono">{nookPrefs.prFeedback ? '开启' : '关闭'}</span>
                      </button>
                      <button
                        type="button"
                        className={`isl-toggle-chip${nookPrefs.prBlocked ? ' on' : ''}`}
                        aria-pressed={nookPrefs.prBlocked}
                        onClick={() => void window.island.setNookReminderPrefs({ prBlocked: !nookPrefs.prBlocked })}
                      >
                        <span>PR 阻塞</span>
                        <span className="mono">{nookPrefs.prBlocked ? '开启' : '关闭'}</span>
                      </button>
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
                      <div className="isl-quick-tools">
                        <button
                          type="button"
                          className={`isl-btn${copyTranslateEnabled ? ' primary' : ''}`}
                          aria-pressed={copyTranslateEnabled}
                          onClick={() => void window.island.setCopyTranslate(!copyTranslateEnabled)}
                        >
                          <Languages size={12} />复制即译 <span className="mono">{copyTranslateEnabled ? '开' : '关'}</span>
                        </button>
                        <button type="button" className="isl-btn" onClick={() => void window.island.quickAction('open-translator')}>
                          <Languages size={12} />输入翻译
                        </button>
                        <button type="button" className="isl-btn" onClick={() => void window.island.quickAction('open-clipboard')}>
                          <ClipboardList size={12} />剪贴板历史 <kbd className="isl-kbd mono">⌥V</kbd>
                        </button>
                      </div>
                      <div className="isl-quick-row">
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
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
