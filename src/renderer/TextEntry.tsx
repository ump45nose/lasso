import { useState } from 'react';
import { targetLabels, type Preset, type Target } from '../shared/contracts';
export function TextEntry({input,presets}:{input:{id:string;text:string};presets:Preset[]}){
  const [target,setTarget]=useState<Target|''>(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  return <section className="image-entry"><span className="eyebrow">图中所选文字</span><h1>这段文字，想问什么？</h1>
    <pre className="ocr-input-preview">{input.text}</pre><p className="hint">仅使用所选文字，不附带图片</p>
    <button className="text-button" onClick={()=>void window.desktop.removeText()}>移除</button>
    <label className="target-field">发送到 <select value={target} onChange={e=>setTarget(e.target.value as Target|'')}><option value="">沿用预设目标</option>{Object.entries(targetLabels).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
    <div className="quick-presets">{presets.filter(p=>p.enabled).map(p=><button disabled={busy} key={p.id} onClick={async()=>{setBusy(true);try{const result=await window.desktop.runPreset(p.id,{textId:input.id,...(target?{target}:{})});setError(result.error||'');}finally{setBusy(false);}}}>{p.name}<small> · {targetLabels[target||p.target]}{p.mode==='edit'?' · 先编辑':''}</small></button>)}</div>{error&&<p className="error">{error}</p>}
  </section>;
}
