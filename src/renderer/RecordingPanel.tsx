import { useEffect, useRef, useState } from 'react';
import { Camera, Circle, Keyboard, MousePointer2, Pause, Play, Save, Square, Video, X } from 'lucide-react';
import { motion } from 'motion/react';
import type { RecordingAction, RecordingFormat, RecordingMode, RecordingSessionState } from '../shared/recording';
import type { Settings } from '../shared/contracts';
import { useFonts } from './fonts';
import { rise, Segmented } from './motion';
import './styles/screenshot-settings.css';

const modes = [
  ['rect', '区域录制'],
  ['window', '窗口录制'],
  ['screen', '全屏录制']
] as const;

const time = (ms: number) =>
  `${Math.floor(ms / 60000)
    .toString()
    .padStart(2, '0')}:${((Math.max(0, ms) / 1000) % 60).toFixed(1).padStart(4, '0')}`;

const shortTime = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
};

const keyNames: Record<string, string> = { Meta: '⌘', Shift: '⇧', Alt: '⌥', Control: '⌃', ' ': '空格' };

export function RecordingPanel() {
  const [session, setSession] = useState<RecordingSessionState | null>(null);
  const [settings, setSettings] = useState<Settings>();
  const [mode, setMode] = useState<RecordingMode>('rect');
  const [format, setFormat] = useState<RecordingFormat>('gif');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [cameraBusy, setCameraBusy] = useState(false);
  const [trim, setTrim] = useState<[number, number]>([0, 0]);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const previousId = useRef<string | undefined>(undefined);
  const hasSession = useRef(false);
  const formatSelected = useRef(false);
  const [confirmDiscard, setConfirmDiscard] = useState<'close' | 'cancel' | 'recovery' | null>(null);

  useFonts(settings);

  useEffect(() => {
    let active = true;
    let received = false;
    const accept = (state: RecordingSessionState | null) => {
      if (active) {
        hasSession.current = !!state;
        setSession(state);
      }
    };
    const stop = window.desktop.onRecording(state => {
      received = true;
      accept(state);
    });
    void window.desktop
      .recordingState()
      .then(state => {
        if (!received) accept(state);
        if (active) setReady(true);
      })
      .catch(reason => {
        if (active) setError(String(reason));
      });
    void window.desktop
      .getState()
      .then(state => {
        if (active) {
          setSettings(state.settings);
          if (!hasSession.current && !formatSelected.current) setFormat(state.settings.screenshot.recording.format);
        }
      })
      .catch(reason => {
        if (active) setError(String(reason));
      });
    return () => {
      active = false;
      stop();
    };
  }, []);

  useEffect(() => {
    if (session?.id !== previousId.current) {
      previousId.current = session?.id;
      setFormat(session?.settings.format ?? settings?.screenshot.recording.format ?? 'gif');
      setMessage('');
      setPlaying(false);
      setConfirmDiscard(null);
      formatSelected.current = false;
    }
    setTrim([session?.trimStartMs ?? 0, session?.trimEndMs ?? 0]);
    setPosition(session?.trimStartMs ?? 0);
  }, [session?.id, session?.status, session?.trimStartMs, session?.trimEndMs]);

  useEffect(() => {
    if (!playing) return;
    const from = position >= trim[1] ? trim[0] : Math.max(trim[0], position);
    const started = performance.now();
    const timer = setInterval(() => {
      const next = from + performance.now() - started;
      setPosition(Math.min(trim[1], next));
      if (next >= trim[1]) setPlaying(false);
    }, 50);
    return () => clearInterval(timer);
  }, [playing, trim[0], trim[1]]);

  useEffect(
    () =>
      window.desktop.onRecordingClose(() => {
        if (session?.frameCount) setConfirmDiscard('close');
        else void window.desktop.recordingPanel(false);
      }),
    [session?.frameCount]
  );

  function discard(kind: 'close' | 'cancel' | 'recovery') {
    if (session?.frameCount && confirmDiscard !== kind) {
      setConfirmDiscard(kind);
      return;
    }
    setConfirmDiscard(null);
    if (kind === 'close') void window.desktop.recordingPanel(false);
    else void act({ type: kind === 'recovery' ? 'discard-recovery' : 'cancel' });
  }

  async function act(action: RecordingAction) {
    setBusy(true);
    setCameraBusy(action.type === 'camera');
    setError('');
    setMessage('');
    try {
      const result = await window.desktop.recordingAction(action);
      hasSession.current = !!result.state;
      setSession(result.state);
      if (result.error) setError(result.error);
      else if (action.type === 'export') {
        setMessage(
          action.action === 'pin'
            ? '已转为动态贴图'
            : action.action === 'save' && !result.path
              ? '已取消保存'
              : action.action === 'copy-file'
                ? '已复制录制文件'
                : '录制已保存'
        );
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
      setCameraBusy(false);
    }
  }

  const status = session?.status ?? 'idle';
  const live = session && ['countdown', 'recording', 'paused'].includes(status);
  const points = session?.previewTimestampsMs ?? [];
  const frames = session?.previewFrames ?? [];
  let frame = 0;
  points.forEach((timestamp, index) => {
    if (timestamp <= position) frame = index;
  });

  function changeTrim(start: number, end: number) {
    setPlaying(false);
    setTrim([start, end]);
    setPosition(start);
  }
  const trimChanged = session && (trim[0] !== session.trimStartMs || trim[1] !== session.trimEndMs);
  async function exportRecording(action: 'save' | 'quick-save' | 'copy-file' | 'pin') {
    setPlaying(false);
    if (trimChanged) {
      setError('请先应用裁剪范围');
      return;
    }
    await act({ type: 'export', format, action });
  }

  return (
    <motion.main className={`l-record-panel${live ? ' live' : ''}`} aria-label="屏幕录制" data-recording-status={status} {...rise}>
      <header className="l-record-head">
        <Video size={16} />
        <h1>{status === 'review' ? '整理这段录制' : '屏幕录制'}</h1>
        <button
          type="button"
          className={confirmDiscard === 'close' ? 'l-btn danger-solid small' : 'l-icon'}
          aria-label={confirmDiscard === 'close' ? '确认关闭并丢弃录制' : '关闭并丢弃录制'}
          onClick={() => discard('close')}
        >
          {confirmDiscard === 'close' ? '再点一次丢弃' : <X size={15} />}
        </button>
      </header>

      {!session && (
        <div className="l-record-start">
          <h2>把操作录下来。</h2>
          <p>选择范围，录制后可裁剪首尾并导出为 GIF / WEBP / MP4。</p>
          <Segmented label="录制模式" value={mode} options={modes} onChange={setMode} />
          <button type="button" className="l-btn primary" disabled={!ready || busy} onClick={() => void act({ type: 'start', mode })}>
            <Circle size={13} />
            {busy ? '准备录制…' : '开始录制'}
          </button>
          <p className="l-field-help">
            {settings?.screenshot.recording.fps ?? 30} FPS ·{' '}
            {settings?.screenshot.recording.countdown ? `${settings.screenshot.recording.countdown} 秒倒计时` : '无倒计时'} · 参数可在设置「截图、贴图与录屏」中调整
          </p>
        </div>
      )}

      {session?.status === 'recoverable' && (
        <div className="l-record-start">
          <h2>还有一段未完成的录制。</h2>
          <p className="mono">
            {time(session.durationMs)} · {session.frameCount} 帧
          </p>
          <div className="l-record-actions">
            <button type="button" className="l-btn primary" disabled={busy} onClick={() => void act({ type: 'recover' })}>
              恢复未完成录制
            </button>
            <button
              type="button"
              className="l-btn"
              disabled={busy}
              aria-label={confirmDiscard === 'recovery' ? '确认丢弃未完成录制' : '丢弃未完成录制'}
              onClick={() => discard('recovery')}
            >
              {confirmDiscard === 'recovery' ? '再点一次丢弃' : '丢弃未完成录制'}
            </button>
          </div>
        </div>
      )}

      {live && (
        <>
          <div className="l-record-control">
            <div className="l-record-readout">
              <span className="l-rec-dot" />
              <strong className="mono">{status === 'countdown' ? `倒计时 ${session.countdownLeft}s` : shortTime(session.durationMs)}</strong>
              <span className="mono faint">{session.frameCount} 帧</span>
            </div>
            <div className="l-record-actions">
              {status !== 'countdown' && (
                <button
                  type="button"
                  className="l-rec-ib"
                  disabled={busy}
                  aria-label={status === 'paused' ? '继续录制' : '暂停录制'}
                  title={status === 'paused' ? '继续录制' : '暂停录制'}
                  onClick={() => void act({ type: status === 'paused' ? 'resume' : 'pause' })}
                >
                  {status === 'paused' ? <Play size={14} /> : <Pause size={14} />}
                </button>
              )}
              <button
                type="button"
                className="l-rec-ib"
                disabled={busy || !session.frameCount}
                aria-label="结束录制"
                title="结束录制"
                onClick={() => void act({ type: 'stop' })}
              >
                <Square size={13} />
              </button>
              <span className="l-rec-sep" />
              <button
                type="button"
                className={'l-rec-ib' + (session.settings.cameraOverlay ? ' act' : '')}
                aria-label="摄像头画中画"
                title="摄像头画中画"
                aria-pressed={session.settings.cameraOverlay}
                aria-busy={cameraBusy}
                disabled={busy}
                onClick={() => void act({ type: 'camera', enabled: !session.settings.cameraOverlay })}
              >
                <Camera size={14} />
              </button>
              <button
                type="button"
                className="l-btn small"
                disabled={busy}
                aria-label={confirmDiscard === 'cancel' ? '确认取消录制' : '取消录制'}
                onClick={() => discard('cancel')}
              >
                {confirmDiscard === 'cancel' ? '再点丢弃' : '取消'}
              </button>
            </div>
          </div>

          <div className="l-record-cues" aria-label="教学演示提示">
            <span>
              <Keyboard size={14} />
              {session.settings.showKeystrokes
                ? session.recentKeys.length
                  ? session.recentKeys.slice(-2).map((cue, index) => (
                      <kbd key={`${cue.timestampMs}-${index}`}>
                        {[...cue.modifiers, cue.key].map(key => keyNames[key] ?? key).join(' + ')}
                      </kbd>
                    ))
                  : '等待按键'
                : '按键提示已关闭'}
            </span>
            <span aria-label="鼠标点击提示" className={session.recentClicks.length && session.settings.showMouseClicks ? 'clicking' : ''}>
              <MousePointer2 size={14} />
              {session.settings.showMouseClicks ? (session.recentClicks.length ? '点击脉冲' : '等待点击') : '点击提示已关闭'}
            </span>
          </div>
        </>
      )}

      {session?.status === 'review' && (
        <div className="l-record-review">
          <div className="l-record-preview" aria-label="关键帧预览">
            {frames[frame] ? <img src={frames[frame]} alt="录制关键帧预览" /> : <span>没有可预览的画面</span>}
            <span className="l-record-preview-caption">关键帧预览 · 不含声音</span>
          </div>
          <div className="l-record-playback">
            <button
              type="button"
              className="l-btn small"
              disabled={!frames.length || busy}
              aria-label={playing ? '暂停关键帧预览' : '播放关键帧预览'}
              onClick={() => setPlaying(!playing)}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
              {playing ? '暂停' : '播放'}
            </button>
            <input
              aria-label="预览位置"
              type="range"
              min={trim[0]}
              max={trim[1]}
              step="1"
              value={position}
              onChange={event => {
                setPlaying(false);
                setPosition(Number(event.target.value));
              }}
            />
            <output className="mono">
              {time(position)} / {time(session.durationMs)}
            </output>
          </div>
          <div className="l-record-timeline" aria-label="关键帧时间轴">
            {frames.map((src, index) => (
              <button
                type="button"
                key={index}
                aria-label={`预览关键帧 ${index + 1}`}
                disabled={points[index] < trim[0] || points[index] > trim[1]}
                aria-pressed={index === frame}
                onClick={() => {
                  setPlaying(false);
                  setPosition(points[index] ?? trim[0]);
                }}
              >
                <img src={src} alt="" />
              </button>
            ))}
          </div>
          <div className="l-record-trim">
            <label>
              起点 <output className="mono">{time(trim[0])}</output>
              <input
                aria-label="裁剪起点"
                type="range"
                min="0"
                max={Math.max(0, session.durationMs - 1)}
                step="1"
                value={trim[0]}
                disabled={busy}
                onChange={event => changeTrim(Math.min(Number(event.target.value), trim[1] - 1), trim[1])}
              />
            </label>
            <label>
              终点 <output className="mono">{time(trim[1])}</output>
              <input
                aria-label="裁剪终点"
                type="range"
                min="1"
                max={session.durationMs}
                step="1"
                value={trim[1]}
                disabled={busy}
                onChange={event => changeTrim(trim[0], Math.max(Number(event.target.value), trim[0] + 1))}
              />
            </label>
            <button
              type="button"
              className="l-btn small"
              disabled={busy || !trimChanged}
              onClick={() => void act({ type: 'trim', startMs: trim[0], endMs: trim[1] })}
            >
              应用裁剪
            </button>
          </div>
          <div className="l-record-output">
            <Segmented
              label="录制导出格式"
              value={format}
              options={[
                ['gif', 'GIF'],
                ['webp', 'WEBP'],
                ['mp4', 'MP4']
              ]}
              onChange={value => {
                formatSelected.current = true;
                setFormat(value);
              }}
            />
            <span className="mono">已选 {time(trim[1] - trim[0])}</span>
          </div>
          <div className="l-record-actions">
            {(
              [
                ['save', '保存录制', '保存'],
                ['quick-save', '快速保存录制', '快速保存'],
                ['copy-file', '复制录制文件', '复制文件'],
                ['pin', '转为动态贴图', '转为动态贴图']
              ] as const
            ).map(([action, label, text]) => (
              <button
                type="button"
                key={action}
                className={`l-btn${action === 'save' ? ' primary' : ''}`}
                aria-label={label}
                disabled={busy || !!trimChanged || !session.frameCount || trim[1] <= trim[0]}
                onClick={() => void exportRecording(action)}
              >
                {action === 'save' && <Save size={14} />}
                {text}
              </button>
            ))}
          </div>
        </div>
      )}

      {(error || session?.message || message) && (
        <p className={`l-record-notice${error ? ' l-danger' : ''}`} role={error ? 'alert' : 'status'}>
          {error || message || session?.message}
        </p>
      )}
    </motion.main>
  );
}
