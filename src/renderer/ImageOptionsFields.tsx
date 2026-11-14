import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Lock, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { ShellState } from '../shared/contracts';
import { imagePixels, mediaAspects, type ApiConnection, type ImageOptions, type MediaAspect, type MediaResolution } from '../shared/media';
import { Segmented } from './motion';

const connectionListeners = new Set<(connections: ApiConnection[]) => void>();
export const broadcastConnections = (connections: ApiConnection[]) => {
  for (const fn of connectionListeners) fn(connections);
};

export function useApiConnections(initial?: ApiConnection[]) {
  const [connections, setConnections] = useState<ApiConnection[]>(initial || []);
  const [loaded, setLoaded] = useState(Boolean(initial));
  useEffect(() => {
    if (initial) {
      setConnections(initial);
      setLoaded(true);
    }
  }, [initial]);
  useEffect(() => {
    let active = true;
    const sync = (next: ApiConnection[]) => {
      if (active) {
        setConnections(next);
        setLoaded(true);
      }
    };
    connectionListeners.add(sync);
    void window.desktop
      .apiConnections()
      .then(sync)
      .catch(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
      connectionListeners.delete(sync);
    };
  }, []);
  const update = (next: ApiConnection[]) => {
    setConnections(next);
    setLoaded(true);
    broadcastConnections(next);
  };
  return { connections, loaded, update };
}

function connectionUsages(state: ShellState, id: string): string[] {
  const usages: string[] = [];
  if (state.settings.defaultApiChat.connectionId === id) usages.push('对话');
  if (state.presets.some(p => p.kind !== 'image' && p.target === 'api' && p.connectionId === id)) usages.push('预设');
  if (state.settings.translation.provider === 'llm' && state.settings.translation.connectionId === id) usages.push('翻译');
  if (state.settings.vision.connectionId === id) usages.push('识别');
  if (state.presets.some(p => p.kind === 'image' && p.target === 'api' && p.connectionId === id)) usages.push('生图');
  return usages;
}

