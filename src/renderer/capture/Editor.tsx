import { RegionControls } from './RegionControls';
import { regionPoints,resizeRegion,moveRegion } from '../../shared/region-geometry';
import { Fragment, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Flashlight, Search, Stamp, Eraser, Link2, SlidersHorizontal, RotateCw, FlipHorizontal2, FlipVertical2, Contrast, Barcode, ChevronDown, Circle, Copy, Crop, Download, EyeOff, Grid3x3, Hash, Highlighter, Languages, Minus, MousePointer2, MoveUpRight, PenLine, Pin, Pipette, Plus, Redo2, ScanLine, ScanText, GalleryVerticalEnd, Send, Sigma, Slash, Square, Table2, TextSelect, Trash2, Type, Undo2, Droplets, X } from 'lucide-react';
import type { BarcodeItem, CaptureFrame, CaptureRect, ExportAction, OCRLine, OCRMode, ScreenshotState } from '../../shared/capture';
import type { TranslationBlock } from '../../shared/intelligence';
import { IntelligencePanel, type IntelligenceView } from './IntelligencePanel';
import { screenshotDefaults, screenshotOutputFormats, type AnnotationStyleMemory, type ScreenshotExportContentMode, type ScreenshotOutputFormat } from '../../shared/screenshot-settings';
import { defaultEditorShortcuts, type EditorShortcutMap } from '../../shared/shortcuts';
import { pixelRect } from '../../shared/capture';
import { Glide, Segmented, spring } from '../motion';
import { Switch } from '../Switch';
import { AnnotationEditor, intersects, type Style, type Tool } from './annotations';
import { editorActionForEvent, toolKeys } from './editor-shortcuts';
import './text-layer.css';
import './editor.css';
import { selectedOCRText } from './selected-text';
import { captureCanvas, CapturePixels } from './pixels';

