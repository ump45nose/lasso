import { useEffect, useRef, useState } from 'react';
import type { CaptureRect, RegionCandidate, ScreenshotAPI, ScreenshotState } from '../../shared/capture';
import './capture.css';
declare global { interface Window { screenshot: ScreenshotAPI } }
const contains=(r:CaptureRect,x:number,y:number)=>x>=r.x&&y>=r.y&&x<r.x+r.width&&y<r.y+r.height;
const labels={window:'窗口',element:'界面区域',edge:'边缘区域',color:'同色区域',screen:'全屏'};
export function Screenshot(){
  const [state,setState]=useState<ScreenshotState|null>(null),[point,setPoint]=useState({x:0,y:0}),[level,setLevel]=useState(0),[draft,setDraft]=useState<CaptureRect|null>(null),[error,setError]=useState('');
  const gesture=useRef<{x:number;y:number;original:CaptureRect|null;handle:string;dragged:boolean}|null>(null);
  const data=useRef(state);data.current=state;
  useEffect(()=>{const off=window.screenshot.onState(next=>setState(old=>({...old,...next}) as ScreenshotState));void window.screenshot.state().then(setState);return off;},[]);
  async function act(a:Parameters<ScreenshotAPI['action']>[0]){const r=await window.screenshot.action(a);setError(r.error||'');}
  useEffect(()=>{const key=(e:KeyboardEvent)=>{const s=data.current;if(!s)return;
    if(e.key==='Escape'){e.preventDefault();void act('cancel');}
    if(e.key.toLowerCase()==='f'&&!e.metaKey&&!e.ctrlKey){e.preventDefault();void act('screen');}
    if(s.phase==='result'&&(e.key==='Enter'||e.metaKey&&e.key.toLowerCase()==='c')){e.preventDefault();void act('copy');}
    if(s.phase==='result'&&e.metaKey&&e.key.toLowerCase()==='s'){e.preventDefault();void act('save');}
    if(s.phase==='result'&&s.selection&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const r={...s.selection},n=e.shiftKey?10:1;if(e.key==='ArrowLeft')r.x-=n;if(e.key==='ArrowRight')r.x+=n;if(e.key==='ArrowUp')r.y-=n;if(e.key==='ArrowDown')r.y+=n;r.x=Math.max(0,Math.min(s.width-r.width,r.x));r.y=Math.max(0,Math.min(s.height-r.height,r.y));void window.screenshot.select(r);}
  };window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[]);
  if(!state)return null;
  const candidates=state.candidates.filter(r=>contains(r,point.x,point.y));
  const candidate=candidates[Math.min(level,Math.max(0,candidates.length-1))];
  const selected=draft||(state.phase==='result'?state.selection:candidate);
  const rectStyle=selected?{left:selected.x,top:selected.y,width:selected.width,height:selected.height}:undefined;
  function down(e:React.PointerEvent){if((e.target as HTMLElement).closest('button,.capture-toolbar'))return;e.preventDefault();const handle=(e.target as HTMLElement).dataset.handle||'';if(state!.phase==='result'&&!handle)return;gesture.current={x:e.clientX,y:e.clientY,original:state!.selection,handle,dragged:false};e.currentTarget.setPointerCapture(e.pointerId);}
  function move(e:React.PointerEvent){
    const x=Math.max(0,Math.min(state!.width,e.clientX)),y=Math.max(0,Math.min(state!.height,e.clientY));setPoint({x,y});
    const g=gesture.current;if(!g){if(state!.phase==='selecting'){setLevel(0);window.screenshot.hover(x,y);}return;}
    if(Math.hypot(x-g.x,y-g.y)>3)g.dragged=true;
    if(g.handle&&g.original){let {x:rx,y:ry,width:w,height:h}=g.original;const dx=x-g.x,dy=y-g.y;if(g.handle==='move'){rx=Math.max(0,Math.min(state!.width-w,rx+dx));ry=Math.max(0,Math.min(state!.height-h,ry+dy));}else{if(g.handle.includes('w')){rx=x;w=g.original.x+g.original.width-x;}if(g.handle.includes('e'))w=x-rx;if(g.handle.includes('n')){ry=y;h=g.original.y+g.original.height-y;}if(g.handle.includes('s'))h=y-ry;}setDraft({x:rx,y:ry,width:Math.max(2,w),height:Math.max(2,h)});
    }else if(g.dragged)setDraft({x:Math.min(g.x,x),y:Math.min(g.y,y),width:Math.abs(x-g.x),height:Math.abs(y-g.y)});
  }
  function up(){const g=gesture.current;if(!g)return;const r=draft||candidate;gesture.current=null;setDraft(null);if(r&&r.width>=2&&r.height>=2)void window.screenshot.select(r);}
  const toolbarTop=selected?Math.min(state.height-58,selected.y+selected.height+12):20;
  return <div className="capture-surface" onPointerDown={down} onPointerMove={move} onPointerUp={up} onWheel={e=>{if(state.phase==='selecting'&&candidates.length){setLevel(n=>(n+(e.deltaY>0?1:-1)+candidates.length)%candidates.length);}}}>
    <img className="capture-background" src={state.image} draggable={false} alt="冻结的屏幕"/>
    {selected?<div className="capture-region" style={rectStyle}>
      <span className="capture-size">{Math.round(selected.width)} × {Math.round(selected.height)}{state.phase==='selecting'&&candidate?` · ${labels[candidate.source]} ${Math.min(level+1,candidates.length)}/${candidates.length}`:''}</span>
      {state.phase==='result'&&<><div className="capture-drag" data-handle="move"/>{['nw','n','ne','e','se','s','sw','w'].map(h=><i key={h} className={'capture-handle '+h} data-handle={h}/>)}</>}
    </div>:<div className="capture-dim"/>}
    {state.phase==='result'&&selected?<div className="capture-toolbar" style={{top:toolbarTop,left:Math.max(12,Math.min(state.width-450,selected.x))}}>
      <button onClick={()=>void act('reselect')}>重新选区</button><button onClick={()=>void act('save')}>保存</button><button onClick={()=>void act('image')}>AI 预设</button><button className="capture-primary" onClick={()=>void act('copy')}>复制 ⌘C</button><button aria-label="取消截图" onClick={()=>void act('cancel')}>×</button>
    </div>:<div className="capture-guide"><strong>截图</strong><span>悬停选区域 · 滚轮切换 · 拖动框选 · F 全屏</span><button onClick={()=>void act('cancel')}>取消 Esc</button></div>}
    {error&&<div className="capture-error" role="alert">{error}</div>}
  </div>;
}
