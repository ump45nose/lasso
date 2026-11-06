import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlignLeft, AlignStartVertical, ArrowUpRight, Check, ChevronDown, Clipboard, Copy, Ellipsis, EyeOff, File as FileIcon, Folder, GripVertical, Grid2X2, Lock, Maximize2, Minimize2, MousePointerClick, Pause, PenLine, Pin, Play, RotateCcw, Save, ScanText, Send, TextSelect, Type, Unlock, X } from 'lucide-react';
import type { PinAPI, PinAction, PinState, PinWorkspaceAPI } from '../../shared/capture';
import type { PinGroup, PinWorkspaceState } from '../../shared/history-sync';
import { spring } from '../motion';
import { PinEdit } from './PinEdit';
import { selectedOCRText } from './selected-text';
import { TextLines } from './TextLines';
import './text-layer.css';
import './pinned.css';

declare global {interface Window {pin:PinAPI;pinWorkspace:PinWorkspaceAPI}}
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const editable=(target:EventTarget|null)=>target instanceof HTMLElement&&!!target.closest('input, textarea, [contenteditable="true"]');
const TipContext=createContext<(tip:string)=>void>(()=>{});
type PinPlayback={source:{id:string;frames:string[];delay:number}|null;frame:number;paused:boolean};
function Tool({label,children,onClick,active,disabled,className=''}:{label:string;children:ReactNode;onClick:()=>void;active?:boolean;disabled?:boolean;className?:string}){
  const setTip=useContext(TipContext);
  return <button type="button" className={className} aria-label={label} data-tip={label} aria-pressed={active} disabled={disabled} onPointerEnter={()=>setTip(label)} onPointerLeave={()=>setTip('')} onFocus={()=>setTip(label)} onBlur={()=>setTip('')} onMouseDown={e=>e.preventDefault()} onClick={onClick}>{children}</button>;
}
function GroupPicker({groups,value,onChange,label='贴图分组',onOpenChange}:{groups:PinGroup[];value?:string;onChange:(id:string)=>void;label?:string;onOpenChange?:(open:boolean)=>void}){
  const [open,setOpen]=useState(false);
  function toggle(next:boolean){setOpen(next);onOpenChange?.(next);}
  return <div className="pin-group" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();toggle(false);}}}>
    <button type="button" className="pin-group-toggle" aria-label={label} aria-expanded={open} aria-haspopup="listbox" onClick={()=>toggle(!open)}><Folder/><span>{groups.find(group=>group.id===value)?.name||'选择分组'}</span><ChevronDown/></button>
    {open&&<div className="pin-group-menu" role="listbox" aria-label={label}>{groups.map(group=><button type="button" role="option" aria-selected={value===group.id} key={group.id} onClick={()=>{onChange(group.id);toggle(false);}}><span>{group.name}{!group.visible?' · 已隐藏':''}</span>{value===group.id&&<Check/>}</button>)}</div>}
  </div>;
}