export function ConnectionsPane({
  state,
  creatingNew,
  onStartCreate,
  onDoneCreate,
  notify
}: {
  state: ShellState;
  creatingNew: boolean;
  onStartCreate(): void;
  onDoneCreate(): void;
  notify(status: { ok?: boolean; error?: string }): void;
}) {
  const { connections, update } = useApiConnections(state.connections);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [credential, setCredential] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    if (creatingNew) {
      setExpandedId('__new__');
      setName('');
      setBaseURL('');
      setCredential('');
      setClearKey(false);
      setConfirmDelete(false);
      setFormError('');
    }
  }, [creatingNew]);

  function openEdit(conn: ApiConnection) {
    if (expandedId === conn.id) {
      setExpandedId(null);
      setConfirmDelete(false);
      setFormError('');
      return;
    }
    onDoneCreate();
    setExpandedId(conn.id);
    setName(conn.name);
    setBaseURL(conn.baseURL);
    setCredential('');
    setClearKey(false);
    setConfirmDelete(false);
    setFormError('');
  }

  function closeForm() {
    setExpandedId(null);
    setConfirmDelete(false);
    setFormError('');
    onDoneCreate();
  }

  async function saveConnection(editing?: ApiConnection) {
    if (!name.trim()) {
      setFormError('请填写连接名称');
      return;
    }
    setBusy(true);
    setFormError('');
    setConfirmDelete(false);
    try {
      const result = await window.desktop.saveApiConnection({
        ...(editing ? { id: editing.id } : {}),
        name: name.trim(),
        baseURL: baseURL.trim(),
        ...(clearKey ? { credential: '' } : credential ? { credential } : {})
      });
      if (result.error) {
        setFormError(result.error);
        notify({ error: result.error });
        return;
      }
      update(result.connections);
      notify({ ok: true });
      closeForm();
    } catch (reason) {
      const msg = String(reason);
      setFormError(msg);
      notify({ error: msg });
    } finally {
      setBusy(false);
    }
  }

  async function pullModels(id: string) {
    setBusy(true);
    setFormError('');
    try {
      const result = await window.desktop.fetchApiConnectionModels(id);
      if (result.error) {
        setFormError(result.error);
        notify({ error: result.error });
        return;
      }
      update(await window.desktop.apiConnections());
      notify({ ok: true });
    } catch (reason) {
      const msg = String(reason);
      setFormError(msg);
      notify({ error: msg });
    } finally {
      setBusy(false);
    }
  }

  async function removeConnection(conn: ApiConnection) {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setBusy(true);
    setFormError('');
    try {
      const result = await window.desktop.deleteApiConnection(conn.id);
      if (result.error) {
        setFormError(result.error);
        setConfirmDelete(false);
        notify({ error: result.error });
        return;
      }
      update(result.connections);
      notify({ ok: true });
      closeForm();
    } catch (reason) {
      setFormError(String(reason));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  const defaultChat = state.settings.defaultApiChat;
  async function saveDefaultChat(next: { connectionId: string; model: string }) {
    const res = await window.desktop.saveDefaultApiChat(next);
    if (res.error) notify({ error: res.error });
    else notify({ ok: true });
  }

  const renderForm = (editing?: ApiConnection) => {
    const models = editing?.models || [];
    return (
      <div className="l-set-row subform" key={editing ? `${editing.id}-form` : 'new-form'}>
        <div className="l-grid-2">
          <div className="l-field">
            <label htmlFor="conn-name">名称</label>
            <input
              id="conn-name"
              className="l-input"
              value={name}
              placeholder="如：DeepSeek / New API 视觉网关"
              onChange={e => {
                setName(e.target.value);
                setConfirmDelete(false);
              }}
            />
          </div>
          <div className="l-field">
            <label htmlFor="conn-base">Base URL</label>
            <input
              id="conn-base"
              className="l-input mono"
              value={baseURL}
              placeholder="https://api.example.com/v1"
              onChange={e => {
                setBaseURL(e.target.value);
                setConfirmDelete(false);
              }}
            />
          </div>
          <div className="l-field l-span-all">
            <div className="l-field-row">
              <label htmlFor="conn-key">API Key</label>
              {editing?.hasCredential && (
                <button type="button" className="l-text-btn" onClick={() => setClearKey(v => !v)}>
                  {clearKey ? '保留已存密钥' : '清除已存密钥'}
                </button>
              )}
            </div>
            <div className="l-row">
              {editing?.hasCredential && !credential && !clearKey && <Lock size={13} className="faint" />}
              <input
                id="conn-key"
                type="password"
                autoComplete="off"
                className="l-input mono"
                disabled={clearKey}
                value={credential}
                placeholder={
                  clearKey
                    ? '保存连接后将清除本机加密密钥'
                    : editing?.hasCredential
                      ? '已加密保存 · 留空表示不修改'
                      : '输入 OpenAI 兼容 API Key'
                }
                onChange={e => {
                  setCredential(e.target.value);
                  setConfirmDelete(false);
                }}
              />
            </div>
          </div>
          {editing && (
            <div className="l-field l-span-all">
              <div className="l-field-row">
                <span className="l-field-label">
                  可用模型 · <span className="mono">{models.length}</span>
                </span>
                <button
                  type="button"
                  className="l-text-btn"
                  disabled={busy || !editing.baseURL || baseURL.trim() !== editing.baseURL || Boolean(credential) || clearKey}
                  onClick={() => void pullModels(editing.id)}
                >
                  <RefreshCw size={12} />
                  <span>{busy ? '拉取中…' : '重新拉取'}</span>
                </button>
              </div>
              {models.length > 0 ? (
                <div className="l-wrap">
                  {models.slice(0, 8).map(m => (
                    <span key={m} className="l-chip mono">
                      {m}
                    </span>
                  ))}
                  {models.length > 8 && <span className="l-chip mono">+{models.length - 8}</span>}
                </div>
              ) : (
                <p className="l-field-help">保存地址与密钥后，点击「重新拉取」缓存模型列表供各处下拉选择。</p>
              )}
            </div>
          )}
        </div>
        {formError && (
          <p className="l-field-help l-danger" role="alert">
            {formError}
          </p>
        )}
        <div className="l-row">
          {editing && (
            <button type="button" className="l-ghost small danger" disabled={busy} onClick={() => void removeConnection(editing)}>
              <Trash2 size={13} />
              <span>{confirmDelete ? `确认删除「${editing.name}」` : '删除连接'}</span>
            </button>
          )}
          <span className="grow" />
          <button type="button" className="l-ghost small" disabled={busy} onClick={closeForm}>
            取消
          </button>
          <button type="button" className="l-btn small primary" disabled={busy || !name.trim()} onClick={() => void saveConnection(editing)}>
            保存连接
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      <p className="l-field-help">这里是唯一的连接池：API 对话、API 预设、LLM 翻译、截图识别、AI 生图都从这里选。</p>

      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>API 连接池（{connections.length}）</span>
          <span className="r">密钥使用 macOS 安全存储加密保存</span>
        </div>
        <div className="l-set-card">
          {expandedId === '__new__' && renderForm(undefined)}
          {connections.map(conn => {
            const expanded = expandedId === conn.id;
            const usages = connectionUsages(state, conn.id);
            const ready = Boolean(conn.hasCredential && conn.baseURL);
            return (
              <div key={conn.id}>
                <div
                  className="l-set-row clickable"
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={() => openEdit(conn)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openEdit(conn);
                    }
                  }}
                >
                  <span className={'l-dot ' + (ready ? 'olive' : 'faint')} />
                  <div className="l-set-row-main">
                    <div className="l-set-row-name">{conn.name}</div>
                    <div className={'l-set-row-sub' + (expanded ? '' : ' mono')}>
                      {expanded ? '正在编辑' : conn.baseURL || '未填写 Base URL'}
                    </div>
                  </div>
                  {usages.length > 0 ? (
                    usages.map(u => (
                      <span key={u} className="l-chip">
                        {u}
                      </span>
                    ))
                  ) : (
                    <span className="l-chip faint">未使用</span>
                  )}
                  {expanded ? <ChevronDown size={14} className="faint" /> : <ChevronRight size={14} className="faint" />}
                </div>
                {expanded && renderForm(conn)}
              </div>
            );
          })}
          {connections.length === 0 && expandedId !== '__new__' && (
            <div className="l-set-row">
              <div className="l-set-row-main">
                <div className="l-set-row-sub">尚未添加 API 连接。点击右上角「新建连接」接入 OpenAI 兼容服务。</div>
              </div>
              <button type="button" className="l-btn small" onClick={onStartCreate}>
                <Plus size={13} />
                <span>新建连接</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>原生 API 对话默认模型</span>
          <span className="r">新建 API 对话与划词快答默认选用</span>
        </div>
        <div className="l-set-card">
          <div className="l-set-row col">
            <ApiConnectionBindingFields
              connectionId={defaultChat.connectionId}
              model={defaultChat.model}
              modelId="default-api-chat-model"
              modelPlaceholder="gpt-4.1-mini / deepseek-chat"
              label="默认对话模型"
              onChange={next => void saveDefaultChat(next)}
            />
          </div>
        </div>
      </div>
    </>
  );
}

export function ApiConnectionBindingFields({
  connectionId,
  model,
  onChange,
  label = '选用模型',
  help,
  modelId = 'api-binding-model',
  modelPlaceholder = 'gpt-4.1-mini',
  onChooseEditModel,
  onOpenConnections
}: {
  connectionId: string;
  model: string;
  onChange(next: { connectionId: string; model: string }): void;
  label?: string;
  help?: string;
  modelId?: string;
  modelPlaceholder?: string;
  onChooseEditModel?(model: string): void;
  onOpenConnections?: () => void;
}) {
  const { connections, update } = useApiConnections();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const activeConnection = connections.find(item => item.id === connectionId) || null;
  const models = activeConnection?.models || [];

  async function fetchModels() {
    if (!activeConnection) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.desktop.fetchApiConnectionModels(activeConnection.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      update(await window.desktop.apiConnections());
      setOpen(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="l-grid-2">
        <div className="l-field">
          <div className="l-field-row">
            <label htmlFor={modelId + '-connection'}>API 连接</label>
            {onOpenConnections && (
              <button type="button" className="l-text-btn" onClick={onOpenConnections}>
                管理连接 →
              </button>
            )}
          </div>
          <select
            id={modelId + '-connection'}
            aria-label="绑定 API 连接"
            className="l-select"
            value={connectionId}
            onChange={e => {
              setError('');
              onChange({ connectionId: e.target.value, model });
            }}
          >
            <option value="">请选择 API 连接…</option>
            {connections.map(conn => (
              <option key={conn.id} value={conn.id}>
                {conn.name}
                {conn.baseURL ? ` · ${conn.baseURL}` : ''}
              </option>
            ))}
            {connectionId && !activeConnection && <option value={connectionId}>未找到连接 ({connectionId})</option>}
          </select>
        </div>

        <div className="l-field">
          <div className="l-field-row">
            <label htmlFor={modelId}>{label}</label>
            <button type="button" className="l-text-btn" disabled={!activeConnection?.baseURL || busy} onClick={() => void fetchModels()}>
              <RefreshCw size={12} />
              <span>{busy ? '读取中…' : models.length ? `选模型 (${models.length})` : '拉取模型'}</span>
            </button>
          </div>
          <input
            id={modelId}
            className="l-input mono"
            value={model}
            placeholder={modelPlaceholder}
            onChange={e => onChange({ connectionId, model: e.target.value })}
          />
        </div>
      </div>

      {help && <p className="l-field-help">{help}</p>}

      {models.length > 0 && (
        <div className="l-field">
          <button type="button" className="l-text-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? '收起已缓存模型' : `从已缓存模型中选择（${models.length}）`}
          </button>
          {open && (
            <div className="l-wrap">
              {models.map(item =>
                onChooseEditModel ? (
                  <span key={item} className="l-chip mono">
                    {item}{' '}
                    <button
                      type="button"
                      className="l-text-btn"
                      onClick={() => {
                        onChange({ connectionId, model: item });
                        setOpen(false);
                      }}
                    >
                      生成
                    </button>
                    {' / '}
                    <button
                      type="button"
                      className="l-text-btn"
                      onClick={() => {
                        onChooseEditModel(item);
                        setOpen(false);
                      }}
                    >
                      改图
                    </button>
                  </span>
                ) : (
                  <button
                    key={item}
                    type="button"
                    className={'l-btn small mono' + (item === model ? ' ton' : '')}
                    onClick={() => {
                      onChange({ connectionId, model: item });
                      setOpen(false);
                    }}
                  >
                    {item}
                  </button>
                )
              )}
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="l-field-help l-danger" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function ImageOptionsFields({
  value,
  update,
  api,
  connectionId = '',
  onConnectionChange,
  onOpenConnections
}: {
  value: ImageOptions;
  update(value: ImageOptions): void;
  api: boolean;
  connectionId?: string;
  onConnectionChange?(connectionId: string): void;
  onOpenConnections?: () => void;
}) {
  const set = (patch: Partial<ImageOptions>) => update({ ...value, ...patch });
  const [error, setError] = useState('');
  const [direction, setDirection] = useState('all');
  const custom = Boolean(value.customSize);
  const pixels = imagePixels(value);
  const orientation = (aspect: MediaAspect) => {
    const [w, h] = aspect.split(':').map(Number);
    return w === h ? 'square' : w > h ? 'landscape' : 'portrait';
  };
  return (
    <>
      <div className="l-field">
        <span className="l-field-label">尺寸模式</span>
        <Segmented
          label="尺寸模式"
          value={custom ? 'custom' : 'preset'}
          onChange={mode => set({ customSize: mode === 'custom' ? pixels || { width: 1024, height: 1024 } : undefined, aspect: '', resolution: undefined })}
          options={[
            ['preset', '预设比例'],
            ['custom', '自定义像素']
          ]}
        />
      </div>

      {custom ? (
        <div className="l-grid-equal">
          {(['width', 'height'] as const).map(key => (
            <div className="l-field" key={key}>
              <label htmlFor={'image-' + key}>{key === 'width' ? '宽度 · px' : '高度 · px'}</label>
              <input
                id={'image-' + key}
                className="l-input mono"
                type="number"
                min={64}
                max={8192}
                step={1}
                value={value.customSize![key] || ''}
                onChange={event => set({ customSize: { ...value.customSize!, [key]: Number(event.target.value) } })}
              />
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="l-grid-equal">
            <div className="l-field">
              <span className="l-field-label">方向</span>
              <Segmented
                label="图片方向"
                value={direction}
                onChange={next => {
                  setDirection(next);
                  if (value.aspect && next !== 'all' && orientation(value.aspect) !== next) set({ aspect: '' });
                }}
                options={[
                  ['all', '全部'],
                  ['square', '方形'],
                  ['portrait', '竖图'],
                  ['landscape', '横图']
                ]}
              />
            </div>
            <div className="l-field">
              <span className="l-field-label">分辨率</span>
              <Segmented
                label="图片分辨率"
                value={value.resolution || ''}
                onChange={resolution => set({ resolution: (resolution as MediaResolution) || undefined })}
                options={[
                  ['', '默认'],
                  ['1K', '1K'],
                  ['2K', '2K'],
                  ['4K', '4K']
                ]}
              />
            </div>
          </div>
          <div className="l-field">
            <span className="l-field-label">图片比例</span>
            <div className="l-wrap" role="radiogroup" aria-label="图片比例">
              {(['', ...mediaAspects] as const)
                .filter(aspect => !aspect || direction === 'all' || orientation(aspect) === direction)
                .map(aspect => (
                  <button
                    type="button"
                    className={'l-btn small mono' + (value.aspect === aspect ? ' ton' : '')}
                    role="radio"
                    aria-checked={value.aspect === aspect}
                    key={aspect || 'auto'}
                    onClick={() => set({ aspect })}
                  >
                    {aspect || '默认'}
                  </button>
                ))}
            </div>
          </div>
        </>
      )}

      <div className="l-field">
        <span className="l-field-label">张数</span>
        <Segmented
          label="图片数量"
          value={value.count ? String(value.count) : ''}
          onChange={count => set({ count: count ? Number(count) : undefined })}
          options={[
            ['', '默认'],
            ['1', '1'],
            ['2', '2'],
            ['3', '3'],
            ['4', '4']
          ]}
        />
      </div>

      <p className="l-field-help mono">
        {pixels ? `${api ? '请求尺寸' : '参考尺寸'}：${pixels.width} × ${pixels.height} px` : '尺寸跟随模型默认'}
      </p>

      {api && (
        <>
          <ApiConnectionBindingFields
            connectionId={connectionId}
            model={value.generationModel}
            modelId="image-generation-model"
            modelPlaceholder="gpt-image-1"
            label="生图模型（必选）"
            onOpenConnections={onOpenConnections}
            onChange={next => {
              if (next.connectionId !== connectionId) onConnectionChange?.(next.connectionId);
              if (next.model !== value.generationModel) set({ generationModel: next.model });
            }}
            onChooseEditModel={editModel => set({ editModel })}
          />
          <div className="l-field">
            <label htmlFor="image-edit-model">参考图改图模型（留空沿用生图模型）</label>
            <input
              id="image-edit-model"
              className="l-input mono"
              value={value.editModel}
              placeholder="gpt-image-1"
              onChange={event => set({ editModel: event.target.value })}
            />
          </div>
          <div className="l-grid-equal">
            <div className="l-field">
              <span className="l-field-label">清晰度</span>
              <Segmented
                label="图片质量"
                value={value.quality}
                onChange={quality => set({ quality })}
                options={[
                  ['auto', '默认'],
                  ['low', '快速'],
                  ['medium', '标准'],
                  ['high', '高清']
                ]}
              />
            </div>
            <div className="l-field">
              <span className="l-field-label">格式</span>
              <Segmented
                label="图片格式"
                value={value.outputFormat}
                onChange={outputFormat => {
                  if (outputFormat === 'jpeg' && value.background === 'transparent') {
                    setError('透明背景请选择 PNG 或 WebP');
                    return;
                  }
                  setError('');
                  set({ outputFormat });
                }}
                options={[
                  ['png', 'PNG'],
                  ['jpeg', 'JPEG'],
                  ['webp', 'WebP']
                ]}
              />
            </div>
          </div>
          <div className="l-field">
            <span className="l-field-label">背景</span>
            <Segmented
              label="图片背景"
              value={value.background}
              onChange={background => {
                setError('');
                set({ background, ...(background === 'transparent' && value.outputFormat === 'jpeg' ? { outputFormat: 'png' } : {}) });
              }}
              options={[
                ['auto', '默认'],
                ['opaque', '不透明'],
                ['transparent', '透明']
              ]}
            />
          </div>
          {error && (
            <p className="l-field-help l-danger" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </>
  );
}

export function ApiTextFields({
  connectionId = '',
  model,
  onChange,
  onConnectionChange,
  onOpenConnections
}: {
  connectionId?: string;
  model: string;
  onChange(model: string): void;
  onConnectionChange?(connectionId: string): void;
  onOpenConnections?: () => void;
}) {
  return (
    <ApiConnectionBindingFields
      connectionId={connectionId}
      model={model}
      modelId="api-chat-model"
      modelPlaceholder="gpt-4.1-mini"
      label="快速对话模型（必选）"
      help="划词动作条触发时将在选区旁原位展开流式快答卡片，支持一键替换、复制或转入小窗继续追问。"
      onOpenConnections={onOpenConnections}
      onChange={next => {
        if (next.connectionId !== connectionId) onConnectionChange?.(next.connectionId);
        if (next.model !== model) onChange(next.model);
      }}
    />
  );
}
