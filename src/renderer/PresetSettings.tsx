import { Fragment, useEffect, useRef, useState } from 'react';
import { ChevronLeft, GripVertical, Image as ImageIcon, Plus, Trash2 } from 'lucide-react';
import { presetTargetLabels as targetLabels, type Preset } from '../shared/contracts';
import { defaultImageOptions, imageOptionsSummary } from '../shared/media';
import { promptSources } from '../shared/prompt-templates';
import { ExecutionFields } from './ExecutionFields';
import { ApiTextFields, ImageOptionsFields } from './ImageOptionsFields';
import { Segmented } from './motion';
import { Switch } from './Switch';
import { Badge, targets } from './targets';

const preview = (template: string) => template.replace(/\s+/g, ' ').split('{{selection}}');

export function PresetSettings({
  presets,
  creatingKind,
  onClearCreate,
  onOpenConnections,
  notify
}: {
  presets: Preset[];
  creatingKind: 'chat' | 'image' | null;
  onClearCreate(): void;
  onOpenConnections(): void;
  notify(status: { ok?: boolean; error?: string }): void;
}) {
  const [editing, setEditing] = useState<Preset | null>(null);
  const [error, setError] = useState('');
  const drag = useRef<string | null>(null);
  const [drop, setDrop] = useState<string | null>(null);

  useEffect(() => {
    if (!creatingKind) return;
    setEditing(
      creatingKind === 'image'
        ? {
            id: crypto.randomUUID(),
            kind: 'image',
            name: '新图片生成预设',
            template: '请生成清晰细腻的插画：\n\n{{selection}}',
            target: 'api',
            image: defaultImageOptions(),
            mode: 'send',
            needsSelection: false,
            enabled: true
          }
        : {
            id: crypto.randomUUID(),
            kind: 'chat',
            name: '新对话预设',
            template: '{{selection}}',
            target: 'chatgpt',
            mode: 'send',
            needsSelection: true,
            enabled: true
          }
    );
    onClearCreate();
  }, [creatingKind, onClearCreate]);

  async function save(next: Preset[]) {
    const r = await window.desktop.savePresets(next);
    setError(r.error || '');
    if (r.error) {
      notify({ error: r.error });
      return false;
    }
    notify({ ok: true });
    return true;
  }

  function move(id: string, toId: string) {
    const from = presets.findIndex(p => p.id === id);
    const to = presets.findIndex(p => p.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...presets];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    void save(next);
  }

  if (editing) {
    const isNew = !presets.some(p => p.id === editing.id);
    return (
      <PresetEditor
        key={editing.id}
        preset={editing}
        isNew={isNew}
        error={error}
        back={() => {
          setEditing(null);
          setError('');
        }}
        onOpenConnections={onOpenConnections}
        save={async preset => {
          const ok = await save(isNew ? [...presets, preset] : presets.map(p => (p.id === preset.id ? preset : p)));
          if (ok) setEditing(null);
          return ok;
        }}
        remove={async id => {
          if (await save(presets.filter(p => p.id !== id))) setEditing(null);
        }}
      />
    );
  }

  const chatPresets = presets.filter(p => p.kind !== 'image');
  const imagePresets = presets.filter(p => p.kind === 'image');

  const renderRow = (preset: Preset) => {
    const isImg = preset.kind === 'image';
    const meta = isImg
      ? [targetLabels[preset.target], preset.image ? imageOptionsSummary(preset.image) : ''].filter(Boolean).join(' · ')
      : [
          targetLabels[preset.target],
          preset.target === 'api' ? (preset.model ? preset.model : '快答卡') : preset.mode === 'edit' ? '先编辑' : '直接发送'
        ]
          .filter(Boolean)
          .join(' · ');

    return (
      <div
        key={preset.id}
        className="l-set-row clickable"
        data-drop={drop === preset.id}
        draggable
        onDragStart={() => {
          drag.current = preset.id;
        }}
        onDragOver={e => {
          e.preventDefault();
          if (drag.current && drag.current !== preset.id) setDrop(preset.id);
        }}
        onDragLeave={() => setDrop(null)}
        onDragEnd={() => {
          drag.current = null;
          setDrop(null);
        }}
        onDrop={() => {
          if (drag.current) move(drag.current, preset.id);
          drag.current = null;
          setDrop(null);
        }}
        onClick={() => setEditing(preset)}
      >
        <span className="l-grip" aria-hidden="true" onClick={e => e.stopPropagation()}>
          <GripVertical size={14} />
        </span>
        {isImg ? <ImageIcon size={15} className="faint" /> : <Badge target={preset.target} />}
        <div className="l-set-row-main">
          <div className="l-set-row-name">
            <span>{preset.name || '未命名'}</span>
            {!preset.needsSelection && <span className="l-chip">无需选区</span>}
            {!preset.enabled && <span className="l-chip faint">已停用</span>}
          </div>
          <div className="l-set-row-sub trunc">
            {preview(preset.template).map((part, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="l-chip mono">选区</span>}
                {part}
              </Fragment>
            ))}
          </div>
        </div>
        <span className="l-set-row-sub">{meta}</span>
        <div onClick={e => e.stopPropagation()}>
          <Switch
            label={'启用 ' + preset.name}
            value={preset.enabled}
            change={() => void save(presets.map(p => (p.id === preset.id ? { ...p, enabled: !p.enabled } : p)))}
          />
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>对话预设（{chatPresets.length}）</span>
          <span className="r">点开编辑；动作条显示顺序在「划词与动作条」调整</span>
        </div>
        <div className="l-set-card">
          {chatPresets.length > 0 ? (
            chatPresets.map(renderRow)
          ) : (
            <div className="l-set-row">
              <span className="l-set-row-sub">尚无对话预设</span>
            </div>
          )}
        </div>
      </div>

      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>AI 生图预设（{imagePresets.length}）</span>
          <span className="r">供独立「AI 生图」窗口与截图「问 AI」使用</span>
        </div>
        <div className="l-set-card">
          {imagePresets.length > 0 ? (
            imagePresets.map(renderRow)
          ) : (
            <div className="l-set-row">
              <div className="l-set-row-main">
                <span className="l-set-row-sub">尚无 AI 生图预设</span>
              </div>
              <button
                type="button"
                className="l-btn small"
                onClick={() =>
                  setEditing({
                    id: crypto.randomUUID(),
                    kind: 'image',
                    name: '内容配图',
                    template: '请直接生成图片。有参考图时结合参考图完成。\n\n{{selection}}',
                    target: 'api',
                    image: defaultImageOptions(),
                    mode: 'send',
                    needsSelection: false,
                    enabled: true
                  })
                }
              >
                <Plus size={13} />
                <span>添加生图预设</span>
              </button>
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

function PresetEditor({
  preset,
  isNew,
  save,
  remove,
  back,
  onOpenConnections,
  error
}: {
  preset: Preset;
  isNew: boolean;
  save(preset: Preset): Promise<boolean>;
  remove(id: string): Promise<void>;
  back(): void;
  onOpenConnections(): void;
  error: string;
}) {
  const [draft, setDraft] = useState(preset);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const source = promptSources.find(item => item.template === draft.template);

  useEffect(() => {
    if (draft.target === 'api' && !draft.connectionId) {
      void window.desktop.apiConnections().then(list => {
        if (list[0]) setDraft(old => ({ ...old, connectionId: old.connectionId || list[0].id }));
      });
    }
  }, [draft.target, draft.connectionId]);

  const set = (changes: Partial<Preset>) => {
    setDraft(old => ({ ...old, ...changes }));
    setConfirmDelete(false);
  };

  function insertSelectionToken() {
    const el = area.current;
    if (!el) return;
    const at = el.selectionStart;
    set({ template: draft.template.slice(0, at) + '{{selection}}' + draft.template.slice(el.selectionEnd) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at + 13, at + 13);
    });
  }

  function switchTarget(target: Preset['target']) {
    set({
      target,
      model: '',
      effort: '',
      ...(target === 'api' ? { temporaryChat: undefined } : {})
    });
  }

  const saveDisabled =
    !draft.name.trim() ||
    !draft.template.trim() ||
    (draft.target === 'api' && (!draft.connectionId || (draft.kind !== 'image' && !draft.model?.trim()) || (draft.kind === 'image' && !draft.image?.generationModel.trim())));

  return (
    <div className="l-set-group">
      <div className="l-row">
        <button type="button" className="l-text-btn" onClick={back}>
          <ChevronLeft size={14} />
          <span>返回全部预设</span>
        </button>
      </div>

      <div className="l-set-card">
        <div className="l-set-row col">
          <div className="l-grid-2">
            <div className="l-field">
              <label htmlFor="preset-name">预设名称</label>
              <input id="preset-name" className="l-input" value={draft.name} onChange={e => set({ name: e.target.value })} placeholder="如：解释 / 总结 / 内容配图" />
            </div>
            <div className="l-field">
              <span className="l-field-label">预设类型</span>
              <Segmented
                label="预设类型"
                value={draft.kind || 'chat'}
                onChange={kind => {
                  if (kind === (draft.kind || 'chat')) return;
                  set({
                    kind,
                    ...(kind === 'image' && isNew && draft.template === '{{selection}}'
                      ? { name: '内容配图', template: '请直接生成图片。有参考图时结合参考图完成。\n\n{{selection}}', target: 'api', needsSelection: false }
                      : {}),
                    image: kind === 'image' ? draft.image || defaultImageOptions() : undefined,
                    model: '',
                    effort: ''
                  });
                }}
                options={[
                  ['chat', '对话预设'],
                  ['image', 'AI 生图预设']
                ]}
              />
            </div>
          </div>

          <div className="l-field">
            <div className="l-field-row">
              <label htmlFor="preset-template">提示词模板</label>
              <button type="button" className="l-btn small" onClick={insertSelectionToken}>
                插入 {'{{selection}}'}
              </button>
            </div>
            <textarea
              id="preset-template"
              ref={area}
              className="l-textarea"
              rows={5}
              value={draft.template}
              onChange={e => set({ template: e.target.value })}
              spellCheck={false}
            />
            {source && (
              <button type="button" className="l-text-btn" onClick={() => void window.desktop.openLink(source.url)}>
                模板来源：{source.name}
              </button>
            )}
            <p className="l-field-help">
              <span className="mono">{'{{selection}}'}</span> 处放入选中文字；未写占位符时自动附在末尾。
              {draft.kind === 'image' && (
                <>
                  {' '}
                  可用 <span className="mono">{'{{aspect}}'}</span> 插入图片比例。
                </>
              )}
            </p>
          </div>

          <div className="l-field">
            <span className="l-field-label">发送目标</span>
            <Segmented
              label="发送目标"
              value={draft.target}
              onChange={switchTarget}
              options={targets.map(id => [id, targetLabels[id]] as const)}
            />
          </div>

          {(draft.target === 'chatgpt' || draft.target === 'gemini') && (
            <>
              <div className="l-grid-equal">
                <div className="l-field">
                  <span className="l-field-label">网页会话</span>
                  <Segmented
                    label="网页会话"
                    value={draft.temporaryChat ? 'temporary' : 'normal'}
                    onChange={mode => set({ temporaryChat: mode === 'temporary' ? true : undefined })}
                    options={[
                      ['normal', '普通提问'],
                      ['temporary', '临时提问']
                    ]}
                  />
                </div>
                <div className="l-field">
                  <span className="l-field-label">执行方式</span>
                  <Segmented
                    label="执行方式"
                    value={draft.mode}
                    onChange={mode => set({ mode })}
                    options={[
                      ['send', '直接发送'],
                      ['edit', '先填入再改']
                    ]}
                  />
                </div>
              </div>
              <ExecutionFields key={draft.target + '-execution'} target={draft.target} profile={draft} update={set} />
            </>
          )}

          {draft.kind !== 'image' && draft.target === 'api' && (
            <ApiTextFields
              connectionId={draft.connectionId || ''}
              model={draft.model || ''}
              onChange={model => set({ model })}
              onConnectionChange={connectionId => set({ connectionId })}
              onOpenConnections={onOpenConnections}
            />
          )}

          {draft.kind === 'image' && (
            <ImageOptionsFields
              key={draft.target + '-image'}
              value={draft.image || defaultImageOptions()}
              update={image => set({ image })}
              api={draft.target === 'api'}
              connectionId={draft.connectionId || ''}
              onConnectionChange={connectionId => set({ connectionId })}
              onOpenConnections={onOpenConnections}
            />
          )}
        </div>

        <div className="l-set-row">
          <div className="l-set-row-main">
            <div className="l-set-row-name">仅在选中内容或图片后可用</div>
            <div className="l-set-row-sub">关闭后可在指令面板（⌘K）直接无输入触发</div>
          </div>
          <Switch label="需要选区内容" value={draft.needsSelection} change={() => set({ needsSelection: !draft.needsSelection })} />
        </div>

        <div className="l-set-row">
          <div className="l-set-row-main">
            <div className="l-set-row-name">启用此预设</div>
            <div className="l-set-row-sub">停用后不出现在动作条、截图「问 AI」与指令面板</div>
          </div>
          <Switch label="启用预设" value={draft.enabled} change={() => set({ enabled: !draft.enabled })} />
        </div>

        <div className="l-set-row">
          {!isNew && (
            <button
              type="button"
              className="l-ghost small danger"
              onClick={() => (confirmDelete ? void remove(preset.id) : setConfirmDelete(true))}
            >
              <Trash2 size={13} />
              <span>{confirmDelete ? `确认删除「${preset.name}」` : '删除预设'}</span>
            </button>
          )}
          <span className="grow" />
          <button type="button" className="l-ghost small" onClick={back}>
            取消
          </button>
          <button type="button" className="l-btn small primary" disabled={saveDisabled} onClick={() => void save(draft)}>
            保存预设
          </button>
        </div>
      </div>

      {error && (
        <p className="l-field-help l-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