/** Pins keep their content in place; editing and text selection are explicit modes. */
export function Pinned(){
  const [state,setState]=useState<PinState|null>(null),[scale,setScale]=useState(1),[text,setText]=useState(''),[moving,setMoving]=useState(false),[pickText,setPickText]=useState(false),[dragging,setDragging]=useState(false),[error,setError]=useState('');
  const [hover,setHover]=useState(false),[options,setOptions]=useState(false),[focused,setFocused]=useState(document.hasFocus()),[textEditing,setTextEditing]=useState(false),[draft,setDraft]=useState(''),[dropping,setDropping]=useState(false);
  const [tip,setTip]=useState(''),[zoomDraft,setZoomDraft]=useState('100');
  const [playback,setPlayback]=useState<PinPlayback>({source:null,frame:0,paused:false});
  const zoomInput=useRef<HTMLInputElement>(null);
  const root=useRef<HTMLElement>(null),viewport=useRef<HTMLDivElement>(null),layer=useRef<HTMLDivElement>(null),selection=useRef(''),leaveTimer=useRef<ReturnType<typeof setTimeout>>(undefined),dropDepth=useRef(0);
  const current=useRef(state),pickRef=useRef(pickText);current.current=state;pickRef.current=pickText;
  const clearSelection=()=>{selection.current='';setText('');window.getSelection()?.removeAllRanges();};
  const togglePickText=()=>{setPickText(on=>{if(on)clearSelection();return !on;});};
  async function run(task:Promise<{error:string|null}>){try{const result=await task;setError(result.error||'');return !result.error;}catch(reason){setError((reason as Error).message);return false;}}
  const action=(value:PinAction)=>run(window.pin.action(value));
  async function outputText(send:boolean,value=selection.current){const pin=current.current;if(value&&pin)await run(window.pin.text(value,send,pin.revision));}
  async function saveText(){if(await run(window.pin.updateText(draft)))setTextEditing(false);}
  function adjust(field:'opacity'|'zoomPercent',value:number){const pin=current.current;if(!pin)return;const next={...pin,[field]:value};current.current=next;setState(next);void run(field==='opacity'?window.pin.setOpacity(value):window.pin.setZoom(value/100));}
  useEffect(()=>{
    const receive=(next:PinState)=>{
      setState(next);
      setPlayback(previous=>{
        const frames=(next.kind||'image')==='image'?next.payload?.frames:undefined,source=previous.source;
        if(!frames?.length)return source?{source:null,frame:0,paused:false}:previous;
        // IPC recreates arrays on ordinary pin updates; keep playback for the same media.
        if(source?.id===next.id&&source.delay===next.payload?.frameDelayMs&&source.frames.length===frames.length&&source.frames.every((frame,index)=>frame===frames[index]))return previous;
        return {source:{id:next.id,frames,delay:next.payload!.frameDelayMs!},frame:0,paused:false};
      });
    };
    const off=window.pin.onState(receive);void window.pin.state().then(receive).catch(reason=>setError((reason as Error).message));return off;
  },[]);
  useEffect(()=>{
    const source=playback.source;
    if(!source||source.frames.length<2||playback.paused||state?.editing)return;
    const timer=setInterval(()=>setPlayback(previous=>({...previous,frame:(previous.frame+1)%source.frames.length})),source.delay);
    return()=>clearInterval(timer);
  },[playback.source,playback.paused,state?.editing]);
  useEffect(()=>{if(!state||!viewport.current)return;const element=viewport.current;const resize=()=>setScale(Math.min(element.clientWidth/state.width,element.clientHeight/state.height));const observer=new ResizeObserver(resize);observer.observe(element);resize();return()=>observer.disconnect();},[state?.width,state?.height,state?.thumbnail,state?.editing]);
  useEffect(()=>{clearSelection();setDraft(state?.payload?.text||'');},[state?.id,state?.revision]);
  useEffect(()=>{if(document.activeElement!==zoomInput.current)setZoomDraft(String(state?.zoomPercent??100));},[state?.zoomPercent]);
  useEffect(()=>{const update=()=>{selection.current=selectedOCRText(layer.current);setText(selection.current);};document.addEventListener('selectionchange',update);return()=>document.removeEventListener('selectionchange',update);},[]);
  useEffect(()=>{
    const element=root.current;if(!element)return;
    const wheel=(event:WheelEvent)=>{const pin=current.current;if(!pin||pin.editing||editable(event.target)||(event.target instanceof Element&&event.target.closest('.pin-bar')))return;event.preventDefault();const opacity=(pin.wheelAction==='opacity')!==event.altKey,delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?100:1);if(opacity)adjust('opacity',Math.round(clamp(pin.opacity-delta*.001,.1,1)*100)/100);else if(!pin.locked)adjust('zoomPercent',Math.round(clamp((pin.zoomPercent??100)*Math.exp(-delta*.002),10,500)));};
    element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel);
  },[state?.id,state?.editing]);
  useEffect(()=>{
    const down=(e:KeyboardEvent)=>{
      if((e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==='w'){e.preventDefault();void action('close');return;}
      if(current.current?.editing||editable(e.target))return;
      if(e.key==='Escape'){if(pickRef.current){e.preventDefault();clearSelection();setPickText(false);}setOptions(false);return;}
      if(e.code==='Space'&&!e.metaKey&&!e.ctrlKey&&!current.current?.locked){e.preventDefault();setMoving(true);}
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
  const kind=state.kind||'image',payload=state.payload,canSelectText=kind==='image'&&pickText&&!moving,showTools=hover||moving||dragging||options||textEditing;
  const animation=playback.source,image=animation?.frames[playback.frame]??state.image;
  const playbackControl=animation&&<Tool label={playback.paused?'播放动态贴图':'暂停动态贴图'} active={playback.paused} onClick={()=>{setPlayback(previous=>({...previous,paused:!previous.paused}));setTip(playback.paused?'暂停动态贴图':'播放动态贴图');}}>{playback.paused?<Play/>:<Pause/>}</Tool>;
  const status=error||tip||(pickText&&state.lines.length?'拖选图中文字 · 再点选字恢复拖动':state.status);
  const stopDrag=()=>{if(dragging){setDragging(false);window.pin.endDrag();}};
  const startDrag=(event:PointerEvent<HTMLElement>)=>{if(event.button!==0||state.locked||canSelectText||editable(event.target)||(event.target as HTMLElement).closest('button'))return;event.preventDefault();setDragging(true);event.currentTarget.setPointerCapture(event.pointerId);window.pin.startDrag();};
  const dragHandlers={onPointerDown:startDrag,onPointerMove:()=>{if(dragging)window.pin.drag();},onPointerUp:stopDrag,onPointerCancel:stopDrag,onLostPointerCapture:stopDrag};
  return <TipContext.Provider value={setTip}><section ref={root} className={'pin pin-'+kind+(focused?' focused':'')+(state.locked?' locked':'')+(state.thumbnail?' thumbnail':'')} aria-label="悬浮贴图" onContextMenu={e=>{e.preventDefault();setHover(true);setOptions(o=>!o);}}
    onPointerEnter={()=>{clearTimeout(leaveTimer.current);setHover(true);}} onPointerLeave={()=>{leaveTimer.current=setTimeout(()=>{setHover(false);if(!state.thumbnail)setOptions(false);},300);}}
    onDragEnter={e=>{e.preventDefault();dropDepth.current++;setDropping(true);}} onDragOver={e=>{e.preventDefault();e.dataTransfer.dropEffect='copy';}} onDragLeave={()=>{if(--dropDepth.current<=0){dropDepth.current=0;setDropping(false);}}}
    onDrop={e=>{e.preventDefault();dropDepth.current=0;setDropping(false);void run(window.pinWorkspace.dropFiles(Array.from(e.dataTransfer.files),e.dataTransfer.getData('text/plain'),state.groupId));}}>
    {state.thumbnail?<div className="pin-thumbnail" {...dragHandlers} onDoubleClick={event=>{if(!state.locked&&!(event.target as HTMLElement).closest('button'))void action('thumbnail');}}>
      {kind==='image'&&<img src={image} alt="贴图缩略图" draggable={false}/>}
      <span className="pin-thumbnail-title">{state.locked&&<Lock/>}{state.title||'贴图'}</span>
      <div className="pin-thumbnail-actions">{playbackControl}<Tool label="锁定贴图" active={state.locked} onClick={()=>void action('lock')}>{state.locked?<Lock/>:<Unlock/>}</Tool><Tool label="展开贴图" disabled={state.locked} onClick={()=>void action('thumbnail')}><Maximize2/></Tool><Tool label="关闭贴图" onClick={()=>void action('close')}><X/></Tool></div>
    </div>:<>
      <div className={'pin-viewport'+(canSelectText?' selecting':'')+(moving?' moving':'')+(dragging?' dragging':'')} ref={viewport} {...dragHandlers}>
        {kind==='image'?<div className="pin-stage" style={{width:state.width*scale,height:state.height*scale}}><div className="pin-pixels" style={{width:state.width,height:state.height,transform:`scale(${scale})`}}>
          <img src={image} draggable={false} alt="贴图成品"/>
          <div className={'editor-text-layer'+(canSelectText?' enabled':'')} ref={layer} aria-label="贴图识别文字" onPointerDown={e=>{if(!e.shiftKey)clearSelection();}} onDragStart={e=>e.preventDefault()} onCopy={e=>{if(selection.current){e.preventDefault();e.clipboardData.setData('text/plain',selection.current);}}}>
            <TextLines lines={state.lines}/>
          </div>
        </div></div>:kind==='text'?<div className={'pin-note'+(textEditing?' editing':'')}>
          {textEditing?<><textarea aria-label="贴图文字" autoFocus value={draft} maxLength={100000} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();void saveText();}if(e.key==='Escape'){e.preventDefault();setTextEditing(false);setDraft(payload?.text||'');}}}/><div className="pin-note-actions"><button className="l-ghost" onClick={()=>{setTextEditing(false);setDraft(payload?.text||'');}}>取消文字编辑</button><button className="l-btn" disabled={!draft.trim()} onClick={()=>void saveText()}>保存文字</button></div></>:<p>{payload?.text}</p>}
        </div>:kind==='color'?<div className="pin-color-card"><img className="pin-color-swatch" src={state.image} alt={payload?.colorHex||'颜色色块'} draggable={false}/><div className="pin-color-values"><button aria-label="复制HEX色值" data-tip="复制 HEX" onClick={()=>void action('copy')}><code>{payload?.colorHex}</code><Copy/></button><button aria-label="复制RGB色值" data-tip="复制 RGB" onClick={()=>void outputText(false,payload?.colorRgb)}><code>{payload?.colorRgb}</code><Copy/></button></div></div>:
        <div className="pin-file-card"><FileIcon/><strong>{payload?.fileName||state.title}</strong><span className="mono">{formatSize(payload?.fileSize||0)}</span><p>{payload?.filePath}</p><div><button className="l-ghost" aria-label="复制文件" onClick={()=>void action('copy-file')}><Copy/>复制文件</button><button className="l-ghost" aria-label="复制文件路径" onClick={()=>void action('copy-path')}>复制路径</button></div></div>}
      </div>
      {state.locked&&<span className="pin-lock-mark" aria-label="贴图已锁定"><Lock/></span>}
      <AnimatePresence>{showTools&&<motion.header key="bar" className="pin-bar" initial={{opacity:0,y:-6,scale:.96}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:-4,transition:{duration:.12}}} transition={spring}>
        <span className="pin-grip" aria-label={state.locked?'贴图已锁定':'拖动贴图'} {...dragHandlers}>{state.locked?<Lock/>:<GripVertical/>}</span>
        {playbackControl}
        {kind==='image'&&<Tool label="选择文字" active={pickText} onClick={togglePickText}><TextSelect/></Tool>}
        {(kind==='image'||kind==='text')&&<Tool label={kind==='text'?'编辑文字':animation?'动态贴图请在录制预览中裁剪':'编辑贴图'} disabled={kind==='image'&&(state.locked||!!animation)} onClick={()=>{if(kind==='text'){setTextEditing(on=>!on);setDraft(payload?.text||'');}else void action('edit');}}><PenLine/></Tool>}
        {(kind==='image'||kind==='text')&&<Tool label={kind==='text'||text?'文字预设':'图片预设'} active={!!text} disabled={textEditing} onClick={()=>{if(kind==='text')void outputText(true,payload?.text);else if(text)void outputText(true);else void action('image');}}><Send/></Tool>}
        <Tool label="快速保存" disabled={textEditing} onClick={()=>void action('quick-save')}><Save/></Tool>
        <Tool label="复制" disabled={textEditing} onClick={()=>{if(text)void outputText(false);else void action('copy');}}><Copy/></Tool>
        <Tool label="贴图选项" active={options} onClick={()=>setOptions(on=>!on)}><Ellipsis/></Tool>
        <Tool label="关闭贴图" onClick={()=>void action('close')}><X/></Tool>
      </motion.header>}</AnimatePresence>
      <AnimatePresence>{showTools&&options&&<motion.div key="options" className="pin-bar pin-options" role="toolbar" aria-label="贴图选项" initial={{opacity:0,y:-6,scale:.96}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:-4,transition:{duration:.1}}} transition={spring}>
        <div className="pin-option-row"><Tool label="保存贴图" disabled={textEditing} onClick={()=>void action('save')}><Save/></Tool><Tool label="锁定贴图" active={state.locked} onClick={()=>void action('lock')}>{state.locked?<Lock/>:<Unlock/>}</Tool><Tool label="缩略贴图" disabled={state.locked} onClick={()=>void action('thumbnail')}><Minimize2/></Tool><Tool label="置顶" active={state.topmost} onClick={()=>void action('topmost')}><Pin/></Tool>{kind==='image'&&<Tool label="重新识别文字" onClick={()=>void action('recognize')}><ScanText/></Tool>}<Tool label="鼠标穿透" onClick={()=>void action('passthrough')}><MousePointerClick/></Tool><Tool label="临时隐藏" onClick={()=>void action('hide')}><EyeOff/></Tool></div>
        <label className="pin-control"><span>透明度</span><input aria-label="透明度" type="range" min="10" max="100" step="1" value={Math.round(state.opacity*100)} onChange={e=>adjust('opacity',Number(e.target.value)/100)}/><output className="mono">{Math.round(state.opacity*100)}%</output></label>
        <label className="pin-control"><span>缩放</span><input ref={zoomInput} className="pin-zoom" aria-label="贴图缩放" type="number" min="10" max="500" step="1" value={zoomDraft} disabled={state.locked} onChange={e=>{setZoomDraft(e.target.value);const value=Number(e.target.value);if(e.target.value&&value>=10&&value<=500)adjust('zoomPercent',value);}} onBlur={()=>setZoomDraft(String(current.current?.zoomPercent??100))} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}}/><span>%</span><Tool label="恢复100%缩放" disabled={state.locked} onClick={()=>void action('reset-zoom')}><RotateCcw/>100%</Tool></label>
        <GroupPicker groups={state.groups||[]} value={state.groupId} onChange={id=>void run(window.pin.setGroup(id))}/>
      </motion.div>}</AnimatePresence>
    </>}
    <AnimatePresence>{(hover||error||tip)&&status&&<motion.div key="status" className={'pin-status'+(error?' error':'')} role="status" initial={{opacity:0,y:4}} animate={{opacity:1,y:0}} exit={{opacity:0,transition:{duration:.12}}} transition={spring}>{status}</motion.div>}</AnimatePresence>
    {dropping&&<div className="pin-drop"><ArrowUpRight/><span>松开以新建贴图</span></div>}
  </section></TipContext.Provider>;
}
function formatSize(bytes:number){return bytes<1024?`${bytes} B`:bytes<1024*1024?`${(bytes/1024).toFixed(1)} KB`:`${(bytes/1024/1024).toFixed(1)} MB`;}

