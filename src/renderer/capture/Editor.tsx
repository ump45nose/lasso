import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, Circle, Copy, Crop, Download, EyeOff, Grid3x3, Hash, Highlighter, Minus, MousePointer2, MoveUpRight, PenLine, Pin, Pipette, Plus, Redo2, ScanLine, ScanText, Send, Slash, Square, TextSelect, Trash2, Type, Undo2, Droplets, X } from 'lucide-react';
import type { CaptureFrame, CaptureRect, ExportAction, OCRLine, OCRMode, ScreenshotState } from '../../shared/capture';
import { pixelRect } from '../../shared/capture';
import { Glide, Segmented, spring } from '../motion';
import { AnnotationEditor, intersects, type Style, type Tool } from './annotations';
import './text-layer.css';
import './editor.css';
import { selectedOCRText } from './selected-text';

const tools: [Tool, string, ReactNode][][] = [
  [['text-select', '选字 · 图上拖选文字', <TextSelect />], ['select', '选择 · 移动、调整标注', <MousePointer2 />]],
  [['arrow', '箭头', <MoveUpRight />], ['line', '直线', <Slash />], ['rectangle', '矩形', <Square />], ['ellipse', '椭圆', <Circle />], ['pen', '画笔', <PenLine />], ['highlight', '高亮', <Highlighter />], ['text', '文字 · 点击添加', <Type />], ['number', '序号 · 点击递增', <Hash />]],
  [['redact', '遮挡 · 实色盖住敏感信息', <EyeOff />], ['mosaic', '马赛克', <Grid3x3 />], ['blur', '模糊', <Droplets />]],
  [['crop', '裁剪 · 可撤销', <Crop />], ['picker', '取色 · 放大镜看像素', <Pipette />]]
];
const styled: Tool[] = ['arrow', 'line', 'rectangle', 'ellipse', 'pen', 'highlight', 'text', 'number'];
const sizes = [16, 24, 32, 40, 48, 64, 96];
const colors=['#e24a35','#eaaa31','#3a9866','#337cc1','#9b62b8','#171717','#ffffff'];
/** OCR status text maps to a dot: running, ready, needs attention, or waiting for edits to finish. */
const ocrTone = (status: string) => status.startsWith('正在') ? 'loading' : status.startsWith('拖选') || status.startsWith('已复制') ? 'ok' : status.includes('未') ? 'warn' : 'idle';
export function Editor({state}:{state:ScreenshotState}){
  const canvasRef=useRef<HTMLCanvasElement>(null),viewportRef=useRef<HTMLDivElement>(null),textRef=useRef<HTMLDivElement>(null),engine=useRef<AnnotationEditor|null>(null);
  const [ready,setReady]=useState(false),[tool,setTool]=useState<Tool>('text-select'),[style,setStyle]=useState<Style>({color:colors[0],width:4,fontSize:32}),[revision,setRevision]=useState(0),[zoom,setZoom]=useState(1),[crop,setCrop]=useState<CaptureRect|null>(null),[preview,setPreview]=useState<CaptureRect|null>(null);
  const [lines,setLines]=useState<OCRLine[]>([]),[ocrStatus,setOCRStatus]=useState('正在识别文字…'),[selectedText,setSelectedText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0),[format,setFormat]=useState<'png'|'jpeg'>('png');
  const [ocrMode,setOCRMode]=useState<OCRMode>('text'),[enhance,setEnhance]=useState(false);
  // Screen captures are edited in place over the frozen screen; clipboard and pin images get a desk window with zoom.
  const inline=state.origin==='screen';
  const [formatOpen,setFormatOpen]=useState(false),[ocrOpen,setOCROpen]=useState(false),[dockWidth,setDockWidth]=useState(0),dockRef=useRef<HTMLDivElement>(null);
  const ocrCache=useRef<{content:string;mode:OCRMode;enhance:boolean;lines:OCRLine[]}|null>(null),forceOCR=useRef(false);
  const version=useRef(0),mutating=useRef(false),exporting=useRef(false),selection=useRef(''),alive=useRef(true);
  const resize=useRef<{x:number;y:number;handle:string;original:CaptureRect;current:CaptureRect}|null>(null);
  const [sample,setSample]=useState<(NonNullable<ReturnType<AnnotationEditor['sample']>>&{left:number;top:number})|null>(null);
  const clearSelection=()=>{selection.current='';setSelectedText('');const s=window.getSelection();if(s?.anchorNode&&textRef.current?.contains(s.anchorNode))s.removeAllRanges();};
  const clearText=()=>{clearSelection();setLines([]);};
  const notifyOCR=()=>window.screenshot.invalidateOCR({id:state.editId,revision:version.current});
  const invalidate=()=>{if(!alive.current)return;mutating.current=true;version.current++;notifyOCR();clearText();setOCRStatus('编辑完成后识别文字');};
  const changed=()=>{if(!alive.current)return;mutating.current=false;version.current++;notifyOCR();clearText();const editor=engine.current;if(editor){setCrop({...editor.crop});setTool(editor.tool);}setRevision(version.current);};
  const showLines=(next:OCRLine[])=>{setLines(next);setOCRStatus(!next.length?'未识别到文字，可试小字增强':next.some(line=>line.confidence<.8)?'拖选图中文字；部分结果需核对':'拖选图中文字，可跨行复制');};
  useEffect(()=>{
    alive.current=true;let editor:AnnotationEditor|null=null;let canceled=false;
    const img=new Image();img.onload=()=>{void(async()=>{
      if(canceled||!canvasRef.current)return;
      const r=pixelRect(state.selection!,state.width,state.height,img.naturalWidth,img.naturalHeight),source=document.createElement('canvas');source.width=r.width;source.height=r.height;
      source.getContext('2d')!.drawImage(img,r.x,r.y,r.width,r.height,0,0,r.width,r.height);
      editor=new AnnotationEditor(canvasRef.current,source,changed,invalidate,setPreview);engine.current=editor;
      if(state.annotations)await editor.load(state.annotations);
      if(canceled)return;
      const area=viewportRef.current!;setZoom(inline?state.selection!.width/r.width:Math.min(1,Math.max(.05,Math.min((area.clientWidth-120)/r.width,(area.clientHeight-200)/r.height))));
      setReady(true);changed();
    })().catch(e=>setError('图片编辑未能加载：'+(e as Error).message));};img.onerror=()=>setError('截图加载失败，请重新选区。');img.src=state.image;
    return()=>{canceled=true;alive.current=false;version.current++;engine.current=null;editor?.dispose();};
  },[]);
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
  const choose=(next:Tool)=>{if(exporting.current)return;engine.current?.setTool(next);setTool(next);setSample(null);clearSelection();};
  const changeOCR=(mode:OCRMode,small:boolean,force=false)=>{if(engine.current?.isEditingText)(engine.current.canvas.getActiveObject() as import('fabric').IText).exitEditing();invalidate();mutating.current=false;forceOCR.current=force;setOCRMode(mode);setEnhance(small);setRevision(version.current);if(force)setRetry(n=>n+1);};
  const changeStyle=(next:Style)=>{setStyle(next);engine.current?.setStyle(next);};
  async function frame(includeAnnotations=false):Promise<CaptureFrame>{
    const editor=engine.current;if(!editor)throw Error('截图尚未加载');
    if(editor.isEditingText){(editor.canvas.getActiveObject() as import('fabric').IText).exitEditing();}
    if(mutating.current)throw Error('请先完成当前编辑。');
    const current=version.current,png=await editor.pixels();if(current!==version.current)throw Error('图片已变化，请重试。');
    return {id:state.editId,revision:current,crop:{...editor.crop},png,...(includeAnnotations?{annotations:editor.snapshot()}:{})};
  }
  async function output(action:ExportAction){
    if(exporting.current)return;exporting.current=true;setBusy(true);setError('');
    try{const result=await window.screenshot.export(await frame(action==='pin'),action,format);if(result.error)setError(result.error);}
    catch(e){setError((e as Error).message);}finally{exporting.current=false;if(alive.current)setBusy(false);}
  }
  async function copyText(){if(!selection.current||mutating.current)return;try{await window.screenshot.copyText({id:state.editId,revision:version.current,text:selection.current});setOCRStatus('已复制选中文字');}catch(e){setError((e as Error).message);}}
  async function sendText(){if(!selection.current||mutating.current||exporting.current)return;exporting.current=true;setBusy(true);try{const result=await window.screenshot.sendText({id:state.editId,revision:version.current,text:selection.current});if(result.error)setError(result.error);}catch(e){setError((e as Error).message);}finally{exporting.current=false;if(alive.current)setBusy(false);}}
  useEffect(()=>{
    const key=(e:KeyboardEvent)=>{
      if((e.target as HTMLElement).closest('input,textarea,select,[contenteditable=true]')||engine.current?.isEditingText)return;
      const command=e.metaKey||e.ctrlKey;
      if(command&&e.key.toLowerCase()==='c'){e.preventDefault();if(selection.current)void copyText();else void output('copy');}
      else if(command&&e.key.toLowerCase()==='s'){e.preventDefault();void output('save');}
      else if(command&&e.key.toLowerCase()==='z'){e.preventDefault();if(!exporting.current)void engine.current?.restore(e.shiftKey?1:-1).catch(e=>setError(e.message));}
      else if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();if(tool==='select'&&!exporting.current)engine.current?.remove();}
      else if(tool==='select'&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const n=e.shiftKey?10:1;if(!exporting.current)engine.current?.nudge(e.key==='ArrowLeft'?-n:e.key==='ArrowRight'?n:0,e.key==='ArrowUp'?-n:e.key==='ArrowDown'?n:0);}
      else if(e.key==='Escape'){e.preventDefault();if(!exporting.current)void window.screenshot.action('cancel');}
    };
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[tool,format]);
  const editor=engine.current,activeCrop=preview||crop;
  useLayoutEffect(()=>{const el=dockRef.current;if(!el)return;const observer=new ResizeObserver(()=>setDockWidth(el.offsetWidth));observer.observe(el);return()=>observer.disconnect();},[]);
  const sel=state.selection!,W=window.innerWidth,H=window.innerHeight,GAP=10,ROOM=104;
  // In place, the dock sits under the selection, else above it, else inside its bottom edge;
  // right-aligned when it fits the selection's width, centred on it otherwise, and always kept on screen.
  const below=sel.y+sel.height+GAP+ROOM<=H-8,above=!below&&sel.y-GAP-ROOM>=8;
  const dockLeft=dockWidth<=sel.width?sel.x+sel.width-dockWidth:sel.x+(sel.width-dockWidth)/2;
  const dockStyle=inline?{left:Math.max(8,Math.min(dockLeft,W-dockWidth-8)),...(below?{top:sel.y+sel.height+GAP}:{bottom:H-(above?sel.y-GAP:sel.y+sel.height-8)})}:undefined;
  const up=!inline||!below;
  const labelsInside=sel.y<44;
  const chipStyle=inline?(labelsInside?{right:W-sel.x-sel.width+8,top:sel.y+8}:{right:W-sel.x-sel.width,bottom:H-sel.y+8}):undefined;
  const closeMenus=()=>{setFormatOpen(false);setOCROpen(false);};
  const reselect=()=>{if(editor?.count&&!window.confirm('重新选区会清除当前标注，是否继续？'))return;void window.screenshot.action('reselect');};
  const panelKind=styled.includes(tool)?'style':['redact','mosaic','blur'].includes(tool)?'privacy':tool==='crop'?'crop':null;
  const panel=panelKind==='style'?<>
      <div className="ed-colors" role="radiogroup" aria-label="标注颜色">{colors.map(color=><button key={color} role="radio" aria-checked={style.color===color} aria-label={`颜色 ${color}`} style={{'--swatch':color} as React.CSSProperties} disabled={busy} onClick={()=>changeStyle({...style,color})}/>)}</div>
      <span className="ed-sep"/>
      {tool==='text'||tool==='number'?<Segmented label="文字字号" value={String(style.fontSize)} onChange={size=>changeStyle({...style,fontSize:Number(size)})} options={sizes.map(n=>[String(n),String(n)] as const)}/>
        :<label className="ed-width" title="线条粗细"><span className="ed-width-dot"><i style={{width:Math.min(16,style.width+2),height:Math.min(16,style.width+2),background:style.color}}/></span>
          <input type="range" min="1" max="24" value={style.width} aria-label="线条粗细" disabled={busy} onChange={e=>changeStyle({...style,width:Number(e.target.value)})}/><span className="mono">{style.width}</span></label>}
    </>:panelKind==='privacy'?<span className="ed-hint">敏感内容请用「遮挡」，马赛克和模糊只是视觉效果</span>
    :panelKind==='crop'?<><span className="ed-hint">拖动画面或边角裁剪</span><button className="ed-text" disabled={busy} onClick={()=>editor?.resetCrop()}>恢复裁剪</button></>:null;
  const toolButton=(id:Tool,label:string,icon:ReactNode)=><button key={id} className="ed-tool" data-tip={label} aria-label={label} aria-pressed={tool===id} disabled={!ready||busy} onClick={()=>choose(id)}>{tool===id&&<Glide id="ed-tool" className="ed-tool-on"/>}{icon}</button>;
  return <section className={'ed '+(inline?'ed-inline':'ed-window')} aria-label="截图编辑器" aria-busy={busy}>
    {inline?<><img className="cap-background" src={state.image} draggable={false} alt=""/>
      <div className="cap-rect ed-hole" style={{left:sel.x,top:sel.y,width:sel.width,height:sel.height}}><span className={'cap-size'+(labelsInside?' inside':'')}><span className="mono">{crop?`${crop.width} × ${crop.height}`:'…'}</span><span className="cap-source">像素</span></span></div></>
      :<header className="ed-drag"><strong>图片编辑</strong><span className="mono">{crop?`${crop.width} × ${crop.height}`:'正在加载…'}</span></header>}
    <div className="ed-viewport" ref={viewportRef} inert={busy} onPointerDown={closeMenus}>
      <div className="editor-stage ed-stage" style={{...(inline?{left:sel.x,top:sel.y}:{}),width:editor?editor.source.width*zoom:0,height:editor?editor.source.height*zoom:0}} onPointerMove={e=>{if(tool!=='picker'||busy||!editor)return;const r=e.currentTarget.getBoundingClientRect(),value=editor.sample((e.clientX-r.left)/zoom,(e.clientY-r.top)/zoom);setSample(value?{...value,left:Math.max(8,Math.min(window.innerWidth-148,e.clientX+20)),top:Math.max(8,Math.min(window.innerHeight-175,e.clientY+20))}:null);}} onPointerLeave={()=>setSample(null)} onClick={()=>{if(tool==='picker'&&sample)changeStyle({...style,color:sample.color});}}>
        <div className="editor-pixels" style={{transform:`scale(${zoom})`,width:editor?.source.width,height:editor?.source.height}}>
          <canvas ref={canvasRef} aria-label="标注画布"/>
          <div ref={textRef} className={'editor-text-layer '+(tool==='text-select'?'enabled':'')} aria-label="识别文字"
            onPointerDown={e=>{if(!e.shiftKey){window.getSelection()?.removeAllRanges();selection.current='';setSelectedText('');}}}
            onDragStart={e=>e.preventDefault()}
            onCopy={e=>{if(selection.current){e.preventDefault();e.clipboardData.setData('text/plain',selection.current);}}}>
            {lines.map((line,index)=><div className="editor-text-line" key={index} style={{left:line.x,top:line.y,width:line.width,height:line.height}}>{line.glyphs.map((g,i)=><span key={i} style={{left:g.x-line.x,top:g.y-line.y,width:g.width,height:g.height,fontSize:g.height*.95,lineHeight:`${g.height}px`}}>{g.text}</span>)}</div>)}
          </div>
          {activeCrop&&crop&&<div className="editor-shade" aria-hidden="true"><i style={{left:activeCrop.x,top:activeCrop.y,width:activeCrop.width,height:activeCrop.height}}/></div>}
          {activeCrop&&crop&&<div className="editor-crop" style={{left:activeCrop.x,top:activeCrop.y,width:activeCrop.width,height:activeCrop.height,outlineWidth:1.5/zoom}}
            onPointerDown={e=>{const handle=(e.target as HTMLElement).dataset.handle;if(!handle||!editor)return;e.preventDefault();e.stopPropagation();invalidate();resize.current={x:e.clientX,y:e.clientY,handle,original:{...crop},current:{...crop}};e.currentTarget.setPointerCapture(e.pointerId);}}
            onPointerMove={e=>{const g=resize.current;if(!g||!editor)return;const dx=(e.clientX-g.x)/zoom,dy=(e.clientY-g.y)/zoom,r={...g.original};if(g.handle.includes('w')){r.x=Math.max(0,Math.min(r.x+r.width-2,r.x+dx));r.width=g.original.x+g.original.width-r.x;}if(g.handle.includes('e'))r.width=Math.max(2,Math.min(editor.source.width-r.x,r.width+dx));if(g.handle.includes('n')){r.y=Math.max(0,Math.min(r.y+r.height-2,r.y+dy));r.height=g.original.y+g.original.height-r.y;}if(g.handle.includes('s'))r.height=Math.max(2,Math.min(editor.source.height-r.y,r.height+dy));g.current=r;setPreview(r);}}
            onPointerUp={()=>{const g=resize.current;resize.current=null;setPreview(null);if(g)editor?.applyCrop(g.current);}}
            onPointerCancel={()=>{resize.current=null;setPreview(null);changed();}}>
            {['nw','n','ne','e','se','s','sw','w'].map(h=><i key={h} data-handle={h} className={'editor-crop-handle '+h} style={{width:9/zoom,height:9/zoom,margin:-4.5/zoom,borderWidth:1.5/zoom,borderRadius:2/zoom}}/>)}
          </div>}
        </div>
      </div>
    </div>
    <motion.div className="ed-chip" style={chipStyle} initial={{opacity:0,y:4}} animate={{opacity:1,y:0}} transition={{...spring,delay:.04}}>
      <button className="ed-chip-main" aria-expanded={ocrOpen} aria-label="文字识别选项" disabled={!ready} onClick={()=>{setFormatOpen(false);setOCROpen(o=>!o);}}><span className={'ed-dot '+ocrTone(ocrStatus)}/><ScanText/><span className="ed-chip-text" role="status">{ocrStatus}</span><ChevronDown className="ed-chev"/></button>
      <AnimatePresence initial={false}>{selectedText&&<motion.span key="text" className="ed-chip-actions" initial={{opacity:0,width:0}} animate={{opacity:1,width:'auto'}} exit={{opacity:0,width:0}} transition={spring}>
        <button onMouseDown={e=>e.preventDefault()} disabled={busy} onClick={()=>void copyText()}><Copy/>复制文字</button>
        <button onMouseDown={e=>e.preventDefault()} disabled={busy} onClick={()=>void sendText()}><Send/>文字预设</button></motion.span>}</AnimatePresence>
      <AnimatePresence>{ocrOpen&&<motion.div className="ed-pop" initial={{opacity:0,y:-4,scale:.98}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,transition:{duration:.1}}} transition={spring}>
        <Segmented label="文字识别模式" value={ocrMode} onChange={mode=>changeOCR(mode,enhance)} options={[['text','中英正文'],['code','代码 / 网址']]}/>
        <div className="ed-pop-row"><span>小字增强</span><button className="l-switch" role="switch" aria-checked={enhance} aria-label="小字增强" disabled={!ready||busy} onClick={()=>changeOCR(ocrMode,!enhance)}><span/></button></div>
        <button className="ed-text" disabled={!ready||busy} onClick={()=>{setOCROpen(false);changeOCR(ocrMode,enhance,true);}}>重新识别</button>
      </motion.div>}</AnimatePresence>
    </motion.div>
    <motion.div ref={dockRef} className={'ed-dock'+(up?' up':'')} style={dockStyle} initial={{opacity:0,y:up?6:-6}} animate={{opacity:1,y:0}} transition={spring}>
      <AnimatePresence initial={false}>{panel&&<motion.div key={panelKind} className="ed-panel" initial={{opacity:0,y:up?4:-4,scale:.98}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,transition:{duration:.1}}} transition={spring}>{panel}</motion.div>}</AnimatePresence>
      <div className="ed-bars">
        <div className="ed-bar" role="toolbar" aria-label="标注工具">
          {tools.map((group,index)=><Fragment key={index}>{index>0&&<span className="ed-sep"/>}{group.map(([id,label,icon])=>toolButton(id,label,icon))}</Fragment>)}
          <span className="ed-sep"/>
          <button className="ed-tool" data-tip="撤销 ⌘Z" aria-label="撤销" disabled={!editor?.canUndo||busy} onClick={()=>void editor?.restore(-1).catch(e=>setError(e.message))}><Undo2/></button>
          <button className="ed-tool" data-tip="重做 ⇧⌘Z" aria-label="重做" disabled={!editor?.canRedo||busy} onClick={()=>void editor?.restore(1).catch(e=>setError(e.message))}><Redo2/></button>
          <button className="ed-tool" data-tip="删除所选标注" aria-label="删除所选标注" disabled={tool!=='select'||busy} onClick={()=>editor?.remove()}><Trash2/></button>
        </div>
        <div className="ed-bar" role="toolbar" aria-label="输出">
          {inline&&<button className="ed-tool" data-tip="重新截图" aria-label="重新截图" disabled={busy} onClick={reselect}><ScanLine/></button>}
          <span className="ed-split">
            <button className="ed-tool" data-tip={`保存为 ${format.toUpperCase()} ⌘S`} aria-label="保存" disabled={!ready||busy} onClick={()=>void output('save')}><Download/></button>
            <button className="ed-caret" aria-label="保存格式" aria-expanded={formatOpen} disabled={busy} onClick={()=>{setOCROpen(false);setFormatOpen(o=>!o);}}><ChevronDown/></button>
            <AnimatePresence>{formatOpen&&<motion.span className="ed-menu" role="menu" initial={{opacity:0,y:up?4:-4}} animate={{opacity:1,y:0}} exit={{opacity:0,transition:{duration:.1}}} transition={spring}>
              {(['png','jpeg'] as const).map(f=><button key={f} role="menuitemradio" aria-checked={format===f} onClick={()=>{setFormat(f);setFormatOpen(false);}}>{f.toUpperCase()}</button>)}</motion.span>}</AnimatePresence>
          </span>
          <button className="ed-tool" data-tip={state.pinId?'更新贴图':'贴到桌面'} aria-label={state.pinId?'更新贴图':'贴图'} disabled={!ready||busy} onClick={()=>void output('pin')}><Pin/></button>
          <button className="ed-text" disabled={!ready||busy} onClick={()=>void output('image')}><Send/>图片预设</button>
          <button className="ed-primary" disabled={!ready||busy} onClick={()=>void output('copy')}><Copy/>复制</button>
          <button className="ed-tool" data-tip="关闭 Esc" aria-label="关闭截图编辑器" disabled={busy} onClick={()=>void window.screenshot.action('cancel')}><X/></button>
        </div>
      </div>
    </motion.div>
    {!inline&&<div className="ed-zoom"><button aria-label="缩小" onClick={()=>setZoom(z=>Math.max(.05,+(z-.1).toFixed(2)))}><Minus/></button><span className="mono">{Math.round(zoom*100)}%</span><button aria-label="放大" onClick={()=>setZoom(z=>Math.min(3,+(z+.1).toFixed(2)))}><Plus/></button></div>}
    {tool==='picker'&&sample&&<aside className="ed-loupe" style={{left:sample.left,top:sample.top}} aria-label="像素放大镜"><div><img src={sample.image} alt="放大的原始像素"/><i/></div><span><b style={{background:sample.color}}/><code>{sample.color}</code></span><small>{sample.x}, {sample.y} · 点击选色</small></aside>}
    <AnimatePresence>{error&&<motion.div className="ed-toast" role="alert" initial={{opacity:0,y:-6}} animate={{opacity:1,y:0}} exit={{opacity:0,transition:{duration:.12}}} transition={spring}>{error}<button aria-label="关闭提示" onClick={()=>setError('')}><X/></button></motion.div>}</AnimatePresence>
  </section>;
}
