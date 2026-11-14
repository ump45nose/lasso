import { useEffect, useRef, useState } from 'react';
import { Check, Download, Ellipsis, GripVertical, Languages, NotebookPen, Plus, RefreshCw, Upload, X, Zap } from 'lucide-react';
import {
  presetTargetLabels as targetLabels,
  type ActionBarConfig,
  type AppPrompt,
  type FinderEditorApp,
  type FinderTerminalApp,
  type GeneralSettings as GeneralPreferences,
  type ShellState,
  type SuiteSettings
} from '../shared/contracts';
import type { WebDavConfig, WebDavConfigInput, WebDavSyncDirection } from '../shared/history-sync';
import type { TranslationLang, TranslationProvider, TranslationSettings } from '../shared/media';
import {
  editorActionIds,
  editorActionLabels,
  globalActionLabels,
  isValidShortcut,
  validateEditorShortcuts,
  type EditorActionId,
  type GlobalActionId,
  type IgnoredAppRule,
  type IgnoredAppScope
} from '../shared/shortcuts';
import { FontSettings } from './FontSettings';
import { ApiConnectionBindingFields } from './ImageOptionsFields';
import { AnimatePresence, motion } from 'motion/react';
import { collapse, Segmented, SelectBox, SubNav, SubPane, useSubNav } from './motion';
import { Switch } from './Switch';
import { Badge, shortcutLabel } from './targets';
import './styles/screenshot-settings.css';

type NotifyFn = (status: { ok?: boolean; error?: string }) => void;

/* ───────────────────────── Module 1: 通用与外观 ───────────────────────── */

