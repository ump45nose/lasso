import { useEffect, useRef, useState } from 'react';
import type { CaptureFrame, CaptureRect, ExportAction, OCRLine, OCRMode, ScreenshotState } from '../../shared/capture';
import { pixelRect } from '../../shared/capture';
import { AnnotationEditor, intersects, type Style, type Tool } from './annotations';
import './editor.css';
import { selectedOCRText } from './selected-text';

const tools: [Tool,string,string][]=[['text-select','选字','图上拖选文字'],['select','选择','移动、调整标注'],['arrow','箭头','拖动添加箭头'],['line','直线','拖动添加直线'],['rectangle','矩形','拖动添加矩形'],['ellipse','椭圆','拖动添加椭圆'],['pen','画笔','自由绘制'],['highlight','高亮','拖动高亮区域'],['text','文字','点击添加可编辑文字'],['number','序号','点击添加递增序号'],['redact','遮挡','实色遮挡敏感信息'],['mosaic','马赛克','马赛克效果'],['blur','模糊','模糊效果'],['crop','裁剪','拖动裁剪，支持撤销'],['picker','取色','查看像素放大镜，点击选用颜色']];
const colors=['#e24a35','#eaaa31','#3a9866','#337cc1','#9b62b8','#171717','#ffffff'];
export function Editor({state}:{state:ScreenshotState}){
  const canvasRef=useRef<HTMLCanvasElement>(null),viewportRef=useRef<HTMLDivElement>(null),textRef=useRef<HTMLDivElement>(null),engine=useRef<AnnotationEditor|null>(null);
  const [ready,setReady]=useState(false),[tool,setTool]=useState<Tool>('text-select'),[style,setStyle]=useState<Style>({color:colors[0],width:4,fontSize:32}),[revision,setRevision]=useState(0),[zoom,setZoom]=useState(1),[crop,setCrop]=useState<CaptureRect|null>(null),[preview,setPreview]=useState<CaptureRect|null>(null);
  const [lines,setLines]=useState<OCRLine[]>([]),[ocrStatus,setOCRStatus]=useState('正在识别文字…'),[selectedText,setSelectedText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0),[format,setFormat]=useState<'png'|'jpeg'>('png');
  const [ocrMode,setOCRMode]=useState<OCRMode>('text'),[enhance,setEnhance]=useState(false);
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
      const area=viewportRef.current!;setZoom(Math.min(1,Math.max(.05,Math.min((area.clientWidth-60)/r.width,(area.clientHeight-60)/r.height))));
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
  return <section className="screenshot-editor" aria-label="截图编辑器" aria-busy={busy}>
    <header className="editor-header"><strong>截图编辑</strong><span>{crop?`${crop.width} × ${crop.height} 像素`: '正在加载…'}</span><div className="editor-actions">
      {state.origin==='screen'&&<button disabled={busy} onClick={()=>{if(editor?.count&&!window.confirm('重新选区会清除当前标注，是否继续？'))return;void window.screenshot.action('reselect');}}>重新截图</button>}
      <select aria-label="保存格式" value={format} disabled={busy} onChange={e=>setFormat(e.target.value as 'png'|'jpeg')}><option value="png">PNG</option><option value="jpeg">JPEG</option></select>
      <button disabled={!ready||busy} onClick={()=>void output('save')}>保存</button><button disabled={!ready||busy} onClick={()=>void output('pin')}>{state.pinId?'更新贴图':'贴图'}</button><button disabled={!ready||busy} onClick={()=>void output('image')}>图片预设</button><button className="editor-primary" disabled={!ready||busy} onClick={()=>void output('copy')}>复制图片</button><button aria-label="关闭截图编辑器" disabled={busy} onClick={()=>void window.screenshot.action('cancel')}>×</button>
    </div></header>
    <nav className="editor-tools" aria-label="标注工具">{tools.map(([id,label,title])=><button key={id} title={title} aria-pressed={tool===id} disabled={!ready||busy} onClick={()=>choose(id)}>{label}</button>)}</nav>
    <div className="editor-options">
      <div className="editor-colors" aria-label="标注颜色">{colors.map(color=><button key={color} aria-label={`颜色 ${color}`} aria-pressed={style.color===color} style={{backgroundColor:color}} disabled={busy} onClick={()=>changeStyle({...style,color})}/>)}</div>
      <label>粗细 <input aria-label="线条粗细" type="range" min="1" max="24" value={style.width} disabled={busy} onChange={e=>changeStyle({...style,width:Number(e.target.value)})}/></label>
      <label>字号 <select aria-label="文字字号" value={style.fontSize} disabled={busy} onChange={e=>changeStyle({...style,fontSize:Number(e.target.value)})}>{[16,24,32,40,48,64,96].map(n=><option key={n}>{n}</option>)}</select></label>
      <button disabled={!editor?.canUndo||busy} onClick={()=>void editor?.restore(-1).catch(e=>setError(e.message))}>撤销</button><button disabled={!editor?.canRedo||busy} onClick={()=>void editor?.restore(1).catch(e=>setError(e.message))}>重做</button><button disabled={tool!=='select'||busy} onClick={()=>editor?.remove()}>删除标注</button>
      {tool==='crop'&&<button disabled={busy} onClick={()=>editor?.resetCrop()}>恢复裁剪</button>}
      {['redact','mosaic','blur'].includes(tool)&&<span className="editor-privacy-tip">敏感内容请用实色遮挡；马赛克、模糊仅作效果处理</span>}
    </div>
    <div className="editor-viewport" ref={viewportRef} inert={busy}>
      <div className="editor-stage" style={{width:editor?editor.source.width*zoom:0,height:editor?editor.source.height*zoom:0}} onPointerMove={e=>{if(tool!=='picker'||busy||!editor)return;const r=e.currentTarget.getBoundingClientRect(),value=editor.sample((e.clientX-r.left)/zoom,(e.clientY-r.top)/zoom);setSample(value?{...value,left:Math.max(8,Math.min(window.innerWidth-148,e.clientX+20)),top:Math.max(8,Math.min(window.innerHeight-175,e.clientY+20))}:null);}} onPointerLeave={()=>setSample(null)} onClick={()=>{if(tool==='picker'&&sample)changeStyle({...style,color:sample.color});}}>
        <div className="editor-pixels" style={{transform:`scale(${zoom})`,width:editor?.source.width,height:editor?.source.height}}>
          <canvas ref={canvasRef} aria-label="标注画布"/>
          <div ref={textRef} className={'editor-text-layer '+(tool==='text-select'?'enabled':'')} aria-label="识别文字"
            onPointerDown={e=>{if(!e.shiftKey){window.getSelection()?.removeAllRanges();selection.current='';setSelectedText('');}}}
            onDragStart={e=>e.preventDefault()}
            onCopy={e=>{if(selection.current){e.preventDefault();e.clipboardData.setData('text/plain',selection.current);}}}>
            {lines.map((line,index)=><div className="editor-text-line" key={index} style={{left:line.x,top:line.y,width:line.width,height:line.height}}>{line.glyphs.map((g,i)=><span key={i} style={{left:g.x-line.x,top:g.y-line.y,width:g.width,height:g.height,fontSize:g.height*.95,lineHeight:`${g.height}px`}}>{g.text}</span>)}</div>)}
          </div>
          {activeCrop&&crop&&<div className="editor-crop" style={{left:activeCrop.x,top:activeCrop.y,width:activeCrop.width,height:activeCrop.height}}
            onPointerDown={e=>{const handle=(e.target as HTMLElement).dataset.handle;if(!handle||!editor)return;e.preventDefault();e.stopPropagation();invalidate();resize.current={x:e.clientX,y:e.clientY,handle,original:{...crop},current:{...crop}};e.currentTarget.setPointerCapture(e.pointerId);}}
            onPointerMove={e=>{const g=resize.current;if(!g||!editor)return;const dx=(e.clientX-g.x)/zoom,dy=(e.clientY-g.y)/zoom,r={...g.original};if(g.handle.includes('w')){r.x=Math.max(0,Math.min(r.x+r.width-2,r.x+dx));r.width=g.original.x+g.original.width-r.x;}if(g.handle.includes('e'))r.width=Math.max(2,Math.min(editor.source.width-r.x,r.width+dx));if(g.handle.includes('n')){r.y=Math.max(0,Math.min(r.y+r.height-2,r.y+dy));r.height=g.original.y+g.original.height-r.y;}if(g.handle.includes('s'))r.height=Math.max(2,Math.min(editor.source.height-r.y,r.height+dy));g.current=r;setPreview(r);}}
            onPointerUp={()=>{const g=resize.current;resize.current=null;setPreview(null);if(g)editor?.applyCrop(g.current);}}
            onPointerCancel={()=>{resize.current=null;setPreview(null);changed();}}>
            {['nw','n','ne','e','se','s','sw','w'].map(h=><i key={h} data-handle={h} className={'editor-crop-handle '+h} style={{width:10/zoom,height:10/zoom,margin:-5/zoom}}/>)}
          </div>}
        </div>
      </div>
    </div>
    {tool==='picker'&&sample&&<aside className="editor-magnifier" style={{left:sample.left,top:sample.top}} aria-label="像素放大镜"><div><img src={sample.image} alt="放大的原始像素"/><i/></div><code>{sample.color}</code><small>{sample.x}, {sample.y} · 点击选色</small></aside>}
    <footer className="editor-footer"><span role="status">{ocrStatus}</span><select aria-label="文字识别模式" value={ocrMode} disabled={!ready||busy} onChange={e=>changeOCR(e.target.value as OCRMode,enhance)}><option value="text">中英正文</option><option value="code">代码／网址</option></select><label className="editor-ocr-enhance"><input type="checkbox" checked={enhance} disabled={!ready||busy} onChange={e=>changeOCR(ocrMode,e.target.checked)}/>小字增强</label><button disabled={!ready||busy} onClick={()=>changeOCR(ocrMode,enhance,true)}>重新识别</button><button onMouseDown={e=>e.preventDefault()} disabled={!selectedText||busy} onClick={()=>void copyText()}>复制文字</button><button onMouseDown={e=>e.preventDefault()} disabled={!selectedText||busy} onClick={()=>void sendText()}>文字预设</button><span className="editor-spacer"/><button aria-label="缩小" onClick={()=>setZoom(z=>Math.max(.05,+(z-.1).toFixed(2)))}>−</button><span>{Math.round(zoom*100)}%</span><button aria-label="放大" onClick={()=>setZoom(z=>Math.min(3,+(z+.1).toFixed(2)))}>＋</button></footer>
    {error&&<div className="editor-error" role="alert">{error}<button onClick={()=>setError('')}>关闭</button></div>}
  </section>;
}
