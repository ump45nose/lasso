import { useEffect, useRef, useState } from 'react';
import type { ExecutionCatalog, ExecutionProfile, Target } from '../shared/contracts';
import { sameWebEffortLabel } from '../shared/web-effort';

export function ExecutionFields({ target, profile, update }: { target: Target; profile: ExecutionProfile; update(changes: ExecutionProfile): void }) {
  const [catalog, setCatalog] = useState<ExecutionCatalog | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const lastRefresh = useRef(0);
  useEffect(() => {
    let active = true;
    const force = lastRefresh.current !== refresh; lastRefresh.current = refresh;
    setLoading(true); setError(''); setCatalog(null);
    void window.desktop.executionCatalog(target, profile.model || '', force).then(result => {
      if (active) { setCatalog(result.catalog); setError(result.error || ''); setLoading(false); }
    }).catch(error => { if (active) { setError(String(error)); setLoading(false); } });
    return () => { active = false; };
  }, [target, profile.model, refresh]);
  const efforts = catalog?.effortOptions || catalog?.efforts.map(id => ({ id, label: id })) || [];
  const effort = efforts.find(option => option.id === profile.effort || (target === 'chatgpt' && sameWebEffortLabel(option.label, profile.effort || '', profile.model)))?.id || profile.effort || '';
  return <div className="l-field">
    <div className="l-pair">
      <div className="l-field"><label htmlFor="preset-model">模型</label>
        <select id="preset-model" className="l-select" value={profile.model || ''} onChange={e => update({ model: e.target.value, effort: '' })}>
          <option value="">跟随目标默认</option>
          {profile.model && !catalog?.models.some(m => m.id === profile.model) && <option value={profile.model}>{profile.model}{!loading ? '（待确认）' : ''}</option>}
          {catalog?.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}
        </select></div>
      <div className="l-field"><label htmlFor="preset-effort">思考强度</label>
        <select id="preset-effort" className="l-select" value={effort} onChange={e => update({ effort: e.target.value })}>
          <option value="">跟随目标默认</option>
          {effort && !efforts.some(option => option.id === effort) && <option value={effort}>{profile.effort?.startsWith('slider:') ? '已保存的网页档位' : profile.effort}（待确认）</option>}
          {efforts.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select></div>
    </div>
    <p className="l-field-help">{target === 'chatgpt' || target === 'gemini' ? '选项读取自当前登录的网页；网站没有独立思考选项时沿用默认。' : '选项读取自本机 CLI，不修改 CLI 全局配置。'}{!loading && catalog && !catalog.efforts.length && ' 当前未读取到独立思考档位。'}{' '}
      <button className="l-link l-link-sm" aria-label="刷新模型和思考强度选项" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{loading ? '读取中…' : '刷新选项'}</button></p>
    {error && <p className="l-field-help error" role="status">{error}</p>}
  </div>;
}
