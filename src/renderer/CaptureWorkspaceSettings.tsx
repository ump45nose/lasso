import { useEffect, useRef, useState } from 'react';
import { Copy, Eye, EyeOff, Image, Lock, Pencil, Pin, Plus, RefreshCw, Search, Trash2, Unlock, X } from 'lucide-react';
import type { CaptureHistoryPolicy, CaptureHistoryState, PinArrangeMode, PinGroup, PinWorkspaceSettings, PinWorkspaceState } from '../shared/history-sync';
import { validatePinWorkspaceSettings } from '../shared/history-sync';
import { Segmented } from './motion';
import { Switch } from './Switch';

const date = (value: number) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`;

export function CaptureHistory({
  policy,
  change,
  pinned,
  notify
}: {
  policy: CaptureHistoryPolicy;
  change: (value: CaptureHistoryPolicy) => void;
  pinned: () => void;
  notify?: (status: { ok?: boolean; error?: string }) => void;
}) {
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<CaptureHistoryState | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState('');
  const request = useRef(0);

  async function refresh() {
    const id = ++request.current;
    setLoading(true);
    setError('');
    try {
      const next = await window.desktop.captureHistory(query.trim());
      if (id === request.current) setHistory(next);
    } catch (reason) {
      if (id === request.current) setError(String(reason));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 180);
    return () => {
      clearTimeout(timer);
      request.current++;
    };
  }, [query, policy]);

  async function act(id: string, action: 'edit' | 'pin' | 'copy' | 'delete') {
    if (action === 'delete' && confirm !== id) {
      setConfirm(id);
      return;
    }
    setBusy(true);
    setError('');
    setConfirm('');
    try {
      const result = await window.desktop.actCaptureHistory(id, action);
      if (result.error) throw Error(result.error);
      await refresh();
      if (action === 'pin') pinned();
      notify?.({ ok: true });
    } catch (reason) {
      const msg = String(reason);
      setError(msg);
      notify?.({ error: msg });
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (confirm !== 'all') {
      setConfirm('all');
      return;
    }
    setBusy(true);
    setError('');
    setConfirm('');
    try {
      const result = await window.desktop.clearCaptureHistory();
      if (result.error) throw Error(result.error);
      await refresh();
      notify?.({ ok: true });
    } catch (reason) {
      const msg = String(reason);
      setError(msg);
      notify?.({ error: msg });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>历史保留策略</span>
          <span className="r">超出任一上限时自动清理最早记录</span>
        </div>
        <div className="l-set-card">
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">自动保存截图历史</div>
              <div className="l-set-row-sub">保留原图、编辑结果与标注对象，可随时继续编辑</div>
            </div>
            <Switch label="保存截图历史" value={policy.enabled} change={() => change({ ...policy, enabled: !policy.enabled })} />
          </div>
          <div className="l-set-row col">
            <div className="l-workspace-limits">
              {(
                [
                  ['maxItems', '保留条数', '条'],
                  ['maxDays', '保留天数', '天'],
                  ['maxBytesMB', '容量上限', 'MB']
                ] as const
              ).map(([key, label, unit]) => (
                <div className="l-field" key={key}>
                  <label htmlFor={'history-' + key}>
                    {label} · {unit}
                  </label>
                  <input
                    id={'history-' + key}
                    aria-label={label}
                    className="l-input mono"
                    type="number"
                    min="1"
                    step="1"
                    value={policy[key] || ''}
                    onChange={e => {
                      const val = Number(e.target.value);
                      if (Number.isSafeInteger(val) && val >= 1) change({ ...policy, [key]: val });
                    }}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>
            {loading ? '正在读取历史…' : history ? `截图资源库（${history.items.length} 条 · ${bytes(history.totalBytes)}）` : '截图资源库'}
          </span>
          <span className="r">
            <button type="button" className="l-text-btn" disabled={busy || loading} onClick={() => void refresh()}>
              <RefreshCw size={12} />
              <span>刷新</span>
            </button>
            {Boolean(history?.totalBytes) && (
              <>
                {' · '}
                <button type="button" className="l-text-btn danger" disabled={busy} onClick={() => void clear()}>
                  {confirm === 'all' ? '确认清空全部' : '清空历史'}
                </button>
              </>
            )}
          </span>
        </div>

        <div className="l-row l-history-search">
          <Search size={15} />
          <input
            className="l-input"
            aria-label="搜索截图历史"
            placeholder="搜索截图内识别出的文字…"
            disabled={busy}
            value={query}
            onChange={e => {
              setQuery(e.target.value);
              setConfirm('');
            }}
          />
        </div>

        <div className="l-set-card">
          {history?.items.map(item => (
            <div key={item.id} className="l-set-row col">
              <div className="l-row">
                <div className="l-history-preview">{item.thumbnailDataUrl ? <img src={item.thumbnailDataUrl} alt="截图缩略图" /> : <Image size={20} />}</div>
                <div className="l-set-row-main">
                  <div className="l-set-row-name mono">
                    <span>
                      {item.width} × {item.height}
                    </span>
                    {item.hasAnnotations && <span className="l-chip">含标注</span>}
                  </div>
                  <div className="l-set-row-sub">
                    {date(item.createdAt)} · <span className="mono">{bytes(item.byteSize)}</span>
                  </div>
                  <p className="l-history-snippet">{item.ocrSnippet || '暂无识别文字'}</p>
                </div>
              </div>
              <div className="l-workspace-actions">
                {(
                  [
                    ['edit', '再编辑', Pencil],
                    ['pin', '贴图', Pin],
                    ['copy', '复制', Copy]
                  ] as const
                ).map(([action, label, Icon]) => (
                  <button key={action} type="button" className="l-btn small" disabled={busy || loading} onClick={() => void act(item.id, action)}>
                    <Icon size={13} />
                    <span>{label}</span>
                  </button>
                ))}
                <span className="grow" />
                <button
                  type="button"
                  className={confirm === item.id ? 'l-btn danger-solid small' : 'l-ghost small danger'}
                  disabled={busy || loading}
                  onClick={() => void act(item.id, 'delete')}
                >
                  <Trash2 size={13} />
                  <span>{confirm === item.id ? '确认删除' : '删除'}</span>
                </button>
              </div>
            </div>
          ))}
          {!loading && history && !history.items.length && (
            <div className="l-set-row">
              <span className="l-set-row-sub">{query ? '没有匹配的截图记录' : '尚无截图历史，完成截图后会显示在这里。'}</span>
            </div>
          )}
        </div>
      </div>

      {error && (
        <p className="l-field-help l-danger" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function PinWorkspace({
  settings,
  revision,
  notify
}: {
  settings: PinWorkspaceSettings;
  revision: number;
  notify?: (status: { ok?: boolean; error?: string }) => void;
}) {
  const [workspace, setWorkspace] = useState<PinWorkspaceState | null>(null);
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState('');
  const [moving, setMoving] = useState('');
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState('');
  const source = JSON.stringify(settings);

  useEffect(() => {
    setDraft(structuredClone(settings));
  }, [source]);

  async function refresh() {
    setWorkspace(await window.desktop.pinWorkspace());
  }

  useEffect(() => {
    void refresh().catch(reason => setError(String(reason)));
  }, [revision, source]);

  async function commitWorkspace(next: PinWorkspaceSettings) {
    setDraft(next);
    setError('');
    try {
      validatePinWorkspaceSettings(next);
      const result = await window.desktop.savePinWorkspace(next);
      if (result.error) throw Error(result.error);
      await refresh();
      notify?.({ ok: true });
    } catch (reason) {
      const msg = String(reason);
      setError(msg);
      notify?.({ error: msg });
    }
  }

  async function run(operation: () => Promise<{ error: string | null }>) {
    setBusy(true);
    setError('');
    try {
      const result = await operation();
      if (result.error) throw Error(result.error);
      await refresh();
      notify?.({ ok: true });
      return true;
    } catch (reason) {
      const msg = String(reason);
      setError(msg);
      notify?.({ error: msg });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function updateGroup(id: string, patch: Partial<PinGroup>) {
    const groups = draft.groups.map(item => (item.id === id ? { ...item, ...patch } : item));
    void commitWorkspace({ ...draft, groups });
  }

  function removeGroup(id: string) {
    if (removing !== id) {
      setRemoving(id);
      return;
    }
    const groups = draft.groups.filter(item => item.id !== id);
    setRemoving('');
    void commitWorkspace({ ...draft, groups, activeGroupId: draft.activeGroupId === id ? groups[0].id : draft.activeGroupId });
  }

  const arranged = (mode: PinArrangeMode) => void run(() => window.desktop.arrangePins(mode, workspace?.settings.activeGroupId));

  return (
    <>
      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>贴图工作空间</span>
          <span className="r">按住 ⌥ 滚轮可临时切换缩放与透明度</span>
        </div>
        <div className="l-set-card">
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">启动时自动恢复贴图</div>
              <div className="l-set-row-sub">重新打开 Lasso 时恢复工作空间内的贴图</div>
            </div>
            <Switch
              label="启动自动恢复贴图"
              value={draft.restoreOnLaunch}
              disabled={busy}
              change={() => void commitWorkspace({ ...draft, restoreOnLaunch: !draft.restoreOnLaunch })}
            />
          </div>
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">桌面贴图悬浮工具条</div>
              <div className="l-set-row-sub">在桌面快速新建贴图、切换分组与一键排列</div>
            </div>
            <Switch
              label="桌面悬浮工具栏"
              value={draft.floatingToolbar}
              disabled={busy}
              change={() => void commitWorkspace({ ...draft, floatingToolbar: !draft.floatingToolbar })}
            />
          </div>
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">鼠标滚轮默认动作</div>
            </div>
            <Segmented
              label="贴图滚轮默认动作"
              value={draft.wheelAction}
              options={[
                ['zoom', '缩放'],
                ['opacity', '透明度']
              ]}
              onChange={wheelAction => void commitWorkspace({ ...draft, wheelAction })}
            />
          </div>
        </div>
      </div>

      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>贴图分组（{draft.groups.length}）</span>
          <span className="r">
            <button
              type="button"
              className="l-text-btn"
              disabled={busy}
              onClick={() =>
                void commitWorkspace({
                  ...draft,
                  groups: [...draft.groups, { id: crypto.randomUUID(), name: '新分组', color: draft.groups[0].color, visible: true }]
                })
              }
            >
              <Plus size={12} />
              <span>新建分组</span>
            </button>
          </span>
        </div>
        <div className="l-set-card">
          {draft.groups.map(item => (
            <div className="l-set-row" key={item.id}>
              <span
                className="l-shot-swatch"
                style={{ backgroundColor: /^#[\da-f]{6}$/i.test(item.color) ? item.color : undefined }}
              />
              {/* ui-check-ignore: user-defined group colour is workspace data */}
              <input
                className="l-input"
                aria-label={`分组名称 ${item.name}`}
                value={item.name}
                disabled={busy}
                onChange={e => setDraft(cur => ({ ...cur, groups: cur.groups.map(g => (g.id === item.id ? { ...g, name: e.target.value } : g)) }))}
                onBlur={() => {
                  if (item.name.trim()) void commitWorkspace(draft);
                }}
              />
              <button
                type="button"
                className={'l-btn small' + (draft.activeGroupId === item.id ? ' ton' : '')}
                aria-pressed={draft.activeGroupId === item.id}
                disabled={busy}
                onClick={() => void commitWorkspace({ ...draft, activeGroupId: item.id })}
              >
                {draft.activeGroupId === item.id ? '当前分组' : '设为当前'}
              </button>
              <Switch label={`显示分组 ${item.name}`} value={item.visible} disabled={busy} change={() => updateGroup(item.id, { visible: !item.visible })} />
              <button
                type="button"
                className={removing === item.id ? 'l-btn danger-solid small' : 'l-icon small danger'}
                aria-label={`删除分组 ${item.name}`}
                disabled={busy || draft.groups.length === 1}
                onClick={() => removeGroup(item.id)}
              >
                {removing === item.id ? '确认' : <Trash2 size={14} />}
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>快捷操作与活跃贴图（{workspace ? workspace.pins.length : '…'}）</span>
          <span className="r">
            <button type="button" className="l-text-btn" disabled={busy} onClick={() => void refresh()}>
              <RefreshCw size={12} />
              <span>刷新</span>
            </button>
          </span>
        </div>
        <div className="l-workspace-actions">
          <button type="button" className="l-btn small" disabled={busy} onClick={() => void run(() => window.desktop.pinClipboard())}>
            剪贴板贴图
          </button>
          <button type="button" className="l-btn small" disabled={busy} aria-expanded={writing} onClick={() => setWriting(!writing)}>
            新建文字贴图
          </button>
          <button
            type="button"
            className="l-btn small"
            disabled={busy || !workspace?.closedCount}
            onClick={() => void run(() => window.desktop.reopenClosedPin())}
          >
            恢复刚关闭{workspace?.closedCount ? ` (${workspace.closedCount})` : ''}
          </button>
          <span className="grow" />
          {(
            [
              ['grid', '网格'],
              ['align-left', '左对齐'],
              ['align-top', '顶对齐']
            ] as const
          ).map(([mode, label]) => (
            <button key={mode} type="button" className="l-btn small" disabled={busy || !workspace?.pins.length} onClick={() => arranged(mode)}>
              {label}
            </button>
          ))}
        </div>

        {writing && (
          <div className="l-set-card">
            <div className="l-set-row col">
              <textarea
                className="l-textarea"
                rows={3}
                aria-label="文字贴图内容"
                placeholder="写下要贴在桌面上的文字…"
                value={text}
                onChange={e => setText(e.target.value)}
              />
              <div className="l-row">
                <span className="grow" />
                <button type="button" className="l-ghost small" onClick={() => setWriting(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="l-btn small primary"
                  disabled={busy || !text.trim()}
                  onClick={() =>
                    void run(() => window.desktop.createPin({ kind: 'text', text, groupId: workspace?.settings.activeGroupId })).then(ok => {
                      if (ok) {
                        setText('');
                        setWriting(false);
                      }
                    })
                  }
                >
                  创建文字贴图
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="l-set-card">
          {workspace?.pins.map(pin => (
            <div className="l-set-row col" key={pin.id}>
              <div className="l-row">
                <div className="l-set-row-main">
                  <div className="l-set-row-name">{pin.title || { image: '图片贴图', text: '文字贴图', color: '颜色贴图', file: '文件贴图' }[pin.kind]}</div>
                  <div className="l-set-row-sub">
                    {workspace.settings.groups.find(g => g.id === pin.groupId)?.name} · <span className="mono">{Math.round(pin.opacity * 100)}%</span> ·{' '}
                    {pin.visible ? '显示中' : '已隐藏'}
                    {pin.locked ? ' · 已锁定' : ''}
                  </div>
                </div>
                <div className="l-workspace-actions">
                  <button type="button" className="l-btn small" disabled={busy} onClick={() => void run(() => window.desktop.actPin(pin.id, 'focus'))}>
                    定位
                  </button>
                  <button
                    type="button"
                    className="l-btn small"
                    disabled={busy}
                    onClick={() => void run(() => window.desktop.actPin(pin.id, 'toggle-visible'))}
                  >
                    {pin.visible ? <EyeOff size={13} /> : <Eye size={13} />}
                    <span>{pin.visible ? '隐藏' : '显示'}</span>
                  </button>
                  <button type="button" className="l-btn small" disabled={busy} onClick={() => void run(() => window.desktop.actPin(pin.id, 'toggle-lock'))}>
                    {pin.locked ? <Unlock size={13} /> : <Lock size={13} />}
                    <span>{pin.locked ? '解锁' : '锁定'}</span>
                  </button>
                  <button type="button" className="l-btn small" disabled={busy} onClick={() => setMoving(moving === pin.id ? '' : pin.id)}>
                    分组
                  </button>
                  <button type="button" className="l-icon small" aria-label="关闭贴图" disabled={busy} onClick={() => void run(() => window.desktop.actPin(pin.id, 'close'))}>
                    <X size={14} />
                  </button>
                </div>
              </div>
              {moving === pin.id && (
                <div className="l-wrap">
                  {workspace.settings.groups.map(g => (
                    <button
                      key={g.id}
                      type="button"
                      className={'l-btn small' + (pin.groupId === g.id ? ' ton' : '')}
                      disabled={busy}
                      onClick={() =>
                        void run(() => window.desktop.actPin(pin.id, 'focus', g.id)).then(ok => {
                          if (ok) setMoving('');
                        })
                      }
                    >
                      {g.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {workspace && !workspace.pins.length && (
            <div className="l-set-row">
              <span className="l-set-row-sub">暂无活跃贴图，可从截图、剪贴板或文字创建。</span>
            </div>
          )}
        </div>
      </div>

      {error && (
        <p className="l-field-help l-danger" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
