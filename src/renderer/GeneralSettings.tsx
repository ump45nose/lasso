import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { ShellState } from '../shared/contracts';
import { captureModeLabels, captureModes, type CaptureMode } from '../shared/capture';
import { shortcutLabel } from './targets';
import { isValidShortcut } from '../shared/shortcuts';
import { Segmented } from './motion';

const captureHelp: Record<CaptureMode, string> = { rect: '直接拖动框选，不自动吸附窗口或识别区域', area: '悬停识别窗口、消息或任意区域，也可拖动框选', window: '悬停高亮整个窗口，点击截取；被遮挡的部分也完整', screen: '直接截取鼠标所在的屏幕', front: '直接截取最前面的应用窗口' };

/** Records on keydown and saves right away; main validates and rejects reserved combinations such as ⌥ Space. */
function ShortcutField({ id, label, help, value, save, error: external }: { id: string; label: string; help: string; value: string; save: (value: string) => Promise<{ error: string | null }>; error?: string | null }) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  async function commit(next: string) { setRecording(false); setError((await save(next)).error || ''); }
  function key(event: React.KeyboardEvent) {
    if (!recording) return;
    event.preventDefault();
    if (event.key === 'Escape') { setRecording(false); return; }
    if (['Meta', 'Alt', 'Control', 'Shift'].includes(event.key)) return;
    const modifiers = [event.metaKey && 'Command', event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean);
    const shortcut = [...modifiers, event.code === 'Space' ? 'Space' : event.code.replace(/^(Key|Digit)/, '')].join('+');
    if (!isValidShortcut(shortcut)) { setError('支持 F1–F24 单键，其他按键请搭配 ⌘、⌥、⌃ 或 ⇧。'); return; }
    void commit(shortcut);
  }
  const message = error || external;
  return <li className="col">
    <div className="l-row">
      <div className="l-row-label"><span>{label}</span><span>{help}</span></div>
      <button id={id} className={'l-btn small' + (recording ? ' primary' : '')} aria-label={`${label}快捷键：${value ? shortcutLabel(value) : '未绑定'}，点击录制`}
        onClick={() => { setRecording(!recording); setError(''); }} onKeyDown={key} onBlur={() => setRecording(false)}>
        {recording ? '请按快捷键…' : <span className="mono">{value ? shortcutLabel(value) : '未绑定'}</span>}</button>
      {value && !recording && <button className="l-icon" aria-label={'取消绑定' + label} title="取消绑定" onClick={() => void commit('')}><X size={14} /></button>}
    </div>
    {message && <p className="l-field-help error" role="alert">{message}</p>}
  </li>;
}

