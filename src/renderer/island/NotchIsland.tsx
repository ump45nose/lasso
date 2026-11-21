import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import {
  ArrowUpRight,
  Check,
  ClipboardList,
  Coffee,
  FileText,
  FolderOpen,
  Languages,
  ListChecks,
  Minus,
  NotebookPen,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Scan,
  Settings,
  Square,
  Timer,
  Volume2,
  VolumeX,
  X
} from 'lucide-react';
import type { IslandAPI, IslandAlertItem, IslandState, IslandTaskItem } from '../../shared/contracts';
import { useFonts } from '../fonts';
import { collapse, ease, Glide, spring } from '../motion';
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

const FOCUS_PRESETS = [15, 25, 45, 60];
const BREAK_PRESETS = [5, 10, 15];

function PomoSoundToggle({ enabled }: { enabled: boolean }) {
  return (
    <button
      type="button"
      className={'isl-ib sm' + (enabled ? ' act' : '')}
      aria-label={enabled ? '关闭结束提示音' : '开启结束提示音'}
      aria-pressed={enabled}
      title={enabled ? '结束提示音：开' : '结束提示音：关'}
      onClick={() => void window.island.setPomodoroPrefs({ soundEnabled: !enabled })}
    >
      {enabled ? <Volume2 size={13} /> : <VolumeX size={13} />}
    </button>
  );
}

function PomoDurationRow({ label, value, presets, onChange }: { label: string; value: number; presets: number[]; onChange: (minutes: number) => void }) {
  const holdRef = useRef<{ delay: ReturnType<typeof setTimeout> | null; repeat: ReturnType<typeof setInterval> | null }>({ delay: null, repeat: null });
  const valueRef = useRef(value);
  valueRef.current = value;
  const stopHold = () => {
    if (holdRef.current.delay) clearTimeout(holdRef.current.delay);
    if (holdRef.current.repeat) clearInterval(holdRef.current.repeat);
    holdRef.current = { delay: null, repeat: null };
  };
  useEffect(() => stopHold, []);
  const step = (delta: number) => {
    const next = Math.max(1, Math.min(180, valueRef.current + delta));
    valueRef.current = next;
    onChange(next);
  };
  const startHold = (delta: number) => {
    stopHold();
    step(delta);
    holdRef.current.delay = setTimeout(() => {
      holdRef.current.repeat = setInterval(() => step(delta), 80);
    }, 420);
  };
  const holdProps = (delta: number) => ({
    onPointerDown: () => startHold(delta),
    onPointerUp: stopHold,
    onPointerLeave: stopHold,
    onPointerCancel: stopHold
  });
  return (
    <div className="isl-pomo-row">
      <span className="isl-pomo-lbl">{label}</span>
      {presets.map(minutes => (
        <button
          key={minutes}
          type="button"
          className={'isl-pomo-chip mono' + (value === minutes ? ' on' : '')}
          aria-pressed={value === minutes}
          onClick={() => onChange(minutes)}
        >
          {minutes}m
        </button>
      ))}
      <span className="isl-pomo-stepper">
        <button type="button" className="isl-pomo-step" aria-label={`减少${label}分钟`} disabled={value <= 1} {...holdProps(-1)}>
          <Minus size={11} />
        </button>
        <span className="isl-pomo-value mono">{value}</span>
        <button type="button" className="isl-pomo-step" aria-label={`增加${label}分钟`} disabled={value >= 180} {...holdProps(1)}>
          <Plus size={11} />
        </button>
        <span className="isl-pomo-unit">m</span>
      </span>
    </div>
  );
}

