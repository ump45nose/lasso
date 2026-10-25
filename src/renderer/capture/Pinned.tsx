import { useEffect, useRef, useState } from 'react';
import type { PinAPI, PinAction, PinState } from '../../shared/capture';
import { selectedOCRText } from './selected-text';
import './editor.css';
import './pinned.css';
declare global {interface Window {pin:PinAPI}}
export function Pinned(){
  const [state,setState]=useState<PinState|null>(null),[scale,setScale]=useState(1),[text,setText]=useState(''),[moving,setMoving]=useState(false),[error,setError]=useState('');
  const viewport=useRef<HTMLDivElement>(null),layer=useRef<HTMLDivElement>(null),selection=useRef('');
  const current=useRef(state);current.current=state;
  useEffect(()=>{const off=window.pin.onState(setState);void window.pin.state().then(setState);return off;},[]);
  useEffect(()=>{if(!state||!viewport.current)return;const element=viewport.current;const resize=()=>setScale(Math.min(element.clientWidth/state.width,element.clientHeight/state.height));const observer=new ResizeObserver(resize);observer.observe(element);resize();return()=>observer.disconnect();},[state?.width,state?.height]);
  useEffect(()=>{selection.current='';setText('');window.getSelection()?.removeAllRanges();},[state?.revision]);
  useEffect(()=>{const update=()=>{selection.current=selectedOCRText(layer.current);setText(selection.current);};document.addEventListener('selectionchange',update);return()=>document.removeEventListener('selectionchange',update);},[]);
  async function action(action:PinAction){const result=await window.pin.action(action);setError(result.error||'');}
  async function outputText(send:boolean){if(!selection.current||!current.current)return;const result=await window.pin.text(selection.current,send,current.current.revision);setError(result.error||'');}
  useEffect(()=>{
    const down=(e:KeyboardEvent)=>{if(e.code==='Space'&&!e.metaKey&&!e.ctrlKey){e.preventDefault();setMoving(true);}if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='c'){e.preventDefault();if(selection.current)void outputText(false);else void action('copy');}};
    const up=(e:KeyboardEvent)=>{if(e.code==='Space')setMoving(false);};const blur=()=>setMoving(false);
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',blur);return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur);};
  },[]);
  if(!state)return null;
  return <section className="pinned-image" aria-label="悬浮贴图" onContextMenu={e=>{e.preventDefault();void action('menu');}}>
    <header className="pin-toolbar"><span className="pin-drag" title="拖动贴图">Lasso</span><button onClick={()=>void action('edit')}>编辑</button><button onMouseDown={e=>e.preventDefault()} onClick={()=>{if(text)void outputText(true);else void action('image');}}>{text?'文字预设':'图片预设'}</button><button aria-label="贴图选项" onClick={()=>void action('menu')}>···</button><button aria-label="关闭贴图" onClick={()=>void action('close')}>×</button></header>
    <div className={'pin-viewport '+(moving?'moving':'')} ref={viewport}>
      <div className="pin-stage" style={{width:state.width*scale,height:state.height*scale}}><div className="pin-pixels" style={{width:state.width,height:state.height,transform:`scale(${scale})`}}>
        <img src={state.image} draggable={false} alt="贴图成品"/>
        <div className="editor-text-layer enabled" ref={layer} aria-label="贴图识别文字" onPointerDown={e=>{if(!e.shiftKey){window.getSelection()?.removeAllRanges();selection.current='';setText('');}}} onDragStart={e=>e.preventDefault()} onCopy={e=>{if(selection.current){e.preventDefault();e.clipboardData.setData('text/plain',selection.current);}}}>
          {state.lines.map((line,index)=><div key={index} className="editor-text-line" style={{left:line.x,top:line.y,width:line.width,height:line.height}}>{line.glyphs.map((g,i)=><span key={i} style={{left:g.x-line.x,top:g.y-line.y,width:g.width,height:g.height,fontSize:g.height*.95,lineHeight:`${g.height}px`}}>{g.text}</span>)}</div>)}
        </div>
      </div></div>
    </div>
    <div className="pin-status" role="status">{error||state.status}</div>
  </section>;
}
