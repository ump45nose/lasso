import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Lock, Unlock, RotateCcw, Save, X } from 'lucide-react';
import type { CaptureRect, EditableRegion } from '../../shared/capture';
import { drawRegion, moveRegion, resizeRegion, validPixelRegion } from '../../shared/region-geometry';
import { Segmented } from '../motion';
export function RegionControls({context,crop,displayCrop,preview,ratio,setRatio,commit,cancelPreview,error,busy,tool,controlsHost,open,setOpen}:{controlsHost:HTMLElement|null;open:boolean;setOpen:(open:boolean)=>void;context:EditableRegion;crop:CaptureRect;displayCrop:CaptureRect;preview:(r:CaptureRect|null)=>void;ratio:number|null;setRatio:(n:number|null)=>void;commit:(r:CaptureRect)=>void;cancelPreview:()=>void;error:(s:string)=>void;busy:boolean;tool:string}){
  const closing=useRef(false),focused=useRef<'w'|'h'|null>(null);
  const currentCrop=useRef(crop);currentCrop.current=crop;
  const [alt,setAlt]=useState(false);
  useEffect(()=>{const down=(e:KeyboardEvent)=>{if(e.key==='Alt')setAlt(true);},up=(e:KeyboardEvent)=>{if(e.key==='Alt')setAlt(false);},blur=()=>setAlt(false);window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',blur);return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur);};},[]);
  const [w,setW]=useState(String(crop.width)),[h,setH]=useState(String(crop.height)),[name,setName]=useState(''),[delay,setDelay]=useState('0'),[custom,setCustom]=useState('');
  const gesture=useRef<{pointerId:number;x:number;y:number;lastX:number;lastY:number;original:CaptureRect;handle:string;current:CaptureRect}|null>(null);
  const sx=context.display.bounds.width/context.sourceSize.width,sy=context.display.bounds.height/context.sourceSize.height;
  const box={left:displayCrop.x*sx,top:displayCrop.y*sy,width:displayCrop.width*sx,height:displayCrop.height*sy};
  useEffect(()=>{if(focused.current!=='w')setW(String(crop.width));if(focused.current!=='h')setH(String(crop.height));},[crop.width,crop.height,open]);
  const close=()=>{closing.current=true;focused.current=null;setW(String(currentCrop.current.width));setH(String(currentCrop.current.height));setOpen(false);};
  const abort=()=>{if(!gesture.current)return false;gesture.current=null;preview(null);cancelPreview();return true;};
  useEffect(()=>{const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&(abort()||open)){e.preventDefault();e.stopImmediatePropagation();close();}};const context=(e:MouseEvent)=>{if(open){e.preventDefault();e.stopImmediatePropagation();close();}};window.addEventListener('keydown',key,true);window.addEventListener('contextmenu',context,true);return()=>{window.removeEventListener('keydown',key,true);window.removeEventListener('contextmenu',context,true);};},[open]);
  const apply=(width:number,height:number)=>{if(busy)return false;const r={...currentCrop.current,width,height};if(!validPixelRegion(r,context.sourceSize)){error('尺寸需要为整数，至少 2 × 2 像素，并位于屏幕内');return false;}setW(String(width));setH(String(height));commit(r);error('');return true;};
  const switchRatio=(n:number|null)=>{if(busy)return;if(n===null){setRatio(null);return;}const c=currentCrop.current,width=Math.min(c.width,context.sourceSize.width-c.x,(context.sourceSize.height-c.y)*n),height=width/n;if(apply(Math.round(width),Math.round(height)))setRatio(n);};
  const input=(axis:'w'|'h')=>{focused.current=null;if(closing.current)return;const n=Number(axis==='w'?w:h);if(n===(axis==='w'?currentCrop.current.width:currentCrop.current.height))return;const width=axis==='w'?n:ratio?Math.round(n*ratio):Number(w),height=axis==='h'?n:ratio?Math.round(n/ratio):Number(h);if(apply(width,height)){setW(String(width));setH(String(height));}};
  const updateGesture=(shift:boolean)=>{const g=gesture.current;if(!g)return;
    const dx=g.lastX-g.x,dy=g.lastY-g.y;
    const r=g.handle==='move'?moveRegion(g.original,dx,dy,context.sourceSize):g.handle==='draw'?drawRegion({x:g.x,y:g.y},{x:g.lastX,y:g.lastY},context.sourceSize,shift?1:ratio):resizeRegion(g.original,g.handle,dx,dy,context.sourceSize,shift?1:ratio);
    g.current=r;preview(r);
  };
  useEffect(()=>{const flags=(e:KeyboardEvent)=>{if(e.key==='Shift')updateGesture(e.type==='keydown');};const blur=()=>abort();window.addEventListener('keydown',flags);window.addEventListener('keyup',flags);window.addEventListener('blur',blur);return()=>{window.removeEventListener('keydown',flags);window.removeEventListener('keyup',flags);window.removeEventListener('blur',blur);};},[ratio]);
  return <>
    <div className={'region-events'+(tool==='crop'?' active':'')} aria-label="调整截图选区" style={{pointerEvents:tool==='crop'||alt?'auto':'none'}}
      onPointerDown={e=>{if(busy||e.button!==0)return;const handle=(e.target as HTMLElement).dataset.regionHandle;
        const inside=e.clientX>=box.left&&e.clientX<=box.left+box.width&&e.clientY>=box.top&&e.clientY<=box.top+box.height;
        if(!handle&&tool!=='crop'&&!e.altKey)return;
        e.preventDefault();e.stopPropagation();gesture.current={pointerId:e.pointerId,x:e.clientX/sx,y:e.clientY/sy,lastX:e.clientX/sx,lastY:e.clientY/sy,original:{...crop},current:{...crop},handle:handle??(inside?'move':'draw')};e.currentTarget.setPointerCapture(e.pointerId);}}
      onPointerMove={e=>{const g=gesture.current;if(!g||g.pointerId!==e.pointerId)return;g.lastX=e.clientX/sx;g.lastY=e.clientY/sy;updateGesture(e.shiftKey);}}
      onPointerUp={e=>{const g=gesture.current;if(!g||g.pointerId!==e.pointerId)return;gesture.current=null;preview(null);if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);commit(g.current);}}
      onLostPointerCapture={()=>{abort();}} onPointerCancel={abort}
      onContextMenu={e=>{if(abort()||open){e.preventDefault();e.stopPropagation();close();}}}>
      <div className="region-border" style={box}>{['n','s','e','w'].map(edge=><i key={'edge'+edge} className={'region-edge '+edge} data-region-handle={edge}/>)}{['nw','n','ne','e','se','s','sw','w'].map(handle=><i key={handle} data-region-handle={handle} className={'editor-crop-handle '+handle}/>)}</div>
    </div>
    {controlsHost&&createPortal(<div className="region-size" inert={busy}>
      <button className="ed-text mono" aria-label="设置选区尺寸" aria-expanded={open} onClick={()=>{setW(String(crop.width));setH(String(crop.height));closing.current=false;setOpen(!open);}}>{crop.width} × {crop.height} px</button>
      <button className="ed-tool" aria-label="锁定当前宽高比" aria-pressed={ratio!==null} disabled={busy} onClick={()=>switchRatio(ratio===null?crop.width/crop.height:null)}>{ratio===null?<Unlock/>:<Lock/>}</button>
      {open&&<div className="region-panel" onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();(e.target as HTMLInputElement).blur();}}}>
        <div className="l-row"><label>宽<input className="l-input mono" aria-label="选区宽度" value={w} onFocus={()=>{focused.current='w';}} onChange={e=>setW(e.target.value)} onBlur={()=>input('w')}/></label><span>×</span><label>高<input className="l-input mono" aria-label="选区高度" value={h} onFocus={()=>{focused.current='h';}} onChange={e=>setH(e.target.value)} onBlur={()=>input('h')}/></label><span>px</span></div>
        <Segmented label="选区比例" value={String(ratio)} onChange={v=>switchRatio(v==='null'?null:Number(v))} options={ [['null','自由'],['1','1:1'],[String(4/3),'4:3'],[String(16/9),'16:9']] }/>
        <div className="l-row"><input className="l-input mono" aria-label="自定义比例" placeholder="宽:高" value={custom} onChange={e=>setCustom(e.target.value)}/><button className="l-btn" onClick={()=>{const [a,b]=custom.split(':').map(Number);if(a>0&&b>0&&Number.isFinite(a/b)){switchRatio(a/b);}else error('比例请填写为宽:高');}}>应用比例</button></div>
        <div className="l-row"><input className="l-input" aria-label="区域预设名称" placeholder="预设名称" value={name} onChange={e=>setName(e.target.value)}/><Segmented label="预设延时" value={delay} onChange={setDelay} options={ [['0','0秒'],['3','3秒'],['5','5秒'],['10','10秒']] }/></div>
        <div className="l-row"><button className="l-btn" onClick={()=>void window.screenshot.saveRegionPreset({id:crypto.randomUUID(),name,width:crop.width,height:crop.height,ratio,delay:Number(delay) as 0|3|5|10}).then(()=>{setName('');close();}).catch(e=>error(e.message))}><Save/>保存为预设</button><button className="l-btn" onClick={()=>{setRatio(context.ratio);commit(context.initialCrop);close();}}><RotateCcw/>恢复选区</button><button className="ed-tool" aria-label="关闭尺寸面板" onClick={close}><X/></button></div>
      </div>}
    </div>,controlsHost)}
  </>;
}
