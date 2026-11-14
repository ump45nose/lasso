import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowUpRight,
  Bell,
  Check,
  ClipboardList,
  Coffee,
  FolderOpen,
  Languages,
  ListChecks,
  NotebookPen,
  Pause,
  Play,
  RotateCcw,
  Scan,
  Settings,
  Square,
  SunDim,
  Target,
  Timer,
  X
} from 'lucide-react';
import type { IslandAPI, IslandState } from '../../shared/contracts';
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

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function formatTodayLabel(): string {
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${mm}·${dd} ${WEEKDAYS[now.getDay()]}`;
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
  const { mode, pomodoro, toast, alerts, nookReview, nookTasks, nookCompletedCount, nookTotalCount, glow, notch } = state;
  const openTasks = nookTasks.filter(t => !t.completed);
  const hasReview = Boolean(nookReview && (nookReview.mainGoal.trim() || nookReview.items.length > 0));
  const hasNotch = Boolean(notch?.hasNotch);
  const notchW = hasNotch ? (notch?.width ?? 168) : 0;
  const notchH = hasNotch ? (notch?.height ?? 30) : (notch?.menuBarHeight ?? 28);
  const menuH = notch?.menuBarHeight ?? (hasNotch ? (notch?.height ?? 30) : 28);
  const leftSafeW = hasNotch
    ? Math.min(220, Math.max(140, notch?.leftSafeWidth ?? 180))
    : Math.min(184, Math.max(124, notch?.leftSafeWidth ?? 156));
  const rightSafeW = hasNotch ? 0 : Math.min(124, Math.max(76, notch?.rightSafeWidth ?? 92));

  // State 1: All-Clear hidden when nothing pending and not expanded
  const wingKind =
    mode === 'toast' && toast
      ? 'toast'
      : alerts.length > 0
        ? 'nook-alert'
        : pomodoro?.active
          ? 'focus'
          : openTasks.length > 0 || hasReview
            ? 'idle'
            : null;

  const dropKind =
    mode === 'board'
      ? 'board'
      : mode === 'nook-alert' && alerts.length > 0
        ? 'nook-alert'
        : mode === 'slacking'
          ? 'slacking'
          : mode === 'focus-hover' && pomodoro?.active
            ? 'focus-hover'
            : null;

  function resolveCollapsedMode() {
    return pomodoro?.active ? (pomodoro.kind === 'slacking' ? 'slacking' : 'focus') : 'idle';
  }

  function enterCard() {
    window.island.hit(true);
    if (mode === 'focus') window.island.setMode('focus-hover');
    else if (mode === 'idle' && alerts.length > 0) window.island.setMode('nook-alert');
  }

  function leaveCard() {
    if (mode === 'focus-hover' || mode === 'nook-alert') window.island.setMode(resolveCollapsedMode());
    window.island.hit(false);
  }

  function startFocus(task?: { id: string | null; title: string }) {
    const first = task ?? (openTasks[0] ? { id: openTasks[0].id, title: openTasks[0].title } : undefined);
    void window.island.startPomodoro(first, 25, 'focus');
  }

  const urgentTitle = openTasks[0]?.title || nookReview?.items[0] || nookReview?.mainGoal || '';
  const pomoProgress =
    pomodoro && pomodoro.totalSeconds > 0
      ? Math.max(2, Math.min(100, Math.round(((pomodoro.totalSeconds - pomodoro.remainingSeconds) / pomodoro.totalSeconds) * 100)))
      : 0;

  return (
    <div
      className="isl-stage"
      onPointerDown={event => {
        if (event.target === event.currentTarget && (mode === 'board' || mode === 'focus-hover' || mode === 'nook-alert')) {
          window.island.setMode(resolveCollapsedMode());
          window.island.hit(false);
        }
      }}
    >
      <div
        style={
          {
            '--notch-w': `${notchW}px`,
            '--notch-h': `${notchH}px`,
            '--menu-h': `${menuH}px`,
            '--left-safe-w': `${leftSafeW}px`,
            '--right-safe-w': `${rightSafeW}px`
          } as React.CSSProperties
        }
        className={`isl-shell mode-${mode}${glow ? ' glow-on' : ''}${!hasNotch ? ' no-notch' : ''}`}
        role="region"
        aria-label="Lasso 刘海岛"
      >
        {(wingKind || dropKind) && hasNotch && (
          <button
            type="button"
            className={`isl-notch-anchor${glow ? ' glow-on' : ''}`}
            aria-label="展开或收起今日聚焦看板"
            onPointerEnter={event => {
              if (event.metaKey) {
                window.island.hit(false);
                return;
              }
              window.island.hit(true);
            }}
            onPointerLeave={() => {
              if (mode !== 'board') window.island.hit(false);
            }}
            onClick={() => window.island.setMode(mode === 'board' ? resolveCollapsedMode() : 'board')}
          />
        )}

        {wingKind && (
          <div
            className={`isl-menubar-wings mode-${wingKind}${!hasNotch ? ' no-notch' : ''}${glow ? ' glow-on' : ''}`}
            onPointerEnter={event => {
              if (event.metaKey) {
                window.island.hit(false);
                return;
              }
              enterCard();
            }}
            onPointerMove={event => {
              if (event.metaKey) window.island.hit(false);
            }}
            onPointerDown={event => {
              if (event.metaKey) window.island.hit(false);
            }}
            onPointerLeave={leaveCard}
          >
            {wingKind === 'idle' && (
              <button
                type="button"
                className="isl-wing-hit"
                aria-label="展开今日聚焦看板"
                onClick={() => window.island.setMode(mode === 'board' ? resolveCollapsedMode() : 'board')}
              >
                <span className="isl-wing isl-wing-left">
                  <span className="isl-dot-faint" />
                  <span className="isl-wing-title">{urgentTitle}</span>
                </span>
                {hasNotch && <span className="isl-wing-notch-gap" aria-hidden="true" />}
                <span className="isl-wing isl-wing-right">
                  <span className="isl-wing-meta mono">{openTasks.length > 0 ? `今日剩 ${openTasks.length} 项` : '本周主线'}</span>
                </span>
              </button>
            )}

            {wingKind === 'focus' && pomodoro && (
              <button
                type="button"
                className="isl-wing-hit"
                aria-label={`专注计时 ${pomodoro.taskTitle}`}
                onClick={() => window.island.setMode(mode === 'board' ? resolveCollapsedMode() : 'board')}
              >
                <span className="isl-wing isl-wing-left">
                  <Timer size={13} className="isl-wing-ic" />
                  <span className="isl-wing-title">
                    {pomodoro.kind === 'slacking' ? '休息' : '专注'} · {pomodoro.taskTitle}
                  </span>
                </span>
                {hasNotch && <span className="isl-wing-notch-gap" aria-hidden="true" />}
                <span className="isl-wing isl-wing-right">
                  <span className="isl-clock mono">{formatClock(pomodoro.remainingSeconds)}</span>
                </span>
              </button>
            )}

            {wingKind === 'nook-alert' && (
              <button
                type="button"
                className="isl-wing-hit"
                aria-label="Nook 紧迫提醒"
                onClick={() => window.island.setMode(mode === 'board' ? resolveCollapsedMode() : 'board')}
              >
                <span className="isl-wing isl-wing-left">
                  <span className="isl-dot-clay" />
                  <span className="isl-wing-title">{alerts[0]?.title || 'Nook 提醒'}</span>
                </span>
                {hasNotch && <span className="isl-wing-notch-gap" aria-hidden="true" />}
                <span className="isl-wing isl-wing-right">
                  <span className="isl-wing-meta mono">{alerts[0]?.subtitle || `${alerts.length} 条提醒`}</span>
                </span>
              </button>
            )}

            {wingKind === 'toast' && toast && (
              <div className="isl-wing-hit">
                <span className="isl-wing isl-wing-left">
                  <span className="isl-dot-olive" />
                  <span className="isl-wing-title">{toast.text}</span>
                </span>
                {hasNotch && <span className="isl-wing-notch-gap" aria-hidden="true" />}
                <span className="isl-wing isl-wing-right">
                  {toast.badge && <kbd className="isl-kbd mono">{toast.badge}</kbd>}
                  <button
                    type="button"
                    className="isl-ib sm"
                    aria-label="关闭提示"
                    onClick={() => window.island.setMode(resolveCollapsedMode())}
                  >
                    <X size={11} />
                  </button>
                </span>
              </div>
            )}
          </div>
        )}

        <div className="isl-drop-wrap">
          <AnimatePresence mode="popLayout" initial={false}>
            {dropKind && (
              <motion.div
                layout
                transition={spring}
                initial={{ opacity: 0, y: -4, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.97 }}
                className={`isl-drop-card mode-${dropKind}${glow ? ' glow-on' : ''}`}
                onPointerEnter={enterCard}
                onPointerLeave={leaveCard}
              >
                {dropKind === 'focus-hover' && pomodoro && (
                  <div className="isl-mini-card">
                    <div className="isl-blk-lbl">
                      <Timer size={13} />
                      <span>{pomodoro.paused ? '已暂停' : '专注中'}</span>
                      <span className="r trunc">{pomodoro.taskTitle}</span>
                    </div>
                    <div className="isl-timer-row">
                      <span className="isl-timer-big">{formatClock(pomodoro.remainingSeconds)}</span>
                      <span className="isl-timer-total mono">/ {formatClock(pomodoro.totalSeconds)}</span>
                      <span className="grow" />
                      <button type="button" className="isl-ib" aria-label={pomodoro.paused ? '继续' : '暂停'} onClick={() => void window.island.togglePausePomodoro()}>
                        {pomodoro.paused ? <Play size={14} /> : <Pause size={14} />}
                      </button>
                      <button type="button" className="isl-ib" aria-label="结束" onClick={() => void window.island.stopPomodoro()}>
                        <Square size={13} />
                      </button>
                    </div>
                    <div className="isl-bar-track">
                      <i style={{ width: `${pomoProgress}%` }} />
                    </div>
                  </div>
                )}

                {dropKind === 'slacking' && (
                  <div className="isl-mini-card">
                    <div className="isl-blk-lbl">
                      <Coffee size={13} />
                      <span>休息提醒 · 起身活动喝水</span>
                    </div>
                    <div className="isl-timer-row">
                      <span className="isl-timer-big">{formatClock(pomodoro?.remainingSeconds ?? 300)}</span>
                      <span className="grow" />
                      <button type="button" className="isl-ink-btn pri" onClick={() => startFocus()}>
                        开始下一轮 25m
                      </button>
                      <button type="button" className="isl-ink-btn line" onClick={() => void window.island.stopPomodoro()}>
                        结束
                      </button>
                    </div>
                  </div>
                )}

                {dropKind === 'nook-alert' && (
                  <div className="isl-mini-card">
                    {alerts.slice(0, 2).map(item => (
                      <div key={item.id} className="isl-blk alert">
                        <div className="isl-alert-top">
                          <Bell size={14} className="isl-clay-ic" />
                          <span className="isl-alert-title">{item.title}</span>
                          <span className="grow" />
                          <span className="isl-alert-meta mono">{item.subtitle}</span>
                        </div>
                        <div className="isl-alert-acts">
                          {item.kind === 'task' && item.target && (
                            <button type="button" className="isl-ink-btn line" onClick={() => void window.island.completeTask(item.target!)}>
                              完成
                            </button>
                          )}
                          {item.kind === 'launchd' && item.target && (
                            <button type="button" className="isl-ink-btn line" onClick={() => void window.island.restartService(item.target!)}>
                              <RotateCcw size={12} />
                              重启
                            </button>
                          )}
                          <button type="button" className="isl-ink-btn line mono" onClick={() => void window.island.snoozeAlert(item.id, 10)}>
                            10m
                          </button>
                          <button type="button" className="isl-ink-btn line mono" onClick={() => void window.island.snoozeAlert(item.id, 30)}>
                            30m
                          </button>
                          <button type="button" className="isl-ink-btn line mono" onClick={() => void window.island.snoozeAlert(item.id, 120)}>
                            2h
                          </button>
                          <span className="grow" />
                          <button type="button" className="isl-ib sm" aria-label="关闭提醒" onClick={() => void window.island.dismissAlert(item.id)}>
                            <X size={13} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {dropKind === 'board' && (
                  <div className="isl-board">
                    <header className="isl-board-head">
                      <h3>今日聚焦</h3>
                      <span className="isl-board-date mono">{formatTodayLabel()}</span>
                      <span className="grow" />
                      <button
                        type="button"
                        className={'isl-ib' + (glow ? ' act' : '')}
                        aria-label={glow ? '静默四边光效' : '开启四边光效'}
                        title={glow ? '点击静默屏幕四边光效' : '屏幕四边提醒微光'}
                        onClick={() => void window.island.setGlow(!glow)}
                      >
                        <SunDim size={15} />
                      </button>
                      <button
                        type="button"
                        className="isl-ib"
                        aria-label="收起看板"
                        onClick={() => window.island.setMode(resolveCollapsedMode())}
                      >
                        <X size={15} />
                      </button>
                    </header>

                    {/* 1. Alert Block (only when pending alerts exist) */}
                    {alerts.map(item => (
                      <div key={item.id} className="isl-blk alert">
                        <div className="isl-alert-top">
                          <Bell size={14} className="isl-clay-ic" />
                          <span className="isl-alert-title">{item.title}</span>
                          <span className="grow" />
                          <span className="isl-alert-meta mono">{item.subtitle}</span>
                        </div>
                        <div className="isl-alert-sub">Nook · 提醒</div>
                        <div className="isl-alert-acts">
                          {item.kind === 'task' && item.target && (
                            <button type="button" className="isl-ink-btn line" onClick={() => void window.island.completeTask(item.target!)}>
                              完成
                            </button>
                          )}
                          {item.kind === 'launchd' && item.target && (
                            <button type="button" className="isl-ink-btn line" onClick={() => void window.island.restartService(item.target!)}>
                              <RotateCcw size={12} />
                              重启
                            </button>
                          )}
                          <button type="button" className="isl-ink-btn line mono" onClick={() => void window.island.snoozeAlert(item.id, 10)}>
                            10m
                          </button>
                          <button type="button" className="isl-ink-btn line mono" onClick={() => void window.island.snoozeAlert(item.id, 30)}>
                            30m
                          </button>
                          <button type="button" className="isl-ink-btn line mono" onClick={() => void window.island.snoozeAlert(item.id, 120)}>
                            2h
                          </button>
                          <span className="grow" />
                          <button type="button" className="isl-ib sm" aria-label="关闭提醒" onClick={() => void window.island.dismissAlert(item.id)}>
                            <X size={13} />
                          </button>
                        </div>
                      </div>
                    ))}

                    {/* 2. Focus Timer Block */}
                    <div className="isl-blk">
                      {pomodoro?.active ? (
                        <>
                          <div className="isl-blk-lbl">
                            <Timer size={13} />
                            <span>{pomodoro.kind === 'slacking' ? '休息' : '专注'}</span>
                            <span className="r trunc">{pomodoro.taskTitle}</span>
                          </div>
                          <div className="isl-timer-row">
                            <span className="isl-timer-big">{formatClock(pomodoro.remainingSeconds)}</span>
                            <span className="isl-timer-total mono">/ {formatClock(pomodoro.totalSeconds)}</span>
                            <span className="grow" />
                            <button
                              type="button"
                              className="isl-ib"
                              aria-label={pomodoro.paused ? '继续' : '暂停'}
                              onClick={() => void window.island.togglePausePomodoro()}
                            >
                              {pomodoro.paused ? <Play size={15} /> : <Pause size={15} />}
                            </button>
                            <button type="button" className="isl-ib" aria-label="结束" onClick={() => void window.island.stopPomodoro()}>
                              <Square size={14} />
                            </button>
                          </div>
                          <div className="isl-bar-track">
                            <i style={{ width: `${pomoProgress}%` }} />
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="isl-blk-lbl">
                            <Timer size={13} />
                            <span>专注计时</span>
                            <span className="r">番茄钟</span>
                          </div>
                          <div className="isl-timer-idle">
                            <span className="isl-timer-hint">选一条事项开始 25m 专注，或直接启动</span>
                            <div className="isl-timer-idle-btns">
                              <button type="button" className="isl-ink-btn pri" onClick={() => startFocus()}>
                                25m 专注
                              </button>
                              <button
                                type="button"
                                className="isl-ink-btn line"
                                onClick={() => void window.island.startPomodoro({ id: null, title: '起身活动喝水' }, 5, 'slacking')}
                              >
                                5m 休息
                              </button>
                            </div>
                          </div>
                        </>
                      )}
                    </div>

                    {/* 3. Nook Review Block */}
                    <button type="button" className="isl-blk isl-review-blk" onClick={() => void window.island.openNook()}>
                      <div className="isl-blk-lbl">
                        <Target size={13} />
                        <span>Nook 复盘 · 本周主线</span>
                        <span className="r">
                          <ArrowUpRight size={13} />
                        </span>
                      </div>
                      <div className="isl-review-goal">{nookReview?.mainGoal || '点击在 Nook 中制定本周主线'}</div>
                      {nookReview &&
                        nookReview.items.slice(0, 3).map((item, idx) => (
                          <div key={idx} className="isl-focus-row">
                            <span className="n mono">{idx + 1}</span>
                            <span className="trunc">{item}</span>
                          </div>
                        ))}
                    </button>

                    {/* 4. Google Tasks Block */}
                    <div className="isl-blk isl-tasks-blk">
                      <div className="isl-blk-lbl">
                        <ListChecks size={13} />
                        <span>Google Tasks · 今日</span>
                        <span className="r mono">
                          {nookCompletedCount} / {nookTotalCount}
                        </span>
                      </div>
                      {nookTasks.length === 0 ? (
                        <div className="isl-task-empty">今日待办已全部清空</div>
                      ) : (
                        <div className="isl-task-list">
                          {nookTasks.slice(0, 5).map(task => (
                            <div key={task.id} className={'isl-task' + (task.completed ? ' done' : '')}>
                              <button
                                type="button"
                                className={'isl-chk' + (task.completed ? ' on' : '')}
                                aria-label={`完成 ${task.title}`}
                                disabled={Boolean(task.completed)}
                                onClick={() => void window.island.completeTask(task.id)}
                              >
                                {task.completed && <Check size={11} />}
                              </button>
                              <span className="t trunc">{task.title}</span>
                              {!task.completed && (
                                <button
                                  type="button"
                                  className="isl-task-focus"
                                  onClick={() => startFocus({ id: task.id, title: task.title })}
                                >
                                  <Timer size={12} />
                                  <span>专注</span>
                                </button>
                              )}
                              {task.dueLabel && !task.completed && (
                                <span className={'due mono' + (task.overdue ? ' late' : '')}>{task.dueLabel}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* 5. 6 Quick Tools */}
                    <div className="isl-tools6">
                      <button type="button" className="isl-tool6" onClick={() => void window.island.quickAction('screenshot-area')}>
                        <Scan size={17} />
                        <span>区域截图</span>
                      </button>
                      <button type="button" className="isl-tool6" onClick={() => void window.island.quickAction('open-translator')}>
                        <Languages size={17} />
                        <span>输入翻译</span>
                      </button>
                      <button type="button" className="isl-tool6" onClick={() => void window.island.quickAction('open-clipboard')}>
                        <ClipboardList size={17} />
                        <span>剪贴板</span>
                      </button>
                      <button type="button" className="isl-tool6" onClick={() => void window.island.quickAction('toggle-notes')}>
                        <NotebookPen size={17} />
                        <span>便签</span>
                      </button>
                      <button type="button" className="isl-tool6" onClick={() => void window.island.quickAction('open-finder-panel')}>
                        <FolderOpen size={17} />
                        <span>访达动作</span>
                      </button>
                      <button type="button" className="isl-tool6" onClick={() => void window.island.quickAction('open-settings')}>
                        <Settings size={17} />
                        <span>设置</span>
                      </button>
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
