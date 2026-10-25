import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { LayoutGroup } from 'motion/react';
import { AppWindow, Monitor, ScanLine } from 'lucide-react';
import type { CaptureRect, CaptureWindow, RegionCandidate, ScreenshotAPI, ScreenshotState } from '../../shared/capture';
import { sameRegion } from '../../shared/capture';
import { Glide } from '../motion';
import './capture.css';
const Editor=lazy(()=>import('./Editor').then(module=>({default:module.Editor})));
declare global { interface Window { screenshot: ScreenshotAPI } }
const contains=(r:CaptureRect,x:number,y:number)=>x>=r.x&&y>=r.y&&x<r.x+r.width&&y<r.y+r.height;
const labels={window:'窗口',element:'界面区域',edge:'边缘区域',color:'同色区域',screen:'全屏'};
const box=(r:CaptureRect)=>({left:r.x,top:r.y,width:r.width,height:r.height});
type Mode='area'|'window';
export function Screenshot(){
  const [state,setState]=useState<ScreenshotState|null>(null),[point,setPoint]=useState({x:-1,y:-1}),[choice,setChoice]=useState<{region:RegionCandidate;x:number;y:number}|null>(null),[draft,setDraft]=useState<CaptureRect|null>(null),[error,setError]=useState(''),[picked,setPicked]=useState<Mode|null>(null);
  const gesture=useRef<{x:number;y:number;candidate:RegionCandidate|null;dragged:boolean}|null>(null);
  const mode:Mode=picked??state?.mode??'area';
  // Before the pointer moves, window mode highlights the frontmost window.
  const target:CaptureWindow|undefined=mode==='window'?(point.x<0?state?.windows?.[0]:state?.windows?.find(w=>contains(w,point.x,point.y))):undefined;
  const live=useRef({state,mode,target});live.current={state,mode,target};
  useEffect(()=>{const off=window.screenshot.onState(next=>setState(old=>({...old,...next}) as ScreenshotState));void window.screenshot.state().then(setState);return off;},[]);
  async function act(a:Parameters<ScreenshotAPI['action']>[0]){const r=await window.screenshot.action(a);setError(r.error||'');}
  async function grab(w:CaptureWindow,shadow:boolean){const r=await window.screenshot.captureWindow(w.id,shadow);setError(r.error||'');}
  const switchMode=(next:Mode)=>{setPicked(next);setChoice(null);setDraft(null);gesture.current=null;};
  useEffect(()=>{const key=(e:KeyboardEvent)=>{const {state:s,mode:m,target:t}=live.current;if(!s||s.phase==='result')return;
    if(e.key==='Escape'){e.preventDefault();void act('cancel');}
    else if(e.key.toLowerCase()==='f'&&!e.metaKey&&!e.ctrlKey){e.preventDefault();void act('screen');}
    else if(e.key===' '){e.preventDefault();switchMode(m==='area'?'window':'area');}
    else if(e.key==='Enter'&&m==='window'&&t){e.preventDefault();void grab(t,e.altKey);}
  };window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  if(!state)return null;
  // While the editor chunk loads, keep showing the frozen screen and the captured rectangle so nothing flashes.
  if(state.phase==='result'&&state.selection)return <Suspense fallback={<div className="cap">{state.backdrop&&<img className="cap-background" src={state.backdrop} draggable={false} alt=""/>}{state.placement&&<div className="cap-rect" style={box(state.placement)}/>}</div>}><Editor key={state.editId} state={state}/></Suspense>;
  const candidates=mode==='area'?state.candidates.filter(r=>contains(r,point.x,point.y)):[];
  // Keep the actual wheel-selected rectangle, not a list index that can change
  // when asynchronous AX/visual candidates arrive. Ignore incidental hand jitter.
  const candidate=choice&&contains(choice.region,point.x,point.y)?choice.region:candidates[0];
  const level=candidate?Math.max(0,candidates.findIndex(r=>sameRegion(r,candidate))):0;
  const selected=mode==='window'?target:draft||candidate;
  function down(e:React.PointerEvent){if((e.target as HTMLElement).closest('button'))return;e.preventDefault();if(mode==='window'){if(target)void grab(target,e.altKey);return;}gesture.current={x:e.clientX,y:e.clientY,candidate:candidate||null,dragged:false};e.currentTarget.setPointerCapture(e.pointerId);}
  function move(e:React.PointerEvent){
    const x=Math.max(0,Math.min(state!.width,e.clientX)),y=Math.max(0,Math.min(state!.height,e.clientY));setPoint({x,y});
    const g=gesture.current;if(!g){if(mode==='area'){if(choice&&(Math.hypot(x-choice.x,y-choice.y)>=5||!contains(choice.region,x,y)))setChoice(null);window.screenshot.hover(x,y);}return;}
    if(Math.hypot(x-g.x,y-g.y)>3)g.dragged=true;
    if(g.dragged)setDraft({x:Math.min(g.x,x),y:Math.min(g.y,y),width:Math.abs(x-g.x),height:Math.abs(y-g.y)});
  }
  function up(){const g=gesture.current;if(!g)return;const r=draft||g.candidate;gesture.current=null;setDraft(null);if(r&&r.width>=2&&r.height>=2)void window.screenshot.select(r);}
  const source=mode==='window'?'窗口':draft?'手动框选':candidate?labels[candidate.source]:'';
  const modes:[Mode|'screen',string,React.ReactNode][]=[['area','区域',<ScanLine/>],['window','窗口',<AppWindow/>],['screen','全屏',<Monitor/>]];
  return <div className={'cap'+(mode==='window'?' cap-window':'')} onPointerDown={down} onPointerMove={move} onPointerUp={up} onWheel={e=>{if(mode==='area'&&candidates.length){const next=(level+(e.deltaY>0?1:-1)+candidates.length)%candidates.length;setChoice({region:candidates[next],...point});}}}>
    {state.backdrop&&<img className="cap-background" src={state.backdrop} draggable={false} alt="冻结的屏幕"/>}
    {selected?<div className={'cap-rect'+(draft?' live':'')} style={box(selected)}>
      <span className={'cap-size'+(selected.y<36?' inside':'')}><span className="mono">{Math.round(selected.width)} × {Math.round(selected.height)}</span>{source&&<span className="cap-source">{source}</span>}
        {!draft&&candidates.length>1&&<span className="cap-levels" aria-label={`第 ${level+1} 层，共 ${candidates.length} 层`}>{candidates.map((_,i)=><i key={i} className={i===level?'on':''}/>)}</span>}</span>
    </div>:<div className="cap-dim"/>}
    <div className="cap-guide">
      <LayoutGroup id="cap-mode"><span className="cap-modes" role="radiogroup" aria-label="截图方式">{modes.map(([id,label,icon])=><button key={id} role="radio" aria-checked={mode===id} title={id==='screen'?'全屏 F':undefined} onClick={()=>id==='screen'?void act('screen'):switchMode(id)}>{mode===id&&<Glide id="cap-mode" className="cap-mode-on"/>}{icon}<span>{label}</span></button>)}</span></LayoutGroup>
      <i className="cap-guide-sep"/>
      {mode==='area'?<><span>悬停选区域</span><span><b>滚轮</b> 切换层级</span><span><b>拖动</b> 框选</span></>
        :<><span>点击截取窗口</span><span><b>⌥</b> 点击带阴影</span><span><b>↩</b> 截取高亮窗口</span></>}
      <span><b>空格</b> 切换</span>
      <button className="cap-cancel" onClick={()=>void act('cancel')}><b>Esc</b> 取消</button>
    </div>
    {error&&<div className="cap-toast error" role="alert">{error}</div>}
  </div>;
}