const tools: [Tool, string, ReactNode][][] = [
  [['text-select', '选字 · 图上拖选文字', <TextSelect />], ['select', '选择 · 移动、调整标注', <MousePointer2 />]],
  [['arrow', '箭头', <MoveUpRight />], ['line', '直线', <Slash />], ['rectangle', '矩形', <Square />], ['ellipse', '椭圆', <Circle />], ['pen', '画笔', <PenLine />], ['highlight', '高亮', <Highlighter />], ['text', '文字 · 点击添加', <Type />], ['number', '序号 · 点击递增', <Hash />]],
  [['redact', '遮挡 · 实色盖住敏感信息', <EyeOff />], ['mosaic', '马赛克', <Grid3x3 />], ['blur', '模糊', <Droplets />], ['auto-mosaic', '联动遮挡相同文字', <Link2 />], ['inpaint', '智能消除 · 框选后以周围像素填补', <Eraser />]],
  [['spotlight', '聚光灯 · 框选重点', <Flashlight />], ['magnifier', '局部放大镜 · 2×', <Search />], ['watermark', '平铺水印', <Stamp />]],
  [['crop', '裁剪 · 可撤销', <Crop />], ['picker', '取色 · 放大镜看像素', <Pipette />]]
];
const styled: Tool[] = ['arrow', 'line', 'rectangle', 'ellipse', 'pen', 'highlight', 'text', 'number'];
const sizes = [16, 24, 32, 40, 48, 64, 96];
const colors=['#e24a35','#eaaa31','#3a9866','#337cc1','#9b62b8','#171717','#ffffff']; // ui-check-ignore: annotation inks are image content, not UI
/** OCR status text maps to a dot: running, ready, needs attention, or waiting for edits to finish. */
const ocrTone = (status: string) => status.startsWith('正在') ? 'loading' : status.startsWith('拖选') || status.startsWith('已复制') ? 'ok' : status.includes('未') ? 'warn' : 'idle';
type Sample = NonNullable<ReturnType<AnnotationEditor['sample']>> & { left: number; top: number };
interface PickerHandle { move(x: number, y: number, clientX: number, clientY: number): void; leave(): void; lock(x: number, y: number, clientX: number, clientY: number): string | null }
const placeLoupe = (clientX: number, clientY: number) => ({ left: Math.max(8, Math.min(window.innerWidth - 148, clientX + 20)), top: Math.max(8, Math.min(window.innerHeight - 232, clientY + 20)) });
const ColorLoupe = forwardRef<PickerHandle, { read: (x: number, y: number) => ReturnType<AnnotationEditor['sample']>; busy: boolean; copy: (text: string) => Promise<void>; fail: (message: string) => void; initialFormat:'hex'|'rgb'|'hsl'; crosshair:boolean }>(function ColorLoupe({ read, busy, copy, fail, initialFormat, crosshair }, ref) {
  const [sample, setSample] = useState<Sample | null>(null), [locked, setLocked] = useState(false), [format, setFormat] = useState<'hex' | 'rgb' | 'hsl'>(initialFormat), [copied, setCopied] = useState(false);
  const pixels = useRef<HTMLCanvasElement>(null), frame = useRef(0), pending = useRef<{ x: number; y: number; clientX: number; clientY: number } | null>(null), readRef = useRef(read);
  readRef.current = read;
  useEffect(() => setCopied(false), [sample?.color, sample?.x, sample?.y, format]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  useLayoutEffect(() => {
    const canvas = pixels.current; if (!canvas || !sample) return;
    const ctx = canvas.getContext('2d')!; ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, 120, 120); ctx.drawImage(sample.image, 0, 0, 120, 120);
  }, [sample]);
  useImperativeHandle(ref, () => ({
    move(x, y, clientX, clientY) {
      if (locked) return; pending.current = { x, y, clientX, clientY };
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0; const next = pending.current; if (!next) return;
        const value = readRef.current(next.x, next.y); setSample(value ? { ...value, ...placeLoupe(next.clientX, next.clientY) } : null);
      });
    },
    leave() { if (!locked) setSample(null); },
    lock(x, y, clientX, clientY) {
      const value = readRef.current(x, y); if (!value) return null;
      setLocked(true); setSample({ ...value, ...placeLoupe(clientX, clientY) }); return value.color;
    }
  }), [locked]);
  if (!sample) return null;
  return <aside className={'ed-loupe' + (locked ? ' locked' : '')} style={{ left: sample.left, top: sample.top }} aria-label="像素放大镜"><div className="ed-loupe-pixels"><canvas ref={pixels} width={120} height={120} />{crosshair&&<i />}</div><span className="ed-color-value"><b style={{ background: sample.color }} /><code className={format !== 'hex' ? 'ed-rgb' : undefined}>{format === 'hex' ? sample.color : sample[format].replaceAll(', ', ',')}</code></span><div className="ed-loupe-controls"><Segmented label="取色格式" value={format} onChange={setFormat} options={[['hex', 'HEX'], ['rgb', 'RGB'], ['hsl', 'HSL']]} /><button className="ed-tool" aria-label="复制颜色" disabled={busy} onClick={() => void copy(format === 'hex' ? sample.color : sample[format]).then(() => setCopied(true)).catch(e => fail((e as Error).message))}><Copy /></button></div><small role="status">{copied ? `已复制 ${format.toUpperCase()}` : `${sample.x}, ${sample.y} · ${locked ? '点击画面重选' : '点击固定取色'}`}</small></aside>;
});
export function Editor({state, source:given}:{state:ScreenshotState; source?:HTMLCanvasElement}){
  const memory=useRef<AnnotationStyleMemory>(state.annotationMemory??screenshotDefaults().annotationMemory),memorySave=useRef(Promise.resolve());
  const initialTool=Object.hasOwn(toolKeys,memory.current.lastTool)?memory.current.lastTool as Tool:'text-select';
  const rememberedStyle=(next:Tool):Style=>({...memory.current.defaultStyle,...(memory.current.rememberToolStyles?memory.current.perTool[next]:{})});
  const settings=state.screenshotSettings??screenshotDefaults(),visibleTool=(id:string)=>!state.toolbarTools?.length||state.toolbarTools.includes(id);
  const shortcuts:EditorShortcutMap & Partial<Record<Tool,string>>={...defaultEditorShortcuts(),...state.editorShortcuts};
  const canvasRef=useRef<HTMLCanvasElement>(null),viewportRef=useRef<HTMLDivElement>(null),textRef=useRef<HTMLDivElement>(null),engine=useRef<AnnotationEditor|null>(null);
  const [ready,setReady]=useState(false),[tool,setTool]=useState<Tool>(initialTool),[style,setStyle]=useState<Style>(()=>rememberedStyle(initialTool)),[revision,setRevision]=useState(0),[zoom,setZoom]=useState(1),[crop,setCrop]=useState<CaptureRect|null>(null),[preview,setPreview]=useState<CaptureRect|null>(null);
  const [lines,setLines]=useState<OCRLine[]>([]),[ocrStatus,setOCRStatus]=useState('正在识别文字…'),[selectedText,setSelectedText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0),[format,setFormat]=useState<ScreenshotOutputFormat>(state.saveFormat??'png');
  const [contentMode,setContentMode]=useState<ScreenshotExportContentMode|undefined>(),[selectedBackground,setSelectedBackground]=useState<boolean|null>(null);
  const [adjustOpen,setAdjustOpen]=useState(false),[mosaicWord,setMosaicWord]=useState(''),[selectionShape,setSelectionShape]=useState(settings.selectionShape),[magnifierShape,setMagnifierShape]=useState<'circle'|'rect'>('circle');
  const [ocrMode,setOCRMode]=useState<OCRMode>('text'),[enhance,setEnhance]=useState(false);
  const [barcodes,setBarcodes]=useState<BarcodeItem[]>([]),[intelligence,setIntelligence]=useState<IntelligenceView|null>(null),[translations,setTranslations]=useState<TranslationBlock[]>([]);
  // Screen captures are edited in place, at their placement over the frozen screen; clipboard and pin images get a desk window with zoom.
  const region=state.editableRegion;
  const place=state.placement,inline=Boolean(place);
  const [ratio,setRatio]=useState<number|null>(state.checkpoint?.regionRatio!==undefined?state.checkpoint.regionRatio:region?.ratio??null);
  const lastCopy=useRef(0),keyGesture=useRef(false),syncedRegion=useRef('');
  const [formatOpen,setFormatOpen]=useState(false),[ocrOpen,setOCROpen]=useState(false),[dockSize,setDockSize]=useState({width:0,height:0}),dockRef=useRef<HTMLDivElement>(null);
  const [controlsHost,setControlsHost]=useState<HTMLDivElement|null>(null),[regionPanelOpen,setRegionPanelOpen]=useState(false);
  const ocrCache=useRef<{content:string;mode:OCRMode;enhance:boolean;lines:OCRLine[];barcodes:BarcodeItem[]}|null>(null),forceOCR=useRef(false);
  const version=useRef(state.checkpoint?.revision ?? 0),mutating=useRef(false),exporting=useRef(false),selection=useRef(''),alive=useRef(true);
  const resize=useRef<{x:number;y:number;handle:string;original:CaptureRect;current:CaptureRect}|null>(null);
  const picker=useRef<PickerHandle>(null);
  const clearSelection=()=>{selection.current='';setSelectedText('');const s=window.getSelection();if(s?.anchorNode&&textRef.current?.contains(s.anchorNode))s.removeAllRanges();};
  const clearText=()=>{clearSelection();setLines([]);setBarcodes([]);setIntelligence(null);setTranslations([]);};
  const notifyOCR=()=>window.screenshot.invalidateOCR({id:state.editId,revision:version.current});
  const invalidate=()=>{if(!alive.current)return;mutating.current=true;version.current++;notifyOCR();clearText();setOCRStatus('编辑完成后识别文字');};
  const changed=()=>{if(!alive.current)return;mutating.current=keyGesture.current;version.current++;notifyOCR();clearText();const editor=engine.current;if(editor){setCrop({...editor.crop});setTool(editor.tool);if(region&&!keyGesture.current&&syncedRegion.current!==JSON.stringify(editor.crop)){syncedRegion.current=JSON.stringify(editor.crop);void window.screenshot.updateRegion({id:state.editId,revision:version.current,crop:{...editor.crop}}).catch(e=>{syncedRegion.current='';setError(e.message);});}}setRevision(version.current);};
  const showLines=(next:OCRLine[],codes:BarcodeItem[])=>{setLines(next);setBarcodes(codes);setOCRStatus(!next.length?(codes.length?`已识别 ${codes.length} 个条码`:'未识别到文字，可试小字增强'):next.some(line=>line.confidence<.8)?'拖选图中文字；部分结果需核对':'拖选图中文字，可跨行复制');};
  useEffect(()=>{
    alive.current=true;let editor:AnnotationEditor|null=null;let canceled=false;
    void(async()=>{
      let source:HTMLCanvasElement,inputWidth=0,cropWidth=0;
      if(given){source=given;inputWidth=given.width;cropWidth=given.width;}
      else{
        if(!state.imageFrame)throw Error('截图图片已失效');
        const input=await captureCanvas(state,state.imageFrame);
        if(canceled||!canvasRef.current)return;
        const r=state.imageCrop??pixelRect(state.selection!,state.width,state.height,input.width,input.height);
        const full=Boolean(region)||r.x===0&&r.y===0&&r.width===input.width&&r.height===input.height;
        // The pixel cache also backs same-frame re-selection; the editor owns a separate canvas.
        source=document.createElement('canvas');
        source.width=full?input.width:r.width;source.height=full?input.height:r.height;
        if(full)source.getContext('2d')!.drawImage(input,0,0);
        else source.getContext('2d')!.drawImage(input,r.x,r.y,r.width,r.height,0,0,r.width,r.height);
        if(state.backdropFrame)await captureCanvas(state,state.backdropFrame);
        inputWidth=input.width;cropWidth=r.width;
      }
      if(canceled||!canvasRef.current)return;
      editor=new AnnotationEditor(canvasRef.current,source,changed,invalidate,setPreview,region?.initialCrop,()=>setSelectedBackground(engine.current?.selectedTextBackground??null));engine.current=editor;
      editor.selectionShape=settings.selectionShape;editor.setStyle(rememberedStyle(initialTool));editor.setTool(initialTool);
      if(state.checkpoint)await editor.restoreCheckpoint(state.checkpoint);
      else if(state.annotations)await editor.load(state.annotations);
      if(canceled)return;
      const area=viewportRef.current!;setZoom(region?region.display.bounds.width/inputWidth:place?place.width/cropWidth:Math.min(1,Math.max(.05,Math.min((area.clientWidth-120)/source.width,(area.clientHeight-200)/source.height))));
      if(state.checkpoint){
        const saved=state.checkpoint;setZoom(saved.zoom);setFormat(saved.format);setOCRMode(saved.ocrMode);setEnhance(saved.enhance);setStyle({...editor.style});
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
    if(!force&&cached?.content===content&&cached.mode===ocrMode&&cached.enhance===enhance){showLines(cached.lines,cached.barcodes);return;}
    const timer=setTimeout(()=>{void(async()=>{
      if(mutating.current||!engine.current)return;
      try{
        setOCRStatus('正在识别文字…');
        const editor=engine.current,png=await editor.pixels(false);
        if(canceled||current!==version.current)return;
        const result=await window.screenshot.recognize({id:state.editId,revision:current,crop:{...editor.crop},png,mode:ocrMode,enhance,force});
        if(canceled||current!==version.current||result.id!==state.editId||result.revision!==current)return;
        const privacy=editor.privacy;
        // Conservatively remove a whole OCR line if any privacy mask touches it.
        const safe=result.lines.map(line=>({...line,x:line.x+crop.x,y:line.y+crop.y,glyphs:line.glyphs.map(g=>({...g,x:g.x+crop.x,y:g.y+crop.y}))})).filter(line=>!privacy.some(r=>intersects(line,r)));
        const codes=(result.barcodes??[]).map(item=>({...item,x:item.x+crop.x,y:item.y+crop.y})).filter(item=>!privacy.some(r=>intersects(item,r)));
        ocrCache.current={content,mode:ocrMode,enhance,lines:safe,barcodes:codes};showLines(safe,codes);
      }catch(e){if(!canceled&&current===version.current)setOCRStatus('文字识别未完成，可重试；图片编辑不受影响');}
    })();},350);
    return()=>{canceled=true;clearTimeout(timer);};
  },[ready,revision,retry,ocrMode,enhance]);
  useEffect(()=>{
    const update=()=>{const value=selectedOCRText(textRef.current);selection.current=value;setSelectedText(value);};
    document.addEventListener('selectionchange',update);return()=>document.removeEventListener('selectionchange',update);
  },[]);
  const remember=(next:Tool,config:Style)=>{
    const current=memory.current;
    const value={...current,lastTool:next,...(current.rememberToolStyles?{perTool:{...current.perTool,[next]:{...config}}}:{defaultStyle:{...config}})};
    memory.current=value;
    memorySave.current=memorySave.current.then(()=>window.screenshot.saveAnnotationMemory(value)).catch(e=>{if(alive.current)setError((e as Error).message);});
  };
  const choose=(next:Tool)=>{if(exporting.current||!ready||(mutating.current&&!engine.current?.isEditingText))return;if(next==='auto-mosaic'&&selection.current)setMosaicWord(selection.current);setAdjustOpen(false);const config=rememberedStyle(next);engine.current?.setTool(next);engine.current?.setStyle(config);setTool(next);setStyle(config);remember(next,config);clearSelection();if(next==='picker')requestAnimationFrame(()=>engine.current?.prepareSample());};
  const changeOCR=(mode:OCRMode,small:boolean,force=false)=>{if(engine.current?.isEditingText)(engine.current.canvas.getActiveObject() as import('fabric').IText).exitEditing();invalidate();mutating.current=false;forceOCR.current=force;setOCRMode(mode);setEnhance(small);setRevision(version.current);if(force)setRetry(n=>n+1);};
  const changeStyle=(patch:Partial<Style>)=>{const next={...style,...patch};setStyle(next);engine.current?.setStyle(next,Object.keys(patch) as (keyof Style)[]);setSelectedBackground(engine.current?.selectedTextBackground??null);remember(tool,next);};
  async function frame(includeAnnotations=false,encoded=false):Promise<CaptureFrame>{
    const editor=engine.current;if(!editor)throw Error('截图尚未加载');
    if(editor.isEditingText){(editor.canvas.getActiveObject() as import('fabric').IText).exitEditing();}
    if(mutating.current)throw Error('请先完成当前编辑。');
    const current=version.current;
    const image=encoded?{png:await editor.pixels()}:{pixels:editor.bitmap()};
    if(current!==version.current)throw Error('图片已变化，请重试。');
    return {id:state.editId,revision:current,crop:{...editor.crop},outputSize:editor.outputSize,...image,...(includeAnnotations?{annotations:editor.snapshot(Boolean(region))}:{})};
  }
  async function output(action:ExportAction){
    if(exporting.current)return;exporting.current=true;setBusy(true);setError('');
    try{const result=await window.screenshot.export(await frame(true,action==='copy'),action,format,contentMode);if(result.error)setError(result.error);}
    catch(e){setError((e as Error).message);}finally{exporting.current=false;if(alive.current)setBusy(false);}
  }
  useEffect(()=>{if(ready&&state.copyIntent&&state.copyIntent!==lastCopy.current){lastCopy.current=state.copyIntent;void output('copy');}},[ready,state.copyIntent]);
  async function copyText(){if(!selection.current||mutating.current)return;try{await window.screenshot.copyText({id:state.editId,revision:version.current,text:selection.current});setOCRStatus('已复制选中文字');}catch(e){setError((e as Error).message);}}
  async function sendText(){if(!selection.current||mutating.current||exporting.current)return;exporting.current=true;setBusy(true);try{const result=await window.screenshot.sendText({id:state.editId,revision:version.current,text:selection.current});if(result.error)setError(result.error);}catch(e){setError((e as Error).message);}finally{exporting.current=false;if(alive.current)setBusy(false);}}
  useEffect(()=>{
    let composing=false;
    const compositionStart=()=>{composing=true;},compositionEnd=()=>{composing=false;};
    const key=(e:KeyboardEvent)=>{
      if(e.defaultPrevented||e.isComposing||composing||e.keyCode===229||(e.target instanceof Element&&e.target.closest('input,textarea,select,[contenteditable=true]'))||engine.current?.isEditingText)return;
      if(e.key==='Shift'){engine.current?.setShift(true);return;}
      if(e.key==='Enter'&&engine.current?.tool==='crop'&&engine.current.selectionShape==='polygon'){e.preventDefault();engine.current.finishPolygon();return;}
      if(region&&mutating.current&&!keyGesture.current)return;
      if(keyGesture.current&&!e.key.startsWith('Arrow')){keyGesture.current=false;engine.current?.commitCrop();}
      const command=e.metaKey||e.ctrlKey;
      const editor=engine.current,lower=e.key.toLowerCase(),action=editorActionForEvent(e,shortcuts);
      if(region&&tool==='crop'&&lower==='r'&&!command&&!e.altKey&&!e.shiftKey){e.preventDefault();void window.screenshot.lastRegion().then(r=>{if(r)engine.current?.applyCrop(r);}).catch(e=>setError(e.message));}
      else if(action){e.preventDefault();if(['copy','save','quick-save','pin'].includes(action)){if(!mutating.current)void output(action as ExportAction);}else choose(action as Tool);}
      else if(command&&lower==='c'){e.preventDefault();if(exporting.current)return;if(editor?.copy())return;if(selection.current)void copyText();else void output('copy');}
      else if(command&&lower==='v'&&editor?.hasCopiedObjects){e.preventDefault();if(!exporting.current)void editor.paste().catch(e=>setError(e.message));}
      else if(command&&lower==='d'&&editor?.hasSelection){e.preventDefault();if(!exporting.current)void editor.duplicate().catch(e=>setError(e.message));}
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
      else if(e.key==='Escape'){e.preventDefault();if(!exporting.current)void window.screenshot.action('cancel');}
    };
    const keyUp=(e:KeyboardEvent)=>{if(keyGesture.current&&e.key.startsWith('Arrow')){keyGesture.current=false;engine.current?.commitCrop();}if(e.key==='Shift')engine.current?.setShift(false);};
    const blur=()=>{if(keyGesture.current){keyGesture.current=false;engine.current?.commitCrop();}composing=false;engine.current?.setShift(false);};
    window.addEventListener('keydown',key);window.addEventListener('keyup',keyUp);window.addEventListener('blur',blur);window.addEventListener('compositionstart',compositionStart);window.addEventListener('compositionend',compositionEnd);
    return()=>{window.removeEventListener('keydown',key);window.removeEventListener('keyup',keyUp);window.removeEventListener('blur',blur);window.removeEventListener('compositionstart',compositionStart);window.removeEventListener('compositionend',compositionEnd);};
  },[tool,format,contentMode,ready,ratio,state.editorShortcuts]);
  const editor=engine.current,activeCrop=preview||crop,displayCrop=tool==='crop'&&selectionShape==='multi-rect'?editor?.editingBounds??crop:preview||editor?.displayCrop||crop;
  const maskSame=(word=selection.current)=>{const count=editor?.autoMosaic(lines,word)??0;if(!count)setError('没有找到相同文字，请选择文字或输入完整词条。');};
  useLayoutEffect(()=>{const el=dockRef.current;if(!el)return;const observer=new ResizeObserver(()=>setDockSize({width:el.offsetWidth,height:el.offsetHeight}));observer.observe(el);return()=>observer.disconnect();},[]);
  const anchor=place??state.selection!,W=window.innerWidth,H=window.innerHeight,GAP=10,scaleY=region?region.display.bounds.height/region.sourceSize.height:zoom;
  // Fit only the inline preview. Image coordinates and the export matrix stay unchanged.
  const nativeRect=region&&displayCrop?regionPoints(displayCrop,region.display.bounds,region.sourceSize):inline&&displayCrop?{x:anchor.x+displayCrop.x*zoom,y:anchor.y+displayCrop.y*scaleY,width:displayCrop.width*zoom,height:displayCrop.height*scaleY}:anchor;
  const fit=inline?Math.min(1,W/nativeRect.width,H/nativeRect.height):1,previewZoomX=zoom*fit,previewZoomY=scaleY*fit;
  const sel=inline?{x:Math.max(0,Math.min(nativeRect.x,W-nativeRect.width*fit)),y:Math.max(0,Math.min(nativeRect.y,H-nativeRect.height*fit)),width:nativeRect.width*fit,height:nativeRect.height*fit}:nativeRect;
  const stageOrigin=inline?{left:displayCrop?sel.x-displayCrop.x*previewZoomX:region?0:sel.x,top:displayCrop?sel.y-displayCrop.y*previewZoomY:region?0:sel.y}:{};
  const windowCrop=!inline&&tool!=='crop'?displayCrop:null,stageSize=windowCrop??editor?.viewSize;
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
  const reselect=()=>{if(editor?.count&&armed!=='reselect'){setArmed('reselect');return;}void window.screenshot.action('reselect').then(result=>{if(result.error)setError(result.error);}).catch(e=>setError(e.message));};
  const startScroll=async()=>{if(!editor||exporting.current||mutating.current)return;if(editor.count&&!scrollArmed){setScrollArmed(true);return;}exporting.current=true;setBusy(true);try{const result=await window.screenshot.startScroll(editor.crop);if(result.error)setError(result.error);}catch(e){setError((e as Error).message);}finally{exporting.current=false;if(alive.current){setBusy(false);setScrollArmed(false);}}};
  const backgroundControl=<label className="ed-toggle"><span>文字背景衬底</span><Switch label="文字背景衬底" value={selectedBackground??style.textBackground} disabled={busy} change={()=>changeStyle({textBackground:!(selectedBackground??style.textBackground)})}/></label>;
  const panelKind=adjustOpen?'adjust':['spotlight','magnifier','watermark','auto-mosaic','inpaint'].includes(tool)?tool:styled.includes(tool)?'style':selectedBackground!==null&&tool==='select'?'text-background':['redact','mosaic','blur'].includes(tool)?'privacy':tool==='crop'?'crop':null;
  const panel=panelKind==='adjust'?<>
      {([['旋转90°',<RotateCw/>,()=>editor?.adjust({turns:(editor.effects.turns+1)%4})],['水平翻转',<FlipHorizontal2/>,()=>editor?.adjust({flipX:!editor.effects.flipX})],['垂直翻转',<FlipVertical2/>,()=>editor?.adjust({flipY:!editor.effects.flipY})],['灰度',<Contrast/>,()=>editor?.adjust({grayscale:!editor.effects.grayscale})]] as [string,ReactNode,()=>void][]).map(([label,icon,run])=><button className="ed-text" aria-label={label} aria-pressed={label==='灰度'?editor?.effects.grayscale:label==='水平翻转'?editor?.effects.flipX:label==='垂直翻转'?editor?.effects.flipY:undefined} key={label} disabled={busy} onClick={run}>{icon}{label}</button>)}
      <label className="ed-width"><span>亮度</span><input type="range" aria-label="亮度" min="50" max="150" value={editor?.effects.brightness??100} onChange={e=>editor?.adjust({brightness:Number(e.target.value)})}/><span className="mono">{editor?.effects.brightness??100}%</span></label>
    </>:panelKind==='magnifier'?<><span className="ed-hint">框选需要放大的区域 · 2×</span><Segmented label="放大镜形状" value={magnifierShape} onChange={shape=>{setMagnifierShape(shape);if(editor)editor.magnifierShape=shape;}} options={ [['circle','圆形'],['rect','矩形']] }/></>:panelKind==='watermark'?<><span className="ed-hint">{settings.watermarkText} · {Math.round(settings.watermarkOpacity*100)}%</span><button className="ed-text" disabled={busy} onClick={()=>editor?.watermark(settings.watermarkText,settings.watermarkOpacity)}>添加平铺水印</button></>:panelKind==='auto-mosaic'?<><input className="ed-word" aria-label="联动遮挡词条" placeholder="输入需要遮挡的相同文字" value={mosaicWord} onChange={e=>setMosaicWord(e.target.value)}/><button className="ed-text" disabled={busy||!mosaicWord.trim()} onClick={()=>maskSame(mosaicWord)}>联动遮挡相同文字</button></>:panelKind==='spotlight'||panelKind==='inpaint'?<span className="ed-hint">{panelKind==='spotlight'?'框选重点，周围画面变暗':'框选待消除区域，以四周邻域像素平滑填补'}</span>:panelKind==='style'?<>
      <div className="ed-colors" role="radiogroup" aria-label="标注颜色">{colors.map(color=><button key={color} role="radio" aria-checked={style.color===color} aria-label={`颜色 ${color}`} style={{'--swatch':color} as React.CSSProperties} disabled={busy} onClick={()=>changeStyle({color})}/>)}</div>
      <span className="ed-sep"/>
      {tool==='text'||tool==='number'?<Segmented label="文字字号" value={String(style.fontSize)} onChange={size=>changeStyle({fontSize:Number(size)})} options={sizes.map(n=>[String(n),String(n)] as const)}/>
        :<label className="ed-width" title="线条粗细"><span className="ed-width-dot"><i style={{width:Math.min(16,style.width+2),height:Math.min(16,style.width+2),background:style.color}}/></span>
          <input type="range" min="1" max="24" value={style.width} aria-label="线条粗细" disabled={busy} onChange={e=>changeStyle({width:Number(e.target.value)})}/><span className="mono">{style.width}</span></label>}
      {tool==='arrow'&&<><span className="ed-sep"/><Segmented label="箭头样式" value={style.arrowType} onChange={arrowType=>changeStyle({arrowType})} options={[["single","单向"],["double","双向"]]}/></>}
      {tool==='text'&&<><span className="ed-sep"/>{backgroundControl}</>}
    </>:panelKind==='text-background'?backgroundControl:panelKind==='privacy'?<>
      {(tool==='mosaic'||tool==='blur')&&<label className="ed-width"><span>{tool==='mosaic'?'马赛克强度':'模糊强度'}</span><input type="range" min={tool==='mosaic'?4:1} max={tool==='mosaic'?48:32} value={tool==='mosaic'?style.mosaicSize:style.blurRadius} aria-label={tool==='mosaic'?'马赛克强度':'模糊强度'} disabled={busy} onChange={e=>changeStyle(tool==='mosaic'?{mosaicSize:Number(e.target.value)}:{blurRadius:Number(e.target.value)})}/><span className="mono">{tool==='mosaic'?style.mosaicSize:style.blurRadius}</span></label>}
      <span className="ed-hint">敏感内容请用「遮挡」，马赛克和模糊只是视觉效果</span>
    </>
    :panelKind==='crop'?<><Segmented label="裁剪形状" value={selectionShape} onChange={shape=>{setSelectionShape(shape);editor?.setSelectionShape(shape);}} options={ [['rect','矩形'],['freehand','自由'],['polygon','多边形'],['multi-rect','多矩形']] }/>{selectionShape==='polygon'&&<button className="ed-text" onClick={()=>editor?.finishPolygon()}>闭合选区 ↵</button>}<span className="ed-hint">{selectionShape==='polygon'?'逐点点击 · 双击或回车闭合':selectionShape==='multi-rect'?'逐次拖动，合并多个矩形裁剪':selectionShape==='freehand'?'拖动勾勒自由选区':region?'拖动移动 · 框外重画 · ⌥ 拖动移动':'拖动画面或边角裁剪'}</span><button className="ed-text" disabled={busy} onClick={()=>{if(region){setRatio(region.ratio);editor?.resetCrop(region.initialCrop);}else editor?.resetCrop();}}>{region?'恢复选区':'恢复裁剪'}</button></>:null;
  const toolButton=(id:Tool,label:string,icon:ReactNode)=>{if(region&&id==='crop')label='选区 · 移动、调整范围';return <button key={id} className="ed-tool" data-tip={`${label}${shortcuts[id]?' '+shortcuts[id]:''}${id==='select'?' · ⌘C / ⌘V / ⌘D':['rectangle','ellipse','line','arrow'].includes(id)?' · ⇧ 约束':''}`} aria-label={label} aria-keyshortcuts={shortcuts[id]||undefined} aria-pressed={tool===id} disabled={!ready||busy} onClick={()=>choose(id)}>{tool===id&&<Glide id="ed-tool" className="ed-tool-on"/>}{icon}</button>;};
  const ocrChip=<motion.div className={'ed-chip'+(ocrOpen?' open':'')} initial={{opacity:0,y:4}} animate={{opacity:1,y:0}} transition={{...spring,delay:.04}}>
      <button className="ed-chip-main" aria-expanded={ocrOpen} aria-label="文字识别选项" disabled={!ready} onClick={()=>{setRegionPanelOpen(false);setFormatOpen(false);setOCROpen(o=>!o);}}><span className={'ed-dot '+ocrTone(ocrStatus)}/><ScanText/><span className="ed-chip-text" role="status">{ocrStatus}</span><ChevronDown className="ed-chev"/></button>
      {barcodes.length>0&&<button className="ed-chip-main ed-barcode-chip" aria-label="条码结果" aria-expanded={intelligence==='barcode'} onClick={()=>{closeMenus();setIntelligence('barcode');}}><Barcode/><span className="mono">{barcodes[0].symbology}</span><span className="ed-chip-text">{barcodes[0].payload}</span></button>}
      <AnimatePresence initial={false}>{selectedText&&<motion.span key="text" className="ed-chip-actions" initial={{opacity:0,width:0}} animate={{opacity:1,width:'auto'}} exit={{opacity:0,width:0}} transition={spring}>
        <button onMouseDown={e=>e.preventDefault()} disabled={busy} onClick={()=>void copyText()}><Copy/>复制文字</button>
        <button onMouseDown={e=>e.preventDefault()} disabled={busy} onClick={()=>void sendText()}><Send/>文字预设</button><button onMouseDown={e=>e.preventDefault()} disabled={busy} onClick={()=>maskSame()}><Link2/>联动遮挡相同文字</button></motion.span>}</AnimatePresence>
      <AnimatePresence>{ocrOpen&&<motion.div className="ed-pop" initial={{opacity:0,y:-4,scale:.98}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,transition:{duration:.1}}} transition={spring}>
        <Segmented label="文字识别模式" value={ocrMode} onChange={mode=>changeOCR(mode,enhance)} options={[['text','正文'],['code','代码 / 网址']]}/>
        <div className="ed-pop-row"><span>小字增强</span><Switch label="小字增强" value={enhance} disabled={!ready||busy} change={()=>changeOCR(ocrMode,!enhance)}/></div>
        <button className="ed-text" disabled={!ready||busy} onClick={()=>{setOCROpen(false);changeOCR(ocrMode,enhance,true);}}>重新识别</button>
      </motion.div>}</AnimatePresence>
    </motion.div>;
  const mouse=state.mouseActions??{doubleClick:'copy',middleClick:'pin',rightClick:'cancel'};
  const contentPointer=(target:EventTarget)=>target instanceof Element&&Boolean(target.closest('.ed-viewport,.region-events'))&&!target.closest('button,input,.region-panel,.editor-text-line,[data-region-handle]');
  return <section onDoubleClick={e=>{if(!contentPointer(e.target)||busy||selection.current||editor?.hasSelection||editor?.isEditingText||!['text-select','crop'].includes(tool)||selectionShape==='polygon'&&tool==='crop')return;if(mouse.doubleClick!=='none')void output(mouse.doubleClick);}} onAuxClick={e=>{if(e.button!==1||!contentPointer(e.target)||busy)return;e.preventDefault();if(mouse.middleClick!=='none')void output(mouse.middleClick);}} onContextMenu={e=>{e.preventDefault();if(busy)return;if(formatOpen||ocrOpen||adjustOpen){closeMenus();setAdjustOpen(false);return;}if(mouse.rightClick==='reselect')reselect();else void window.screenshot.action('cancel');}} className={'ed '+(inline?'ed-inline':'ed-window')+(region?' ed-region':'')} aria-label="截图编辑器" aria-busy={busy}>
    {inline?<>{state.backdropFrame&&<CapturePixels state={state} frameId={state.backdropFrame} className="cap-background"/>}
      <div className="cap-rect ed-hole" style={{left:sel.x,top:sel.y,width:sel.width,height:sel.height}}>{!region&&<span className="cap-size"><span className="mono">{crop?`${editor?.outputSize.width??crop.width} × ${editor?.outputSize.height??crop.height}`:'…'}</span><span className="cap-source">像素</span></span>}</div></>
      :<header className="ed-drag"><strong>图片编辑</strong><span className="mono">{crop?`${editor?.outputSize.width??crop.width} × ${editor?.outputSize.height??crop.height}`:'正在加载…'}</span></header>}
    <div className="ed-viewport" ref={viewportRef} inert={busy} onPointerDown={closeMenus}
      >
      <div className={'editor-stage ed-stage'+(windowCrop?' ed-result':'')} style={{...stageOrigin,width:stageSize?stageSize.width*previewZoomX:0,height:stageSize?stageSize.height*previewZoomY:0}} onPointerMove={e=>{if(tool!=='picker'||busy)return;const r=e.currentTarget.getBoundingClientRect();picker.current?.move((e.clientX-r.left)/previewZoomX+(windowCrop?.x??0),(e.clientY-r.top)/previewZoomY+(windowCrop?.y??0),e.clientX,e.clientY);}} onPointerLeave={()=>picker.current?.leave()} onClick={e=>{if(tool!=='picker'||busy)return;const r=e.currentTarget.getBoundingClientRect();const color=picker.current?.lock((e.clientX-r.left)/previewZoomX+(windowCrop?.x??0),(e.clientY-r.top)/previewZoomY+(windowCrop?.y??0),e.clientX,e.clientY);if(color)changeStyle({color});}}>
        <div className="editor-pixels" style={{left:-(windowCrop?.x??0)*previewZoomX,top:-(windowCrop?.y??0)*previewZoomY,transform:`scale(${previewZoomX},${previewZoomY})`,...(region&&displayCrop?{clipPath:`inset(${displayCrop.y}px ${editor!.viewSize.width-displayCrop.x-displayCrop.width}px ${editor!.viewSize.height-displayCrop.y-displayCrop.height}px ${displayCrop.x}px)`}:{}),width:editor?.viewSize.width,height:editor?.viewSize.height}}>
          <canvas ref={canvasRef} aria-label="标注画布"/>
          <div ref={textRef} style={{transform:`matrix(${editor?.matrix.join(',')??'1,0,0,1,0,0'})`,transformOrigin:'0 0'}} className={'editor-text-layer '+(tool==='text-select'?'enabled':'')} aria-label="识别文字"
            onPointerDown={e=>{if(!e.shiftKey){window.getSelection()?.removeAllRanges();selection.current='';setSelectedText('');}}}
            onDragStart={e=>e.preventDefault()}
            onCopy={e=>{if(selection.current){e.preventDefault();e.clipboardData.setData('text/plain',selection.current);}}}>
            {lines.map((line,index)=><div className="editor-text-line" key={index} style={{left:line.x,top:line.y,width:line.width,height:line.height}}>{line.glyphs.map((g,i)=><span key={i} style={{left:g.x-line.x,top:g.y-line.y,width:g.width,height:g.height,fontSize:g.height*.95,lineHeight:`${g.height}px`}}>{g.text}</span>)}</div>)}
          </div>
          {translations.length>0&&<div style={{transform:`matrix(${editor?.matrix.join(',')})`,transformOrigin:'0 0'}} className="editor-translations" aria-label="图上译文">{translations.map((block,index)=>block.box&&<span key={index} style={{left:block.box.x,top:block.box.y,width:block.box.width,minHeight:block.box.height,fontSize:Math.max(12,block.box.height*.72)}}>{block.translated}</span>)}</div>}
          {!region&&activeCrop&&crop&&<div className="editor-shade" aria-hidden="true"><i style={{left:displayCrop!.x,top:displayCrop!.y,width:displayCrop!.width,height:displayCrop!.height}}/></div>}
          {!region&&tool==='crop'&&selectionShape==='rect'&&!editor?.effects.turns&&!editor?.effects.flipX&&!editor?.effects.flipY&&activeCrop&&crop&&<div className="editor-crop" style={{left:displayCrop!.x,top:displayCrop!.y,width:displayCrop!.width,height:displayCrop!.height,outlineWidth:1.5/previewZoomX}}
            onPointerDown={e=>{const handle=(e.target as HTMLElement).dataset.handle;if(!handle||!editor)return;e.preventDefault();e.stopPropagation();invalidate();resize.current={x:e.clientX,y:e.clientY,handle,original:{...crop},current:{...crop}};e.currentTarget.setPointerCapture(e.pointerId);}}
            onPointerMove={e=>{const g=resize.current;if(!g||!editor)return;const dx=(e.clientX-g.x)/previewZoomX,dy=(e.clientY-g.y)/previewZoomY,r={...g.original};if(g.handle.includes('w')){r.x=Math.max(0,Math.min(r.x+r.width-2,r.x+dx));r.width=g.original.x+g.original.width-r.x;}if(g.handle.includes('e'))r.width=Math.max(2,Math.min(editor.source.width-r.x,r.width+dx));if(g.handle.includes('n')){r.y=Math.max(0,Math.min(r.y+r.height-2,r.y+dy));r.height=g.original.y+g.original.height-r.y;}if(g.handle.includes('s'))r.height=Math.max(2,Math.min(editor.source.height-r.y,r.height+dy));g.current=r;setPreview(r);}}
            onPointerUp={()=>{const g=resize.current;resize.current=null;setPreview(null);if(g)editor?.applyCrop(g.current);}}
            onPointerCancel={()=>{resize.current=null;setPreview(null);changed();}}>
            {['nw','n','ne','e','se','s','sw','w'].map(h=><i key={h} data-handle={h} className={'editor-crop-handle '+h} style={{width:9/previewZoomX,height:9/previewZoomY,margin:-4.5/previewZoomX,borderWidth:1.5/previewZoomX,borderRadius:2/previewZoomX}}/>)}
          </div>}
        </div>
      </div>
    </div>
    {region&&crop&&selectionShape==='rect'&&!editor?.effects.turns&&!editor?.effects.flipX&&!editor?.effects.flipY&&<RegionControls controlsHost={controlsHost} open={regionPanelOpen} setOpen={open=>{if(open){setOCROpen(false);setFormatOpen(false);}setRegionPanelOpen(open);}} context={region} crop={crop} displayCrop={activeCrop??crop} tool={tool} preview={r=>{if(r&&!mutating.current)invalidate();if(!r)mutating.current=false;setPreview(r);}} cancelPreview={()=>changed()} ratio={ratio} setRatio={setRatio} commit={r=>{invalidate();editor?.applyCrop(r);}} error={setError} busy={busy}/>}
    {!inline&&ocrChip}
    <motion.div ref={dockRef} className={'ed-dock'+(up?' up':'')} style={dockStyle} initial={{opacity:0,y:up?6:-6}} animate={{opacity:1,y:0}} transition={spring}>
      {inline&&<div className="ed-meta"><div className="ed-size-host" ref={setControlsHost}/>{ocrChip}</div>}
      <AnimatePresence initial={false}>{panel&&<motion.div key={panelKind} className="ed-panel" initial={{opacity:0,y:up?4:-4,scale:.98}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,transition:{duration:.1}}} transition={spring}>{panel}</motion.div>}</AnimatePresence>
      <AnimatePresence>{formatOpen&&<motion.div className="ed-menu ed-format-panel" role="menu" aria-label="保存与导出" inert={busy} initial={{opacity:0,y:up?4:-4}} animate={{opacity:1,y:0}} exit={{opacity:0,transition:{duration:.1}}} transition={spring}>
        <span className="ed-menu-label">保存格式</span><Segmented label="保存格式" value={format} onChange={setFormat} options={screenshotOutputFormats.map(f=>[f,f.toUpperCase()] as const)}/>
        <span className="ed-menu-label">导出内容</span><Segmented label="导出内容" value={contentMode??'settings'} onChange={mode=>setContentMode(mode==='settings'?undefined:mode)} options={[["settings","按截图设置"],["result","编辑结果"],["original","原始底图"],["display","显示效果"]]}/>
        <div className="ed-menu-actions">{([['quick-save','快速保存'],['copy-file','复制文件'],['copy-path','复制路径']] as const).map(([action,label])=><button key={action} role="menuitem" onClick={()=>{setFormatOpen(false);void output(action);}}>{label}</button>)}</div>
      </motion.div>}</AnimatePresence>
      <div className="ed-bars">
        <div className="ed-bar" role="toolbar" aria-label="标注工具">
          {tools.map(group=>group.filter(([id])=>visibleTool(id))).filter(group=>group.length).map((group,index)=><Fragment key={index}>{index>0&&<span className="ed-sep"/>}{group.map(([id,label,icon])=>toolButton(id,label,icon))}</Fragment>)}
          {visibleTool('image-adjust')&&<button className="ed-tool" aria-label="图像调整" data-tip="旋转、翻转与色调" aria-pressed={adjustOpen} disabled={!ready||busy} onClick={()=>setAdjustOpen(o=>!o)}>{adjustOpen&&<Glide id="ed-adjust" className="ed-tool-on"/>}<SlidersHorizontal/></button>}
          <span className="ed-sep"/>
          <button className="ed-tool" data-tip="撤销 ⌘Z" aria-label="撤销" disabled={!editor?.canUndo||busy} onClick={()=>void editor?.restore(-1).catch(e=>setError(e.message))}><Undo2/></button>
          <button className="ed-tool" data-tip="重做 ⇧⌘Z" aria-label="重做" disabled={!editor?.canRedo||busy} onClick={()=>void editor?.restore(1).catch(e=>setError(e.message))}><Redo2/></button>
          <button className="ed-tool" data-tip="删除所选标注" aria-label="删除所选标注" disabled={tool!=='select'||busy} onClick={()=>editor?.remove()}><Trash2/></button>
        </div>
        <div className="ed-bar" role="toolbar" aria-label="输出">
          {([['translate','翻译',<Languages/>],['table','表格',<Table2/>],['formula','公式',<Sigma/>]] as const).map(([kind,label,icon])=><button className="ed-text" key={kind} aria-label={label} disabled={!ready||busy} onClick={()=>{closeMenus();setIntelligence(kind);}}>{icon}{label}</button>)}
          {inline&&(armed?<button className="ed-text ed-armed" disabled={busy} onClick={armed==='clear'?()=>void window.screenshot.clearRegion().catch(e=>setError(e.message)):reselect}><ScanLine/>再点一次清除标注</button>
            :<button className="ed-tool" data-tip="重新截图" aria-label="重新截图" disabled={busy} onClick={reselect}><ScanLine/></button>)}
          {region&&<button className="ed-text" disabled={busy||!ready} onClick={()=>void startScroll()}><GalleryVerticalEnd/>{scrollArmed?'再点一次清除标注并开始':'长截图'}</button>}
          <span className="ed-split">
            <button className="ed-tool" data-tip={`另存副本 ${format.toUpperCase()} ${shortcuts.save}`} aria-label="保存" disabled={!ready||busy} onClick={()=>void output('save')}><Download/></button>
            <button className="ed-caret" aria-label="保存格式" aria-expanded={formatOpen} disabled={busy} onClick={()=>{setRegionPanelOpen(false);setOCROpen(false);setFormatOpen(o=>!o);}}><ChevronDown/></button>
          </span>
          <button className="ed-tool" data-tip={state.pinId?'更新贴图':'贴到桌面'} aria-label={state.pinId?'更新贴图':'贴图'} disabled={!ready||busy} onClick={()=>void output('pin')}><Pin/></button>
          <button className="ed-text" disabled={!ready||busy} onClick={()=>void output('image')}><Send/>图片预设</button>
          <button className="ed-primary" disabled={!ready||busy} onClick={()=>void output('copy')}><Copy/>复制</button>
          <button className="ed-tool" data-tip={state.origin==='pin'?'返回贴图 Esc':'关闭 Esc'} aria-label={state.origin==='pin'?'返回贴图':'关闭截图编辑器'} disabled={busy} onClick={()=>void window.screenshot.action('cancel')}><X/></button>
        </div>
      </div>
    </motion.div>
    {!inline&&<div className="ed-zoom"><button aria-label="缩小" onClick={()=>setZoom(z=>Math.max(.05,+(z-.1).toFixed(2)))}><Minus/></button><span className="mono">{Math.round(zoom*100)}%</span><button aria-label="放大" onClick={()=>setZoom(z=>Math.min(3,+(z+.1).toFixed(2)))}><Plus/></button></div>}
    {tool==='picker'&&<ColorLoupe ref={picker} initialFormat={settings.loupeColorFormat} crosshair={settings.showCrosshair} read={(x,y)=>engine.current?.sample(x,y,settings.loupeMagnification)??null} busy={busy} copy={async text=>{await window.screenshot.copyText({id:state.editId,revision:version.current,text});}} fail={setError}/>}
    <AnimatePresence>{intelligence&&<IntelligencePanel key={revision} id={state.editId} revision={revision} kind={intelligence} barcodes={barcodes} lines={lines} frame={async()=>{const value=await frame(true,true);return {...value,png:await editor!.pixels(false),outputSize:{width:editor!.crop.width,height:editor!.crop.height}};}} change={setIntelligence} close={()=>{setIntelligence(null);setTranslations([]);}} overlay={setTranslations}/>}</AnimatePresence>
    <AnimatePresence>{(error||state.outputError||state.outputStatus)&&<motion.div className={'ed-toast'+(!error&&!state.outputError?' ed-toast-success':'')} role={error||state.outputError?'alert':'status'} initial={{opacity:0,y:-6}} animate={{opacity:1,y:0}} exit={{opacity:0,transition:{duration:.12}}} transition={spring}>{[error,state.outputStatus,state.outputError].filter(Boolean).join('；')}{error&&!ready&&<button className="ed-text" onClick={()=>void window.screenshot.action('retry')}>重新加载图片</button>}{error&&<button aria-label="关闭提示" onClick={()=>setError('')}><X/></button>}</motion.div>}</AnimatePresence>
  </section>;
}
