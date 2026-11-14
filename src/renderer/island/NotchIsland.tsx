import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowUpRight,
  Check,
  ClipboardList,
  Coffee,
  FileText,
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
  Timer,
  X
} from 'lucide-react';
import type { IslandAPI, IslandAlertItem, IslandState, IslandTaskItem } from '../../shared/contracts';
import { useFonts } from '../fonts';
import { collapse, spring } from '../motion';
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

const ALERT_KIND_LABELS: Record<IslandAlertItem['kind'], string> = {
  launchd: '后台服务',
  task: '待办逾期',
  reset: '额度重置',
  custom: 'Nook 提醒'
};

function compactWingAlertTitle(item: IslandAlertItem | undefined): string {
  if (!item) return 'Nook 提醒';
  return item.title.replace(/\s*(未运行|异常退出|服务异常)$/u, '').trim() || item.title;
}

function compactWingAlertMeta(alerts: IslandAlertItem[]): string {
  if (alerts.length > 1) return `${alerts.length} 项`;
  return alerts[0]?.kind === 'launchd' ? '异常' : '提醒';
}

function IslandAlertCard({ item }: { item: IslandAlertItem }) {
  return (
    <div className="isl-blk alert isl-alert-card">
      <div className="isl-alert-head">
        <span className="isl-dot-clay" aria-hidden="true" />
        <span className="isl-alert-title trunc">{item.title}</span>
        <span className="isl-alert-kind mono">{ALERT_KIND_LABELS[item.kind]}</span>
        <button type="button" className="isl-ib sm" aria-label="关闭提醒" onClick={() => void window.island.dismissAlert(item.id)}>
          <X size={13} />
        </button>
      </div>
      {item.subtitle && <div className="isl-alert-sub trunc">{item.subtitle}</div>}
      <div className="isl-alert-acts">
        {item.kind === 'task' && item.target && (
          <button type="button" className="isl-ink-btn line" onClick={() => void window.island.completeTask(item.target!)}>
            <Check size={12} />
            完成
          </button>
        )}
        {item.kind === 'launchd' && item.target && (
          <button type="button" className="isl-ink-btn line" onClick={() => void window.island.restartService(item.target!)}>
            <RotateCcw size={12} />
            重启服务
          </button>
        )}
        <span className="grow" />
        <button type="button" className="isl-ink-btn line mono" onClick={() => void window.island.snoozeAlert(item.id, 10)}>
          10m
        </button>
        <button type="button" className="isl-ink-btn line mono" onClick={() => void window.island.snoozeAlert(item.id, 30)}>
          30m
        </button>
        <button type="button" className="isl-ink-btn line mono" onClick={() => void window.island.snoozeAlert(item.id, 120)}>
          2h
        </button>
      </div>
    </div>
  );
}

function shortTag(listTitle: string): string {
  const t = listTitle.trim();
  if (t === '持续性任务') return '持续';
  if (t === '阻塞任务') return '阻塞';
  if (t === '循环任务') return '循环';
  return t;
}