export function GeneralAppearancePane({ state, notify }: { state: ShellState; notify: NotifyFn }) {
  const { settings } = state;
  const [minutes, setMinutes] = useState(String(settings.memory.idleMinutes));
  useEffect(() => {
    setMinutes(String(settings.memory.idleMinutes));
  }, [settings.memory.idleMinutes]);

  async function saveGeneral(patch: Partial<GeneralPreferences>) {
    const res = await window.desktop.saveGeneral({
      launchAtLogin: settings.launchAtLogin,
      themeMode: settings.themeMode,
      toolbarTools: settings.toolbarTools,
      mouseActions: settings.mouseActions,
      autoCheckUpdates: settings.autoCheckUpdates,
      ...patch
    });
    if (res.error) notify({ error: res.error });
    else notify({ ok: true });
  }

  async function saveMemory(idleMinutes = settings.memory.idleMinutes, enabled = settings.memory.enabled) {
    const res = await window.desktop.saveMemory({ enabled, idleMinutes });
    if (res.error) notify({ error: res.error });
    else {
      setMinutes(String(idleMinutes));
      notify({ ok: true });
    }
  }

  const resident = state.tasks.filter(t => t.residency === 'resident').length;
  const released = state.tasks.length - resident;

  return (
    <>
      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>系统与外观</span>
        </div>
        <div className="l-set-card">
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">登录 macOS 时自动启动</div>
            </div>
            <Switch label="开机自启" value={settings.launchAtLogin} change={() => void saveGeneral({ launchAtLogin: !settings.launchAtLogin })} />
          </div>
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">自动检查版本更新</div>
            </div>
            <Switch label="自动检查更新" value={settings.autoCheckUpdates} change={() => void saveGeneral({ autoCheckUpdates: !settings.autoCheckUpdates })} />
          </div>
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">界面主题</div>
              <div className="l-set-row-sub">纸面暖白或跟随系统浅色／深色外观</div>
            </div>
            <Segmented
              label="界面主题"
              value={settings.themeMode}
              onChange={themeMode => void saveGeneral({ themeMode })}
              options={[
                ['paper', '暖白纸面'],
                ['system', '跟随系统']
              ]}
            />
          </div>
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">AI 对话小窗默认置顶</div>
              <div className="l-set-row-sub">关闭置顶时，点击小窗外部自动收起隐藏</div>
            </div>
            <Switch
              label="始终置顶"
              value={state.pinned}
              change={() => {
                void window.desktop.act('pin');
                notify({ ok: true });
              }}
            />
          </div>
        </div>
      </div>

      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>内存与网页会话休眠</span>
          <span className="r">
            当前 {resident} 个驻留 · {released} 个已休眠
          </span>
        </div>
        <div className="l-set-card">
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">后台闲置自动释放网页内存</div>
              <div className="l-set-row-sub">隐藏后开始计时，重新切回会话时按原链接恢复</div>
            </div>
            <Switch label="闲置休眠" value={settings.memory.enabled} change={() => void saveMemory(undefined, !settings.memory.enabled)} />
          </div>
          <AnimatePresence initial={false}>
            {settings.memory.enabled && (
              <motion.div key="mem-idle" className="l-set-collapse" {...collapse}>
                <div className="l-set-row">
                  <div className="l-set-row-main">
                    <div className="l-set-row-name">闲置休眠时长</div>
                  </div>
                  <Segmented
                    label="闲置休眠时间"
                    value={[5, 15, 30, 60].includes(settings.memory.idleMinutes) ? String(settings.memory.idleMinutes) : ''}
                    options={[
                      ['5', '5 分'],
                      ['15', '15 分'],
                      ['30', '30 分'],
                      ['60', '60 分']
                    ]}
                    onChange={v => v && void saveMemory(Number(v))}
                  />
                  <div className="l-row">
                    <input
                      aria-label="自定义休眠分钟"
                      className="l-input mono l-shot-height"
                      type="number"
                      min="1"
                      max="1440"
                      value={minutes}
                      onChange={e => setMinutes(e.target.value)}
                      onBlur={() => {
                        const n = Number(minutes);
                        if (Number.isSafeInteger(n) && n >= 1 && n <= 1440 && n !== settings.memory.idleMinutes) void saveMemory(n);
                      }}
                    />
                    <span className="l-set-row-sub">分</span>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <FontSettings settings={settings} notify={notify} />

      <div className="l-row">
        <button type="button" className="l-ghost small danger" onClick={() => void window.desktop.act('quit')}>
          退出 Lasso
        </button>
      </div>
    </>
  );
}

/* ───────────────────────── Module 2: 划词与动作条 (B9-A) ───────────────────────── */

const ignoredScopes: readonly (readonly [IgnoredAppScope, string])[] = [
  ['selection', '划词触发'],
  ['shortcuts', '快捷键'],
  ['capture-candidates', '窗口候选']
];

interface BarEntry {
  id: string;
  kind: 'translate' | 'note' | 'preset';
  name: string;
  sub: string;
  subMono?: boolean;
  target?: 'chatgpt' | 'gemini' | 'api';
  enabled: boolean;
}

export function SelectionActionBarPane({ state, notify }: { state: ShellState; notify: NotifyFn }) {
  const { settings, capture, presets } = state;
  const dragId = useRef<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  async function saveCapture(patch: Partial<Pick<typeof settings, 'selectionEnabled' | 'clipboardFallback'>>) {
    const res = await window.desktop.saveCapture({
      selectionEnabled: settings.selectionEnabled,
      clipboardFallback: settings.clipboardFallback,
      ...patch
    });
    if (res.error) notify({ error: res.error });
    else notify({ ok: true });
  }

  // Build ordered action-bar entries matching B1 & B9-A
  const hiddenSet = new Set(settings.actionBar.hidden);
  const chatPresets = presets.filter(p => p.kind !== 'image');
  const rawEntries = new Map<string, BarEntry>();
  rawEntries.set('translate', {
    id: 'translate',
    kind: 'translate',
    name: '翻译',
    sub: '打开翻译浮窗',
    enabled: !hiddenSet.has('translate')
  });
  for (const p of chatPresets) {
    const itemId = `preset:${p.id}`;
    rawEntries.set(itemId, {
      id: itemId,
      kind: 'preset',
      name: p.name || '未命名预设',
      sub:
        p.target === 'api'
          ? 'API · 快答卡'
          : `${targetLabels[p.target]} · ${p.mode === 'edit' ? '先编辑' : '直接发送'}`,
      target: p.target,
      enabled: p.enabled && !hiddenSet.has(itemId)
    });
  }
  rawEntries.set('note', {
    id: 'note',
    kind: 'note',
    name: '存入便签',
    sub: 'Scratchpad.md',
    subMono: true,
    enabled: !hiddenSet.has('note')
  });

  const inlineLimit = Math.max(1, Math.min(8, settings.actionBar.inlineCount || 5));
  const orderedEntries: BarEntry[] = [];
  for (const id of settings.actionBar.order) {
    const entry = rawEntries.get(id);
    if (entry) {
      orderedEntries.push(entry);
      rawEntries.delete(id);
    }
  }
  for (const [id, entry] of rawEntries.entries()) {
    if (id === 'note' && !settings.actionBar.order.includes('note')) {
      let enabledBefore = 0;
      let insertIdx = orderedEntries.length;
      for (let i = 0; i < orderedEntries.length; i++) {
        if (orderedEntries[i].enabled) {
          enabledBefore++;
          if (enabledBefore === inlineLimit) {
            insertIdx = i;
            break;
          }
        }
      }
      orderedEntries.splice(insertIdx, 0, entry);
    } else {
      orderedEntries.push(entry);
    }
  }
  const inlineEntries: BarEntry[] = [];
  const overflowEntries: BarEntry[] = [];
  let activeSeen = 0;
  for (const entry of orderedEntries) {
    if (entry.enabled && activeSeen < inlineLimit) {
      inlineEntries.push(entry);
      activeSeen++;
    } else {
      overflowEntries.push(entry);
    }
  }

  async function persistActionBar(next: ActionBarConfig) {
    const res = await window.desktop.saveActionBarConfig(next);
    if (res.error) notify({ error: res.error });
    else notify({ ok: true });
  }

  async function toggleEntry(entry: BarEntry) {
    const nextHidden = new Set(settings.actionBar.hidden);
    if (entry.enabled) {
      nextHidden.add(entry.id);
    } else {
      nextHidden.delete(entry.id);
      if (entry.kind === 'preset') {
        const pid = entry.id.slice('preset:'.length);
        const targetPreset = presets.find(p => p.id === pid);
        if (targetPreset && !targetPreset.enabled) {
          await window.desktop.savePresets(presets.map(p => (p.id === pid ? { ...p, enabled: true } : p)));
        }
      }
    }
    await persistActionBar({
      order: orderedEntries.map(e => e.id),
      hidden: [...nextHidden],
      inlineCount: inlineLimit
    });
  }

  function reorderEntries(fromId: string, toTarget: string) {
    const ids = orderedEntries.map(e => e.id);
    const fromIdx = ids.indexOf(fromId);
    if (fromIdx < 0) return;
    if (toTarget === '__cutline__') {
      // Place right above the cutline and adjust inlineCount
      const [moved] = ids.splice(fromIdx, 1);
      const insertAt = Math.min(ids.length, inlineEntries.filter(e => e.id !== fromId).length);
      ids.splice(insertAt, 0, moved);
      const newInline = Math.max(1, Math.min(8, insertAt + 1));
      void persistActionBar({
        order: ids,
        hidden: settings.actionBar.hidden,
        inlineCount: newInline
      });
      return;
    }
    const toIdx = ids.indexOf(toTarget);
    if (toIdx < 0 || fromIdx === toIdx) return;
    const [moved] = ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, moved);
    // Recompute inlineCount if dragged across cutline
    const wasInline = inlineEntries.some(e => e.id === fromId);
    const targetIsInline = inlineEntries.some(e => e.id === toTarget);
    let nextInline = inlineLimit;
    if (!wasInline && targetIsInline) nextInline = Math.min(8, inlineLimit + 1);
    else if (wasInline && !targetIsInline) nextInline = Math.max(1, inlineLimit - 1);
    void persistActionBar({
      order: ids,
      hidden: settings.actionBar.hidden,
      inlineCount: nextInline
    });
  }

  async function saveAppRules(rules: AppPrompt[]) {
    const res = await window.desktop.saveAppPrompts(rules);
    if (res.error) notify({ error: res.error });
    else notify({ ok: true });
  }

  async function addAppPromptRule() {
    const choice = await window.desktop.choosePath('application');
    if (!choice?.bundleId || !choice.name) return;
    if (settings.appPrompts.some(r => r.bundleId === choice.bundleId)) {
      notify({ error: '该应用已在背景规则中' });
      return;
    }
    await saveAppRules([...settings.appPrompts, { bundleId: choice.bundleId, name: choice.name, prompt: '', enabled: true }]);
  }

  async function saveIgnored(rules: IgnoredAppRule[]) {
    const res = await window.desktop.saveIgnoredApps(rules);
    if (res.error) notify({ error: res.error });
    else notify({ ok: true });
  }

  async function addIgnoredApp() {
    const choice = await window.desktop.choosePath('application');
    if (!choice?.bundleId || !choice.name) return;
    if (settings.ignoredApps.some(r => r.bundleId === choice.bundleId)) {
      notify({ error: '该应用已在忽略名单中' });
      return;
    }
    await saveIgnored([
      ...settings.ignoredApps,
      { bundleId: choice.bundleId, name: choice.name, enabled: true, scopes: ['selection', 'shortcuts', 'capture-candidates'] }
    ]);
  }

  const renderBarRow = (entry: BarEntry) => (
    <div
      key={entry.id}
      className="l-set-row"
      data-drop={dropId === entry.id}
      draggable
      onDragStart={() => {
        dragId.current = entry.id;
      }}
      onDragOver={e => {
        e.preventDefault();
        if (dragId.current && dragId.current !== entry.id) setDropId(entry.id);
      }}
      onDragLeave={() => setDropId(null)}
      onDragEnd={() => {
        dragId.current = null;
        setDropId(null);
      }}
      onDrop={() => {
        if (dragId.current) reorderEntries(dragId.current, entry.id);
        dragId.current = null;
        setDropId(null);
      }}
    >
      <span className="l-grip" aria-hidden="true">
        <GripVertical size={14} />
      </span>
      {entry.kind === 'translate' ? (
        <Languages size={15} className="faint" />
      ) : entry.kind === 'note' ? (
        <NotebookPen size={15} className="faint" />
      ) : entry.target === 'api' ? (
        <Zap size={15} className="faint" />
      ) : (
        <Badge target={entry.target || 'chatgpt'} />
      )}
      <div className="l-set-row-main">
        <div className="l-set-row-name">{entry.name}</div>
      </div>
      <span className={'l-set-row-sub' + (entry.subMono ? ' mono' : '')}>{entry.sub}</span>
      <Switch label={'动作条显示 ' + entry.name} value={entry.enabled} change={() => void toggleEntry(entry)} />
    </div>
  );

  const authorized = capture.status === 'active' || (capture.status === 'paused' && !settings.selectionEnabled);

  return (
    <>
      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>划词触发</span>
        </div>
        <div className="l-set-card">
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">选中文字时显示动作条</div>
              <div className="l-set-row-sub">需要辅助功能权限</div>
            </div>
            {authorized ? (
              <span className="l-chip olive">
                <span className="l-dot olive" />
                <span>已授权</span>
              </span>
            ) : (
              <button type="button" className="l-btn small" onClick={() => void window.desktop.act('selection-permission')}>
                去系统设置授权
              </button>
            )}
            <Switch
              label="选中文字时显示动作条"
              value={settings.selectionEnabled}
              change={() => void saveCapture({ selectionEnabled: !settings.selectionEnabled })}
            />
          </div>
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">
                取不到选区时模拟 <span className="mono">⌘C</span>
              </div>
              <div className="l-set-row-sub">终端等不支持辅助功能取词的应用需要</div>
            </div>
            <Switch
              label="取不到选区时模拟 ⌘C"
              value={settings.clipboardFallback}
              change={() => void saveCapture({ clipboardFallback: !settings.clipboardFallback })}
            />
          </div>
        </div>
      </div>

      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>动作条布局与排序</span>
          <span className="r">拖动排序；分隔线以上直接显示在胶囊里</span>
        </div>
        <div className="l-set-card">
          {inlineEntries.map(renderBarRow)}
          <div
            className="l-set-cutline"
            data-drop={dropId === '__cutline__'}
            onDragOver={e => {
              e.preventDefault();
              if (dragId.current) setDropId('__cutline__');
            }}
            onDragLeave={() => setDropId(null)}
            onDrop={() => {
              if (dragId.current) reorderEntries(dragId.current, '__cutline__');
              dragId.current = null;
              setDropId(null);
            }}
          >
            <Ellipsis size={13} />
            <span>以下收进 ··· 菜单</span>
            <span className="grow" />
            <span className="mono">胶囊上限 {inlineLimit}</span>
            <button
              type="button"
              className="l-text-btn mono"
              disabled={inlineLimit <= 1}
              onClick={() =>
                void persistActionBar({
                  order: orderedEntries.map(e => e.id),
                  hidden: settings.actionBar.hidden,
                  inlineCount: inlineLimit - 1
                })
              }
            >
              −
            </button>
            <button
              type="button"
              className="l-text-btn mono"
              disabled={inlineLimit >= 8}
              onClick={() =>
                void persistActionBar({
                  order: orderedEntries.map(e => e.id),
                  hidden: settings.actionBar.hidden,
                  inlineCount: inlineLimit + 1
                })
              }
            >
              +
            </button>
          </div>
          {overflowEntries.map(renderBarRow)}
        </div>
      </div>

      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>应用背景规则（{settings.appPrompts.length}）</span>
          <span className="r">
            <button type="button" className="l-text-btn" onClick={() => void addAppPromptRule()}>
              <Plus size={12} />
              <span>添加应用背景…</span>
            </button>
          </span>
        </div>
        <div className="l-set-card">
          {settings.appPrompts.length > 0 ? (
            settings.appPrompts.map((rule, idx) => (
              <div key={rule.bundleId} className="l-set-row col">
                <div className="l-row">
                  <div className="l-set-row-main">
                    <div className="l-set-row-name">{rule.name}</div>
                    <div className="l-set-row-sub mono">{rule.bundleId}</div>
                  </div>
                  <Switch
                    label={'启用应用背景 ' + rule.name}
                    value={rule.enabled}
                    change={() => void saveAppRules(settings.appPrompts.map((r, i) => (i === idx ? { ...r, enabled: !r.enabled } : r)))}
                  />
                  <button
                    type="button"
                    className="l-icon small"
                    aria-label={'删除应用背景 ' + rule.name}
                    onClick={() => void saveAppRules(settings.appPrompts.filter((_, i) => i !== idx))}
                  >
                    <X size={14} />
                  </button>
                </div>
                <AppPromptEditor
                  value={rule.prompt}
                  onCommit={prompt => void saveAppRules(settings.appPrompts.map((r, i) => (i === idx ? { ...r, prompt } : r)))}
                />
              </div>
            ))
          ) : (
            <div className="l-set-row">
              <span className="l-set-row-sub">按划词来源应用自动前置背景说明（如在终端附加「命令环境为 macOS zsh」）。</span>
            </div>
          )}
        </div>
      </div>

      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>忽略应用名单（{settings.ignoredApps.length}）</span>
          <span className="r">
            <button type="button" className="l-text-btn" onClick={() => void addIgnoredApp()}>
              <Plus size={12} />
              <span>添加忽略应用…</span>
            </button>
          </span>
        </div>
        <div className="l-set-card">
          {settings.ignoredApps.length > 0 ? (
            settings.ignoredApps.map((rule, idx) => (
              <div key={rule.bundleId} className="l-set-row col">
                <div className="l-row">
                  <div className="l-set-row-main">
                    <div className="l-set-row-name">{rule.name}</div>
                    <div className="l-set-row-sub mono">{rule.bundleId}</div>
                  </div>
                  <Switch
                    label={'启用忽略 ' + rule.name}
                    value={rule.enabled}
                    change={() => void saveIgnored(settings.ignoredApps.map((r, i) => (i === idx ? { ...r, enabled: !r.enabled } : r)))}
                  />
                  <button
                    type="button"
                    className="l-icon small"
                    aria-label={'移除忽略应用 ' + rule.name}
                    onClick={() => void saveIgnored(settings.ignoredApps.filter((_, i) => i !== idx))}
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className="l-ignored-scopes">
                  {ignoredScopes.map(([scope, label]) => {
                    const checked = rule.scopes.includes(scope);
                    return (
                      <button
                        key={scope}
                        type="button"
                        className="l-btn small"
                        role="checkbox"
                        aria-checked={checked}
                        onClick={() => {
                          const nextScopes = checked ? rule.scopes.filter(s => s !== scope) : [...rule.scopes, scope];
                          if (!nextScopes.length) return;
                          void saveIgnored(settings.ignoredApps.map((r, i) => (i === idx ? { ...r, scopes: nextScopes } : r)));
                        }}
                      >
                        <Check size={13} aria-hidden="true" />
                        <span>{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          ) : (
            <div className="l-set-row">
              <span className="l-set-row-sub">在指定应用中自动暂停划词、全局热键或截图窗口候选。</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function AppPromptEditor({ value, onCommit }: { value: string; onCommit(next: string): void }) {
  const [text, setText] = useState(value);
  useEffect(() => {
    setText(value);
  }, [value]);
  return (
    <textarea
      className="l-textarea"
      rows={2}
      placeholder="输入在此应用划词时自动前置的背景提示词…"
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={() => {
        if (text !== value) onCommit(text);
      }}
    />
  );
}

/* ───────────────────────── Module 4: 翻译 ───────────────────────── */

const translationLanguages: readonly (readonly [TranslationLang, string])[] = [
  ['auto', '中 ⇄ 英自动'],
  ['zh', '简体中文'],
  ['en', 'English'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['fr', 'Français'],
  ['de', 'Deutsch']
];

const translationProviders: readonly (readonly [TranslationProvider, string])[] = [
  ['system', '内置极速'],
  ['deepl', 'DeepL'],
  ['google', 'Google'],
  ['llm', 'AI 大模型']
];

export function TranslationPane({
  translation,
  onOpenConnections,
  notify
}: {
  translation: TranslationSettings;
  onOpenConnections(): void;
  notify: NotifyFn;
}) {
  const [draft, setDraft] = useState(translation);
  useEffect(() => {
    setDraft(translation);
  }, [translation]);

  const activeProvider: TranslationProvider = draft.provider || (draft.connectionId && draft.model.trim() ? 'llm' : 'system');

  async function commit(next: TranslationSettings) {
    setDraft(next);
    const provider = next.provider || 'system';
    if (provider === 'llm' && (!next.connectionId || !next.model.trim())) return;
    if (provider === 'deepl' && !next.deeplApiKey?.trim()) return;
    const res = await window.desktop.saveTranslationSettings({ ...next, provider, model: next.model.trim() });
    if (res.error) notify({ error: res.error });
    else notify({ ok: true });
  }

  return (
    <>
      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>翻译引擎</span>
          <span className="r">供划词「翻译」、独立翻译浮窗、截图选字翻译与复制即译共用</span>
        </div>
        <div className="l-set-card">
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">首选引擎</div>
              <div className="l-set-row-sub">内置引擎免配置开箱即用；AI 大模型支持流式地道润色</div>
            </div>
            <Segmented
              label="翻译引擎"
              value={activeProvider}
              options={translationProviders}
              onChange={provider => void commit({ ...draft, provider })}
            />
          </div>

          <AnimatePresence initial={false}>
            {activeProvider === 'deepl' && (
              <motion.div key="tr-deepl" className="l-set-collapse" {...collapse}>
                <div className="l-set-row col">
                  <div className="l-field">
                    <label htmlFor="translation-deepl-key">DeepL API Key 或 DeepLX 接口地址</label>
                    <input
                      id="translation-deepl-key"
                      className="l-input mono"
                      type="password"
                      autoComplete="off"
                      placeholder="输入官方 DeepL Key 或完整 DeepLX /translate 地址"
                      value={draft.deeplApiKey || ''}
                      onChange={e => setDraft({ ...draft, provider: 'deepl', deeplApiKey: e.target.value })}
                      onBlur={() => void commit({ ...draft, provider: 'deepl' })}
                    />
                  </div>
                </div>
              </motion.div>
            )}

            {activeProvider === 'google' && (
              <motion.div key="tr-google" className="l-set-collapse" {...collapse}>
                <div className="l-set-row col">
                  <div className="l-field">
                    <label htmlFor="translation-google-key">Google Cloud API Key（可选，留空走免配置极速通道）</label>
                    <input
                      id="translation-google-key"
                      className="l-input mono"
                      type="password"
                      autoComplete="off"
                      placeholder="留空直接使用内置 Google 翻译，或填入 Cloud Translation Key"
                      value={draft.googleApiKey || ''}
                      onChange={e => setDraft({ ...draft, provider: 'google', googleApiKey: e.target.value })}
                      onBlur={() => void commit({ ...draft, provider: 'google' })}
                    />
                  </div>
                </div>
              </motion.div>
            )}

            {activeProvider === 'llm' && (
              <motion.div key="tr-llm" className="l-set-collapse" {...collapse}>
                <div className="l-set-row col">
                  <ApiConnectionBindingFields
                    connectionId={draft.connectionId}
                    model={draft.model}
                    modelId="translation-llm-model"
                    modelPlaceholder="deepseek-chat / gpt-4.1-mini"
                    label="流式翻译模型"
                    onOpenConnections={onOpenConnections}
                    onChange={({ connectionId, model }) => void commit({ ...draft, provider: 'llm', connectionId, model })}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">默认目标语言</div>
            </div>
            <SelectBox
              label="默认翻译目标语言"
              compact
              value={draft.targetLang}
              options={translationLanguages}
              onChange={targetLang => void commit({ ...draft, targetLang })}
            />
          </div>
        </div>
      </div>

      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>复制即译</span>
        </div>
        <div className="l-set-card">
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">启用复制即译</div>
              <div className="l-set-row-sub">在 PDF、终端等不便直接划词的应用中复制文字后自动弹出翻译窗（自动跳过密码软件）</div>
            </div>
            <Switch
              label="复制即译"
              value={draft.copyTranslateEnabled}
              change={() => void commit({ ...draft, copyTranslateEnabled: !draft.copyTranslateEnabled })}
            />
          </div>
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">触发手势</div>
            </div>
            <Segmented
              label="复制即译触发方式"
              value={draft.copyTranslateTrigger}
              onChange={copyTranslateTrigger => void commit({ ...draft, copyTranslateTrigger })}
              options={[
                ['double-cmd-c', '连按两次 ⌘C'],
                ['every-copy', '每次复制']
              ]}
            />
          </div>
        </div>
      </div>
    </>
  );
}

/* ───────────────────────── Module 7: 桌面套件 ───────────────────────── */

export function DesktopSuitePane({ state, notify }: { state: ShellState; notify: NotifyFn }) {
  const { settings } = state;

  async function saveSuite(patch: Partial<SuiteSettings>) {
    const res = await window.desktop.saveSuiteSettings(patch);
    if (res.error) notify({ error: res.error });
    else notify({ ok: true });
  }

  const prefs = settings.nookPrefs;

  return (
    <>
      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>顶部刘海岛与 Nook 提醒</span>
          <span className="r">
            <button type="button" className="l-text-btn" onClick={() => void window.desktop.act('open-island-board')}>
              展开专注看板 →
            </button>
          </span>
        </div>
        <div className="l-set-card">
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">启用顶部刘海岛</div>
              <div className="l-set-row-sub">平时无事项自动隐藏；有专注任务、番茄钟或提醒时显现（按住 ⌘ 点击穿透）</div>
            </div>
            <Switch
              label="启用顶部刘海岛"
              value={settings.notchIslandEnabled}
              change={() => void saveSuite({ notchIslandEnabled: !settings.notchIslandEnabled })}
            />
          </div>
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">接收 Nook 待办与紧迫提醒</div>
            </div>
            <Switch
              label="Nook 提醒总开关"
              value={prefs.enabled}
              change={() => void saveSuite({ nookPrefs: { ...prefs, enabled: !prefs.enabled } })}
            />
          </div>
          <AnimatePresence initial={false}>
            {prefs.enabled && (
              <motion.div key="nook-sub" className="l-set-collapse" {...collapse}>
                {(
                  [
                    ['tasks', '日程与 Google Tasks 待办提醒'],
                    ['hubAttention', 'Nook Hub 状态告警'],
                    ['aiResets', 'AI 订阅额度重置提醒'],
                    ['localAndCustom', '本机守护进程与自定义定时提醒']
                  ] as const
                ).map(([key, label]) => (
                  <div className="l-set-row" key={key}>
                    <div className="l-set-row-main">
                      <div className="l-set-row-name">{label}</div>
                    </div>
                    <Switch
                      label={label}
                      value={prefs[key]}
                      change={() => void saveSuite({ nookPrefs: { ...prefs, [key]: !prefs[key] } })}
                    />
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>窗口拖拽磁吸分屏</span>
          <span className="r">自动避让底部与左右程序坞（Dock）</span>
        </div>
        <div className="l-set-card">
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">鼠标拖动窗口至边缘／四角分屏</div>
              <div className="l-set-row-sub">左右边缘即时触发半屏；上边缘最大化与下边缘 1/3 · 2/3 屏需停顿防误触</div>
            </div>
            <Switch
              label="鼠标拖拽分屏"
              value={settings.windowDragSnap}
              change={() => void saveSuite({ windowDragSnap: !settings.windowDragSnap })}
            />
          </div>
          <AnimatePresence initial={false}>
            {settings.windowDragSnap && (
              <motion.div key="snap-dwell" className="l-set-collapse" {...collapse}>
                <div className="l-set-row">
                  <div className="l-set-row-main">
                    <div className="l-set-row-name">上／下边缘停顿触发时长</div>
                  </div>
                  <Segmented
                    label="边缘停顿时长"
                    value={String(settings.snapDwellMs || 250)}
                    onChange={v => void saveSuite({ snapDwellMs: Number(v) })}
                    options={[
                      ['150', '150 ms'],
                      ['250', '250 ms'],
                      ['400', '400 ms']
                    ]}
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">一键排列当前双窗口</div>
            </div>
            <div className="l-row">
              <button type="button" className="l-btn small" onClick={() => void window.desktop.act('snap-coding-ai')}>
                2:1 双栏
              </button>
              <button type="button" className="l-btn small" onClick={() => void window.desktop.act('snap-equal-split')}>
                1:1 双栏
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>访达动作面板</span>
          <span className="r">
            <button type="button" className="l-text-btn" onClick={() => void window.desktop.act('open-finder-panel')}>
              唤起面板 →
            </button>
          </span>
        </div>
        <div className="l-set-card">
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">在访达窗口内单击鼠标中键唤起</div>
            </div>
            <Switch
              label="访达中键唤起"
              value={settings.finderTriggers.middleClick}
              change={() => void saveSuite({ finderTriggers: { ...settings.finderTriggers, middleClick: !settings.finderTriggers.middleClick } })}
            />
          </div>
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">在访达窗口内长按鼠标右键唤起</div>
            </div>
            <Switch
              label="访达长按右键唤起"
              value={settings.finderTriggers.rightHold}
              change={() => void saveSuite({ finderTriggers: { ...settings.finderTriggers, rightHold: !settings.finderTriggers.rightHold } })}
            />
          </div>
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">默认终端</div>
            </div>
            <Segmented
              label="默认终端"
              value={settings.finderTerminal}
              onChange={(finderTerminal: FinderTerminalApp) => void saveSuite({ finderTerminal })}
              options={[
                ['Terminal', 'Terminal'],
                ['Ghostty', 'Ghostty'],
                ['Warp', 'Warp'],
                ['iTerm', 'iTerm']
              ]}
            />
          </div>
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">默认代码编辑器</div>
            </div>
            <Segmented
              label="默认编辑器"
              value={settings.finderEditor}
              onChange={(finderEditor: FinderEditorApp) => void saveSuite({ finderEditor })}
              options={[
                ['Cursor', 'Cursor'],
                ['VSCode', 'VS Code'],
                ['Zed', 'Zed']
              ]}
            />
          </div>
        </div>
      </div>

      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>剪贴板历史与浮动便签</span>
        </div>
        <div className="l-set-card">
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">剪贴板历史最大保留条数</div>
              <div className="l-set-row-sub">收藏条目永久保留，不随清空历史删除</div>
            </div>
            <Segmented
              label="剪贴板保留条数"
              value={String(settings.clipboardMaxItems || 200)}
              onChange={v => void saveSuite({ clipboardMaxItems: Number(v) })}
              options={[
                ['100', '100 条'],
                ['200', '200 条'],
                ['500', '500 条']
              ]}
            />
          </div>
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">浮动便签存储目录</div>
              <div className="l-set-row-sub mono">~/Documents/LassoNotes</div>
            </div>
            <button type="button" className="l-btn small" onClick={() => void window.desktop.act('toggle-edge-notes')}>
              打开便签
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/* ───────────────────────── Module 8: 快捷键与同步 ───────────────────────── */

const shortcutGroups: { title: string; ids: GlobalActionId[] }[] = [
  {
    title: '常用入口',
    ids: ['open-launcher', 'open-translator', 'open-clipboard-history', 'toggle-notes', 'open-finder-panel']
  },
  {
    title: '截图与贴图',
    ids: ['area', 'rect', 'window', 'screen', 'front', 'scroll-capture', 'repeat-last', 'delay-3s', 'delay-5s', 'delay-10s', 'pin-clipboard']
  },
  {
    title: '窗口分屏与多显示器',
    ids: [
      'snap-left-half',
      'snap-right-half',
      'snap-maximize',
      'snap-center',
      'snap-left-third',
      'snap-center-third',
      'snap-right-third',
      'snap-left-two-thirds',
      'snap-right-two-thirds',
      'snap-coding-ai',
      'snap-equal-split',
      'snap-prev-display',
      'snap-next-display'
    ]
  }
];

function ShortcutRow({
  id,
  label,
  value,
  local = false,
  save,
  notify
}: {
  id: string;
  label: string;
  value: string;
  local?: boolean;
  save: (shortcut: string) => Promise<{ error: string | null }>;
  notify: NotifyFn;
}) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function commit(next: string) {
    setRecording(false);
    setSaving(true);
    try {
      const res = await save(next);
      setError(res.error || '');
      if (res.error) notify({ error: res.error });
      else notify({ ok: true });
    } catch (reason) {
      const msg = String(reason);
      setError(msg);
      notify({ error: msg });
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      setRecording(false);
      return;
    }
    if (event.repeat || ['Meta', 'Alt', 'Control', 'Shift'].includes(event.key)) return;
    const modifiers = [event.metaKey && 'Command', event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean);
    const code = event.code
      .replace(/^(Key|Digit|Arrow)/, '')
      .replace(/^Backquote$/, 'Backtick')
      .replace(/^NumpadEnter$/, 'Enter');
    const shortcut = [...modifiers, code].join('+');
    if (!local && !isValidShortcut(shortcut)) {
      setError('支持 F1–F24 单键，其他按键请搭配 ⌘、⌥、⌃ 或 ⇧');
      return;
    }
    void commit(shortcut);
  }

  return (
    <div className="l-set-row">
      <div className="l-set-row-main">
        <div className="l-set-row-name">{label}</div>
        {error && <div className="l-set-row-sub l-danger">{error}</div>}
      </div>
      <button
        id={id}
        type="button"
        className={'l-btn small' + (recording ? ' primary' : '')}
        disabled={saving}
        aria-label={`${label}快捷键：${value ? shortcutLabel(value) : '未绑定'}，点击录制`}
        onClick={() => {
          setRecording(!recording);
          setError('');
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setRecording(false)}
      >
        {recording ? '按下快捷键…' : <span className="mono">{value ? shortcutLabel(value) : '未绑定'}</span>}
      </button>
      {value && !recording && (
        <button
          type="button"
          className="l-icon small"
          disabled={saving}
          aria-label={'清空绑定 ' + label}
          title="清空解绑"
          onClick={() => void commit('')}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

const webdavInput = (value: WebDavConfig): WebDavConfigInput => ({
  enabled: value.enabled,
  url: value.url,
  remotePath: value.remotePath,
  username: value.username,
  autoSync: value.autoSync
});

const syncLabels = {
  idle: '等待同步',
  syncing: '正在同步…',
  synced: '已同步',
  conflict: '发现配置冲突，请选择方向',
  offline: '暂时离线',
  error: '同步失败'
};

function ConfigSyncSection({ notify }: { notify: NotifyFn }) {
  const [config, setConfig] = useState<WebDavConfig | null>(null);
  const [draft, setDraft] = useState<WebDavConfigInput | null>(null);
  const [password, setPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<'push' | 'pull' | 'import' | null>(null);

  async function refresh() {
    const next = await window.desktop.webdavConfig();
    setConfig(next);
    setDraft(webdavInput(next));
  }

  // On-demand read on mount only — NO 3-second polling!
  useEffect(() => {
    let active = true;
    void window.desktop.webdavConfig().then(
      next => {
        if (active) {
          setConfig(next);
          setDraft(webdavInput(next));
        }
      },
      reason => {
        if (active) setError(String(reason));
      }
    );
    return () => {
      active = false;
    };
  }, []);

  async function commitWebdav(nextDraft: WebDavConfigInput, pwd = password, clr = clearPassword) {
    setDraft(nextDraft);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const next = await window.desktop.saveWebdavConfig({
        ...nextDraft,
        ...(pwd ? { password: pwd } : {}),
        ...(clr ? { clearPassword: true } : {})
      });
      setConfig(next);
      setDraft(webdavInput(next));
      if (pwd || clr) {
        setPassword('');
        setClearPassword(false);
      }
      notify({ ok: true });
    } catch (reason) {
      const msg = String(reason);
      setError(msg);
      notify({ error: msg });
    } finally {
      setBusy(false);
    }
  }

  async function sync(direction: WebDavSyncDirection) {
    setBusy(true);
    setError('');
    setNotice('');
    setConfirm(null);
    try {
      const result = await window.desktop.syncWebdav(direction);
      setConfig(result.state);
      if (result.error) {
        setError(result.error);
        notify({ error: result.error });
      } else {
        setNotice(result.state.status === 'synced' ? '配置已同步' : '');
        notify({ ok: true });
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function transfer(direction: 'export' | 'import') {
    setBusy(true);
    setError('');
    setNotice('');
    setConfirm(null);
    try {
      if (direction === 'export') {
        const res = await window.desktop.exportConfig();
        if (res.error) throw Error(res.error);
        if (res.path) setNotice('已导出至：' + res.path);
      } else {
        const res = await window.desktop.importConfig();
        if (res.error) throw Error(res.error);
        setNotice('已导入配置');
        await refresh();
      }
      notify({ ok: true });
    } catch (reason) {
      const msg = String(reason);
      setError(msg);
      notify({ error: msg });
    } finally {
      setBusy(false);
    }
  }

  const syncing = busy || config?.status === 'syncing';
  const disabledSync = syncing || !config?.enabled;

  return (
    <>
      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>本地配置包迁移</span>
          <span className="r">含偏好设置、快捷键与预设；不含密钥与本机路径</span>
        </div>
        <div className="l-set-card">
          <div className="l-set-row">
            <div className="l-set-row-main">
              <div className="l-set-row-name">导出或导入 JSON 配置文件</div>
            </div>
            <button type="button" className="l-btn small" disabled={syncing} onClick={() => void transfer('export')}>
              <Upload size={13} />
              <span>导出配置</span>
            </button>
            <button
              type="button"
              className={confirm === 'import' ? 'l-btn small primary' : 'l-btn small'}
              disabled={syncing}
              onClick={() => (confirm === 'import' ? void transfer('import') : setConfirm('import'))}
            >
              <Download size={13} />
              <span>{confirm === 'import' ? '确认选择并覆盖' : '导入配置'}</span>
            </button>
          </div>
        </div>
      </div>

      <div className="l-set-group">
        <div className="l-set-lbl">
          <span>WebDAV 云同步</span>
          <span className="r">
            <button type="button" className="l-text-btn" disabled={syncing} onClick={() => void refresh()}>
              <RefreshCw size={12} />
              <span>刷新状态</span>
            </button>
          </span>
        </div>
        <div className="l-set-card">
          {draft ? (
            <>
              <div className="l-set-row">
                <div className="l-set-row-main">
                  <div className="l-set-row-name">启用 WebDAV 同步</div>
                  <div className="l-set-row-sub">密码仅加密保存在本机安全存储中</div>
                </div>
                <Switch
                  label="启用 WebDAV 同步"
                  value={draft.enabled}
                  disabled={syncing}
                  change={() => void commitWebdav({ ...draft, enabled: !draft.enabled })}
                />
              </div>

              <div className="l-set-row col">
                <div className="l-grid-2">
                  <div className="l-field">
                    <label htmlFor="webdav-url">服务器地址</label>
                    <input
                      id="webdav-url"
                      className="l-input mono"
                      placeholder="https://nas.example.com/webdav"
                      value={draft.url}
                      disabled={syncing}
                      onChange={e => setDraft({ ...draft, url: e.target.value })}
                      onBlur={() => void commitWebdav(draft)}
                    />
                  </div>
                  <div className="l-field">
                    <label htmlFor="webdav-remotePath">远端路径</label>
                    <input
                      id="webdav-remotePath"
                      className="l-input mono"
                      placeholder="Lasso/config.json"
                      value={draft.remotePath}
                      disabled={syncing}
                      onChange={e => setDraft({ ...draft, remotePath: e.target.value })}
                      onBlur={() => void commitWebdav(draft)}
                    />
                  </div>
                  <div className="l-field">
                    <label htmlFor="webdav-username">用户名</label>
                    <input
                      id="webdav-username"
                      className="l-input mono"
                      value={draft.username}
                      disabled={syncing}
                      onChange={e => setDraft({ ...draft, username: e.target.value })}
                      onBlur={() => void commitWebdav(draft)}
                    />
                  </div>
                  <div className="l-field">
                    <div className="l-field-row">
                      <label htmlFor="webdav-password">密码</label>
                      {config?.hasPassword && (
                        <button
                          type="button"
                          className="l-text-btn"
                          onClick={() => void commitWebdav(draft, '', !clearPassword)}
                        >
                          {clearPassword ? '取消清除' : '清除密码'}
                        </button>
                      )}
                    </div>
                    <input
                      id="webdav-password"
                      type="password"
                      autoComplete="new-password"
                      className="l-input"
                      value={password}
                      disabled={syncing}
                      placeholder={config?.hasPassword ? '已加密保存 · 留空不修改' : '输入 WebDAV 密码'}
                      onChange={e => setPassword(e.target.value)}
                      onBlur={() => {
                        if (password) void commitWebdav(draft, password, false);
                      }}
                    />
                  </div>
                </div>
              </div>

              <div className="l-set-row">
                <div className="l-set-row-main">
                  <div className="l-set-row-name">本地修改后自动防抖推送</div>
                  <div className="l-set-row-sub">无后台定时轮询；仅在本机配置变更时防抖同步</div>
                </div>
                <Switch
                  label="WebDAV 自动同步"
                  value={draft.autoSync}
                  disabled={syncing}
                  change={() => void commitWebdav({ ...draft, autoSync: !draft.autoSync })}
                />
              </div>

              <div className="l-set-row">
                <div className="l-set-row-main">
                  <div className="l-set-row-name">{config?.enabled ? syncLabels[config.status ?? 'idle'] : 'WebDAV 未启用'}</div>
                  <div className="l-set-row-sub">
                    {config?.lastSyncedAt ? '上次同步：' + new Date(config.lastSyncedAt).toLocaleString('zh-CN') : '尚无同步记录'}
                    {config?.message ? ` · ${config.message}` : ''}
                  </div>
                </div>
                <div className="l-row">
                  <button
                    type="button"
                    className={confirm === 'push' ? 'l-btn small primary' : 'l-btn small'}
                    disabled={disabledSync}
                    onClick={() => (confirm === 'push' ? void sync('push') : setConfirm('push'))}
                  >
                    {confirm === 'push' ? '确认上传覆盖' : config?.status === 'conflict' ? '采用本机' : '上传'}
                  </button>
                  <button
                    type="button"
                    className={confirm === 'pull' ? 'l-btn small primary' : 'l-btn small'}
                    disabled={disabledSync}
                    onClick={() => (confirm === 'pull' ? void sync('pull') : setConfirm('pull'))}
                  >
                    {confirm === 'pull' ? '确认拉取覆盖' : config?.status === 'conflict' ? '采用远端' : '拉取'}
                  </button>
                  <button type="button" className="l-btn small" disabled={disabledSync} onClick={() => void sync('auto')}>
                    检查同步
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="l-set-row">
              <span className="l-set-row-sub">正在读取同步状态…</span>
            </div>
          )}
        </div>
      </div>

      {error && (
        <p className="l-field-help l-danger" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="l-field-help" role="status">
          {notice}
        </p>
      )}
    </>
  );
}

const shortcutsTabs = [
  ['shortcuts', '全局与局部快捷键'],
  ['sync', '配置同步与迁移']
] as const;

export function ShortcutsSyncPane({ state, notify }: { state: ShellState; notify: NotifyFn }) {
  const { settings } = state;
  const [sub, setSub] = useSubNav<(typeof shortcutsTabs)[number][0]>('shortcuts');

  async function saveEditorShortcut(action: EditorActionId, shortcut: string) {
    const next = { ...settings.editorShortcuts, [action]: shortcut };
    const error = validateEditorShortcuts(next);
    return error ? { error } : window.desktop.saveEditorShortcuts(next);
  }

  return (
    <>
      <SubNav scope="shortcuts" label="快捷键与同步分类" value={sub} options={shortcutsTabs} onChange={setSub} />

      <SubPane scope="shortcuts" id="shortcuts" active={sub === 'shortcuts'}>
        <p className="l-field-help">点击任意按键胶囊即可录制；按 Esc 取消录制；点击右侧 × 永久清空解绑，重启也不会恢复默认。</p>

        {shortcutGroups.map(group => (
          <div className="l-set-group" key={group.title}>
            <div className="l-set-lbl">
              <span>{group.title}</span>
            </div>
            <div className="l-set-card">
              {group.ids.map(action => (
                <ShortcutRow
                  key={action}
                  id={'shortcut-' + action}
                  label={globalActionLabels[action]}
                  value={settings.actionShortcuts[action] || ''}
                  save={shortcut => window.desktop.saveActionShortcut(action, shortcut)}
                  notify={notify}
                />
              ))}
            </div>
          </div>
        ))}

        <div className="l-set-group">
          <div className="l-set-lbl">
            <span>截图编辑器局部快捷键</span>
            <span className="r">仅在截图与贴图编辑时生效，支持单键</span>
          </div>
          <div className="l-set-card">
            {editorActionIds.map(action => (
              <ShortcutRow
                key={action}
                id={'editor-shortcut-' + action}
                label={editorActionLabels[action]}
                value={settings.editorShortcuts[action]}
                local
                save={shortcut => saveEditorShortcut(action, shortcut)}
                notify={notify}
              />
            ))}
          </div>
        </div>
      </SubPane>

      <SubPane scope="shortcuts" id="sync" active={sub === 'sync'}>
        <ConfigSyncSection notify={notify} />
      </SubPane>
    </>
  );
}