function formatNowClock(now: Date): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export function NotchIsland() {
  const [state, setState] = useState<IslandState | null>(null);
  const [activeListTab, setActiveListTab] = useState<string>('focus');
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [clockText, setClockText] = useState<string>(() => formatNowClock(new Date()));
  useFonts(state?.fonts);

  useEffect(() => {
    document.documentElement.classList.add('isl-html');
    document.body.classList.add('isl-body');
    const stop = window.island.onState(setState);
    void window.island.getState().then(setState);
    return () => stop();
  }, []);

  const fullscreenClock = Boolean(state?.fullscreenClock);

  useEffect(() => {
    if (!fullscreenClock) return;
    setClockText(formatNowClock(new Date()));
    const timer = setInterval(() => setClockText(formatNowClock(new Date())), 1000);
    return () => clearInterval(timer);
  }, [fullscreenClock]);

  const mode = state?.mode ?? 'idle';
  const pomodoro = state?.pomodoro ?? null;
  const pomoPrefs = state?.pomodoroPrefs ?? { focusMinutes: 25, breakMinutes: 5, soundEnabled: true };
  const toast = state?.toast ?? null;
  const alerts = state?.alerts ?? [];
  const nookReviewBadge = state?.nookReviewBadge ?? null;
  const nookTaskLists = state?.nookTaskLists ?? [];
  const nookTasks = state?.nookTasks ?? [];
  const nookCompletedCount = state?.nookCompletedCount ?? 0;
  const nookTotalCount = state?.nookTotalCount ?? 0;
  const notch = state?.notch;

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
    : Math.min(160, Math.max(116, notch?.leftSafeWidth ?? 132));
  const rightSafeW = hasNotch ? 0 : Math.min(88, Math.max(48, notch?.rightSafeWidth ?? 56));

  // State 1: All-Clear hidden when nothing pending and not expanded
  const wingKind =
    !state || fullscreenClock
      ? null
      : mode === 'toast' && toast
        ? 'toast'
        : alerts.length > 0
          ? 'nook-alert'
          : pomodoro?.active
            ? 'focus'
            : focusOpenTasks.length > 0 || hasHotReview
              ? 'idle'
              : null;

  const dropKind =
    !state || fullscreenClock
      ? null
      : mode === 'board'
        ? 'board'
        : mode === 'nook-alert' && alerts.length > 0
          ? 'nook-alert'
          : mode === 'slacking'
            ? 'slacking'
            : mode === 'focus-hover' && pomodoro?.active
              ? 'focus-hover'
              : null;

  const wingKindRef = useRef(wingKind);
  const dropKindRef = useRef(dropKind);
  wingKindRef.current = wingKind;
  dropKindRef.current = dropKind;

  useEffect(() => {
    if (state && !dropKind && !wingKind) {
      window.island.hit(false);
    }
  }, [state, dropKind, wingKind]);

  if (!state) return null;

  function resolveCollapsedMode() {
    return pomodoro?.active ? (pomodoro.kind === 'slacking' ? 'slacking' : 'focus') : 'idle';
  }

  function enterWing() {
    if (!wingKindRef.current) {
      window.island.hit(false);
      return;
    }
    window.island.hit(true);
    if (alerts.length > 0 && (mode === 'idle' || mode === 'focus')) window.island.setMode('nook-alert');
    else if (mode === 'focus' && pomodoro?.active) window.island.setMode('focus-hover');
  }

  function enterCard(event?: { metaKey?: boolean }) {
    if (event?.metaKey || !dropKindRef.current) {
      window.island.hit(false);
      return;
    }
    window.island.hit(true);
  }

  function leaveCard() {
    if (mode === 'focus-hover' || mode === 'nook-alert') window.island.setMode(resolveCollapsedMode());
    window.island.hit(false);
  }

  function startFocus(task?: { id: string | null; title: string }) {
    const candidate = visibleOpenTasks[0] ?? focusOpenTasks[0];
    const first = task ?? (candidate ? { id: candidate.id, title: candidate.title } : undefined);
    void window.island.startPomodoro(first, undefined, 'focus');
  }

  const urgentTitle = focusOpenTasks[0]?.title || nookReviewBadge?.label || '';
  const pomoProgress =
    pomodoro && pomodoro.totalSeconds > 0
      ? Math.max(2, Math.min(100, Math.round(((pomodoro.totalSeconds - pomodoro.remainingSeconds) / pomodoro.totalSeconds) * 100)))
      : 0;

  return (
    <div
      className="isl-stage"
      onPointerMove={event => {
        if (event.metaKey || !(event.target as Element | null)?.closest?.('.isl-drop-card, .isl-menubar-wings, .isl-notch-anchor')) {
          window.island.hit(false);
        }
      }}
      onPointerDown={event => {
        if (event.target === event.currentTarget) {
          window.island.hit(false);
          if (mode === 'board' || mode === 'focus-hover' || mode === 'nook-alert') {
            window.island.setMode(resolveCollapsedMode());
          }
        }
      }}
      onPointerLeave={() => window.island.hit(false)}
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
        <AnimatePresence initial={false}>
          {fullscreenClock && (
            <motion.div
              key="fs-clock"
              className="isl-fs-clock"
              role="status"
              aria-label={`当前时间 ${clockText}`}
              initial={{ opacity: 0, y: -6, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: spring }}
              exit={{ opacity: 0, y: -6, scale: 0.9, transition: { duration: 0.14, ease } }}
            >
              <span className="mono">{clockText}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence initial={false}>
          {(wingKind || dropKind) && hasNotch && (
            <motion.button
              key="notch-anchor"
              type="button"
              className="isl-notch-anchor"
              aria-label="展开或收起今日聚焦看板"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.14, ease } }}
              exit={{ opacity: 0, transition: { duration: 0.12, ease: 'easeIn' } }}
              onPointerEnter={event => {
                if (event.metaKey || (!wingKindRef.current && !dropKindRef.current)) {
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
        </AnimatePresence>

        <div className={`isl-menubar-wings-pos${!hasNotch ? ' no-notch' : ''}`}>
          <AnimatePresence initial={false}>
            {wingKind && (
              <motion.div
                key="wings"
                className={`isl-menubar-wings mode-${wingKind}${!hasNotch ? ' no-notch' : ''}`}
                style={{ transformOrigin: hasNotch ? 'right top' : 'center top' }}
                initial={{ opacity: 0, scaleX: 0.72, scaleY: 0.65, y: -6 }}
                animate={{ opacity: 1, scaleX: 1, scaleY: 1, y: 0, transition: spring }}
                exit={{ opacity: 0, scaleX: 0.76, scaleY: 0.65, y: -6, transition: { duration: 0.16, ease } }}
                onPointerEnter={event => {
                  if (event.metaKey) {
                    window.island.hit(false);
                    return;
                  }
                  enterWing();
                }}
                onPointerMove={event => {
                  if (event.metaKey) window.island.hit(false);
                }}
                onPointerDown={event => {
                  if (event.metaKey) window.island.hit(false);
                }}
                onPointerLeave={leaveCard}
              >
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={wingKind}
                    className="isl-wing-inner"
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0, transition: { duration: 0.16, ease } }}
                    exit={{ opacity: 0, y: 4, transition: { duration: 0.1, ease: 'easeIn' } }}
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
                          <span className="isl-wing-meta mono">
                            {focusOpenTasks.length > 0 ? (
                              <>
                                <ListChecks size={11} className="isl-wing-meta-ic" aria-hidden="true" />
                                <span>{focusOpenTasks.length}</span>
                              </>
                            ) : (
                              '复盘'
                            )}
                          </span>
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
                  </motion.div>
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="isl-drop-wrap">
          <AnimatePresence mode="popLayout" initial={false}>
            {dropKind && (
              <motion.div
                key={dropKind}
                layout
                style={{ transformOrigin: 'top center' }}
                initial={{ opacity: 0, y: -14, scale: 0.92 }}
                animate={{ opacity: 1, y: 0, scale: 1, transition: spring }}
                exit={{ opacity: 0, y: -10, scale: 0.94, transition: { duration: 0.16, ease } }}
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
                      <PomoSoundToggle enabled={pomoPrefs.soundEnabled} />
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
                      <span className="grow" />
                      <PomoSoundToggle enabled={pomoPrefs.soundEnabled} />
                    </div>
                    <div className="isl-timer-row">
                      <span className="isl-timer-big">{formatClock(pomodoro?.remainingSeconds ?? 300)}</span>
                      <span className="grow" />
                      <button type="button" className="isl-ink-btn pri" onClick={() => startFocus()}>
                        开始下一轮 {pomoPrefs.focusMinutes}m
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
                    <AnimatePresence initial={false}>
                      {alerts.map(item => (
                        <motion.div key={item.id} className="isl-alert-motion" {...collapse}>
                          <IslandAlertCard item={item} />
                        </motion.div>
                      ))}
                    </AnimatePresence>

                    {/* 2. Focus Timer Block */}
                    <div className="isl-blk isl-pomo-blk">
                      <AnimatePresence mode="wait" initial={false}>
                        {pomodoro?.active ? (
                          <motion.div
                            key="pomo-active"
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0, transition: { duration: 0.16, ease } }}
                            exit={{ opacity: 0, y: -4, transition: { duration: 0.1, ease: 'easeIn' } }}
                          >
                            <div className="isl-blk-lbl">
                              <Timer size={13} />
                              <span>{pomodoro.kind === 'slacking' ? '休息' : '专注'}</span>
                              <span className="r trunc">{pomodoro.taskTitle}</span>
                              <PomoSoundToggle enabled={pomoPrefs.soundEnabled} />
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
                          </motion.div>
                        ) : (
                          <motion.div
                            key="pomo-idle"
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0, transition: { duration: 0.16, ease } }}
                            exit={{ opacity: 0, y: -4, transition: { duration: 0.1, ease: 'easeIn' } }}
                          >
                            <div className="isl-blk-lbl">
                              <Timer size={13} />
                              <span>专注计时</span>
                              <span className="r">番茄钟</span>
                              <PomoSoundToggle enabled={pomoPrefs.soundEnabled} />
                            </div>
                            <div className="isl-pomo-setup">
                              <PomoDurationRow
                                label="专注"
                                value={pomoPrefs.focusMinutes}
                                presets={FOCUS_PRESETS}
                                onChange={focusMinutes => void window.island.setPomodoroPrefs({ focusMinutes })}
                              />
                              <PomoDurationRow
                                label="休息"
                                value={pomoPrefs.breakMinutes}
                                presets={BREAK_PRESETS}
                                onChange={breakMinutes => void window.island.setPomodoroPrefs({ breakMinutes })}
                              />
                            </div>
                            <div className="isl-timer-idle">
                              <span className="isl-timer-hint">选一条事项开始专注，或直接启动</span>
                              <div className="isl-timer-idle-btns">
                                <button type="button" className="isl-ink-btn pri" onClick={() => startFocus()}>
                                  {pomoPrefs.focusMinutes}m 专注
                                </button>
                                <button
                                  type="button"
                                  className="isl-ink-btn line"
                                  onClick={() => void window.island.startPomodoro({ id: null, title: '起身活动喝水' }, pomoPrefs.breakMinutes, 'slacking')}
                                >
                                  {pomoPrefs.breakMinutes}m 休息
                                </button>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
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

                      <LayoutGroup id="isl-task-tabs">
                        <div className="isl-task-tabs" role="tablist" aria-label="任务清单">
                          <button
                            type="button"
                            role="tab"
                            aria-selected={effectiveTab === 'focus'}
                            className={'isl-task-tab' + (effectiveTab === 'focus' ? ' on' : '')}
                            onClick={() => setActiveListTab('focus')}
                          >
                            {effectiveTab === 'focus' && <Glide id="isl-task-tab-bg" className="isl-task-tab-glide" />}
                            <span className="isl-task-tab-lbl">重点</span>
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
                              {effectiveTab === list.id && <Glide id="isl-task-tab-bg" className="isl-task-tab-glide" />}
                              <span className="isl-task-tab-lbl">{list.shortTitle}</span>
                              {list.openCount > 0 && <span className="n mono">{list.openCount}</span>}
                            </button>
                          ))}
                        </div>
                      </LayoutGroup>

                      <AnimatePresence mode="wait" initial={false}>
                        <motion.div
                          key={effectiveTab}
                          className="isl-task-pane"
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0, transition: { duration: 0.16, ease } }}
                          exit={{ opacity: 0, y: -3, transition: { duration: 0.09, ease: 'easeIn' } }}
                        >
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
                        </motion.div>
                      </AnimatePresence>
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
