import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Image, Maximize2, Minimize2, Minus, Pin, RotateCw, ScanLine, Search, Settings2 } from 'lucide-react';
import { targetLabels } from '../shared/contracts';
import type { Action, PaletteScope, Preset, ShellState, Target, TaskSummary } from '../shared/contracts';
import { Badge, isLocal, shortcutLabel, taskDot, taskStatus, targets } from './targets';
import { motion } from 'motion/react';
import { spring } from './motion';

const scrimMotion = { hidden: { opacity: 0, transition: { duration: 0.12 } }, shown: { opacity: 1, transition: { duration: 0.14 } } };
const panelMotion = { hidden: { opacity: 0, y: -6, scale: 0.98, transition: { duration: 0.12 } }, shown: { opacity: 1, y: 0, scale: 1, transition: spring } };

type Row = { key: string; label: string; disabled?: boolean } & (
  | { kind: 'preset'; preset: Preset }
  | { kind: 'task'; task: TaskSummary }
  | { kind: 'new'; target: Target; cwd?: boolean }
  | { kind: 'cmd'; icon: ReactNode; hint?: string; run: () => unknown; keepOpen?: boolean });

const close = () => window.desktop.closePalette();
const act = (action: Action) => () => window.desktop.act(action);

/** Main owns open/close (⌘K works while a web page has focus); this only renders and runs the chosen row. */
export function Palette({ state, scope, backdrop }: { state: ShellState; scope: PaletteScope; backdrop: string | null }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const [overrides, setOverrides] = useState<Record<string, Target>>({});
  const [error, setError] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const { selection, settings } = state;
  const rule = selection && settings.appPrompts.find(item => item.enabled && item.bundleId === selection.sourceApp);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (text: string) => !q || text.toLowerCase().includes(q);
    const out: { title: string; rows: Row[] }[] = [];
    if (scope === 'all') {
      const rows: Row[] = state.presets.filter(preset => preset.enabled && match(preset.name)).map(preset => ({ key: 'p-' + preset.id, kind: 'preset', preset, label: preset.name, disabled: preset.needsSelection && !selection }));
      if (rows.length) out.push({ title: '预设', rows });
    }
    if (scope !== 'new') {
      const rows: Row[] = state.tasks.filter(task => (scope === 'tasks' || task.id !== state.activeTaskId) && match(task.title)).map(task => ({ key: 't-' + task.id, kind: 'task', task, label: task.title }));
      if (rows.length) out.push({ title: scope === 'tasks' ? '全部任务' : '切换任务', rows });
    }
    if (scope !== 'tasks') {
      const rows: Row[] = [
        ...targets.map(target => ({ key: 'n-' + target, kind: 'new' as const, target, label: targetLabels[target] + ' 新对话' })),
        ...targets.filter(isLocal).map(target => ({ key: 'c-' + target, kind: 'new' as const, target, cwd: true, label: targetLabels[target] + ' · 选择工作目录…' }))
      ].filter(row => match(row.label));
      if (rows.length) out.push({ title: '新任务', rows });
    }
    if (scope === 'all') {
      const rows: Row[] = ([
        { key: 'shot', kind: 'cmd', icon: <ScanLine size={14} />, label: '截图', hint: settings.screenshotShortcut ? shortcutLabel(settings.screenshotShortcut) : undefined, run: act('screenshot') },
        { key: 'clip', kind: 'cmd', icon: <Image size={14} />, label: '使用剪贴板图片', run: () => window.desktop.readImage() },
        { key: 'pin', kind: 'cmd', icon: <Pin size={14} />, label: state.pinned ? '取消置顶' : '置顶小窗', run: act('pin'), keepOpen: true },
        ...(state.hasPage ? [{ key: 'reload', kind: 'cmd' as const, icon: <RotateCw size={14} />, label: isLocal(state.activeTarget) ? '恢复 CLI 会话' : '重新加载网页', run: act('reload') }] : []),
        { key: 'expand', kind: 'cmd', icon: state.expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />, label: state.expanded ? '还原小窗' : '放大到工作区', run: act('expand') },
        { key: 'hide', kind: 'cmd', icon: <Minus size={14} />, label: '隐藏小窗', hint: '⌘W', run: act('hide') },
        { key: 'settings', kind: 'cmd', icon: <Settings2 size={14} />, label: '设置…', hint: '⌘,', run: act('settings') }
      ] satisfies Row[]).filter(row => match(row.label));
      if (rows.length) out.push({ title: '图片与窗口', rows });
    }
    return out;
  }, [query, scope, state.presets, state.tasks, state.activeTaskId, state.pinned, state.expanded, state.hasPage, state.activeTarget, selection, settings.screenshotShortcut]);
  const flat = groups.flatMap(group => group.rows).filter(row => !row.disabled);
  const current = flat[Math.min(index, flat.length - 1)];
  useEffect(() => { setIndex(0); setError(''); }, [query, scope]);
  useEffect(() => { input.current?.focus(); }, [scope]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [index]);
  const targetOf = (preset: Preset) => overrides[preset.id] || preset.target;
  async function run(row: Row | undefined) {
    if (!row || row.disabled) return;
    setError('');
    if (row.kind === 'preset') {
      const target = targetOf(row.preset);
      const result = await window.desktop.runPreset(row.preset.id, target === row.preset.target ? {} : { target });
      if (result.error) setError(result.error);
    } else if (row.kind === 'task') await window.desktop.selectTask(row.task.id);
    else if (row.kind === 'new') {
      const cwd = row.cwd ? (await window.desktop.choosePath('directory'))?.path : undefined;
      if (row.cwd && !cwd) return;
      await window.desktop.newTask({ target: row.target, cwd });
    } else {
      if (!row.keepOpen) await close();
      await row.run();
    }
  }
  function key(event: React.KeyboardEvent) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); void close(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(i => (i + 1) % Math.max(1, flat.length)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(i => (i - 1 + flat.length) % Math.max(1, flat.length)); }
    else if (event.key === 'Enter') { event.preventDefault(); void run(current); }
    else if (event.key === 'Tab' && current?.kind === 'preset') {
      event.preventDefault();
      const preset = current.preset, at = targets.indexOf(targetOf(preset));
      setOverrides({ ...overrides, [preset.id]: targets[(at + (event.shiftKey ? targets.length - 1 : 1)) % targets.length] });
    }
  }
  return <motion.div className="l-pal-layer" initial="hidden" animate="shown" exit="hidden">
    {backdrop && <img className="l-backdrop" src={backdrop} alt="" />}
    <motion.div className="l-scrim" variants={scrimMotion} onClick={() => void close()} />
    <motion.div className="l-palette" role="dialog" aria-label="指令面板" variants={panelMotion}>
      <label className="l-pal-search"><Search size={16} />
        <input ref={input} aria-label="搜索预设、任务或指令" aria-controls="palette-list" aria-activedescendant={current ? 'pal-' + current.key : undefined}
          placeholder={scope === 'tasks' ? '搜索任务' : scope === 'new' ? '选择新任务的目标' : '搜索预设、任务或指令'} value={query} onChange={event => setQuery(event.target.value)} onKeyDown={key} spellCheck={false} />
        <span className="l-keycap">esc</span></label>
      {scope === 'all' && <div className="l-pal-ctx">{selection
        ? <><span className="l-mark">已选 <span className="mono">{selection.length.toLocaleString()}</span> 字</span><span>来自 {rule ? rule.name : selection.sourceApp || '未知应用'}{rule && ' · 已匹配应用背景'}</span></>
        : <span>没有选区 · 需要选区的预设暂不可用</span>}</div>}
      {error && <div className="l-pal-error" role="alert">{error}</div>}
      <div className="l-pal-list" id="palette-list" ref={list} role="listbox" aria-label="指令">
        {groups.map(group => <Fragment key={group.title}>
          <div className="l-pal-group" role="presentation">{group.title}</div>
          {group.rows.map(row => {
            const selected = row === current;
            return <button key={row.key} id={'pal-' + row.key} role="option" tabIndex={-1} className="l-pal-row" aria-selected={selected} disabled={row.disabled}
              onMouseEnter={() => !row.disabled && setIndex(flat.indexOf(row))} onClick={() => void run(row)}>
              {row.kind === 'task' && <><span className={'dot ' + taskDot(row.task)} aria-hidden="true" /><Badge target={row.task.target} /></>}
              {row.kind === 'new' && <Badge target={row.target} />}
              {row.kind === 'cmd' && <span className="l-pal-icon">{row.icon}</span>}
              <span className="l-pal-label">{row.label}</span>
              {row.kind === 'preset' && <PresetMeta preset={row.preset} target={targetOf(row.preset)} selected={selected} disabled={row.disabled} />}
              {row.kind === 'task' && <small className="push">{taskStatus(row.task)}</small>}
              {row.kind === 'cmd' && row.hint && <small className="push mono">{row.hint}</small>}
              {selected && <span className={'l-kbd' + (row.kind === 'new' || (row.kind === 'cmd' && !row.hint) ? ' push' : '')}>↵</span>}
            </button>;
          })}
        </Fragment>)}
        {!flat.length && <p className="l-pal-empty">{query ? `没有匹配「${query}」的预设或指令。` : '没有可用的项目。'}</p>}
      </div>
      <div className="l-pal-foot"><span><span className="mono">↑↓</span> 选择</span><span><span className="mono">↵</span> 运行</span>{scope === 'all' && <span><span className="mono">⇥</span> 临时换目标</span>}<span className="push"><span className="mono">⌘,</span> 设置</span></div>
    </motion.div>
  </motion.div>;
}
function PresetMeta({ preset, target, selected, disabled }: { preset: Preset; target: Target; selected: boolean; disabled?: boolean }) {
  const changed = target !== preset.target;
  return <>
    {selected ? <span className={'l-pal-target push' + (changed ? ' changed' : '')}>{targetLabels[target]}<kbd>⇥</kbd></span> : <small className="push">{targetLabels[target]}</small>}
    <small>{disabled ? '需要选区' : changed && (preset.model || preset.effort) ? '跟随目标默认' : preset.mode === 'edit' ? '先编辑' : '直接发送'}</small>
  </>;
}
