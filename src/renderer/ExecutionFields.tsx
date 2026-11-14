import { useEffect, useRef, useState } from 'react';
import type { ExecutionCatalog, ExecutionProfile, WebTarget } from '../shared/contracts';
import { sameWebEffortLabel } from '../shared/web-effort';
import { SelectBox } from './motion';

export function ExecutionFields({ target, profile, update }: { target: WebTarget; profile: ExecutionProfile; update(changes: ExecutionProfile): void }) {
  const [catalog, setCatalog] = useState<ExecutionCatalog | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const lastRefresh = useRef(0);
  useEffect(() => {
    let active = true;
    const force = lastRefresh.current !== refresh;
    lastRefresh.current = refresh;
    setLoading(true);
    setError('');
    setCatalog(null);
    void window.desktop
      .executionCatalog(target, profile.model || '', force)
      .then(result => {
        if (active) {
          setCatalog(result.catalog);
          setError(result.error || '');
          setLoading(false);
        }
      })
      .catch(reason => {
        if (active) {
          setError(String(reason));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [target, profile.model, refresh]);
  const efforts = catalog?.effortOptions || catalog?.efforts.map(id => ({ id, label: id })) || [];
  const effort =
    efforts.find(option => option.id === profile.effort || (target === 'chatgpt' && sameWebEffortLabel(option.label, profile.effort || '', profile.model)))?.id ||
    profile.effort ||
    '';
  return (
    <div className="l-field">
      <div className="l-grid-equal">
        <div className="l-field">
          <label htmlFor="preset-model">模型</label>
          <SelectBox
            id="preset-model"
            label="模型"
            value={profile.model || ''}
            onChange={model => update({ model, effort: '' })}
            options={[
              { value: '', label: '跟随目标默认' },
              ...(profile.model && !catalog?.models.some(m => m.id === profile.model)
                ? [{ value: profile.model, label: `${profile.model}${!loading ? '（待确认）' : ''}` }]
                : []),
              ...(catalog?.models.map(model => ({ value: model.id, label: model.label })) ?? [])
            ]}
          />
        </div>
        <div className="l-field">
          <label htmlFor="preset-effort">思考强度</label>
          <SelectBox
            id="preset-effort"
            label="思考强度"
            value={effort}
            onChange={nextEffort => update({ effort: nextEffort })}
            options={[
              { value: '', label: '跟随目标默认' },
              ...(effort && !efforts.some(option => option.id === effort)
                ? [{ value: effort, label: `${profile.effort?.startsWith('slider:') ? '已保存的网页档位' : profile.effort}（待确认）` }]
                : []),
              ...efforts.map(option => ({ value: option.id, label: option.label }))
            ]}
          />
        </div>
      </div>
      <p className="l-field-help">
        选项读取自当前已登录网页；没有独立思考档位时沿用网页默认。
        {!loading && catalog && !catalog.efforts.length && ' 当前未读取到独立思考档位。'}{' '}
        <button type="button" className="l-text-btn" aria-label="刷新模型和思考强度选项" disabled={loading} onClick={() => setRefresh(value => value + 1)}>
          {loading ? '读取中…' : '刷新选项'}
        </button>
      </p>
      {error && (
        <p className="l-field-help l-danger" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
