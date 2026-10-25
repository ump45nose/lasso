import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Copy, Ellipsis, GripVertical, PenLine, Send, X } from 'lucide-react';
import type { PinAPI, PinAction, PinState } from '../../shared/capture';
import { spring } from '../motion';
import { selectedOCRText } from './selected-text';
import './text-layer.css';
import './pinned.css';
declare global {interface Window {pin:PinAPI}}
/** At rest a pin is just the image; the ink toolbar and the status float in while the pointer is over it. */
export function Pinned(){
  const [state,setState]=useState<PinState|null>(null),[scale,setScale]=useState(1),[text,setText]=useState(''),[moving,setMoving]=useState(false),[error,setError]=useState('');
  const [hover,setHover]=useState(false),[focused,setFocused]=useState(document.hasFocus());
  const viewport=useRef<HTMLDivElement>(null),layer=useRef<HTMLDivElement>(null),selection=useRef(''),leaveTimer=useRef<ReturnType<typeof setTimeout>>(undefined);
  const current=useRef(state);current.current=state;
  useEffect(()=>{const off=window.pin.onState(setState);void window.pin.state().then(setState);return off;},[]);
  useEffect(()=>{if(!state||!viewport.current)return;const element=viewport.current;const resize=()=>setScale(Math.min(element.clientWidth/state.width,element.clientHeight/state.height));const observer=new ResizeObserver(resize);observer.observe(element);resize();return()=>observer.disconnect();},[state?.width,state?.height]);
  useEffect(()=>{selection.current='';setText('');window.getSelection()?.removeAllRanges();},[state?.revision]);
  useEffect(()=>{const update=()=>{selection.current=selectedOCRText(layer.current);setText(selection.current);};document.addEventListener('selectionchange',update);return()=>document.removeEventListener('selectionchange',update);},[]);
  async function action(action:PinAction){const result=await window.pin.action(action);setError(result.error||'');}
  async function outputText(send:boolean){if(!selection.current||!current.current)return;const result=await window.pin.text(selection.current,send,current.current.revision);setError(result.error||'');}
  useEffect(()=>{
    const down=(e:KeyboardEvent)=>{if(e.code==='Space'&&!e.metaKey&&!e.ctrlKey){e.preventDefault();setMoving(true);}if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='c'){e.preventDefault();if(selection.current)void outputText(false);else void action('copy');}};
    const up=(e:KeyboardEvent)=>{if(e.code==='Space')setMoving(false);};const blur=()=>{setMoving(false);setFocused(false);};const focus=()=>setFocused(true);
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',blur);window.addEventListener('focus',focus);
    return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur);window.removeEventListener('focus',focus);clearTimeout(leaveTimer.current);};
  },[]);
  if(!state)return null;
  const status=error||state.status;
  return <section className={'pin'+(focused?' focused':'')} aria-label="悬浮贴图" onContextMenu={e=>{e.preventDefault();void action('menu');}}
    onPointerEnter={()=>{clearTimeout(leaveTimer.current);setHover(true);}} onPointerLeave={()=>{leaveTimer.current=setTimeout(()=>setHover(false),300);}}>
    <div className={'pin-viewport'+(moving?' moving':'')} ref={viewport}>
      <div className="pin-stage" style={{width:state.width*scale,height:state.height*scale}}><div className="pin-pixels" style={{width:state.width,height:state.height,transform:`scale(${scale})`}}>
        <img src={state.image} draggable={false} alt="贴图成品"/>
        <div className="editor-text-layer enabled" ref={layer} aria-label="贴图识别文字" onPointerDown={e=>{if(!e.shiftKey){window.getSelection()?.removeAllRanges();selection.current='';setText('');}}} onDragStart={e=>e.preventDefault()} onCopy={e=>{if(selection.current){e.preventDefault();e.clipboardData.setData('text/plain',selection.current);}}}>
          {state.lines.map((line,index)=><div key={index} className="editor-text-line" style={{left:line.x,top:line.y,width:line.width,height:line.height}}>{line.glyphs.map((g,i)=><span key={i} style={{left:g.x-line.x,top:g.y-line.y,width:g.width,height:g.height,fontSize:g.height*.95,lineHeight:`${g.height}px`}}>{g.text}</span>)}</div>)}
        </div>
      </div></div>
    </div>
    <AnimatePresence>{(hover||moving)&&<motion.header key="bar" className="pin-bar" initial={{opacity:0,y:-6,scale:.96}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:-4,transition:{duration:.12}}} transition={spring}>
      <span className="pin-grip" title="拖动贴图（或按住空格拖动图片）"><GripVertical/></span>
      <button title="编辑" aria-label="编辑贴图" onClick={()=>void action('edit')}><PenLine/></button>
      <button className={text?'pin-text':''} title={text?'用选中文字运行预设':'用图片运行预设'} aria-label={text?'文字预设':'图片预设'} onMouseDown={e=>e.preventDefault()} onClick={()=>{if(text)void outputText(true);else void action('image');}}><Send/>{text&&<span>文字预设</span>}</button>
      <button title={text?'复制选中文字 ⌘C':'复制图片 ⌘C'} aria-label="复制" onMouseDown={e=>e.preventDefault()} onClick={()=>{if(text)void outputText(false);else void action('copy');}}><Copy/></button>
      <button title="置顶、透明度、缩放、穿透" aria-label="贴图选项" onClick={()=>void action('menu')}><Ellipsis/></button>
      <button title="关闭贴图" aria-label="关闭贴图" onClick={()=>void action('close')}><X/></button>
    </motion.header>}</AnimatePresence>
    <AnimatePresence>{(hover||error)&&status&&<motion.div key="status" className={'pin-status'+(error?' error':'')} role="status" initial={{opacity:0,y:4}} animate={{opacity:1,y:0}} exit={{opacity:0,transition:{duration:.12}}} transition={spring}>{status}</motion.div>}</AnimatePresence>
  </section>;
}