export function PinToolbar(){
  const [workspace,setWorkspace]=useState<PinWorkspaceState|null>(null),[error,setError]=useState(''),[groupsOpen,setGroupsOpen]=useState(false),[busy,setBusy]=useState(false);
  const [tip,setTip]=useState('');
  const api=window.pinWorkspace;
  useEffect(()=>{document.documentElement.classList.add('pin-toolbar-surface');document.body.classList.add('pin-toolbar-surface');const off=api.onChanged(setWorkspace);void api.pinWorkspace().then(setWorkspace).catch(reason=>setError((reason as Error).message));return()=>{off();document.documentElement.classList.remove('pin-toolbar-surface');document.body.classList.remove('pin-toolbar-surface');};},[]);
  useEffect(()=>{api.setToolbarHeight(52+(groupsOpen?Math.min(180,(workspace?.settings.groups.length||0)*30+10):0)+(error||tip?28:0));},[groupsOpen,error,tip,workspace?.settings.groups.length]);
  async function run(task:()=>Promise<{error:string|null}>){setBusy(true);try{const result=await task();setError(result.error||'');if(!result.error)setWorkspace(await api.pinWorkspace());}catch(reason){setError((reason as Error).message);}finally{setBusy(false);}}
  if(!workspace)return <aside className="pin-workspace-bar" aria-label="桌面贴图工具栏"><span role="status">{error||'正在载入贴图工作空间…'}</span></aside>;
  const settings=workspace.settings,groupId=settings.activeGroupId;
  return <TipContext.Provider value={setTip}><aside className="pin-workspace-bar" aria-label="桌面贴图工具栏">
    <div className="pin-bar pin-workspace-actions"><span className="pin-grip" aria-label="拖动悬浮工具栏"><GripVertical/></span>
      <GroupPicker groups={settings.groups} value={groupId} label="当前分组" onOpenChange={setGroupsOpen} onChange={id=>void run(()=>api.savePinWorkspace({...settings,activeGroupId:id}))}/>
      <Tool label="剪贴板贴图" disabled={busy} onClick={()=>void run(()=>api.pinClipboard())}><Clipboard/></Tool>
      <Tool label="新建文字贴图" disabled={busy} onClick={()=>void run(()=>api.createPin({kind:'text',text:'点编辑，记下你的想法。',groupId}))}><Type/></Tool>
      <Tool label="恢复刚关闭贴图" disabled={busy||!workspace.closedCount} onClick={()=>void run(()=>api.reopenClosedPin())}><RotateCcw/></Tool>
      <Tool label="网格排列" disabled={busy} onClick={()=>void run(()=>api.arrangePins('grid',groupId))}><Grid2X2/></Tool>
      <Tool label="左对齐" disabled={busy} onClick={()=>void run(()=>api.arrangePins('align-left',groupId))}><AlignLeft/></Tool>
      <Tool label="顶对齐" disabled={busy} onClick={()=>void run(()=>api.arrangePins('align-top',groupId))}><AlignStartVertical/></Tool>
      <Tool label="关闭悬浮工具栏" disabled={busy} onClick={()=>void run(()=>api.savePinWorkspace({...settings,floatingToolbar:false}))}><X/></Tool>
    </div>
    {(error||tip)&&<div className={'pin-workspace-tip'+(error?' error':'')} role="status">{error||tip}</div>}
  </aside></TipContext.Provider>;
}
