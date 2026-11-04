import { useEffect, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { ShellState } from '../shared/contracts';
import { shortcutLabel } from './targets';
import { editorActionIds, editorActionLabels, globalActionIds, globalActionLabels, isValidShortcut, validateEditorShortcuts, type EditorActionId, type GlobalActionId, type IgnoredAppRule, type IgnoredAppScope } from '../shared/shortcuts';
import { Segmented } from './motion';
import './styles/screenshot-settings.css';

const actionHelp: Record<GlobalActionId, string> = {
  rect: '直接拖动框选，不自动吸附窗口或识别区域', area: '悬停识别窗口、消息或任意区域，也可拖动框选', window: '悬停高亮整个窗口，点击截取；被遮挡的部分也完整', screen: '直接截取鼠标所在的屏幕', front: '直接截取最前面的应用窗口',
  'repeat-last': '按上次截图的区域再次截取', 'custom-capture': '打开自定义尺寸与区域预设', 'scroll-capture': '选择窗口中的滚动区域', 'delay-3s': '倒计时 3 秒后框选截图', 'delay-5s': '倒计时 5 秒后框选截图', 'delay-10s': '倒计时 10 秒后框选截图', 'pin-clipboard': '将剪贴板中的图片贴到屏幕上', 'open-launcher': '有选区时同时打开指令面板；不绑定也可从菜单栏打开'
};
const ignoredScopes: readonly (readonly [IgnoredAppScope, string])[] = [['selection', '划词'], ['shortcuts', '快捷键'], ['capture-candidates', '窗口候选']];

/** Records on keydown and saves right away; main validates and rejects reserved combinations such as ⌥ Space. */
function ShortcutField({ id, label, help, value, save, local = false, error: external }: { id: string; label: string; help?: string; value: string; save: (value: string) => Promise<{ error: string | null }>; local?: boolean; error?: string | null }) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState(''), [saving, setSaving] = useState(false);
  async function commit(next: string) {
    setRecording(false); setSaving(true);
    try { setError((await save(next)).error || ''); } catch (error) { setError(String(error)); }
    finally { setSaving(false); }
  }
  function key(event: React.KeyboardEvent) {
    if (!recording) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { setRecording(false); return; }
    if (event.repeat || ['Meta', 'Alt', 'Control', 'Shift'].includes(event.key)) return;
    const modifiers = [event.metaKey && 'Command', event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean);
    const code = event.code.replace(/^(Key|Digit|Arrow)/, '').replace(/^Backquote$/, 'Backtick').replace(/^NumpadEnter$/, 'Enter');
    const shortcut = [...modifiers, code].join('+');
    if (!local && !isValidShortcut(shortcut)) { setError('支持 F1–F24 单键，其他按键请搭配 ⌘、⌥、⌃ 或 ⇧。'); return; }
    void commit(shortcut);
  }
  const message = error || external;
  return <li className="col">
    <div className="l-row">
      <div className="l-row-label"><span>{label}</span>{help && <span>{help}</span>}</div>
      <button id={id} className={'l-btn small' + (recording ? ' primary' : '')} disabled={saving} aria-label={`${label}快捷键：${value ? shortcutLabel(value) : '未绑定'}，点击录制`}
        onClick={() => { setRecording(!recording); setError(''); }} onKeyDown={key} onBlur={() => setRecording(false)}>
        {recording ? '请按快捷键…' : <span className="mono">{value ? shortcutLabel(value) : '未绑定'}</span>}</button>
      {value && !recording && <button className="l-icon" disabled={saving} aria-label={'取消绑定' + label} data-tip="取消绑定" onClick={() => void commit('')}><X size={14} /></button>}
    </div>
    {message && <p className="l-field-help error" role="alert">{message}</p>}
  </li>;
}