export function GeneralSettings({ state }: { state: ShellState }) {
  const { settings, capture } = state;
  const [error, setError] = useState('');
  const saveCapture = async (next: Partial<Pick<typeof settings, 'selectionEnabled' | 'clipboardFallback'>>) => setError((await window.desktop.saveCapture({ selectionEnabled: settings.selectionEnabled, clipboardFallback: settings.clipboardFallback, ...next })).error || '');
  const [minutes, setMinutes] = useState(String(settings.memory.idleMinutes));
  useEffect(()=>setMinutes(String(settings.memory.idleMinutes)),[settings.memory.idleMinutes]);
  const saveMemory = async (idleMinutes = settings.memory.idleMinutes, enabled = settings.memory.enabled) => {
    const result = await window.desktop.saveMemory({ enabled, idleMinutes });
    setError(result.error || '');
    if (!result.error) setMinutes(String(idleMinutes));
  };
  const resident = state.tasks.filter(task => task.residency === 'resident').length, released = state.tasks.length - resident;
  const captureDot = capture.status === 'active' ? 'complete' : capture.status === 'error' ? 'error' : capture.status === 'permission' ? 'waiting' : 'released';
  return <div className="l-set-body">
    <div className="l-set-row-head"><h3>划词</h3></div>
    <ul className="l-group">
      <li className="col">
        <div className="l-row">
          <div className="l-row-label"><span>划词动作条</span><span className={'l-status' + (capture.status === 'error' ? ' error' : '')}><span className={'dot ' + captureDot} />{capture.message}</span></div>
          <button className="l-switch" role="switch" aria-checked={settings.selectionEnabled} aria-label="划词动作条" onClick={() => void saveCapture({ selectionEnabled: !settings.selectionEnabled })}><span /></button>
        </div>
        {(capture.status === 'permission' || (capture.status !== 'active' && settings.selectionEnabled)) && <div className="l-row">
          {capture.status === 'permission' && <button className="l-btn small" onClick={() => void window.desktop.act('selection-permission')}>打开系统设置授权</button>}
          {settings.selectionEnabled && <button className="l-btn small" onClick={() => void window.desktop.act('refresh-capture')}>重新检查</button>}
        </div>}
      </li>
      <li><div className="l-row-label"><span>允许模拟复制取词</span><span>只在辅助功能取不到文字时模拟 ⌘C，可能改动剪贴板。默认关闭。</span></div>
        <button className="l-switch" role="switch" aria-checked={settings.clipboardFallback} aria-label="允许模拟复制取词" onClick={() => void saveCapture({ clipboardFallback: !settings.clipboardFallback })}><span /></button></li>
    </ul>
    <div className="l-set-row-head l-gap"><h3>快捷键</h3><span>支持 F1–F24 单键 · 默认不绑定</span></div>
    <ul className="l-group">
      <ShortcutField id="shortcut-open" label="唤起小窗" help="有选区时同时打开指令面板；不绑定也可从菜单栏打开" value={settings.shortcut} save={window.desktop.saveShortcut} error={state.shortcutError} />
      {captureModes.map(mode => <ShortcutField key={mode} id={'shortcut-' + mode} label={captureModeLabels[mode]} help={captureHelp[mode]} value={settings.captureShortcuts[mode]} save={shortcut => window.desktop.saveCaptureShortcut(mode, shortcut)} />)}
    </ul>
    <div className="l-set-row-head l-gap"><h3>窗口与任务</h3></div>
    <ul className="l-group">
      <li><div className="l-row-label"><span>始终置顶</span><span>未置顶时，点击窗外会隐藏小窗；任务继续在后台运行。</span></div>
        <button className="l-switch" role="switch" aria-checked={state.pinned} aria-label="始终置顶" onClick={() => void window.desktop.act('pin')}><span /></button></li>
      <li><div className="l-row-label"><span>{resident} 个驻留 · {released} 个已休眠</span><span>任务休眠后可按原链接或原会话恢复；生成中的任务和网页草稿保留。</span></div></li>
      <li><div className="l-row-label"><span>网页与账户</span><span>在小窗内登录 ChatGPT、Gemini 一次，以后保持登录。网页仍使用自己的模型、工具和会话。</span></div></li>
    </ul>
    <div id="memory-settings" className="l-set-row-head l-gap"><h3>内存</h3></div>
    <ul className="l-group">
      <li><div className="l-row-label"><span>闲置休眠</span><span>隐藏或最小化后开始计时，返回时恢复；正在处理的操作保持运行。</span></div><button className="l-switch" role="switch" aria-checked={settings.memory.enabled} aria-label="闲置休眠" onClick={() => void saveMemory(undefined, !settings.memory.enabled)}><span /></button></li>
      <li className="col"><div className="l-field"><label htmlFor="memory-minutes">休眠时间（分钟）</label>
        <Segmented label="闲置休眠时间" value={String(settings.memory.idleMinutes)} options={[5,15,30,60].map(value => [String(value), String(value)] as const)} onChange={value => void saveMemory(Number(value))} />
        <div className="l-row"><input id="memory-minutes" className="l-input mono" type="number" min="1" max="1440" value={minutes} onChange={event => setMinutes(event.target.value)} /><button className="l-btn small" onClick={() => void saveMemory(Number(minutes))}>应用</button></div>
        <p className="l-field-help">可自定义 1–1440 分钟，默认 30 分钟。修改后按已有闲置时间重新计算；关闭开关可保持驻留。</p>
      </div></li>
    </ul>
    {error && <p className="l-field-help error" role="alert">{error}</p>}
    <button className="l-btn danger l-quit" onClick={() => void window.desktop.act('quit')}>退出 Lasso</button>
  </div>;
}
