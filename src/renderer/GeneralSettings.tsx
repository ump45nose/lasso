import { useState } from 'react';
import { X } from 'lucide-react';
import type { ShellState } from '../shared/contracts';
import { shortcutLabel } from './targets';

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
    if (!modifiers.length) { setError('需要加上 ⌘、⌥、⌃ 或 ⇧。'); return; }
    void commit([...modifiers, event.code === 'Space' ? 'Space' : event.code.replace(/^(Key|Digit)/, '')].join('+'));
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
  const resident = state.tasks.filter(task => task.residency === 'resident').length, released = state.tasks.length - resident;
  const captureDot = capture.status === 'active' ? 'complete' : capture.status === 'error' ? 'error' : capture.status === 'permission' ? 'waiting' : 'released';
  return <div className="l-set-body l-surface-enter">
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
    {error && <p className="l-field-help error" role="alert">{error}</p>}
    <div className="l-set-row-head l-gap"><h3>快捷键</h3><span>默认不绑定</span></div>
    <ul className="l-group">
      <ShortcutField id="shortcut-open" label="唤起小窗" help="有选区时同时打开指令面板；不绑定也可从菜单栏打开" value={settings.shortcut} save={window.desktop.saveShortcut} error={state.shortcutError} />
      <ShortcutField id="shortcut-shot" label="截图" help="选择窗口、消息或任意区域" value={settings.screenshotShortcut} save={window.desktop.saveScreenshotShortcut} />
    </ul>
    <div className="l-set-row-head l-gap"><h3>窗口与任务</h3></div>
    <ul className="l-group">
      <li><div className="l-row-label"><span>始终置顶</span><span>未置顶时，点击窗外会隐藏小窗；任务继续在后台运行。</span></div>
        <button className="l-switch" role="switch" aria-checked={state.pinned} aria-label="始终置顶" onClick={() => void window.desktop.act('pin')}><span /></button></li>
      <li><div className="l-row-label"><span>{resident} 个驻留 · {released} 个已释放</span><span>后台闲置 10 分钟，只释放已完成、无草稿且能按原链接或原会话恢复的任务。</span></div></li>
      <li><div className="l-row-label"><span>网页与账户</span><span>在小窗内登录 ChatGPT、Gemini 一次，以后保持登录。网页仍使用自己的模型、工具和会话。</span></div></li>
    </ul>
    <button className="l-btn danger l-quit" onClick={() => void window.desktop.act('quit')}>退出 Lasso</button>
  </div>;
}