export function GeneralSettings({ state }: { state: ShellState }) {
  const { settings, capture } = state;
  const [error, setError] = useState('');
  const [ignoredError, setIgnoredError] = useState(''), [ignoredSaving, setIgnoredSaving] = useState(false);
  async function saveIgnored(rules: IgnoredAppRule[]) {
    setIgnoredSaving(true); setIgnoredError('');
    try { setIgnoredError((await window.desktop.saveIgnoredApps(rules)).error || ''); }
    catch (error) { setIgnoredError(String(error)); } finally { setIgnoredSaving(false); }
  }
  async function addIgnored() {
    try {
      const choice = await window.desktop.choosePath('application');
      if (!choice) return;
      if (!choice.bundleId || !choice.name) { setIgnoredError('所选应用缺少名称或 bundle ID'); return; }
      if (settings.ignoredApps.some(rule => rule.bundleId === choice.bundleId)) { setIgnoredError('这个应用已在忽略列表中'); return; }
      await saveIgnored([...settings.ignoredApps, { bundleId: choice.bundleId, name: choice.name, enabled: true, scopes: ['selection', 'shortcuts', 'capture-candidates'] }]);
    } catch (error) { setIgnoredError(String(error)); }
  }
  function updateIgnored(index: number, patch: Partial<IgnoredAppRule>) {
    if (patch.scopes?.length === 0) { setIgnoredError('至少保留一个忽略范围；无需忽略时可关闭这条规则。'); return; }
    void saveIgnored(settings.ignoredApps.map((rule, i) => i === index ? { ...rule, ...patch } : rule));
  }
  async function saveEditor(action: EditorActionId, shortcut: string) {
    const next = { ...settings.editorShortcuts, [action]: shortcut }, error = validateEditorShortcuts(next);
    return error ? { error } : window.desktop.saveEditorShortcuts(next);
  }
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
    <div id="global-shortcuts" className="l-set-row-head l-gap"><h3>全局动作快捷键</h3><span>F1–F24 或组合键 · 立即保存</span></div>
    <ul className="l-group">
      {globalActionIds.map(action => <ShortcutField key={action} id={'shortcut-' + action} label={globalActionLabels[action]} help={actionHelp[action]} value={settings.actionShortcuts[action] || ''} save={shortcut => window.desktop.saveActionShortcut(action, shortcut)} error={action === 'open-launcher' ? state.shortcutError : null} />)}
    </ul>
    <div id="editor-shortcuts" className="l-set-row-head l-gap"><h3>编辑器局部快捷键</h3><span>支持单键 · 立即保存</span></div>
    <p className="l-field-help">仅在截图编辑器与贴图编辑时生效。点击录制，按 Esc 取消；右侧 × 清空绑定。</p>
    <ul className="l-group">{editorActionIds.map(action => <ShortcutField key={action} id={'editor-shortcut-' + action} label={editorActionLabels[action]} value={settings.editorShortcuts[action]} local save={shortcut => saveEditor(action, shortcut)} />)}</ul>
    <div id="ignored-apps" className="l-set-row-head l-gap"><h3>忽略应用</h3><button className="l-text-btn" disabled={ignoredSaving} onClick={() => void addIgnored()}>选择忽略应用…</button></div>
    <p className="l-field-help">在这些应用中暂停所选功能。窗口候选只过滤截图可选窗口，修改后立即保存。</p>
    <ul className="l-group">{settings.ignoredApps.length ? settings.ignoredApps.map((rule, index) => <li className="col" key={rule.bundleId}>
      <div className="l-row"><div className="l-row-label"><span>{rule.name}</span><span className="mono">{rule.bundleId}</span></div><button className="l-switch" role="switch" aria-label={'启用忽略 ' + rule.name} aria-checked={rule.enabled} disabled={ignoredSaving} onClick={() => updateIgnored(index, { enabled: !rule.enabled })}><span /></button><button className="l-icon" aria-label={'删除忽略应用 ' + rule.name} disabled={ignoredSaving} onClick={() => void saveIgnored(settings.ignoredApps.filter((_, i) => i !== index))}><X size={14} /></button></div>
      <div className="l-ignored-scopes">{ignoredScopes.map(([scope, label]) => <button key={scope} className="l-btn small" role="checkbox" aria-label={`${rule.name}：忽略${label}`} aria-checked={rule.scopes.includes(scope)} disabled={ignoredSaving} onClick={() => updateIgnored(index, { scopes: rule.scopes.includes(scope) ? rule.scopes.filter(value => value !== scope) : [...rule.scopes, scope] })}><Check size={14} aria-hidden="true" />{label}</button>)}</div>
    </li>) : <li><p className="l-field-help">尚未添加忽略应用</p></li>}</ul>
    {ignoredError && <p className="l-field-help error" role="alert">{ignoredError}</p>}
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
