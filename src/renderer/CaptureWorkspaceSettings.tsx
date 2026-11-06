import { useEffect, useRef, useState } from 'react';
import { Copy, Eye, EyeOff, Image, Lock, Pencil, Pin, RefreshCw, Search, Trash2, Unlock, X } from 'lucide-react';
import type { CaptureHistoryPolicy, CaptureHistoryState, PinArrangeMode, PinGroup, PinWorkspaceSettings, PinWorkspaceState } from '../shared/history-sync';
import { validatePinWorkspaceSettings } from '../shared/history-sync';
import { Segmented } from './motion';
import { Switch } from './Switch';

const date = (value: number) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`;

export function CaptureHistory({ policy, change, pinned }: { policy: CaptureHistoryPolicy; change: (value: CaptureHistoryPolicy) => void; pinned: () => void }) {
  const [query, setQuery] = useState(''), [history, setHistory] = useState<CaptureHistoryState | null>(null);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState(''), [confirm, setConfirm] = useState('');
  const request = useRef(0);
  async function refresh() {
    const id = ++request.current; setLoading(true); setError('');
    try { const next = await window.desktop.captureHistory(query.trim()); if (id === request.current) setHistory(next); }
    catch (error) { if (id === request.current) setError(String(error)); }
    finally { if (id === request.current) setLoading(false); }
  }
  useEffect(() => { const timer = setTimeout(() => void refresh(), 180); return () => { clearTimeout(timer); request.current++; }; }, [query, policy]);
  async function act(id: string, action: 'edit' | 'pin' | 'copy' | 'delete') {
    if (action === 'delete' && confirm !== id) { setConfirm(id); return; }
    setBusy(true); setError(''); setNotice(''); setConfirm('');
    try { const result = await window.desktop.actCaptureHistory(id, action); if (result.error) throw Error(result.error); setNotice(({ edit: '已打开编辑器', pin: '已转为贴图', copy: '已复制图片', delete: '已删除记录' })[action]); await refresh(); if (action === 'pin') pinned(); }
    catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  async function clear() {
    if (confirm !== 'all') { setConfirm('all'); return; }
    setBusy(true); setError(''); setNotice(''); setConfirm('');
    try { const result = await window.desktop.clearCaptureHistory(); if (result.error) throw Error(result.error); await refresh(); setNotice('已清空截图历史'); }
    catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  return <section id="capture-history" className="l-set-section">
    <div className="l-set-row-head"><h3>截图历史与资源库</h3><button className="l-text-btn" disabled={busy || loading} onClick={() => void refresh()}><RefreshCw size={13} />刷新历史</button></div>
    <ul className="l-group">
      <li><div className="l-row-label"><span>保存截图历史</span><span>保留原图、编辑结果与标注，可随时继续编辑。</span></div><Switch label="保存截图历史" value={policy.enabled} change={() => change({ ...policy, enabled: !policy.enabled })} /></li>
      <li className="col"><div className="l-workspace-limits">{([['maxItems', '保留条数', '条'], ['maxDays', '保留天数', '天'], ['maxBytesMB', '容量上限', 'MB']] as const).map(([key, label, unit]) => <div className="l-field" key={key}><label htmlFor={'history-' + key}>{label} · {unit}</label><input id={'history-' + key} aria-label={label} className="l-input mono" type="number" min="1" step="1" value={policy[key] || ''} onChange={e => change({ ...policy, [key]: Number(e.target.value) })} /></div>)}</div><p className="l-field-help">三项上限同时生效，超出后先清理最早的记录。随本页截图设置一同保存。</p></li>
    </ul>
    <div className="l-row l-history-search"><Search size={16} /><input className="l-input" aria-label="搜索截图历史" placeholder="搜索截图中的文字" disabled={busy} value={query} onChange={e => { setQuery(e.target.value); setConfirm(''); setNotice(''); }} /></div>
    <div className="l-set-row-head"><span>{loading ? '正在读取历史…' : history ? `${history.items.length} 条${query ? '匹配记录' : '记录'} · 共 ${bytes(history.totalBytes)}` : '历史尚未载入'}</span><button className="l-text-btn l-danger" disabled={busy || !history?.totalBytes} onClick={() => void clear()}>{confirm === 'all' ? '确认清空' : '清空历史'}</button></div>
    {confirm === 'all' && <p className="l-field-help">将永久删除全部截图历史及其原图和标注。<button className="l-text-btn" onClick={() => setConfirm('')}>取消</button></p>}
    <ul className="l-group l-history-list">{history?.items.map(item => <li key={item.id} className="col">
      <div className="l-row"><div className="l-history-preview">{item.thumbnailDataUrl ? <img src={item.thumbnailDataUrl} alt="截图缩略图" /> : <Image size={22} />}</div><div className="l-row-label"><span className="mono">{item.width} × {item.height}{item.hasAnnotations && <span className="l-history-tag">含标注</span>}</span><span>{date(item.createdAt)} · {bytes(item.byteSize)}</span><p className="l-history-snippet">{item.ocrSnippet || '暂无识别文字'}</p></div></div>
      <div className="l-workspace-actions">{([['edit', '再编辑', Pencil], ['pin', '贴图', Pin], ['copy', '复制', Copy], ['delete', confirm === item.id ? '确认删除' : '删除', Trash2]] as const).map(([action, label, Icon]) => <button key={action} className={'l-btn small' + (action === 'delete' ? ' danger' : '')} disabled={busy || loading} onClick={() => void act(item.id, action)}><Icon size={14} />{label}</button>)}{confirm === item.id && <button className="l-btn small" onClick={() => setConfirm('')}>取消</button>}</div>
    </li>)}{!loading && history && !history.items.length && <li><p className="l-field-help">{query ? '没有匹配的截图记录' : '尚无截图历史，完成截图后会显示在这里。'}</p></li>}</ul>
    {busy && <p className="l-field-help" role="status">正在处理历史记录…</p>}{error && <p className="l-field-help error" role="alert">{error}</p>}{notice && <p className="l-field-help" role="status">{notice}</p>}
  </section>;
}

export function PinWorkspace({ settings, revision }: { settings: PinWorkspaceSettings; revision: number }) {
  const [workspace, setWorkspace] = useState<PinWorkspaceState | null>(null), [draft, setDraft] = useState(() => structuredClone(settings));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [removing, setRemoving] = useState(''), [moving, setMoving] = useState('');
  const [writing, setWriting] = useState(false), [text, setText] = useState('');
  const source = JSON.stringify(settings), dirty = JSON.stringify(draft) !== JSON.stringify(workspace?.settings ?? settings);
  useEffect(() => { setDraft(structuredClone(settings)); }, [source]);
  async function refresh() { setWorkspace(await window.desktop.pinWorkspace()); }
  useEffect(() => { void refresh().catch(error => setError(String(error))); }, [revision, source]);
  const patch = (value: Partial<PinWorkspaceSettings>) => { setDraft(current => ({ ...current, ...value })); setNotice(''); setError(''); };
  const group = (id: string, value: Partial<PinGroup>) => patch({ groups: draft.groups.map(item => item.id === id ? { ...item, ...value } : item) });
  async function run(operation: () => Promise<{ error: string | null }>, message: string) {
    setBusy(true); setError(''); setNotice('');
    try { const result = await operation(); if (result.error) throw Error(result.error); await refresh(); setNotice(message); return true; }
    catch (error) { setError(String(error)); return false; } finally { setBusy(false); }
  }
  async function save() {
    try { validatePinWorkspaceSettings(draft); await run(() => window.desktop.savePinWorkspace(draft), '工作空间已保存'); }
    catch (error) { setError(String(error)); }
  }
  function remove(id: string) {
    if (removing !== id) { setRemoving(id); return; }
    const groups = draft.groups.filter(item => item.id !== id); patch({ groups, activeGroupId: draft.activeGroupId === id ? groups[0].id : draft.activeGroupId }); setRemoving('');
  }
  const arranged = (mode: PinArrangeMode) => void run(() => window.desktop.arrangePins(mode, workspace?.settings.activeGroupId), '已排列当前分组中可见且未锁定的贴图');
  const unavailable = busy || !workspace || dirty;
  return <section id="pin-workspace" className="l-set-section">
    <div className="l-set-row-head l-gap"><h3>贴图工作空间</h3><button className="l-text-btn" disabled={busy} onClick={() => void run(async () => ({ error: null }), '已刷新贴图列表')}><RefreshCw size={13} />刷新贴图</button></div>
    <ul className="l-group">
      <li><div className="l-row-label"><span>启动自动恢复贴图</span><span>下次打开 Lasso 时恢复工作空间中的贴图。</span></div><Switch label="启动自动恢复贴图" value={draft.restoreOnLaunch} disabled={busy} change={() => patch({ restoreOnLaunch: !draft.restoreOnLaunch })} /></li>
      <li><div className="l-row-label"><span>桌面悬浮工具栏</span><span>在桌面快速创建贴图、恢复与排列。</span></div><Switch label="桌面悬浮工具栏" value={draft.floatingToolbar} disabled={busy} change={() => patch({ floatingToolbar: !draft.floatingToolbar })} /></li>
      <li className="l-shot-option"><span>滚轮默认动作</span><Segmented label="贴图滚轮默认动作" value={draft.wheelAction} options={ [['zoom', '缩放'], ['opacity', '透明度']] } onChange={wheelAction => patch({ wheelAction })} /></li>
    </ul>
    <p className="l-field-help">按住 Option 滚轮可使用另一种动作。修改后点击「保存工作空间」。</p>
    <div className="l-set-row-head"><h3>贴图分组</h3><button className="l-text-btn" disabled={busy} onClick={() => patch({ groups: [...draft.groups, { id: crypto.randomUUID(), name: '新分组', color: draft.groups[0].color, visible: true }] })}>新建分组</button></div>
    <ul className="l-group">{draft.groups.map(item => <li className="col" key={item.id}>
      <div className="l-row"><input className="l-input" aria-label={`分组名称 ${item.name}`} value={item.name} disabled={busy} onChange={e => group(item.id, { name: e.target.value })} /><Switch label={`显示分组 ${item.name}`} value={item.visible} disabled={busy} change={() => group(item.id, { visible: !item.visible })} /><button className="l-icon" aria-label={`删除分组 ${item.name}`} data-tip={removing === item.id ? '再次点击确认删除' : '删除分组'} disabled={busy || draft.groups.length === 1} onClick={() => remove(item.id)}><Trash2 size={15} /></button></div>
      <div className="l-row l-workspace-group-meta">
        <span className="l-shot-swatch" style={{ backgroundColor: /^#[\da-f]{6}$/i.test(item.color) ? item.color : undefined }} />{/* ui-check-ignore: user-defined group colour is workspace data */}
        <input className="l-input mono l-shot-color" aria-label={`分组颜色 ${item.name}`} maxLength={7} value={item.color} disabled={busy} onChange={e => group(item.id, { color: e.target.value })} />
        <button className="l-btn small" aria-pressed={draft.activeGroupId === item.id} disabled={busy} onClick={() => patch({ activeGroupId: item.id })}>{draft.activeGroupId === item.id ? '当前分组' : '设为当前'}</button>
      </div>
      {removing === item.id && <p className="l-field-help">再次点击删除，保存后组内贴图会移入当前分组。<button className="l-text-btn" onClick={() => setRemoving('')}>取消</button></p>}
    </li>)}</ul>
    {dirty && <div className="l-workspace-actions"><span className="l-field-help">有未保存的工作空间更改</span><button className="l-btn small" disabled={busy} onClick={() => { setDraft(structuredClone(workspace?.settings ?? settings)); setRemoving(''); }}>放弃更改</button><button className="l-btn small primary" disabled={busy} onClick={() => void save()}>保存工作空间</button></div>}
    <div className="l-workspace-actions"><button className="l-btn small" disabled={unavailable} onClick={() => void run(() => window.desktop.pinClipboard(), '已从剪贴板创建贴图')}>剪贴板贴图</button><button className="l-btn small" disabled={unavailable} aria-expanded={writing} onClick={() => setWriting(!writing)}>新建文字贴图</button><button className="l-btn small" disabled={unavailable || !workspace?.closedCount} onClick={() => void run(() => window.desktop.reopenClosedPin(), '已恢复刚关闭的贴图')}>恢复刚关闭贴图{workspace?.closedCount ? ` (${workspace.closedCount})` : ''}</button></div>
    {writing && <div className="l-set-section"><textarea className="l-textarea l-textarea-short" aria-label="文字贴图内容" placeholder="写下要贴在桌面上的文字…" value={text} onChange={e => setText(e.target.value)} /><div className="l-workspace-actions"><button className="l-btn small primary" disabled={unavailable || !text.trim()} onClick={() => void run(() => window.desktop.createPin({ kind: 'text', text, groupId: workspace?.settings.activeGroupId }), '已创建文字贴图').then(ok => { if (ok) { setText(''); setWriting(false); } })}>创建文字贴图</button><button className="l-btn small" onClick={() => setWriting(false)}>取消</button></div></div>}
    <div className="l-workspace-actions">{([['grid', '网格排列'], ['align-left', '左对齐'], ['align-top', '顶对齐']] as const).map(([mode, label]) => <button className="l-btn small" key={mode} disabled={unavailable || !workspace?.pins.length} onClick={() => arranged(mode)}>{label}</button>)}</div>
    <p className="l-field-help">新贴图与排列使用当前分组；排列跳过隐藏或锁定的贴图。{dirty && '请先保存工作空间更改。'}</p>
    <div className="l-set-row-head"><h3>活跃贴图</h3><span>{workspace ? `${workspace.pins.length} 个` : '正在载入…'}</span></div>
    <ul className="l-group">{workspace?.pins.map(pin => <li className="col" key={pin.id}><div className="l-row"><div className="l-row-label"><span>{pin.title || ({ image: '图片贴图', text: '文字贴图', color: '颜色贴图', file: '文件贴图' })[pin.kind]}</span><span>{workspace.settings.groups.find(group => group.id === pin.groupId)?.name} · {Math.round(pin.opacity * 100)}% · {pin.visible ? '显示中' : '已隐藏'}{pin.locked ? ' · 已锁定' : ''}{pin.thumbnail ? ' · 缩略态' : ''}</span></div></div><div className="l-workspace-actions">
      <button className="l-btn small" disabled={unavailable} onClick={() => void run(() => window.desktop.actPin(pin.id, 'focus'), '已定位贴图；隐藏分组需先开启显隐')}>定位</button>
      <button className="l-btn small" disabled={unavailable} onClick={() => void run(() => window.desktop.actPin(pin.id, 'toggle-visible'), '已切换贴图显隐')}>{pin.visible ? <EyeOff size={14} /> : <Eye size={14} />}{pin.visible ? '隐藏' : '显示'}</button>
      <button className="l-btn small" disabled={unavailable} onClick={() => void run(() => window.desktop.actPin(pin.id, 'toggle-lock'), '已切换贴图锁定')}>{pin.locked ? <Unlock size={14} /> : <Lock size={14} />}{pin.locked ? '解锁' : '锁定'}</button>
      <button className="l-btn small" disabled={unavailable} aria-expanded={moving === pin.id} onClick={() => setMoving(moving === pin.id ? '' : pin.id)}>分组</button><button className="l-btn small" disabled={unavailable} onClick={() => void run(() => window.desktop.actPin(pin.id, 'close'), '已关闭贴图，可恢复刚关闭的贴图')}><X size={14} />关闭</button>
    </div>{moving === pin.id && <div className="l-workspace-actions">{workspace.settings.groups.map(group => <button key={group.id} className="l-btn small" aria-pressed={pin.groupId === group.id} disabled={unavailable} onClick={() => void run(() => window.desktop.actPin(pin.id, 'focus', group.id), '已移动贴图分组').then(ok => { if (ok) setMoving(''); })}>{group.name}</button>)}</div>}</li>)}{workspace && !workspace.pins.length && <li><p className="l-field-help">暂无活跃贴图，可从剪贴板或文字创建。</p></li>}</ul>
    {busy && <p className="l-field-help" role="status">正在更新工作空间…</p>}{error && <p className="l-field-help error" role="alert">{error}</p>}{notice && <p className="l-field-help" role="status">{notice}</p>}
  </section>;
}
