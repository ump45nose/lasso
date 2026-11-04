import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ScanText, Copy, Ellipsis, EyeOff, GripVertical, MousePointerClick, PenLine, Pin, Send, TextSelect, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { PinAPI, PinAction, PinState } from '../../shared/capture';
import { spring } from '../motion';
import { PinEdit } from './PinEdit';
import { selectedOCRText } from './selected-text';
import './text-layer.css';
import './pinned.css';
declare global {interface Window {pin:PinAPI}}
/** At rest a pin is just the image; the ink toolbar and the status float in while the pointer is over it.
 *  ··· (or a right click) slides out a second ink row with window options instead of a native menu. */
export function Pinned(){
  const [state,setState]=useState<PinState|null>(null),[scale,setScale]=useState(1),[text,setText]=useState(''),[moving,setMoving]=useState(false),[pickText,setPickText]=useState(false),[dragging,setDragging]=useState(false),[error,setError]=useState('');
  const [hover,setHover]=useState(false),[options,setOptions]=useState(false),[focused,setFocused]=useState(document.hasFocus());
  const viewport=useRef<HTMLDivElement>(null),layer=useRef<HTMLDivElement>(null),selection=useRef(''),leaveTimer=useRef<ReturnType<typeof setTimeout>>(undefined);
  const current=useRef(state),pickRef=useRef(pickText);current.current=state;pickRef.current=pickText;
  const clearSelection=()=>{selection.current='';setText('');window.getSelection()?.removeAllRanges();};
  const togglePickText=()=>{setPickText(on=>{if(on)clearSelection();return !on;});};
  useEffect(()=>{const off=window.pin.onState(setState);void window.pin.state().then(setState);return off;},[]);
  useEffect(()=>{if(!state||!viewport.current)return;const element=viewport.current;const resize=()=>setScale(Math.min(element.clientWidth/state.width,element.clientHeight/state.height));const observer=new ResizeObserver(resize);observer.observe(element);resize();return()=>observer.disconnect();},[state?.width,state?.height]);
  useEffect(()=>{clearSelection();},[state?.revision]);
  useEffect(()=>{const update=()=>{selection.current=selectedOCRText(layer.current);setText(selection.current);};document.addEventListener('selectionchange',update);return()=>document.removeEventListener('selectionchange',update);},[]);
  async function action(action:PinAction){const result=await window.pin.action(action);setError(result.error||'');}
  async function outputText(send:boolean){if(!selection.current||!current.current)return;const result=await window.pin.text(selection.current,send,current.current.revision);setError(result.error||'');}
  useEffect(()=>{
    const down=(e:KeyboardEvent)=>{
      if((e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='w'){e.preventDefault();void action('close');return;}
      if(e.key==='Escape'&&pickRef.current){e.preventDefault();clearSelection();setPickText(false);return;}
      if(e.code==='Space'&&!e.metaKey&&!e.ctrlKey){e.preventDefault();setMoving(true);}
      if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='c'){e.preventDefault();if(selection.current)void outputText(false);else void action('copy');}
    };
    const up=(e:KeyboardEvent)=>{if(e.code==='Space')setMoving(false);};
    const blur=()=>{setMoving(false);setDragging(false);window.pin.endDrag();setFocused(false);};
    const focus=()=>setFocused(true);
    window.addEventListener('keydown',down);window.addEventListener('keyup',up);window.addEventListener('blur',blur);window.addEventListener('focus',focus);
    return()=>{window.removeEventListener('keydown',down);window.removeEventListener('keyup',up);window.removeEventListener('blur',blur);window.removeEventListener('focus',focus);clearTimeout(leaveTimer.current);};
  },[]);
  if(!state)return null;
  if(state.editing&&state.editId)return <PinEdit editId={state.editId} pinId={state.id}/>;
  const canSelectText=pickText&&!moving;
  const status=error||(pickText&&state.lines.length?'拖选图中文字 · 再点选字恢复拖动':state.status);
  const stopDrag=()=>{if(dragging){setDragging(false);window.pin.endDrag();}};
  return <section className={'pin'+(focused?' focused':'')} aria-label="悬浮贴图" onContextMenu={e=>{e.preventDefault();setHover(true);setOptions(o=>!o);}}
    onPointerEnter={()=>{clearTimeout(leaveTimer.current);setHover(true);}} onPointerLeave={()=>{leaveTimer.current=setTimeout(()=>{setHover(false);setOptions(false);},300);}}>
    <div className={'pin-viewport'+(canSelectText?' selecting':'')+(moving?' moving':'')+(dragging?' dragging':'')} ref={viewport}
      onPointerDown={e=>{if(e.button!==0||canSelectText)return;e.preventDefault();setDragging(true);e.currentTarget.setPointerCapture(e.pointerId);window.pin.startDrag();}}
      onPointerMove={()=>{if(dragging)window.pin.drag();}}
      onPointerUp={stopDrag} onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}>
      <div className="pin-stage" style={{width:state.width*scale,height:state.height*scale}}><div className="pin-pixels" style={{width:state.width,height:state.height,transform:`scale(${scale})`}}>
        <img src={state.image} draggable={false} alt="贴图成品"/>
        <div className={'editor-text-layer'+(canSelectText?' enabled':'')} ref={layer} aria-label="贴图识别文字" onPointerDown={e=>{if(!e.shiftKey)clearSelection();}} onDragStart={e=>e.preventDefault()} onCopy={e=>{if(selection.current){e.preventDefault();e.clipboardData.setData('text/plain',selection.current);}}}>
          {state.lines.map((line,index)=><div key={index} className="editor-text-line" style={{left:line.x,top:line.y,width:line.width,height:line.height}}>{line.glyphs.map((g,i)=><span key={i} style={{left:g.x-line.x,top:g.y-line.y,width:g.width,height:g.height,fontSize:g.height*.95,lineHeight:`${g.height}px`}}>{g.text}</span>)}</div>)}
        </div>
      </div></div>
    </div>
    <AnimatePresence>{(hover||moving||dragging)&&<motion.header key="bar" className="pin-bar" initial={{opacity:0,y:-6,scale:.96}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:-4,transition:{duration:.12}}} transition={spring}>
      <span className="pin-grip" title="拖动贴图"><GripVertical/></span>
      <button title={pickText?'退出选择文字（恢复拖动贴图）':'选择文字'} aria-label="选择文字" aria-pressed={pickText} onMouseDown={e=>e.preventDefault()} onClick={togglePickText}><TextSelect/></button>
      <button title="编辑" aria-label="编辑贴图" onClick={()=>void action('edit')}><PenLine/></button>
      <button className={text?'pin-text':''} title={text?'用选中文字运行预设':'用图片运行预设'} aria-label={text?'文字预设':'图片预设'} onMouseDown={e=>e.preventDefault()} onClick={()=>{if(text)void outputText(true);else void action('image');}}><Send/>{text&&<span>文字预设</span>}</button>
      <button title={text?'复制选中文字 ⌘C':'复制图片 ⌘C'} aria-label="复制" onMouseDown={e=>e.preventDefault()} onClick={()=>{if(text)void outputText(false);else void action('copy');}}><Copy/></button>
      <button title="置顶、透明度、缩放、穿透" aria-label="贴图选项" aria-expanded={options} className={options?'on':''} onClick={()=>setOptions(o=>!o)}><Ellipsis/></button>
      <button title="关闭贴图 ⌘W" aria-label="关闭贴图" onClick={()=>void action('close')}><X/></button>
    </motion.header>}</AnimatePresence>
    <AnimatePresence>{(hover||moving||dragging)&&options&&<motion.div key="options" className="pin-bar pin-options" role="toolbar" aria-label="贴图选项" initial={{opacity:0,y:-6,scale:.96}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:-4,transition:{duration:.1}}} transition={spring}>
      <button title={state.topmost?'取消置顶':'置顶'} aria-label="置顶" aria-pressed={state.topmost} onClick={()=>void action('topmost')}><Pin/></button>
      <button aria-label="重新识别文字" data-tip="重新识别文字" onClick={()=>void action('recognize')}><ScanText/></button>
        <button title="透明度，点击切换" aria-label="透明度" className="pin-opacity" onClick={()=>void action('opacity')}><span className="mono">{Math.round(state.opacity*100)}%</span></button>
      <button title="缩小" aria-label="缩小贴图" onClick={()=>void action('zoom-out')}><ZoomOut/></button>
      <button title="放大" aria-label="放大贴图" onClick={()=>void action('zoom-in')}><ZoomIn/></button>
      <button title="鼠标穿透（从菜单栏恢复）" aria-label="鼠标穿透" onClick={()=>void action('passthrough')}><MousePointerClick/></button>
      <button title="临时隐藏（从菜单栏恢复）" aria-label="临时隐藏" onClick={()=>void action('hide')}><EyeOff/></button>
    </motion.div>}</AnimatePresence>
    <AnimatePresence>{(hover||error)&&status&&<motion.div key="status" className={'pin-status'+(error?' error':'')} role="status" initial={{opacity:0,y:4}} animate={{opacity:1,y:0}} exit={{opacity:0,transition:{duration:.12}}} transition={spring}>{status}</motion.div>}</AnimatePresence>
  </section>;
}
