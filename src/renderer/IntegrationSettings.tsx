import { useEffect, useState } from 'react';
import { AppWindow, Check } from 'lucide-react';
import type { Settings, AppPrompt, LocalTarget } from '../shared/contracts';
import { targetLabels } from '../shared/contracts';

/** Both sections save local CLI paths and app rules together, so the save bar compares against the stored pair. */
export function IntegrationSettings({ settings, section }: { settings: Settings; section: 'local' | 'apps' }) {
  const [local, setLocal] = useState(() => structuredClone(settings.local));
  const [rules, setRules] = useState(() => structuredClone(settings.appPrompts));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const dirty = JSON.stringify({ local, rules }) !== JSON.stringify({ local: settings.local, rules: settings.appPrompts });
  const edited = () => { setSaved(false); setError(''); };
  const update = (index: number, patch: Partial<AppPrompt>) => { setRules(rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule)); edited(); };
  const setPath = (target: LocalTarget, patch: Partial<Settings['local'][LocalTarget]>) => { setLocal({ ...local, [target]: { ...local[target], ...patch } }); edited(); };
  async function addApp() {
    try { const choice = await window.desktop.choosePath('application'); if (choice?.bundleId) { setRules([...rules, { bundleId: choice.bundleId, name: choice.name || '', prompt: '', enabled: true }]); edited(); } }
    catch (error) { setError(String(error)); }
  }
  async function choose(target: LocalTarget, field: 'executable' | 'cwd') {
    const path = await window.desktop.choosePath(field === 'cwd' ? 'directory' : 'executable');
    if (path) setPath(target, { [field]: path.path });
  }
  async function save() { const r = await window.desktop.saveIntegrations({ local, appPrompts: rules }); setError(r.error || ''); setSaved(!r.error); }
  return <>
    <div className="l-set-body">
      {section === 'local' ? <>
        {(['codex', 'pi'] as const).map(target => <div className="l-set-section" key={target}>
          <div className="l-set-row-head"><h3>{targetLabels[target]}</h3></div>
          <ul className="l-group"><li className="col">
            <div className="l-field"><label htmlFor={'exec-' + target}>可执行文件（绝对路径）</label>
              <div className="l-row"><input id={'exec-' + target} className="l-input mono" value={local[target].executable} placeholder={`/opt/homebrew/bin/${target}`} spellCheck={false} onChange={e => setPath(target, { executable: e.target.value })} /><button className="l-btn" onClick={() => void choose(target, 'executable')}>选择…</button></div></div>
            <div className="l-field"><label htmlFor={'cwd-' + target}>默认工作目录</label>
              <div className="l-row"><input id={'cwd-' + target} className="l-input mono" value={local[target].cwd} spellCheck={false} onChange={e => setPath(target, { cwd: e.target.value })} /><button className="l-btn" onClick={() => void choose(target, 'cwd')}>选择…</button></div></div>
          </li></ul>
        </div>)}
        <p className="l-field-help">沿用 CLI 自己的登录、模型、MCP、Skills 与扩展。GUI 不读取终端的 PATH，所以需要绝对路径。目录只影响新任务；单次任务可在指令面板里临时选择。</p>
      </> : <>
        <p className="l-field-help l-lead">只给来自这个应用的划词补充背景，放在预设内容之前，只注入一次。没有选区、图片和后续追问不会注入。</p>
        {rules.map((rule, i) => <ul className="l-group" key={i}><li className="col">
          <div className="l-row">
            <AppIcon bundleId={rule.bundleId} />
            <div className="l-row-label">
              <input className="l-inline-input" aria-label="应用名称" placeholder="应用名称" value={rule.name} onChange={e => update(i, { name: e.target.value })} />
              <input className="l-inline-input mono" aria-label="应用 bundle ID" placeholder="com.example.app" value={rule.bundleId} spellCheck={false} onChange={e => update(i, { bundleId: e.target.value })} />
            </div>
            <button className="l-switch" role="switch" aria-checked={rule.enabled} aria-label={'启用 ' + (rule.name || '这条规则')} onClick={() => update(i, { enabled: !rule.enabled })}><span /></button>
          </div>
          <textarea className="l-textarea l-textarea-short" aria-label={`${rule.name} 的背景提示词`} placeholder="例如：选中文字来自工作沟通，请保留人物、日期和待办事项。" value={rule.prompt} onChange={e => update(i, { prompt: e.target.value })} />
          <button className="l-text-btn l-danger l-end" onClick={() => { setRules(rules.filter((_, n) => n !== i)); edited(); }}>删除</button>
        </li></ul>)}
        <div className="l-row"><button className="l-btn" onClick={() => void addApp()}>选择应用…</button><button className="l-btn" onClick={() => { setRules([...rules, { name: '', bundleId: '', prompt: '', enabled: true }]); edited(); }}>手动填写 bundle ID</button></div>
      </>}
    </div>
    {(dirty || saved || error) && <div className="l-save-bar" role="status">
      {error ? <span className="l-danger">{error}</span> : saved && !dirty ? <span className="l-ok"><Check size={14} />已保存</span> : '有未保存的更改'}
      <span className="push" />
      {dirty && <><button className="l-btn small" onClick={() => { setLocal(structuredClone(settings.local)); setRules(structuredClone(settings.appPrompts)); edited(); }}>放弃</button><button className="l-btn small primary" onClick={() => void save()}>保存</button></>}
    </div>}
  </>;
}

function AppIcon({ bundleId }: { bundleId: string }) {
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    let active = true; setIcon(null);
    void window.desktop.appIcon(bundleId).then(value => { if (active) setIcon(value); }, () => { if (active) setIcon(null); });
    return () => { active = false; };
  }, [bundleId]);
  return <span className="l-app-icon" aria-hidden="true">{icon ? <img src={icon} alt="" /> : <AppWindow size={20} />}</span>;
}
