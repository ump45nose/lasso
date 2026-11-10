import { useEffect, useState } from 'react';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { imagePixels, mediaAspects, type ApiConnection, type ImageOptions, type MediaAspect, type MediaResolution } from '../shared/media';
import { Segmented } from './motion';

const connectionListeners = new Set<(connections: ApiConnection[]) => void>();
const broadcastConnections = (connections: ApiConnection[]) => { for (const fn of connectionListeners) fn(connections); };

function useApiConnections() {
  const [connections, setConnections] = useState<ApiConnection[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    const sync = (next: ApiConnection[]) => { if (active) { setConnections(next); setLoaded(true); } };
    connectionListeners.add(sync);
    void window.desktop.apiConnections().then(sync).catch(() => { if (active) setLoaded(true); });
    return () => { active = false; connectionListeners.delete(sync); };
  }, []);
  const update = (next: ApiConnection[]) => { setConnections(next); setLoaded(true); broadcastConnections(next); };
  return { connections, loaded, update };
}

export function ApiConnectionPoolManager({ idPrefix = 'image-', onSelect, onChange }: { idPrefix?: string; onSelect?(connectionId: string): void; onChange?(connections: ApiConnection[]): void } = {}) {
  const { connections, loaded, update } = useApiConnections();
  const [selectedId, setSelectedId] = useState(''), [creating, setCreating] = useState(false);
  const [name, setName] = useState(''), [baseURL, setBaseURL] = useState(''), [credential, setCredential] = useState('');
  const [clear, setClear] = useState(false), [confirmDelete, setConfirmDelete] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const current = !creating ? connections.find(item => item.id === selectedId) || connections[0] || null : null;

  useEffect(() => {
    if (!loaded || creating) return;
    const target = connections.find(item => item.id === selectedId) || connections[0];
    if (target && target.id !== selectedId) { setSelectedId(target.id); setName(target.name); setBaseURL(target.baseURL); setCredential(''); setClear(false); }
    else if (!target) { setCreating(true); setName('默认 API 服务'); setBaseURL(''); }
  }, [loaded, connections, selectedId, creating]);

  function selectConnection(conn: ApiConnection) {
    setCreating(false); setSelectedId(conn.id); setName(conn.name); setBaseURL(conn.baseURL);
    setCredential(''); setClear(false); setConfirmDelete(false); setError(''); setMessage(''); onSelect?.(conn.id);
  }
  function startNew() {
    setCreating(true); setSelectedId(''); setName(''); setBaseURL(''); setCredential(''); setClear(false); setConfirmDelete(false); setError(''); setMessage('');
  }
  async function save() {
    if (!name.trim()) { setError('请填写 API 连接名称'); return; }
    setBusy(true); setError(''); setMessage(''); setConfirmDelete(false);
    try {
      const result = await window.desktop.saveApiConnection({ ...(current && !creating ? { id: current.id } : {}), name: name.trim(), baseURL: baseURL.trim(), ...(clear ? { credential: '' } : credential ? { credential } : {}) });
      if (result.error) { setError(result.error); return; }
      update(result.connections); onChange?.(result.connections);
      if (result.connection) selectConnection(result.connection);
      setMessage('API 连接已保存');
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  }
  async function fetchModels(id: string) {
    setBusy(true); setError(''); setMessage(''); setConfirmDelete(false);
    try {
      const result = await window.desktop.fetchApiConnectionModels(id);
      if (result.error) { setError(result.error); return; }
      const next = await window.desktop.apiConnections();
      update(next); onChange?.(next); setMessage(`已读取并缓存 ${result.models.length} 个模型`);
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  }
  async function remove() {
    if (!current) return;
    if (!confirmDelete) { setConfirmDelete(true); setError(''); setMessage(''); return; }
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await window.desktop.deleteApiConnection(current.id);
      if (result.error) { setError(result.error); setConfirmDelete(false); return; }
      update(result.connections); onChange?.(result.connections); setConfirmDelete(false);
      if (result.connections[0]) selectConnection(result.connections[0]); else startNew();
      setMessage('API 连接已删除');
    } catch (reason) { setError(String(reason)); setConfirmDelete(false); } finally { setBusy(false); }
  }

  return <section className="l-set-section">
    <div className="l-set-row-head"><h3>API 连接池（{connections.length} 组）</h3><button type="button" className="l-text-btn" disabled={busy} onClick={startNew}><Plus size={14} />新建连接</button></div>
    {connections.length > 0 && <ul className="l-group">{connections.map(conn => <li key={conn.id}>
      <button type="button" className="l-preset" aria-pressed={!creating && current?.id === conn.id} onClick={() => selectConnection(conn)}>
        <strong>{conn.name}<span className="tag">{conn.hasCredential ? '已存密钥' : '未存密钥'}</span>{conn.models.length > 0 && <span className="tag mono">{conn.models.length} 个模型</span>}</strong>
        <span className="mono">{conn.baseURL || '未填写 API 地址'}</span>
      </button>
      <button type="button" className="l-btn small" disabled={busy || !conn.baseURL} onClick={() => void fetchModels(conn.id)}><RefreshCw size={13} />读取模型</button>
    </li>)}</ul>}
    <div className="l-image-options">
      <div className="l-field-row"><span className="l-field-label">{creating || !current ? '新建 API 连接' : `编辑连接 · ${current.name}`}</span>{creating && connections.length > 0 && <button type="button" className="l-text-btn" disabled={busy} onClick={() => selectConnection(connections[0])}>取消新建</button>}</div>
      <div className="l-field"><label htmlFor={idPrefix + 'api-name'}>连接名称</label><input id={idPrefix + 'api-name'} className="l-input" value={name} onChange={e => { setName(e.target.value); setConfirmDelete(false); }} placeholder="如：New API 主力网关 / DeepSeek 极速翻译" /></div>
      <div className="l-field"><label htmlFor={idPrefix + 'api-base'}>API 地址</label><input id={idPrefix + 'api-base'} className="l-input mono" value={baseURL} onChange={e => { setBaseURL(e.target.value); setConfirmDelete(false); }} placeholder="https://api.example.com/v1" /></div>
      <div className="l-field"><label htmlFor={idPrefix + 'api-key'}>API 密钥</label><input id={idPrefix + 'api-key'} type="password" autoComplete="off" className="l-input mono" value={credential} placeholder={!creating && current?.hasCredential ? '已安全保存，留空保留' : '输入 API 密钥'} onChange={e => { setCredential(e.target.value); setClear(false); setConfirmDelete(false); }} />
        {!creating && current?.hasCredential && <button type="button" className="l-text-btn" aria-pressed={clear} onClick={() => setClear(!clear)}>{clear ? '保存时清除密钥 · 撤销' : '清除已存密钥'}</button>}
      </div>
      <div className="l-workspace-actions">
        <button type="button" className="l-btn small primary" disabled={busy || !name.trim()} onClick={() => void save()}>{creating || !current ? '创建并保存连接' : '保存连接'}</button>
        {!creating && current && <>
          <button type="button" className="l-btn small" disabled={busy || !current.baseURL || baseURL.trim() !== current.baseURL || !!credential || clear} onClick={() => void fetchModels(current.id)}><RefreshCw size={13} />读取模型{current.models.length ? ` (${current.models.length})` : ''}</button>
          <button type="button" className="l-btn small danger" disabled={busy} onClick={() => void remove()}><Trash2 size={13} />{confirmDelete ? `确认删除「${current.name}」` : '删除连接'}</button>
          {confirmDelete && <button type="button" className="l-text-btn" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button>}
        </>}
      </div>
      {error && <p className="l-field-help error" role="alert">{error}</p>}{message && <p className="l-field-help" role="status">{message}</p>}
    </div>
  </section>;
}

export function ApiConnectionBindingFields({ connectionId, model, onChange, label = '选用模型', help, modelId = 'api-binding-model', modelPlaceholder = 'gpt-4.1-mini', onChooseEditModel }: {
  connectionId: string; model: string; onChange(next: { connectionId: string; model: string }): void; label?: string; help?: string; modelId?: string; modelPlaceholder?: string; onChooseEditModel?(model: string): void;
}) {
  const { connections, update } = useApiConnections();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const activeConnection = connections.find(item => item.id === connectionId) || null, models = activeConnection?.models || [];

  async function fetchModels() {
    if (!activeConnection) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await window.desktop.fetchApiConnectionModels(activeConnection.id);
      if (result.error) { setError(result.error); return; }
      update(await window.desktop.apiConnections()); setOpen(true); setMessage(`已读取 ${result.models.length} 个模型；支持的功能以实际请求为准。`);
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  }

  return <>
    <div className="l-field">
      <div className="l-field-row">
        <label htmlFor={modelId + '-connection'} className="l-field-label">绑定 API 连接（必选）</label>
        <button type="button" className="l-btn small" disabled={!activeConnection?.baseURL || busy} onClick={() => void fetchModels()}><RefreshCw size={13} />{busy ? '读取中…' : `读取模型${models.length ? ` (${models.length})` : ''}`}</button>
      </div>
      <select id={modelId + '-connection'} aria-label="绑定 API 连接" className="l-select" value={connectionId} onChange={e => { setError(''); setMessage(''); onChange({ connectionId: e.target.value, model }); }}>
        <option value="">请选择 API 连接…</option>
        {connections.map(conn => <option key={conn.id} value={conn.id}>{conn.name}{conn.baseURL ? ` · ${conn.baseURL}` : ' · 未填地址'}</option>)}
        {connectionId && !activeConnection && <option value={connectionId}>未找到连接 ({connectionId})</option>}
      </select>
      {activeConnection && <p className="l-field-help mono">{activeConnection.baseURL || '当前连接尚未填写 API 地址'} · {activeConnection.hasCredential ? '已存密钥' : '未存密钥'}</p>}
    </div>
    <div className="l-field">
      <label htmlFor={modelId}>{label}</label>
      <input id={modelId} className="l-input mono" value={model} placeholder={modelPlaceholder} onChange={e => onChange({ connectionId, model: e.target.value })} />
      {help && <p className="l-field-help">{help}</p>}
    </div>
    {models.length > 0 && <div className="l-field">
      <button type="button" className="l-text-btn" aria-expanded={open} onClick={() => setOpen(!open)}>从服务模型列表选择（{models.length}）</button>
      {open && <div className="l-image-model-list">{models.map(item => <div className="l-field-row" key={item}>
        <span className="mono">{item}</span>
        {onChooseEditModel ? <>
          <button type="button" className="l-btn small" onClick={() => { onChange({ connectionId, model: item }); setOpen(false); }}>用于生成</button>
          <button type="button" className="l-btn small" onClick={() => { onChooseEditModel(item); setOpen(false); }}>用于改图</button>
        </> : <button type="button" className="l-btn small" onClick={() => { onChange({ connectionId, model: item }); setOpen(false); }}>选用此模型</button>}
      </div>)}</div>}
    </div>}
    {error && <p className="l-field-help error" role="alert">{error}</p>}{message && <p className="l-field-help" role="status">{message}</p>}
  </>;
}

export function ImageOptionsFields({ value, update, api, connectionId = '', onConnectionChange }: { value: ImageOptions; update(value: ImageOptions): void; api: boolean; connectionId?: string; onConnectionChange?(connectionId: string): void }) {
  const set = (patch: Partial<ImageOptions>) => update({ ...value, ...patch });
  const [error, setError] = useState(''), [direction, setDirection] = useState('all');
  const custom = !!value.customSize, pixels = imagePixels(value);
  const orientation = (aspect: MediaAspect) => { const [w, h] = aspect.split(':').map(Number); return w === h ? 'square' : w > h ? 'landscape' : 'portrait'; };
  return <>
    <div className="l-image-options">
      <div className="l-field"><span className="l-field-label">尺寸模式</span><Segmented label="尺寸模式" value={custom ? 'custom' : 'preset'} onChange={mode => set({ customSize: mode === 'custom' ? pixels || { width: 1024, height: 1024 } : undefined, aspect: '', resolution: undefined })} options={[['preset', '预设尺寸'], ['custom', '自定义尺寸']]} /></div>
      {custom ? <div className="l-pair">
        {(['width', 'height'] as const).map(key => <div className="l-field" key={key}><label htmlFor={'image-' + key}>{key === 'width' ? '宽度' : '高度'} · px</label><input id={'image-' + key} className="l-input mono" type="number" min={64} max={8192} step={1} value={value.customSize![key] || ''} onChange={event => set({ customSize: { ...value.customSize!, [key]: Number(event.target.value) } })} /></div>)}
      </div> : <>
        <div className="l-pair">
          <div className="l-field"><span className="l-field-label">方向</span><Segmented label="图片方向" value={direction} onChange={next => { setDirection(next); if (value.aspect && next !== 'all' && orientation(value.aspect) !== next) set({ aspect: '' }); }} options={[['all', '全部'], ['square', '方形'], ['portrait', '竖图'], ['landscape', '横图']]} /></div>
          <div className="l-field"><span className="l-field-label">分辨率</span><Segmented label="图片分辨率" value={value.resolution || ''} onChange={resolution => set({ resolution: resolution as MediaResolution || undefined })} options={[['', '不指定'], ['1K', '1K'], ['2K', '2K'], ['4K', '4K']]} /></div>
        </div>
        <div className="l-field"><span className="l-field-label">图片比例</span><div className="l-aspect-grid" role="radiogroup" aria-label="图片比例">
          {(['', ...mediaAspects] as const).filter(aspect => !aspect || direction === 'all' || orientation(aspect) === direction).map(aspect => <button type="button" className="l-btn small mono" role="radio" aria-checked={value.aspect === aspect} key={aspect || 'auto'} onClick={() => set({ aspect })}>{aspect || '不指定'}</button>)}
        </div></div>
      </>}
      <div className="l-field"><span className="l-field-label">数量</span><Segmented label="图片数量" value={value.count ? String(value.count) : ''} onChange={count => set({ count: count ? Number(count) : undefined })} options={[['', '不指定'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']]} /></div>
      <p className="l-field-help mono">{pixels ? `${api ? '请求尺寸' : '参考尺寸'}：${pixels.width} × ${pixels.height} px` : '尺寸跟随模型'}{api && ' · 以模型支持的尺寸为准'}</p>
    </div>
    {api && <>
      <ApiConnectionBindingFields connectionId={connectionId} model={value.generationModel} modelId="image-generation-model" modelPlaceholder="gpt-image-1" label="生成模型（必选）"
        onChange={next => { if (next.connectionId !== connectionId) onConnectionChange?.(next.connectionId); if (next.model !== value.generationModel) set({ generationModel: next.model }); }}
        onChooseEditModel={editModel => set({ editModel })} />
      <div className="l-field"><label htmlFor="image-edit-model">改图模型</label><input id="image-edit-model" className="l-input mono" value={value.editModel} placeholder="gpt-image-1" onChange={event => set({ editModel: event.target.value })} /></div>
      <div className="l-field"><span className="l-field-label">质量</span><Segmented label="图片质量" value={value.quality} onChange={quality => set({ quality })} options={[['auto', '默认'], ['low', '低'], ['medium', '中'], ['high', '高']]} /></div>
      <div className="l-field"><span className="l-field-label">背景</span><Segmented label="图片背景" value={value.background} onChange={background => { setError(''); set({ background, ...(background === 'transparent' && value.outputFormat === 'jpeg' ? { outputFormat: 'png' } : {}) }); }} options={[['auto', '默认'], ['opaque', '不透明'], ['transparent', '透明']]} /></div>
      <div className="l-field"><span className="l-field-label">格式</span><Segmented label="图片格式" value={value.outputFormat} onChange={outputFormat => { if (outputFormat === 'jpeg' && value.background === 'transparent') { setError('透明背景请选择 PNG 或 WebP'); return; } setError(''); set({ outputFormat }); }} options={[['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP']]} /></div>
      {error && <p className="l-field-help error" role="alert">{error}</p>}
      <ApiConnectionPoolManager idPrefix="image-" onSelect={id => { if (!connectionId) onConnectionChange?.(id); }} />
    </>}
  </>;
}

export function ApiTextFields({ connectionId = '', model, onChange, onConnectionChange }: { connectionId?: string; model: string; onChange(model: string): void; onConnectionChange?(connectionId: string): void }) {
  return <>
    <ApiConnectionBindingFields connectionId={connectionId} model={model} modelId="api-chat-model" modelPlaceholder="gpt-4.1-mini" label="快速对话／翻译模型（必选）"
      help="划词动作条触发时将在原位展开流式卡片，支持一键替换选中文本或复制。"
      onChange={next => { if (next.connectionId !== connectionId) onConnectionChange?.(next.connectionId); if (next.model !== model) onChange(next.model); }} />
    <ApiConnectionPoolManager idPrefix="image-" onSelect={id => { if (!connectionId) onConnectionChange?.(id); }} />
  </>;
}