export function NotchIsland() {
  const [state, setState] = useState<IslandState | null>(null);
  const [activeListTab, setActiveListTab] = useState<string>('focus');
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  useFonts(state?.fonts);

  useEffect(() => {
    document.documentElement.classList.add('isl-html');
    document.body.classList.add('isl-body');
    const stop = window.island.onState(setState);
    void window.island.getState().then(setState);
    return () => stop();
  }, []);

  if (!state) return null;
  const {
    mode,
    pomodoro,
    toast,
    alerts,
    nookReviewBadge,
    nookTaskLists = [],
    nookTasks,
    nookCompletedCount,
    nookTotalCount,
    notch
  } = state;
  const focusOpenTasks = nookTasks.filter(t => !t.completed && t.inFocus);
  const focusDoneTasks = nookTasks.filter(t => t.completed && t.inFocus);
  const effectiveTab = activeListTab === 'focus' || nookTaskLists.some(l => l.id === activeListTab) ? activeListTab : 'focus';
  const visibleTasks: IslandTaskItem[] =
    effectiveTab === 'focus'
      ? [...focusOpenTasks, ...focusDoneTasks.slice(0, 2)]
      : [
          ...nookTasks.filter(t => t.listId === effectiveTab && !t.completed),
          ...nookTasks.filter(t => t.listId === effectiveTab && t.completed).slice(0, 4)
        ];
  const visibleOpenTasks = visibleTasks.filter(t => !t.completed);
  const hasHotReview = Boolean(nookReviewBadge?.hot);
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
          : focusOpenTasks.length > 0 || hasHotReview
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
    if (alerts.length > 0 && (mode === 'idle' || mode === 'focus')) window.island.setMode('nook-alert');
    else if (mode === 'focus' && pomodoro?.active) window.island.setMode('focus-hover');
  }

  function leaveCard() {
    if (mode === 'focus-hover' || mode === 'nook-alert') window.island.setMode(resolveCollapsedMode());
    window.island.hit(false);
  }

  function startFocus(task?: { id: string | null; title: string }) {
    const candidate = visibleOpenTasks[0] ?? focusOpenTasks[0];
    const first = task ?? (candidate ? { id: candidate.id, title: candidate.title } : undefined);
    void window.island.startPomodoro(first, 25, 'focus');
  }

  const urgentTitle = focusOpenTasks[0]?.title || nookReviewBadge?.label || '';
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
        className={`isl-shell mode-${mode}${!hasNotch ? ' no-notch' : ''}`}
        role="region"
        aria-label="Lasso 刘海岛"
      >
        {(wingKind || dropKind) && hasNotch && (
          <button
            type="button"
            className="isl-notch-anchor"
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
            className={`isl-menubar-wings mode-${wingKind}${!hasNotch ? ' no-notch' : ''}`}
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
                  <span className="isl-wing-meta mono">{focusOpenTasks.length > 0 ? `今日剩 ${focusOpenTasks.length} 项` : 'Nook 复盘'}</span>
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
                  <span className="isl-wing-title">{compactWingAlertTitle(alerts[0])}</span>
                </span>
                {hasNotch && <span className="isl-wing-notch-gap" aria-hidden="true" />}
                <span className="isl-wing isl-wing-right">
                  <span className="isl-wing-meta mono">{compactWingAlertMeta(alerts)}</span>
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
                className={`isl-drop-card mode-${dropKind}`}
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
                      <IslandAlertCard key={item.id} item={item} />
                    ))}
                  </div>
                )}

                {dropKind === 'board' && (
                  <div className="isl-board">
                    <header className="isl-board-head">
                      <h3>今日聚焦</h3>
                      <span className="isl-board-date mono">{formatTodayLabel()}</span>
                      <span className="grow" />
                      {nookReviewBadge && (
                        <button
                          type="button"
                          className="isl-review-pill"
                          title="在 Nook 中打开复盘"
                          onClick={() => void window.island.openNook()}
                        >
                          <span className="isl-dot-clay" aria-hidden="true" />
                          <span>{nookReviewBadge.label}</span>
                          <ArrowUpRight size={11} />
                        </button>
                      )}
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
                      <IslandAlertCard key={item.id} item={item} />
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

                    {/* 3. Google Tasks Block with List Tabs */}
                    <div className="isl-blk isl-tasks-blk">
                      <div className="isl-blk-lbl">
                        <ListChecks size={13} />
                        <span>Google Tasks</span>
                        <span className="r mono">
                          {effectiveTab === 'focus' ? `${nookCompletedCount} / ${nookTotalCount}` : `${visibleOpenTasks.length} 待办`}
                        </span>
                        <button
                          type="button"
                          className="isl-ib sm"
                          aria-label="在 Nook 中打开任务"
                          onClick={() => void window.island.openNook()}
                        >
                          <ArrowUpRight size={13} />
                        </button>
                      </div>

                      <div className="isl-task-tabs" role="tablist" aria-label="任务清单">
                        <button
                          type="button"
                          role="tab"
                          aria-selected={effectiveTab === 'focus'}
                          className={'isl-task-tab' + (effectiveTab === 'focus' ? ' on' : '')}
                          onClick={() => setActiveListTab('focus')}
                        >
                          <span>重点</span>
                          {focusOpenTasks.length > 0 && <span className="n mono">{focusOpenTasks.length}</span>}
                        </button>
                        {nookTaskLists.map(list => (
                          <button
                            key={list.id}
                            type="button"
                            role="tab"
                            aria-selected={effectiveTab === list.id}
                            className={'isl-task-tab' + (effectiveTab === list.id ? ' on' : '')}
                            onClick={() => setActiveListTab(list.id)}
                          >
                            <span>{list.shortTitle}</span>
                            {list.openCount > 0 && <span className="n mono">{list.openCount}</span>}
                          </button>
                        ))}
                      </div>

                      {visibleTasks.length === 0 ? (
                        <div className="isl-task-empty">{effectiveTab === 'focus' ? '今日重点已全部清空' : '该清单暂无待办'}</div>
                      ) : (
                        <div className="isl-task-list">
                          {visibleTasks.map(task => {
                            const hasNotes = Boolean(task.notes);
                            const isExpanded = hasNotes && expandedTaskId === task.id;
                            const secondaryTag =
                              effectiveTab === 'focus' && task.listTitle && task.listTitle !== '一般性' && task.listTitle !== 'Google Tasks'
                                ? shortTag(task.listTitle)
                                : '';
                            return (
                              <div key={task.id} className={'isl-task-wrap' + (isExpanded ? ' open' : '')}>
                                <div className={'isl-task' + (task.completed ? ' done' : '') + (hasNotes ? ' has-notes' : '')}>
                                  <button
                                    type="button"
                                    className={'isl-chk' + (task.completed ? ' on' : '')}
                                    aria-label={`完成 ${task.title}`}
                                    disabled={Boolean(task.completed)}
                                    onClick={event => {
                                      event.stopPropagation();
                                      void window.island.completeTask(task.id);
                                    }}
                                  >
                                    {task.completed && <Check size={11} />}
                                  </button>
                                  {hasNotes ? (
                                    <button
                                      type="button"
                                      className="isl-task-main"
                                      aria-expanded={isExpanded}
                                      onClick={() => setExpandedTaskId(prev => (prev === task.id ? null : task.id))}
                                    >
                                      <span className="t trunc">{task.title}</span>
                                      <FileText size={11} className="isl-note-ic" aria-hidden="true" />
                                    </button>
                                  ) : (
                                    <span className="t trunc">{task.title}</span>
                                  )}
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
                                  {!task.completed && task.routineSlot ? (
                                    <span className="isl-task-slot">{task.routineSlot}</span>
                                  ) : !task.completed && task.dueLabel ? (
                                    <span className={'due mono' + (task.overdue ? ' late' : '')}>{task.dueLabel}</span>
                                  ) : !task.completed && secondaryTag ? (
                                    <span className="due">{secondaryTag}</span>
                                  ) : null}
                                </div>
                                <AnimatePresence initial={false}>
                                  {isExpanded && task.notes && (
                                    <motion.div className="isl-task-notes-wrap" {...collapse}>
                                      <div className="isl-task-notes">{task.notes}</div>
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              </div>
                            );
                          })}
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
