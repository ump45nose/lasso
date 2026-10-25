import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { CaptureRect, RegionCandidate, ScreenshotAPI, ScreenshotState } from '../../shared/capture';
import { sameRegion } from '../../shared/capture';
import './capture.css';
const Editor=lazy(()=>import('./Editor').then(module=>({default:module.Editor})));
declare global { interface Window { screenshot: ScreenshotAPI } }
const contains=(r:CaptureRect,x:number,y:number)=>x>=r.x&&y>=r.y&&x<r.x+r.width&&y<r.y+r.height;
const labels={window:'窗口',element:'界面区域',edge:'边缘区域',color:'同色区域',screen:'全屏'};
export function Screenshot(){
  const [state,setState]=useState<ScreenshotState|null>(null),[point,setPoint]=useState({x:0,y:0}),[choice,setChoice]=useState<{region:RegionCandidate;x:number;y:number}|null>(null),[draft,setDraft]=useState<CaptureRect|null>(null),[error,setError]=useState('');
  const gesture=useRef<{x:number;y:number;original:CaptureRect|null;candidate:RegionCandidate|null;handle:string;dragged:boolean}|null>(null);
  const data=useRef(state);data.current=state;
  useEffect(()=>{const off=window.screenshot.onState(next=>setState(old=>({...old,...next}) as ScreenshotState));void window.screenshot.state().then(setState);return off;},[]);
  async function act(a:Parameters<ScreenshotAPI['action']>[0]){const r=await window.screenshot.action(a);setError(r.error||'');}
  useEffect(()=>{const key=(e:KeyboardEvent)=>{const s=data.current;if(!s)return;
    if(s.phase==='result')return;
    if(e.key==='Escape'){e.preventDefault();void act('cancel');}
    if(e.key.toLowerCase()==='f'&&!e.metaKey&&!e.ctrlKey){e.preventDefault();void act('screen');}
  };window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  if(!state)return null;
  if(state.phase==='result'&&state.selection)return <Suspense fallback={<div className="cap-guide">正在打开截图编辑器…</div>}><Editor key={state.editId} state={state}/></Suspense>;
  const candidates=state.candidates.filter(r=>contains(r,point.x,point.y));
  // Keep the actual wheel-selected rectangle, not a list index that can change
  // when asynchronous AX/visual candidates arrive. Ignore incidental hand jitter.
  const candidate=choice&&contains(choice.region,point.x,point.y)?choice.region:candidates[0];
  const level=candidate?Math.max(0,candidates.findIndex(r=>sameRegion(r,candidate))):0;
  const selected=draft||candidate;
  const rectStyle=selected?{left:selected.x,top:selected.y,width:selected.width,height:selected.height}:undefined;
  function down(e:React.PointerEvent){if((e.target as HTMLElement).closest('button'))return;e.preventDefault();const handle=(e.target as HTMLElement).dataset.handle||'';if(state!.phase==='result'&&!handle)return;gesture.current={x:e.clientX,y:e.clientY,original:state!.selection,candidate:candidate||null,handle,dragged:false};e.currentTarget.setPointerCapture(e.pointerId);}
  function move(e:React.PointerEvent){
    const x=Math.max(0,Math.min(state!.width,e.clientX)),y=Math.max(0,Math.min(state!.height,e.clientY));setPoint({x,y});
    const g=gesture.current;if(!g){if(state!.phase==='selecting'){if(choice&&(Math.hypot(x-choice.x,y-choice.y)>=5||!contains(choice.region,x,y)))setChoice(null);window.screenshot.hover(x,y);}return;}
    if(Math.hypot(x-g.x,y-g.y)>3)g.dragged=true;
    if(g.handle&&g.original){let {x:rx,y:ry,width:w,height:h}=g.original;const dx=x-g.x,dy=y-g.y;if(g.handle==='move'){rx=Math.max(0,Math.min(state!.width-w,rx+dx));ry=Math.max(0,Math.min(state!.height-h,ry+dy));}else{if(g.handle.includes('w')){rx=x;w=g.original.x+g.original.width-x;}if(g.handle.includes('e'))w=x-rx;if(g.handle.includes('n')){ry=y;h=g.original.y+g.original.height-y;}if(g.handle.includes('s'))h=y-ry;}setDraft({x:rx,y:ry,width:Math.max(2,w),height:Math.max(2,h)});
    }else if(g.dragged)setDraft({x:Math.min(g.x,x),y:Math.min(g.y,y),width:Math.abs(x-g.x),height:Math.abs(y-g.y)});
  }
  function up(){const g=gesture.current;if(!g)return;const r=draft||g.original||g.candidate;gesture.current=null;setDraft(null);if(r&&r.width>=2&&r.height>=2)void window.screenshot.select(r);}
  const source=draft?'手动框选':candidate?labels[candidate.source]:'';
  return <div className="cap" onPointerDown={down} onPointerMove={move} onPointerUp={up} onWheel={e=>{if(state.phase==='selecting'&&candidates.length){const next=(level+(e.deltaY>0?1:-1)+candidates.length)%candidates.length;setChoice({region:candidates[next],...point});}}}>
    <img className="cap-background" src={state.image} draggable={false} alt="冻结的屏幕"/>
    {selected?<div className={'cap-rect'+(draft?' live':'')} style={rectStyle}>
      <span className={'cap-size'+(selected.y<36?' inside':'')}><span className="mono">{Math.round(selected.width)} × {Math.round(selected.height)}</span>{source&&<span className="cap-source">{source}</span>}
        {!draft&&candidates.length>1&&<span className="cap-levels" aria-label={`第 ${level+1} 层，共 ${candidates.length} 层`}>{candidates.map((_,i)=><i key={i} className={i===level?'on':''}/>)}</span>}</span>
    </div>:<div className="cap-dim"/>}
    <div className="cap-guide"><span>悬停选区域</span><span><b>滚轮</b> 切换层级</span><span><b>拖动</b> 框选</span><span><b>F</b> 全屏</span><button onClick={()=>void act('cancel')}><b>Esc</b> 取消</button></div>
    {error&&<div className="cap-toast error" role="alert">{error}</div>}
  </div>;
}
