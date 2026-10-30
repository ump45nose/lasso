import { RegionControls } from './RegionControls';
import { regionPoints,resizeRegion,moveRegion } from '../../shared/region-geometry';
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, Circle, Copy, Crop, Download, EyeOff, Grid3x3, Hash, Highlighter, ImagePlus, Minus, MousePointer2, MoveUpRight, PenLine, Pin, Pipette, Plus, Redo2, ScanLine, ScanText, GalleryVerticalEnd, Send, Slash, Square, TextSelect, Trash2, Type, Undo2, Droplets, X } from 'lucide-react';
import type { CaptureFrame, CaptureRect, ExportAction, OCRLine, OCRMode, ScreenshotState } from '../../shared/capture';
import { pixelRect } from '../../shared/capture';
import { Glide, Segmented, spring } from '../motion';
import { AnnotationEditor, intersects, type Style, type Tool } from './annotations';
import { toolForKey, toolKeys } from './editor-shortcuts';
import './text-layer.css';
import './editor.css';
import { selectedOCRText } from './selected-text';
import { captureCanvas, CapturePixels } from './pixels';

const tools: [Tool, string, ReactNode][][] = [
  [['text-select', '选字 · 图上拖选文字', <TextSelect />], ['select', '选择 · 移动、调整标注', <MousePointer2 />]],
  [['arrow', '箭头', <MoveUpRight />], ['line', '直线', <Slash />], ['rectangle', '矩形', <Square />], ['ellipse', '椭圆', <Circle />], ['pen', '画笔', <PenLine />], ['highlight', '高亮', <Highlighter />], ['text', '文字 · 点击添加', <Type />], ['number', '序号 · 点击递增', <Hash />]],
  [['redact', '遮挡 · 实色盖住敏感信息', <EyeOff />], ['mosaic', '马赛克', <Grid3x3 />], ['blur', '模糊', <Droplets />]],
  [['crop', '裁剪 · 可撤销', <Crop />], ['picker', '取色 · 放大镜看像素', <Pipette />]]
];
const styled: Tool[] = ['arrow', 'line', 'rectangle', 'ellipse', 'pen', 'highlight', 'text', 'number'];
const sizes = [16, 24, 32, 40, 48, 64, 96];
const colors=['#e24a35','#eaaa31','#3a9866','#337cc1','#9b62b8','#171717','#ffffff']; // ui-check-ignore: annotation inks are image content, not UI
/** OCR status text maps to a dot: running, ready, needs attention, or waiting for edits to finish. */
const ocrTone = (status: string) => status.startsWith('正在') ? 'loading' : status.startsWith('拖选') || status.startsWith('已复制') ? 'ok' : status.includes('未') ? 'warn' : 'idle';
export function Editor({state}:{state:ScreenshotState}){
  const canvasRef=useRef<HTMLCanvasElement>(null),viewportRef=useRef<HTMLDivElement>(null),textRef=useRef<HTMLDivElement>(null),engine=useRef<AnnotationEditor|null>(null);
  const [ready,setReady]=useState(false),[tool,setTool]=useState<Tool>('text-select'),[style,setStyle]=useState<Style>({color:colors[0],width:4,fontSize:32}),[revision,setRevision]=useState(0),[zoom,setZoom]=useState(1),[crop,setCrop]=useState<CaptureRect|null>(null),[preview,setPreview]=useState<CaptureRect|null>(null);
  const [lines,setLines]=useState<OCRLine[]>([]),[ocrStatus,setOCRStatus]=useState('正在识别文字…'),[selectedText,setSelectedText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0),[format,setFormat]=useState<'png'|'jpeg'>(state.saveFormat??'png');
  const [ocrMode,setOCRMode]=useState<OCRMode>('text'),[enhance,setEnhance]=useState(false);
  // Screen captures are edited in place, at their placement over the frozen screen; clipboard and pin images get a desk window with zoom.
  const region=state.editableRegion;
  const place=state.placement,inline=Boolean(place);
  const [ratio,setRatio]=useState<number|null>(state.checkpoint?.regionRatio!==undefined?state.checkpoint.regionRatio:region?.ratio??null);
  const lastCopy=useRef(0),keyGesture=useRef(false),syncedRegion=useRef('');
  const [formatOpen,setFormatOpen]=useState(false),[ocrOpen,setOCROpen]=useState(false),[dockSize,setDockSize]=useState({width:0,height:0}),dockRef=useRef<HTMLDivElement>(null);
  const [controlsHost,setControlsHost]=useState<HTMLDivElement|null>(null),[regionPanelOpen,setRegionPanelOpen]=useState(false);
  const ocrCache=useRef<{content:string;mode:OCRMode;enhance:boolean;lines:OCRLine[]}|null>(null),forceOCR=useRef(false);
  const version=useRef(state.checkpoint?.revision ?? 0),mutating=useRef(false),exporting=useRef(false),selection=useRef(''),alive=useRef(true);
  const resize=useRef<{x:number;y:number;handle:string;original:CaptureRect;current:CaptureRect}|null>(null);
  const [sample,setSample]=useState<(NonNullable<ReturnType<AnnotationEditor['sample']>>&{left:number;top:number})|null>(null);
  const [sampleLocked,setSampleLocked]=useState(false),[colorFormat,setColorFormat]=useState<'hex'|'rgb'>('hex'),[colorCopied,setColorCopied]=useState(false);
  const clearSelection=()=>{selection.current='';setSelectedText('');const s=window.getSelection();if(s?.anchorNode&&textRef.current?.contains(s.anchorNode))s.removeAllRanges();};
  const clearText=()=>{clearSelection();setLines([]);};
  const notifyOCR=()=>window.screenshot.invalidateOCR({id:state.editId,revision:version.current});
  const invalidate=()=>{if(!alive.current)return;mutating.current=true;version.current++;notifyOCR();clearText();setOCRStatus('编辑完成后识别文字');};
  const changed=()=>{if(!alive.current)return;mutating.current=keyGesture.current;version.current++;notifyOCR();clearText();const editor=engine.current;if(editor){setCrop({...editor.crop});setTool(editor.tool);if(region&&!keyGesture.current&&syncedRegion.current!==JSON.stringify(editor.crop)){syncedRegion.current=JSON.stringify(editor.crop);void window.screenshot.updateRegion({id:state.editId,revision:version.current,crop:{...editor.crop}}).catch(e=>{syncedRegion.current='';setError(e.message);});}}setRevision(version.current);};
  const showLines=(next:OCRLine[])=>{setLines(next);setOCRStatus(!next.length?'未识别到文字，可试小字增强':next.some(line=>line.confidence<.8)?'拖选图中文字；部分结果需核对':'拖选图中文字，可跨行复制');};
  useEffect(()=>{
    alive.current=true;let editor:AnnotationEditor|null=null;let canceled=false;
    void(async()=>{
      if(!state.imageFrame)throw Error('截图图片已失效');
      const input=await captureCanvas(state,state.imageFrame);
      if(canceled||!canvasRef.current)return;
      const r=state.imageCrop??pixelRect(state.selection!,state.width,state.height,input.width,input.height);
      const full=Boolean(region)||r.x===0&&r.y===0&&r.width===input.width&&r.height===input.height;
      // The pixel cache also backs same-frame re-selection; the editor owns a separate canvas.
      const source=document.createElement('canvas');
      source.width=full?input.width:r.width;source.height=full?input.height:r.height;
      if(full)source.getContext('2d')!.drawImage(input,0,0);
      else source.getContext('2d')!.drawImage(input,r.x,r.y,r.width,r.height,0,0,r.width,r.height);
      if(state.backdropFrame)await captureCanvas(state,state.backdropFrame);
      if(canceled)return;
      editor=new AnnotationEditor(canvasRef.current,source,changed,invalidate,setPreview,region?.initialCrop);engine.current=editor;
      if(state.checkpoint)await editor.restoreCheckpoint(state.checkpoint);
      else if(state.annotations)await editor.load(state.annotations);
      if(canceled)return;
      const area=viewportRef.current!;setZoom(region?region.display.bounds.width/input.width:place?place.width/r.width:Math.min(1,Math.max(.05,Math.min((area.clientWidth-120)/r.width,(area.clientHeight-200)/r.height))));
      if(state.checkpoint){
        const saved=state.checkpoint;setZoom(saved.zoom);setFormat(saved.format);setOCRMode(saved.ocrMode);setEnhance(saved.enhance);setStyle({...saved.style});
        requestAnimationFrame(()=>{if(!canceled&&viewportRef.current){viewportRef.current.scrollLeft=saved.scrollLeft;viewportRef.current.scrollTop=saved.scrollTop;}});
      }
      editor.canvas.renderAll();setReady(true);changed();
    })().catch(e=>{if(!canceled){setError('图片编辑未能加载：'+(e as Error).message);window.screenshot.loadError(state.editId);}});
    return()=>{canceled=true;alive.current=false;version.current++;engine.current=null;editor?.dispose();};
  },[]);
  useEffect(()=>{if(ready)window.screenshot.ready(state.id,state.editId);},[ready,error,state.id,state.editId]);
  useEffect(()=>window.screenshot.onSuspend(()=>{
    const editor=engine.current,viewport=viewportRef.current;
    if(!ready||!editor||!viewport||mutating.current||exporting.current||!editor.canSuspend)return null;
    return {...editor.checkpoint(),revision:version.current,zoom,scrollLeft:viewport.scrollLeft,scrollTop:viewport.scrollTop,format,ocrMode,enhance,regionRatio:ratio};
  }),[ready,zoom,format,ocrMode,enhance,ratio]);
  useEffect(()=>{
    if(!ready||!crop)return;
    const current=version.current;let canceled=false;
    const content=engine.current!.contentKey,force=forceOCR.current;forceOCR.current=false;
    const cached=ocrCache.current;
    if(!force&&cached?.content===content&&cached.mode===ocrMode&&cached.enhance===enhance){showLines(cached.lines);return;}
    const timer=setTimeout(()=>{void(async()=>{
      if(mutating.current||!engine.current)return;
      try{
        setOCRStatus('正在识别文字…');
        const editor=engine.current,png=await editor.pixels();
        if(canceled||current!==version.current)return;
        const result=await window.screenshot.recognize({id:state.editId,revision:current,crop:{...editor.crop},png,mode:ocrMode,enhance,force});
        if(canceled||current!==version.current||result.id!==state.editId||result.revision!==current)return;
        const privacy=editor.privacy;
        // Conservatively remove a whole OCR line if any privacy mask touches it.
        const safe=result.lines.map(line=>({...line,x:line.x+crop.x,y:line.y+crop.y,glyphs:line.glyphs.map(g=>({...g,x:g.x+crop.x,y:g.y+crop.y}))})).filter(line=>!privacy.some(r=>intersects(line,r)));
        ocrCache.current={content,mode:ocrMode,enhance,lines:safe};showLines(safe);
      }catch(e){if(!canceled&&current===version.current)setOCRStatus('文字识别未完成，可重试；图片编辑不受影响');}
    })();},350);
    return()=>{canceled=true;clearTimeout(timer);};
  },[ready,revision,retry,ocrMode,enhance]);
  useEffect(()=>{
    const update=()=>{const value=selectedOCRText(textRef.current);selection.current=value;setSelectedText(value);};
    document.addEventListener('selectionchange',update);return()=>document.removeEventListener('selectionchange',update);
  },[]);
  const choose=(next:Tool)=>{if(exporting.current||!ready||(mutating.current&&!engine.current?.isEditingText))return;engine.current?.setTool(next);setTool(next);setSample(null);setSampleLocked(false);clearSelection();};
  const changeOCR=(mode:OCRMode,small:boolean,force=false)=>{if(engine.current?.isEditingText)(engine.current.canvas.getActiveObject() as import('fabric').IText).exitEditing();invalidate();mutating.current=false;forceOCR.current=force;setOCRMode(mode);setEnhance(small);setRevision(version.current);if(force)setRetry(n=>n+1);};
  const changeStyle=(next:Style)=>{setStyle(next);engine.current?.setStyle(next);};
  async function frame(includeAnnotations=false):Promise<CaptureFrame>{
    const editor=engine.current;if(!editor)throw Error('截图尚未加载');
    if(editor.isEditingText){(editor.canvas.getActiveObject() as import('fabric').IText).exitEditing();}
    if(mutating.current)throw Error('请先完成当前编辑。');
    const current=version.current,png=await editor.pixels();if(current!==version.current)throw Error('图片已变化，请重试。');
    return {id:state.editId,revision:current,crop:{...editor.crop},png,...(includeAnnotations?{annotations:editor.snapshot(Boolean(region))}:{})};
  }
  async function output(action:ExportAction){
    if(exporting.current)return;exporting.current=true;setBusy(true);setError('');
    try{const result=await window.screenshot.export(await frame(action==='pin'),action,format);if(result.error)setError(result.error);}
    catch(e){setError((e as Error).message);}finally{exporting.current=false;if(alive.current)setBusy(false);}
  }
  useEffect(()=>{if(ready&&state.copyIntent&&state.copyIntent!==lastCopy.current){lastCopy.current=state.copyIntent;void output('copy');}},[ready,state.copyIntent]);
  async function copyText(){if(!selection.current||mutating.current)return;try{await window.screenshot.copyText({id:state.editId,revision:version.current,text:selection.current});setOCRStatus('已复制选中文字');}catch(e){setError((e as Error).message);}}
  async function copyColor(){if(!sample||mutating.current||exporting.current)return;try{await window.screenshot.copyText({id:state.editId,revision:version.current,text:colorFormat==='hex'?sample.color:sample.rgb});if(alive.current)setColorCopied(true);}catch(e){setError((e as Error).message);}}
  useEffect(()=>setColorCopied(false),[sample,colorFormat]);
  async function sendText(){if(!selection.current||mutating.current||exporting.current)return;exporting.current=true;setBusy(true);try{const result=await window.screenshot.sendText({id:state.editId,revision:version.current,text:selection.current});if(result.error)setError(result.error);}catch(e){setError((e as Error).message);}finally{exporting.current=false;if(alive.current)setBusy(false);}}
  useEffect(()=>{
    let composing=false;
    const compositionStart=()=>{composing=true;},compositionEnd=()=>{composing=false;};
    const key=(e:KeyboardEvent)=>{
      if(e.defaultPrevented||e.isComposing||composing||e.keyCode===229||(e.target instanceof Element&&e.target.closest('input,textarea,select,[contenteditable=true]'))||engine.current?.isEditingText)return;
      if(e.key==='Shift'){engine.current?.setShift(true);return;}
      if(region&&mutating.current&&!keyGesture.current)return;
      if(keyGesture.current&&!e.key.startsWith('Arrow')){keyGesture.current=false;engine.current?.commitCrop();}
      const command=e.metaKey||e.ctrlKey;
      const editor=engine.current,lower=e.key.toLowerCase();
      if(command&&lower==='c'){e.preventDefault();if(exporting.current)return;if(editor?.copy())return;if(selection.current)void copyText();else void output('copy');}
      else if(command&&lower==='v'&&editor?.hasCopiedObjects){e.preventDefault();if(!exporting.current)void editor.paste().catch(e=>setError(e.message));}
      else if(command&&lower==='d'&&editor?.hasSelection){e.preventDefault();if(!exporting.current)void editor.duplicate().catch(e=>setError(e.message));}
      else if(command&&e.key.toLowerCase()==='s'){e.preventDefault();void output('save');}
      else if(command&&e.key.toLowerCase()==='z'){e.preventDefault();if(!exporting.current)void engine.current?.restore(e.shiftKey?1:-1).catch(e=>setError(e.message));}
      else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();if(tool==='select'&&!exporting.current)engine.current?.remove();}
      else if(tool==='select'&&editor?.hasSelection&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const n=e.shiftKey?10:1;if(!exporting.current)engine.current?.nudge(e.key==='ArrowLeft'?-n:e.key==='ArrowRight'?n:0,e.key==='ArrowUp'?-n:e.key==='ArrowDown'?n:0);}
      else if(region&&editor&&!selection.current&&!e.altKey&&!e.ctrlKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
        e.preventDefault();if(exporting.current)return;keyGesture.current=true;
        const side=e.key==='ArrowLeft'?'w':e.key==='ArrowRight'?'e':e.key==='ArrowUp'?'n':'s';
        const dx=side==='w'?-1:side==='e'?1:0,dy=side==='n'?-1:side==='s'?1:0;
        const next=e.shiftKey||e.metaKey?resizeRegion(editor.crop,side,dx*(e.shiftKey?-1:1),dy*(e.shiftKey?-1:1),region.sourceSize,ratio):moveRegion(editor.crop,dx,dy,region.sourceSize);
        invalidate();editor.applyCrop(next,false);
      }
      else if(e.key==='Enter'){e.preventDefault();if(!mutating.current)void output('copy');}
      else if(region&&tool==='crop'&&lower==='r'&&!command){e.preventDefault();void window.screenshot.lastRegion().then(r=>{if(r)engine.current?.applyCrop(r);}).catch(e=>setError(e.message));}
      else if(e.key==='Escape'){e.preventDefault();if(!exporting.current)void window.screenshot.action('cancel');}
      else if(!command&&!e.altKey&&!e.shiftKey){const next=toolForKey(e.key);if(next){e.preventDefault();choose(next);}}
    };
    const keyUp=(e:KeyboardEvent)=>{if(keyGesture.current&&e.key.startsWith('Arrow')){keyGesture.current=false;engine.current?.commitCrop();}if(e.key==='Shift')engine.current?.setShift(false);};
    const blur=()=>{if(keyGesture.current){keyGesture.current=false;engine.current?.commitCrop();}composing=false;engine.current?.setShift(false);};
    window.addEventListener('keydown',key);window.addEventListener('keyup',keyUp);window.addEventListener('blur',blur);window.addEventListener('compositionstart',compositionStart);window.addEventListener('compositionend',compositionEnd);
    return()=>{window.removeEventListener('keydown',key);window.removeEventListener('keyup',keyUp);window.removeEventListener('blur',blur);window.removeEventListener('compositionstart',compositionStart);window.removeEventListener('compositionend',compositionEnd);};
  },[tool,format,ready,ratio]);
  const editor=engine.current,activeCrop=preview||crop;
  useLayoutEffect(()=>{const el=dockRef.current;if(!el)return;const observer=new ResizeObserver(()=>setDockSize({width:el.offsetWidth,height:el.offsetHeight}));observer.observe(el);return()=>observer.disconnect();},[]);
  const sel=region&&activeCrop?regionPoints(activeCrop,region.display.bounds,region.sourceSize):place??state.selection!,W=window.innerWidth,H=window.innerHeight,GAP=10;
  // One measured stack owns the metadata, expanded controls and toolbars.
  const below=sel.y+sel.height+GAP+dockSize.height<=H-8,above=sel.y-GAP-dockSize.height>=8;
  const dockLeft=dockSize.width<=sel.width?sel.x+sel.width-dockSize.width:sel.x+(sel.width-dockSize.width)/2;
  const dockTop=below?sel.y+sel.height+GAP:above?sel.y-GAP-dockSize.height:Math.max(8,Math.min(H-dockSize.height-8,sel.y+sel.height-dockSize.height-8));
  const dockStyle=inline?{left:Math.max(8,Math.min(dockLeft,W-dockSize.width-8)),top:dockTop}:undefined;
  const up=!inline||!below;
  const closeMenus=()=>{setFormatOpen(false);setOCROpen(false);setRegionPanelOpen(false);};
  // With annotations, the first press arms the button and a second press within 3s discards them.
  const [armed,setArmed]=useState<'clear'|'reselect'|null>(null),[scrollArmed,setScrollArmed]=useState(false);
  useEffect(()=>{if(!armed)return;const timer=setTimeout(()=>setArmed(null),3000);return()=>clearTimeout(timer);},[armed]);
  const reselect=()=>{if(editor?.count&&armed!=='reselect'){setArmed('reselect');return;}void window.screenshot.action('reselect');};
  const startScroll=async()=>{if(!editor||exporting.current||mutating.current)return;if(editor.count&&!scrollArmed){setScrollArmed(true);return;}exporting.current=true;setBusy(true);try{const result=await window.screenshot.startScroll(editor.crop);if(result.error)setError(result.error);}catch(e){setError((e as Error).message);}finally{exporting.current=false;if(alive.current){setBusy(false);setScrollArmed(false);}}};
  const panelKind=styled.includes(tool)?'style':['redact','mosaic','blur'].includes(tool)?'privacy':tool==='crop'?'crop':null;
  const panel=panelKind==='style'?<>
      <div className="ed-colors" role="radiogroup" aria-label="标注颜色">{colors.map(color=><button key={color} role="radio" aria-checked={style.color===color} aria-label={`颜色 ${color}`} style={{'--swatch':color} as React.CSSProperties} disabled={busy} onClick={()=>changeStyle({...style,color})}/>)}</div>
      <span className="ed-sep"/>
      {tool==='text'||tool==='number'?<Segmented label="文字字号" value={String(style.fontSize)} onChange={size=>changeStyle({...style,fontSize:Number(size)})} options={sizes.map(n=>[String(n),String(n)] as const)}/>
        :<label className="ed-width" title="线条粗细"><span className="ed-width-dot"><i style={{width:Math.min(16,style.width+2),height:Math.min(16,style.width+2),background:style.color}}/></span>
          <input type="range" min="1" max="24" value={style.width} aria-label="线条粗细" disabled={busy} onChange={e=>changeStyle({...style,width:Number(e.target.value)})}/><span className="mono">{style.width}</span></label>}
    </>:panelKind==='privacy'?<span className="ed-hint">敏感内容请用「遮挡」，马赛克和模糊只是视觉效果</span>
    :panelKind==='crop'?<><span className="ed-hint">{region?'拖动移动 · 框外重画 · ⌥ 拖动移动':'拖动画面或边角裁剪'}</span><button className="ed-text" disabled={busy} onClick={()=>{if(region){setRatio(region.ratio);editor?.applyCrop(region.initialCrop);}else editor?.resetCrop();}}>{region?'恢复选区':'恢复裁剪'}</button></>:null;
  const toolButton=(id:Tool,label:string,icon:ReactNode)=>{if(region&&id==='crop')label='选区 · 移动、调整范围';return <button key={id} className="ed-tool" data-tip={`${label} ${toolKeys[id]}${id==='select'?' · ⌘C / ⌘V / ⌘D':['rectangle','ellipse','line','arrow'].includes(id)?' · ⇧ 约束':''}`} aria-label={label} aria-keyshortcuts={toolKeys[id]} aria-pressed={tool===id} disabled={!ready||busy} onClick={()=>choose(id)}>{tool===id&&<Glide id="ed-tool" className="ed-tool-on"/>}{icon}</button>;};
  const ocrChip=<motion.div className={'ed-chip'+(ocrOpen?' open':'')} initial={{opacity:0,y:4}} animate={{opacity:1,y:0}} transition={{...spring,delay:.04}}>
      <button className="ed-chip-main" aria-expanded={ocrOpen} aria-label="文字识别选项" disabled={!ready} onClick={()=>{setRegionPanelOpen(false);setFormatOpen(false);setOCROpen(o=>!o);}}><span className={'ed-dot '+ocrTone(ocrStatus)}/><ScanText/><span className="ed-chip-text" role="status">{ocrStatus}</span><ChevronDown className="ed-chev"/></button>
      <AnimatePresence initial={false}>{selectedText&&<motion.span key="text" className="ed-chip-actions" initial={{opacity:0,width:0}} animate={{opacity:1,width:'auto'}} exit={{opacity:0,width:0}} transition={spring}>
        <button onMouseDown={e=>e.preventDefault()} disabled={busy} onClick={()=>void copyText()}><Copy/>复制文字</button>
        <button onMouseDown={e=>e.preventDefault()} disabled={busy} onClick={()=>void sendText()}><Send/>文字预设</button></motion.span>}</AnimatePresence>
      <AnimatePresence>{ocrOpen&&<motion.div className="ed-pop" initial={{opacity:0,y:-4,scale:.98}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,transition:{duration:.1}}} transition={spring}>
        <Segmented label="文字识别模式" value={ocrMode} onChange={mode=>changeOCR(mode,enhance)} options={[['text','正文'],['code','代码 / 网址']]}/>
        <div className="ed-pop-row"><span>小字增强</span><button className="l-switch" role="switch" aria-checked={enhance} aria-label="小字增强" disabled={!ready||busy} onClick={()=>changeOCR(ocrMode,!enhance)}><span/></button></div>
        <button className="ed-text" disabled={!ready||busy} onClick={()=>{setOCROpen(false);changeOCR(ocrMode,enhance,true);}}>重新识别</button>
      </motion.div>}</AnimatePresence>
    </motion.div>;
  return <section onDoubleClick={e=>{if(!region||!crop||!['text-select','crop'].includes(tool)||selection.current||editor?.hasSelection||editor?.isEditingText||(e.target as Element).closest('button,input,.region-panel,.editor-text-line'))return;const b=regionPoints(crop,region.display.bounds,region.sourceSize);if(e.clientX>=b.x&&e.clientY>=b.y&&e.clientX<=b.x+b.width&&e.clientY<=b.y+b.height)void output('copy');}} onContextMenu={e=>{if(!region||busy)return;e.preventDefault();if(formatOpen||ocrOpen){closeMenus();return;}if(engine.current?.hasSelection||!['text-select','crop'].includes(tool)){choose('text-select');return;}if(editor?.count&&armed!=='clear'){setArmed('clear');return;}void window.screenshot.clearRegion().catch(e=>setError(e.message));}} className={'ed '+(inline?'ed-inline':'ed-window')+(region?' ed-region':'')} aria-label="截图编辑器" aria-busy={busy}>
    {inline?<>{state.backdropFrame&&<CapturePixels state={state} frameId={state.backdropFrame} className="cap-background"/>}
      <div className="cap-rect ed-hole" style={{left:sel.x,top:sel.y,width:sel.width,height:sel.height}}>{!region&&<span className="cap-size"><span className="mono">{crop?`${crop.width} × ${crop.height}`:'…'}</span><span className="cap-source">像素</span></span>}</div></>
      :<header className="ed-drag"><strong>图片编辑</strong><span className="mono">{crop?`${crop.width} × ${crop.height}`:'正在加载…'}</span></header>}
    <div className="ed-viewport" ref={viewportRef} inert={busy} onPointerDown={closeMenus}
      >
      <div className="editor-stage ed-stage" style={{...(inline?{left:region?0:sel.x,top:region?0:sel.y}:{}),width:editor?editor.source.width*zoom:0,height:editor?editor.source.height*zoom:0}} onPointerMove={e=>{if(tool!=='picker'||busy||!editor||sampleLocked)return;const r=e.currentTarget.getBoundingClientRect(),value=editor.sample((e.clientX-r.left)/zoom,(e.clientY-r.top)/zoom);setSample(value?{...value,left:Math.max(8,Math.min(window.innerWidth-148,e.clientX+20)),top:Math.max(8,Math.min(window.innerHeight-232,e.clientY+20))}:null);}} onPointerLeave={()=>{if(!sampleLocked)setSample(null);}} onClick={e=>{if(tool!=='picker'||busy||!editor)return;const r=e.currentTarget.getBoundingClientRect(),value=editor.sample((e.clientX-r.left)/zoom,(e.clientY-r.top)/zoom);if(value){setSample({...value,left:Math.max(8,Math.min(window.innerWidth-148,e.clientX+20)),top:Math.max(8,Math.min(window.innerHeight-232,e.clientY+20))});setSampleLocked(true);changeStyle({...style,color:value.color});}}}>
        <div className="editor-pixels" style={{transform:`scale(${zoom},${region?region.display.bounds.height/region.sourceSize.height:zoom})`,...(region&&activeCrop?{clipPath:`inset(${activeCrop.y}px ${region.sourceSize.width-activeCrop.x-activeCrop.width}px ${region.sourceSize.height-activeCrop.y-activeCrop.height}px ${activeCrop.x}px)`}:{}),width:editor?.source.width,height:editor?.source.height}}>
          <canvas ref={canvasRef} aria-label="标注画布"/>
          <div ref={textRef} className={'editor-text-layer '+(tool==='text-select'?'enabled':'')} aria-label="识别文字"
            onPointerDown={e=>{if(!e.shiftKey){window.getSelection()?.removeAllRanges();selection.current='';setSelectedText('');}}}
            onDragStart={e=>e.preventDefault()}
            onCopy={e=>{if(selection.current){e.preventDefault();e.clipboardData.setData('text/plain',selection.current);}}}>
            {lines.map((line,index)=><div className="editor-text-line" key={index} style={{left:line.x,top:line.y,width:line.width,height:line.height}}>{line.glyphs.map((g,i)=><span key={i} style={{left:g.x-line.x,top:g.y-line.y,width:g.width,height:g.height,fontSize:g.height*.95,lineHeight:`${g.height}px`}}>{g.text}</span>)}</div>)}
          </div>
          {!region&&activeCrop&&crop&&<div className="editor-shade" aria-hidden="true"><i style={{left:activeCrop.x,top:activeCrop.y,width:activeCrop.width,height:activeCrop.height}}/></div>}
          {!region&&tool==='crop'&&activeCrop&&crop&&<div className="editor-crop" style={{left:activeCrop.x,top:activeCrop.y,width:activeCrop.width,height:activeCrop.height,outlineWidth:1.5/zoom}}
            onPointerDown={e=>{const handle=(e.target as HTMLElement).dataset.handle;if(!handle||!editor)return;e.preventDefault();e.stopPropagation();invalidate();resize.current={x:e.clientX,y:e.clientY,handle,original:{...crop},current:{...crop}};e.currentTarget.setPointerCapture(e.pointerId);}}
            onPointerMove={e=>{const g=resize.current;if(!g||!editor)return;const dx=(e.clientX-g.x)/zoom,dy=(e.clientY-g.y)/zoom,r={...g.original};if(g.handle.includes('w')){r.x=Math.max(0,Math.min(r.x+r.width-2,r.x+dx));r.width=g.original.x+g.original.width-r.x;}if(g.handle.includes('e'))r.width=Math.max(2,Math.min(editor.source.width-r.x,r.width+dx));if(g.handle.includes('n')){r.y=Math.max(0,Math.min(r.y+r.height-2,r.y+dy));r.height=g.original.y+g.original.height-r.y;}if(g.handle.includes('s'))r.height=Math.max(2,Math.min(editor.source.height-r.y,r.height+dy));g.current=r;setPreview(r);}}
            onPointerUp={()=>{const g=resize.current;resize.current=null;setPreview(null);if(g)editor?.applyCrop(g.current);}}
            onPointerCancel={()=>{resize.current=null;setPreview(null);changed();}}>
            {['nw','n','ne','e','se','s','sw','w'].map(h=><i key={h} data-handle={h} className={'editor-crop-handle '+h} style={{width:9/zoom,height:9/zoom,margin:-4.5/zoom,borderWidth:1.5/zoom,borderRadius:2/zoom}}/>)}
          </div>}
        </div>
      </div>
    </div>
    {region&&crop&&<RegionControls controlsHost={controlsHost} open={regionPanelOpen} setOpen={open=>{if(open){setOCROpen(false);setFormatOpen(false);}setRegionPanelOpen(open);}} context={region} crop={crop} displayCrop={activeCrop??crop} tool={tool} preview={r=>{if(r&&!mutating.current)invalidate();if(!r)mutating.current=false;setPreview(r);}} cancelPreview={()=>changed()} ratio={ratio} setRatio={setRatio} commit={r=>{invalidate();editor?.applyCrop(r);}} error={setError} busy={busy}/>}
    {!inline&&ocrChip}
    <motion.div ref={dockRef} className={'ed-dock'+(up?' up':'')} style={dockStyle} initial={{opacity:0,y:up?6:-6}} animate={{opacity:1,y:0}} transition={spring}>
      {inline&&<div className="ed-meta"><div className="ed-size-host" ref={setControlsHost}/>{ocrChip}</div>}
      <AnimatePresence initial={false}>{panel&&<motion.div key={panelKind} className="ed-panel" initial={{opacity:0,y:up?4:-4,scale:.98}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,transition:{duration:.1}}} transition={spring}>{panel}</motion.div>}</AnimatePresence>
      <AnimatePresence>{inline&&formatOpen&&<motion.div className="ed-menu ed-format-panel" role="menu" initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}>{(['png','jpeg'] as const).map(f=><button key={f} role="menuitemradio" aria-checked={format===f} onClick={()=>{setFormat(f);setFormatOpen(false);}}>{f.toUpperCase()}</button>)}</motion.div>}</AnimatePresence>
      <div className="ed-bars">
        <div className="ed-bar" role="toolbar" aria-label="标注工具">
          {tools.map((group,index)=><Fragment key={index}>{index>0&&<span className="ed-sep"/>}{group.map(([id,label,icon])=>toolButton(id,label,icon))}</Fragment>)}
          <span className="ed-sep"/>
          <button className="ed-tool" data-tip="撤销 ⌘Z" aria-label="撤销" disabled={!editor?.canUndo||busy} onClick={()=>void editor?.restore(-1).catch(e=>setError(e.message))}><Undo2/></button>
          <button className="ed-tool" data-tip="重做 ⇧⌘Z" aria-label="重做" disabled={!editor?.canRedo||busy} onClick={()=>void editor?.restore(1).catch(e=>setError(e.message))}><Redo2/></button>
          <button className="ed-tool" data-tip="删除所选标注" aria-label="删除所选标注" disabled={tool!=='select'||busy} onClick={()=>editor?.remove()}><Trash2/></button>
        </div>
        <div className="ed-bar" role="toolbar" aria-label="输出">
          {inline&&(armed?<button className="ed-text ed-armed" disabled={busy} onClick={armed==='clear'?()=>void window.screenshot.clearRegion().catch(e=>setError(e.message)):reselect}><ScanLine/>再点一次清除标注</button>
            :<button className="ed-tool" data-tip="重新截图" aria-label="重新截图" disabled={busy} onClick={reselect}><ScanLine/></button>)}
          {region&&<button className="ed-text" disabled={busy||!ready} onClick={()=>void startScroll()}><GalleryVerticalEnd/>{scrollArmed?'再点一次清除标注并开始':'长截图'}</button>}
          <span className="ed-split">
            <button className="ed-tool" data-tip={`另存副本 ${format.toUpperCase()} ⌘S`} aria-label="保存" disabled={!ready||busy} onClick={()=>void output('save')}><Download/></button>
            <button className="ed-caret" aria-label="保存格式" aria-expanded={formatOpen} disabled={busy} onClick={()=>{setRegionPanelOpen(false);setOCROpen(false);setFormatOpen(o=>!o);}}><ChevronDown/></button>
            <AnimatePresence>{!inline&&formatOpen&&<motion.span className="ed-menu" role="menu" initial={{opacity:0,y:up?4:-4}} animate={{opacity:1,y:0}} exit={{opacity:0,transition:{duration:.1}}} transition={spring}>
              {(['png','jpeg'] as const).map(f=><button key={f} role="menuitemradio" aria-checked={format===f} onClick={()=>{setFormat(f);setFormatOpen(false);}}>{f.toUpperCase()}</button>)}</motion.span>}</AnimatePresence>
          </span>
          <button className="ed-tool" data-tip={state.pinId?'更新贴图':'贴到桌面'} aria-label={state.pinId?'更新贴图':'贴图'} disabled={!ready||busy} onClick={()=>void output('pin')}><Pin/></button>
          <button className="ed-tool" data-tip="用于生图 · 使用处理后的图片" aria-label="用于生图" disabled={!ready||busy} onClick={()=>void output('media')}><ImagePlus/></button>
          <button className="ed-text" disabled={!ready||busy} onClick={()=>void output('image')}><Send/>图片预设</button>
          <button className="ed-primary" disabled={!ready||busy} onClick={()=>void output('copy')}><Copy/>复制</button>
          <button className="ed-tool" data-tip="关闭 Esc" aria-label="关闭截图编辑器" disabled={busy} onClick={()=>void window.screenshot.action('cancel')}><X/></button>
        </div>
      </div>
    </motion.div>
    {!inline&&<div className="ed-zoom"><button aria-label="缩小" onClick={()=>setZoom(z=>Math.max(.05,+(z-.1).toFixed(2)))}><Minus/></button><span className="mono">{Math.round(zoom*100)}%</span><button aria-label="放大" onClick={()=>setZoom(z=>Math.min(3,+(z+.1).toFixed(2)))}><Plus/></button></div>}
    {tool==='picker'&&sample&&<aside className={'ed-loupe'+(sampleLocked?' locked':'')} style={{left:sample.left,top:sample.top}} aria-label="像素放大镜"><div className="ed-loupe-pixels"><img src={sample.image} alt="放大的原始像素"/><i/></div><span className="ed-color-value"><b style={{background:sample.color}}/><code className={colorFormat==='rgb'?'ed-rgb':undefined}>{colorFormat==='hex'?sample.color:sample.rgb.replaceAll(', ', ',')}</code></span><div className="ed-loupe-controls"><Segmented label="取色格式" value={colorFormat} onChange={setColorFormat} options={ [['hex','HEX'],['rgb','RGB']] }/><button className="ed-tool" aria-label="复制颜色" disabled={busy} onClick={()=>void copyColor()}><Copy/></button></div><small role="status">{colorCopied?`已复制 ${colorFormat.toUpperCase()}`:`${sample.x}, ${sample.y} · ${sampleLocked?'点击画面重选':'点击固定取色'}`}</small></aside>}
    <AnimatePresence>{(error||state.outputError||state.outputStatus)&&<motion.div className={'ed-toast'+(!error&&!state.outputError?' ed-toast-success':'')} role={error||state.outputError?'alert':'status'} initial={{opacity:0,y:-6}} animate={{opacity:1,y:0}} exit={{opacity:0,transition:{duration:.12}}} transition={spring}>{[error,state.outputStatus,state.outputError].filter(Boolean).join('；')}{error&&!ready&&<button className="ed-text" onClick={()=>void window.screenshot.action('retry')}>重新加载图片</button>}{error&&<button aria-label="关闭提示" onClick={()=>setError('')}><X/></button>}</motion.div>}</AnimatePresence>
  </section>;
}
