import { useState } from 'react';
import type { Settings, AppPrompt } from '../shared/contracts';
export function IntegrationSettings({ settings, section }: { settings: Settings; section: 'local' | 'apps' }) {
  const [local, setLocal] = useState(() => structuredClone(settings.local));
  const [rules, setRules] = useState(() => structuredClone(settings.appPrompts));
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const update = (index: number, patch: Partial<AppPrompt>) => { setRules(rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule)); setMessage(''); };
  async function addApp() {
    try { const choice = await window.desktop.choosePath('application'); if (choice?.bundleId) setRules([...rules, { bundleId: choice.bundleId, name: choice.name || '', prompt: '', enabled: true }]); }
    catch (error) { setError(String(error)); }
  }
  async function save() { const r = await window.desktop.saveIntegrations({ local, appPrompts: rules }); setError(r.error || ''); setMessage(r.error ? '' : '已保存'); }
  return <section className="integration-settings">
    {section === 'local' ? <>{(['codex', 'pi'] as const).map(target => <div className="setting-section" key={target}>
      <h2>{target === 'codex' ? 'Codex' : 'Pi'}</h2><label>CLI 可执行文件</label><div className="path-field"><input value={local[target].executable} onChange={e => setLocal({ ...local, [target]: { ...local[target], executable: e.target.value } })} /><button onClick={async () => { const path = await window.desktop.choosePath('executable'); if (path) setLocal({ ...local, [target]: { ...local[target], executable: path.path } }); }}>选择</button></div>
      <label>默认工作目录</label><div className="path-field"><input value={local[target].cwd} onChange={e => setLocal({ ...local, [target]: { ...local[target], cwd: e.target.value } })} /><button onClick={async () => { const path = await window.desktop.choosePath('directory'); if (path) setLocal({ ...local, [target]: { ...local[target], cwd: path.path } }); }}>选择</button></div>
    </div>)}<p className="description">沿用 CLI 已有登录、模型、MCP、Skills 与扩展。目录修改只影响新任务，也可从新对话菜单临时选择目录。</p></>
      : <><p className="description">只为来自这个应用的划词补充背景；无选区、剪贴板图片和后续追问不会自动注入。</p>
        {rules.map((rule, i) => <div className="app-rule" key={i}><div className="setting-row"><input aria-label="应用名称" value={rule.name} onChange={e => update(i, { name: e.target.value })} /><button className="text-button" onClick={() => setRules(rules.filter((_, n) => n !== i))}>删除</button></div>
          <input aria-label="应用 bundle ID" placeholder="com.example.app" value={rule.bundleId} onChange={e => update(i, { bundleId: e.target.value })} />
          <textarea aria-label={`${rule.name} 的额外提示词`} placeholder="例如：选中文字来自工作沟通，请保留人物、日期和待办事项。" rows={4} value={rule.prompt} onChange={e => update(i, { prompt: e.target.value })} />
          <label className="check-label"><input type="checkbox" checked={rule.enabled} onChange={e => update(i, { enabled: e.target.checked })} />启用</label>
        </div>)}<button className="record" onClick={() => void addApp()}>选择应用…</button><button className="text-button" onClick={() => setRules([...rules, { name: '', bundleId: '', prompt: '', enabled: true }])}>手动添加</button></>}
    {error && <p className="error">{error}</p>}<div className="save-row"><button className="primary" onClick={() => void save()}>保存</button><span className="saved">{message}</span></div>
  </section>;
}
