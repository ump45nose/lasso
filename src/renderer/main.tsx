import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowLeft, ArrowUpRight, Check, Maximize2, Minimize2, Minus, Pin, PinOff, RotateCw, Settings2, X, Asterisk, LoaderCircle, Sparkles, Copy } from 'lucide-react';
import type { DesktopAPI, ShellState, Action } from '../shared/contracts';
import './style.css';
import { ActionBar } from './ActionBar';
import { TaskTabs } from './TaskTabs';
import { PresetSettings } from './PresetSettings';
declare global { interface Window { desktop: DesktopAPI } }
const shortcutLabel = (value: string) => value.replace(/CommandOrControl|Command/gi, '⌘').replace(/Control/gi, '⌃').replace(/Alt|Option/gi, '⌥').replace(/Shift/gi, '⇧').replaceAll('+', ' ').replace('Space', '空格');

function App() {
  const [state, setState] = useState<ShellState | null>(null);
  const [shortcut, setShortcut] = useState('');
  const [recording, setRecording] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [saved, setSaved] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'presets' | 'general'>('presets');
  const [captureError, setCaptureError] = useState('');
  useEffect(() => {
    const unsubscribe = window.desktop.onState(setState);
    void window.desktop.getState().then(setState);
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (state) { setShortcut(state.settings.shortcut); setFeedback(''); setSaved(false); setRecording(false); }
  }, [state?.settingsOpen]);
  const act = (action: Action) => { void window.desktop.act(action); };
  async function saveShortcut(value: string) {
    const { error } = await window.desktop.saveShortcut(value);
    if (!error) setShortcut(value);
    setFeedback(error || '');
    setSaved(!error);
    setRecording(false);
  }
  function record(event: React.KeyboardEvent) {
    if (!recording) return;
    event.preventDefault();
    if (event.key === 'Escape') { setRecording(false); return; }
    if (['Meta', 'Alt', 'Control', 'Shift'].includes(event.key)) return;
    const modifiers = [event.metaKey && 'Command', event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean);
    if (!modifiers.length) { setFeedback('请加上 ⌘、⌥、⌃ 或 ⇧ 修饰键。'); return; }
    const key = event.code === 'Space' ? 'Space' : event.code.replace(/^(Key|Digit)/, '');
    setShortcut([...modifiers, key].join('+')); setRecording(false); setSaved(false); setFeedback('');
  }
  if (!state) return null;
  return <div className={'app' + (state.delivery ? ' has-delivery' : '')}>
    <header className="shell">
      <TaskTabs tasks={state.tasks} activeId={state.activeTaskId} />
      <div className="utility-row">
        <span className="caption"><Asterisk size={19} strokeWidth={1.5} /><span>{state.settingsOpen ? '设置' : '选中即问'}</span></span>
        <div className="controls">
          <IconButton label="运行预设" onClick={() => act('presets')}><Sparkles /></IconButton>
          {state.hasPage && !state.settingsOpen && <IconButton label="重新加载网页" onClick={() => act('reload')}><RotateCw /></IconButton>}
          <IconButton label={state.pinned ? '取消置顶' : '置顶'} pressed={state.pinned} onClick={() => act('pin')}>{state.pinned ? <PinOff /> : <Pin />}</IconButton>
          <IconButton label={state.expanded ? '还原小窗' : '放大到工作区'} pressed={state.expanded} onClick={() => act('expand')}>{state.expanded ? <Minimize2 /> : <Maximize2 />}</IconButton>
          <IconButton label="隐藏小窗" onClick={() => act('hide')}><Minus /></IconButton>
          <IconButton label={state.settingsOpen ? '关闭设置' : '设置'} pressed={state.settingsOpen} onClick={() => act(state.settingsOpen ? 'close-settings' : 'settings')}>{state.settingsOpen ? <X /> : <Settings2 />}</IconButton>
        </div>
      </div>
      {state.loading && !state.settingsOpen && <div className="loading-line" aria-label="网页加载中" />}
      {state.delivery && <div className={'delivery-strip ' + (state.delivery.phase === 'error' ? 'failed' : '')}>
        <span role="status" title={state.delivery.message}>{state.delivery.message}</span>
        {state.delivery.canCopy && <button title="复制完整原文" aria-label="复制完整原文" onClick={() => act('copy-pending')}><Copy size={14} /></button>}
        <button title="关闭提示并取消待发送动作" aria-label="关闭提示并取消待发送动作" onClick={() => act('cancel-delivery')}><X size={14} /></button>
      </div>}
    </header>
    <main>
      {state.settingsOpen ? <section className="settings">
        <button className="text-button back" onClick={() => act('close-settings')}><ArrowLeft size={15} /> 返回{state.hasPage ? '对话' : '小窗'}</button>
        <h1>让小窗顺手一点。</h1>
        <nav className="settings-tabs" aria-label="设置分类"><button className={settingsTab === 'presets' ? 'selected' : ''} onClick={() => setSettingsTab('presets')}>预设</button><button className={settingsTab === 'general' ? 'selected' : ''} onClick={() => setSettingsTab('general')}>通用</button></nav>
        {settingsTab === 'presets' ? <PresetSettings presets={state.presets} /> : <>
        <section className="capture-settings">
          <div className="setting-row"><span>划词动作条</span><button className={'switch ' + (state.settings.selectionEnabled ? 'on' : '')} role="switch" aria-checked={state.settings.selectionEnabled} aria-label="开启划词动作条" onClick={async () => { const r = await window.desktop.saveCapture({ selectionEnabled: !state.settings.selectionEnabled, clipboardFallback: state.settings.clipboardFallback }); setCaptureError(r.error || ''); }}><span /></button></div>
          <p className={'description ' + (state.capture.status === 'error' ? 'error' : '')}>{state.capture.message}</p>
          {state.capture.status === 'permission' && <button className="record" onClick={() => act('selection-permission')}>打开系统设置授权</button>}
          {state.capture.status !== 'active' && state.settings.selectionEnabled && <button className="text-button recheck" onClick={() => act('refresh-capture')}>重新检查</button>}
          <label className="check-label"><input type="checkbox" checked={state.settings.clipboardFallback} onChange={async e => { const r = await window.desktop.saveCapture({ selectionEnabled: state.settings.selectionEnabled, clipboardFallback: e.target.checked }); setCaptureError(r.error || ''); }} /> 允许模拟复制取词</label>
          <p className="hint">仅在辅助功能取不到文字时模拟 ⌘C，可能影响剪贴板。默认关闭。</p>
          {captureError && <p className="error">{captureError}</p>}
        </section>
        <form onSubmit={event => { event.preventDefault(); void saveShortcut(shortcut.trim()); }}>
          <label htmlFor="shortcut">唤起快捷键</label>
          <p className="description">随时回到小窗，不打断当前网页。</p>
          <div className="shortcut-field">
            <input id="shortcut" placeholder="未绑定" value={shortcut} onChange={e => {setShortcut(e.target.value);setSaved(false);setFeedback('');}} aria-describedby="shortcut-help" spellCheck={false} autoComplete="off" />
            <button type="button" className={'record ' + (recording ? 'recording' : '')} onClick={() => {setRecording(!recording);setFeedback('');}} onKeyDown={record}>{recording ? '请按快捷键…' : '录制'}</button>
          </div>
          <p className="hint" id="shortcut-help">留空可取消绑定，仍可从菜单栏打开。录制时按 Esc 取消。</p>
          {(feedback || state.shortcutError) && <p className="error" role="alert">{feedback || state.shortcutError}</p>}
          <div className="save-row"><button className="primary" type="submit">保存快捷键</button><button className="text-button" type="button" disabled={!state.settings.shortcut} onClick={() => void saveShortcut('')}>取消绑定</button>{saved && <span className="saved" role="status"><Check size={15} /> 已保存</span>}</div>
        </form>
        <div className="setting-section"><span className="eyebrow">网页与账户</span><div className="setting-row"><span>目标网站</span><strong>ChatGPT</strong></div><p className="description">在小窗内登录一次，以后保持登录。网页仍使用自己的模型、工具和会话。</p></div>
        <div className="setting-section"><span className="eyebrow">窗口</span><div className="setting-row"><span>始终置顶</span><button className={'switch ' + (state.pinned ? 'on' : '')} role="switch" aria-checked={state.pinned} aria-label="始终置顶" onClick={() => act('pin')}><span /></button></div><p className="description">未置顶时，点击窗外隐藏；网页继续保留。</p></div>
        <div className="setting-section"><span className="eyebrow">后台页面</span><div className="setting-row"><span>{state.tasks.filter(task => task.residency === 'resident').length} 个驻留</span><span>{state.tasks.filter(task => task.residency === 'released').length} 个已释放</span></div><p className="description">后台闲置 10 分钟后，仅释放已完成、无草稿且有恢复链接的页面。点击标签按原链接恢复。</p></div>
        <button className="text-button quit" onClick={() => act('quit')}>退出选中即问</button></>}
      </section> : state.pageError ? <section className="empty error-page"><RotateCw className="hero-symbol" size={40} strokeWidth={1} /><h1>网页还没打开。</h1><p>{state.pageError}</p><button className="primary" onClick={() => act('reload')}>重新加载</button></section> : !state.hasPage ? <section className="empty">
        <Asterisk className="hero-symbol" size={56} strokeWidth={1.2} />
        <span className="eyebrow">一个随手可用的 AI 小窗</span>
        <h1>随时问一句。</h1>
        <p>查询、整理、读懂一段话。<br />在这里聊完，回到手上的事。</p>
        <button className="primary open-chat" onClick={() => act('open-chat')}>打开 ChatGPT <ArrowUpRight size={17} /></button>
        <div className="quick-presets">{state.presets.filter(p => p.enabled && !p.needsSelection).map(p => <button key={p.id} onClick={() => void window.desktop.runPreset(p.id)}>{p.name}</button>)}</div>
        {state.capture.status === 'permission' && <button className="text-button permission-entry" onClick={() => { setSettingsTab('general'); act('settings'); }}>开启划词 · 授予辅助功能权限</button>}
        <span className="shortcut-hint">{state.settings.shortcut ? <>随时按 <kbd>{shortcutLabel(state.settings.shortcut)}</kbd> 唤起</> : <>从菜单栏 <span aria-label="选中即问图标">✳</span> 打开小窗</>}</span>
      </section> : <div className="web-placeholder" aria-label={`${state.hostname} 网页区域`}>{state.loading && <LoaderCircle size={22} className="spinner" />}</div>}
    </main>
  </div>;
}
function IconButton({label, pressed, onClick, children}: {label: string; pressed?: boolean; onClick: () => void; children: React.ReactNode}) {
  return <button className="icon-button" title={label} aria-label={label} aria-pressed={pressed} onClick={onClick}>{children}</button>;
}
createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).get('surface') === 'action-bar' ? <ActionBar /> : <App />);
