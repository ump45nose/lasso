import { Check } from 'lucide-react';

export function SaveBar({ dirty, saved, error, pending = '有未保存的更改', saving, saveLabel = '保存', saveDisabled, discard, save }: { dirty: boolean; saved: boolean; error: string; pending?: string; saving?: boolean; saveLabel?: string; saveDisabled?: boolean; discard: () => void; save: () => void }) {
  if (!dirty && !saved && !error) return null;
  return <div className="l-save-bar" role="status">
    {error ? <span className="l-danger">{error}</span> : saved && !dirty ? <span className="l-ok"><Check size={14} />已保存</span> : pending}
    <span className="push" />
    {dirty && <><button className="l-btn small" disabled={saving} onClick={discard}>放弃</button><button className="l-btn small primary" disabled={saving || saveDisabled} onClick={save}>{saveLabel}</button></>}
  </div>;
}
