import { ActiveSelection, Canvas, Circle, Ellipse, FabricImage, FabricObject, FabricText, Group, IText, Line, Path, PencilBrush, Rect, util, type BasicTransformEvent } from 'fabric';
import type { AnnotationSnapshot, CaptureRect, EditorCheckpoint, OCRLine } from '../../shared/capture';
import { screenshotDefaults, type AnnotationStyleConfig } from '../../shared/screenshot-settings';
import { constrainedEnd } from './annotation-geometry';

export type Tool = 'text-select' | 'select' | 'arrow' | 'line' | 'rectangle' | 'ellipse' | 'pen' | 'highlight' | 'text' | 'number' | 'redact' | 'mosaic' | 'blur' | 'crop' | 'picker' | 'spotlight' | 'magnifier' | 'watermark' | 'auto-mosaic' | 'inpaint';
export type Style = AnnotationStyleConfig;
type Mark = FabricObject & { lassoTool?: Tool };
type Snapshot = AnnotationSnapshot;
const box = (a: { x: number; y: number }, b: { x: number; y: number }): CaptureRect => ({ x: Math.round(Math.min(a.x,b.x)), y: Math.round(Math.min(a.y,b.y)), width: Math.round(Math.abs(b.x-a.x)), height: Math.round(Math.abs(b.y-a.y)) });
const shapeTools = new Set<Tool>(['arrow', 'line', 'rectangle', 'ellipse', 'highlight', 'redact', 'mosaic', 'blur', 'spotlight', 'magnifier', 'inpaint']);
const arrowPoints=(start:{x:number;y:number},end:{x:number;y:number},style:Style)=>{
  const angle=Math.atan2(end.y-start.y,end.x-start.x),head=Math.max(14,style.width*4);
  const wing=(tip:typeof start,a:number)=>[{x:tip.x-head*Math.cos(a-.5),y:tip.y-head*Math.sin(a-.5)},tip,{x:tip.x-head*Math.cos(a+.5),y:tip.y-head*Math.sin(a+.5)}];
  return [wing(end,angle),...(style.arrowType==='double'?[wing(start,angle+Math.PI)]:[])];
};
const textBackground=(style:Style)=>{
  const rgb=style.color.slice(1).match(/../g)!.map(v=>parseInt(v,16));
  return style.textBackground?(rgb[0]*.299+rgb[1]*.587+rgb[2]*.114>150?'rgba(20, 20, 19, 0.8)':'rgba(250, 249, 245, 0.88)'):'';
};
export const intersects = (a: CaptureRect,b: CaptureRect) => a.x < b.x+b.width && a.x+a.width > b.x && a.y < b.y+b.height && a.y+a.height > b.y;
// ActiveSelection stores children in group coordinates; history and clipboard always store image coordinates.
const serializeMark=(o:FabricObject):Record<string,unknown>=>{
  const {translateX,translateY,scaleX,scaleY,...transform}=util.qrDecompose(o.calcTransformMatrix());
  return {...o.toObject(['lassoTool']),...transform,scaleX:Math.abs(scaleX),scaleY:Math.abs(scaleY),left:translateX,top:translateY,originX:'center',originY:'center',flipX:scaleX<0,flipY:scaleY<0};
};

/** Fabric owns object editing; this adapter owns tools, bounded history and pixels.
 * The screenshot stays on a static canvas, so a drag repaints only the mark preview.
 * No eSearch application/tool source is copied into this module. */
export class AnnotationEditor {
  readonly canvas: Canvas;
  crop: CaptureRect;
  tool: Tool = 'text-select';
  style: Style = screenshotDefaults().annotationMemory.defaultStyle;
  private history: string[] = [];
  private cursor = -1;
  private restoring = false;
  private disposed = false;
  private start: { x: number; y: number } | null = null;
  private draft: Mark | null = null;
  private cropDraft: CaptureRect | null = null;
  private number = 1;
  private objectClipboard: Record<string, unknown>[] | null = null;
  private pasteOffset = 0;
  private pointer: { x: number; y: number } | null = null;
  private gestureEnd: { x: number; y: number } | null = null;
  private previewFrame = 0;
  private flat: HTMLCanvasElement | null = null;
  private sampled: HTMLCanvasElement | null = null;
  private loupe: HTMLCanvasElement | null = null;
  private shift = false;
  effects = { turns:0, flipX:false, flipY:false, grayscale:false, brightness:100 };
  cropPolygons: {x:number;y:number}[][] = [];
  selectionShape: 'rect'|'freehand'|'polygon'|'multi-rect' = 'rect';
  magnifierShape: 'circle'|'rect' = 'circle';
  private vertices: {x:number;y:number}[] = [];
  private multiBounds: CaptureRect | null = null;
  private selectionBounds: CaptureRect | null = null;
  get outputSize(){return this.effects.turns%2?{width:this.crop.height,height:this.crop.width}:{width:this.crop.width,height:this.crop.height};}
  get displayCrop(){return {...this.crop,...this.outputSize};}
  get editingBounds(){return this.tool==='crop'&&this.selectionShape==='multi-rect'?this.multiBounds??this.crop:this.displayCrop;}
  get matrix(): [number,number,number,number,number,number] {
    const r=this.crop,c=Math.round(Math.cos(this.effects.turns*Math.PI/2)),s=Math.round(Math.sin(this.effects.turns*Math.PI/2)),fx=this.effects.flipX?-1:1,fy=this.effects.flipY?-1:1,a=c*fx,b=s*fx,d=c*fy,k=-s*fy;
    return [a,b,k,d,r.x+this.outputSize.width/2-a*(r.x+r.width/2)-k*(r.y+r.height/2),r.y+this.outputSize.height/2-b*(r.x+r.width/2)-d*(r.y+r.height/2)];
  }
  get viewSize(){return {width:Math.max(this.source.width,this.displayCrop.x+this.displayCrop.width),height:Math.max(this.source.height,this.displayCrop.y+this.displayCrop.height)};}
  get filter(){return `grayscale(${this.effects.grayscale?1:0}) brightness(${this.effects.brightness}%)`;}
  adjust(patch:Partial<typeof this.effects>){this.invalidate();this.effects={...this.effects,...patch};this.syncView();this.commit();}
  private syncView(){
    this.canvas.setDimensions(this.viewSize);this.canvas.setViewportTransform(this.matrix);
    this.source.style.width=`${this.source.width}px`;this.source.style.height=`${this.source.height}px`;this.source.style.transformOrigin='0 0';this.source.style.transform=`matrix(${this.matrix.join(',')})`;this.source.style.filter=this.filter;
    this.canvas.wrapperEl.style.filter=this.filter;
    const path=(points:{x:number;y:number}[][])=>`path('${points.map(p=>'M '+p.map(v=>`${v.x} ${v.y}`).join(' L ')+' Z').join(' ')}')`;
    this.source.style.clipPath=this.cropPolygons.length&&this.tool!=='crop'?path(this.cropPolygons):'';
    this.canvas.wrapperEl.style.clipPath=this.cropPolygons.length&&this.tool!=='crop'?path(this.cropPolygons.map(p=>p.map(v=>util.transformPoint(v,this.matrix)))):'';
    this.canvas.requestRenderAll();
  }
  private restoreExtras(snapshot:Snapshot){this.effects={turns:0,flipX:false,flipY:false,grayscale:false,brightness:100,...snapshot.effects};this.cropPolygons=snapshot.cropPolygons??[];this.multiBounds=null;this.syncView();}
  private async applySnapshot(snapshot:Snapshot,crop:CaptureRect){
    const objects=await util.enlivenObjects<FabricObject>(snapshot.objects);
    if(this.disposed){objects.forEach(o=>o.dispose());return false;}
    this.canvas.discardActiveObject();this.canvas.remove(...this.canvas.getObjects());objects.forEach(o=>this.canvas.add(this.decorate(o,(o as Mark).lassoTool)));
    this.crop=crop;this.restoreExtras(snapshot);this.number=snapshot.nextNumber;
    return true;
  }

  constructor(element: HTMLCanvasElement, readonly source: HTMLCanvasElement, private changed: () => void, private invalidate: () => void, private preview: (r: CaptureRect | null) => void, initialCrop?:CaptureRect, selected?:()=>void) {
    this.crop = initialCrop?{...initialCrop}:{ x:0,y:0,width:source.width,height:source.height };
    this.canvas = new Canvas(element, { width:source.width,height:source.height,enableRetinaScaling:false,preserveObjectStacking:true,selection:false,altActionKey:undefined,backgroundColor:'',renderOnAddRemove:false });
    const wrapper=this.canvas.wrapperEl;
    wrapper.style.position='absolute';wrapper.style.left='0';wrapper.style.top='0';
    source.classList.add('editor-source');source.setAttribute('aria-hidden','true');
    wrapper.parentElement?.insertBefore(source,wrapper);
    this.canvas.on('mouse:down',e=>{if(!('button' in e.e)||e.e.button===0)this.down(e.scenePoint,e.target);});
    this.canvas.on('mouse:move',e=>{this.shift=e.e.shiftKey;this.move(e.scenePoint);});
    this.canvas.on('mouse:up',()=>this.up());
    this.canvas.on('after:render',()=>{if(this.tool==='crop'&&this.selectionShape==='multi-rect'&&this.cropPolygons.length){const ctx=this.canvas.contextTop;ctx.save();ctx.transform(...this.matrix);ctx.strokeStyle=this.style.color;ctx.lineWidth=2;for(const polygon of this.cropPolygons){ctx.beginPath();polygon.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.stroke();}ctx.restore();}});
    this.canvas.on('mouse:dblclick',()=>{if(this.tool==='crop'&&this.selectionShape==='polygon')this.finishPolygon();});
    this.canvas.on('path:created',({path})=>{(path as Mark).lassoTool=this.tool;this.commit();});
    this.canvas.on('object:modified',()=>this.commit());
    this.canvas.on('object:scaling',e=>this.constrainTransform(e));
    this.canvas.on('object:rotating',e=>this.constrainTransform(e));
    this.canvas.on('text:changed',()=>this.invalidate());
    this.canvas.on('text:editing:exited',()=>this.commit());
    if(selected)for(const event of ['selection:created','selection:updated','selection:cleared'] as const)this.canvas.on(event,selected);
    this.save(); this.setTool(this.tool); this.canvas.requestRenderAll();
  }
  get canUndo(){return this.cursor>0&&!this.restoring;}
  get canRedo(){return this.cursor<this.history.length-1&&!this.restoring;}
  get canSuspend(){return !this.restoring&&!this.start&&!this.draft&&!this.cropDraft&&!this.isEditingText;}
  get count(){return this.canvas.getObjects().length;}
  get hasSelection(){return this.canvas.getActiveObjects().length>0;}
  get hasCopiedObjects(){return Boolean(this.objectClipboard);}
  get contentKey(){return this.history[this.cursor]+JSON.stringify(this.crop);}
  snapshot(visibleOnly=false): Snapshot {return {objects:this.canvas.getObjects().filter(o=>{const r=o.getBoundingRect();return !visibleOnly||intersects({x:r.left,y:r.top,width:r.width,height:r.height},this.crop);}).map(o=>({...serializeMark(o),...(visibleOnly?{lassoBounds:(()=>{const r=o.getBoundingRect();return {x:r.left,y:r.top,width:r.width,height:r.height};})()}: {})})),crop:{...this.crop},nextNumber:this.number,privacy:this.privacy,effects:{...this.effects},cropPolygons:this.cropPolygons};}
  async load(snapshot: Snapshot){
    this.flat=null;this.sampled=null;this.restoring=true;
    try{
      if(!await this.applySnapshot(snapshot,{...snapshot.crop}))return;
      this.history=[];this.cursor=-1;
      this.setTool(this.tool);this.save();this.canvas.requestRenderAll();
    }finally{this.restoring=false;}
  }
  checkpoint(): Pick<EditorCheckpoint, 'history' | 'cursor' | 'tool' | 'style' | 'objectClipboard'> {
    return { history: [...this.history], cursor: this.cursor, tool: this.tool, style: {...this.style}, objectClipboard: this.objectClipboard };
  }
  async restoreCheckpoint(checkpoint: EditorCheckpoint) {
    await this.load(JSON.parse(checkpoint.history[checkpoint.cursor]) as Snapshot);
    this.history = [...checkpoint.history]; this.cursor = checkpoint.cursor;
    this.style = {...this.style,...checkpoint.style}; this.objectClipboard = checkpoint.objectClipboard;
    this.setTool(checkpoint.tool as Tool);
  }
  get isEditingText(){return this.canvas.getActiveObject() instanceof IText && (this.canvas.getActiveObject() as IText).isEditing;}
  get selectedTextBackground(){const text=this.canvas.getActiveObjects().find(o=>o instanceof IText);return text?Boolean(text.backgroundColor):null;}
  get privacy(){return this.canvas.getObjects().filter(o=>['redact','mosaic','blur','inpaint'].includes((o as Mark).lassoTool||'')).map(o=>{const r=o.getBoundingRect();return {x:r.left,y:r.top,width:r.width,height:r.height};});}
  /** Warm the flattened pixels after the tool changes, so the first loupe move does not composite. */
  prepareSample(){if(this.disposed||this.sampled)return;const raw=this.compose(),canvas=document.createElement('canvas');canvas.width=raw.width;canvas.height=raw.height;const ctx=canvas.getContext('2d')!;ctx.filter=this.filter;ctx.drawImage(raw,0,0);this.sampled=canvas;}
  sample(x:number,y:number,magnification=8){
    const point=util.transformPoint({x,y},util.invertTransform(this.matrix));x=Math.floor(point.x);y=Math.floor(point.y);if(x<this.crop.x||y<this.crop.y||x>=this.crop.x+this.crop.width||y>=this.crop.y+this.crop.height)return null;
    this.prepareSample();const flat=this.sampled!,sx=x-this.crop.x,sy=y-this.crop.y,pixel=flat.getContext('2d')!.getImageData(sx,sy,1,1).data,side=Math.round(120/magnification);
    const loupe=this.loupe??=document.createElement('canvas');loupe.width=loupe.height=side;const preview=loupe.getContext('2d')!;
    preview.imageSmoothingEnabled=false;preview.drawImage(flat,sx-Math.floor(side/2),sy-Math.floor(side/2),side,side,0,0,side,side);
    const [r,g,b]=[pixel[0],pixel[1],pixel[2]].map(v=>v/255),max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min,l=(max+min)/2,h=d?((max===r?(g-b)/d+(g<b?6:0):max===g?(b-r)/d+2:(r-g)/d+4)*60):0,s=d?d/(1-Math.abs(2*l-1)):0;
    return {color:'#'+[pixel[0],pixel[1],pixel[2]].map(v=>v.toString(16).padStart(2,'0')).join(''),rgb:`rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`,hsl:`hsl(${Math.round(h)}, ${Math.round(s*100)}%, ${Math.round(l*100)}%)`,image:loupe,x,y};
  }
  private decorate(o: Mark, tool: Tool | undefined){o.lassoTool=tool;o.set({borderColor:'#bd7658',cornerColor:'#bd7658',cornerStrokeColor:'#fff',transparentCorners:false,cornerSize:10});return o;}
  setTool(tool: Tool){
    if(this.tool==='crop'&&this.selectionShape==='polygon'&&this.vertices.length)this.finishPolygon();
    if(this.start)this.up();
    this.clearPreview();
    if(this.isEditingText)(this.canvas.getActiveObject() as IText).exitEditing();
    this.tool=tool;this.canvas.discardActiveObject();this.canvas.selection=tool==='select';this.canvas.skipTargetFind=tool!=='select';
    this.canvas.isDrawingMode=tool==='pen';
    if(this.canvas.isDrawingMode){const brush=new PencilBrush(this.canvas);brush.color=this.style.color;brush.width=this.style.width;this.canvas.freeDrawingBrush=brush;}
    for(const o of this.canvas.getObjects())o.set({selectable:tool==='select',evented:tool==='select'});
    this.canvas.defaultCursor=tool==='select'?'default':'crosshair';this.syncView();
  }
  setStyle(style: Style, properties: (keyof Style)[]=Object.keys(style) as (keyof Style)[]){
    this.style=style;
    if(this.canvas.freeDrawingBrush){this.canvas.freeDrawingBrush.color=style.color;this.canvas.freeDrawingBrush.width=style.width;}
    const active=this.canvas.getActiveObjects();
    const paint=(o: Mark)=>{
      if(['mosaic','blur'].includes(o.lassoTool||''))return;
      if(o instanceof Group){o.getObjects().forEach(c=>{if((o as Mark).lassoTool==='number'&&c instanceof FabricText){if(properties.includes('fontSize'))c.set({fontSize:style.fontSize});}else paint(c);});return;}
      if(o instanceof FabricText){
        if(properties.includes('color'))o.set({fill:style.color});
        if(properties.includes('fontSize'))o.set({fontSize:style.fontSize});
        if(o instanceof IText&&(properties.includes('textBackground')||properties.includes('color')))o.set({backgroundColor:textBackground({...style,color:typeof o.fill==='string'?o.fill:style.color,textBackground:properties.includes('textBackground')?style.textBackground:Boolean(o.backgroundColor)})});
      }
      else if(['redact','highlight','number'].includes(o.lassoTool||'')){if(properties.includes('color'))o.set({fill:o.lassoTool==='redact'?'#171717':style.color});}
      else {if(properties.includes('color'))o.set({stroke:style.color});if(properties.includes('width'))o.set({strokeWidth:style.width});}
      o.setCoords();
    };
    if(active.length){this.invalidate();active.forEach(o=>paint(o));this.canvas.requestRenderAll();this.commit();}
  }
  private point(p:{x:number;y:number}){const r=this.tool==='crop'&&this.selectionShape==='multi-rect'&&this.multiBounds?this.multiBounds:this.crop;return {x:Math.max(r.x,Math.min(r.x+r.width,p.x)),y:Math.max(r.y,Math.min(r.y+r.height,p.y))};}
  private down(p:{x:number;y:number},target?: FabricObject){
    if(this.restoring)return;
    if(this.tool==='select'){if(target)this.invalidate();return;}
    if(this.tool==='text-select'||this.tool==='picker'||this.tool==='watermark'||this.tool==='auto-mosaic')return;
    const point=this.point(p);this.invalidate();
    if(this.tool==='pen')return;
    if(this.tool==='text'){
      const text=new IText('输入文字',{left:point.x,top:point.y,originX:'left',originY:'top',fill:this.style.color,fontSize:this.style.fontSize,backgroundColor:textBackground(this.style),fontFamily:'-apple-system, PingFang SC, sans-serif'});
      this.canvas.add(this.decorate(text,'text'));this.setTool('select');this.canvas.setActiveObject(text);text.enterEditing();text.selectAll();this.canvas.requestRenderAll();return;
    }
    if(this.tool==='number'){
      const radius=this.style.fontSize*.7;
      const circle=this.decorate(new Circle({radius,fill:this.style.color,originX:'center',originY:'center'}),'number');
      const text=new FabricText(String(this.number++),{fontSize:this.style.fontSize,fill:'#fff',fontFamily:'sans-serif',originX:'center',originY:'center'});
      const group=new Group([circle,text],{left:point.x,top:point.y,originX:'center',originY:'center'});
      this.canvas.add(this.decorate(group,'number'));this.commit();this.canvas.requestRenderAll();return;
    }
    if(this.tool==='crop'&&this.selectionShape!=='rect'){if(!this.vertices.length)this.selectionBounds=this.multiBounds??{...this.crop};if(this.selectionShape==='polygon'){this.vertices.push(point);this.start=this.vertices[0];return;}this.vertices=[point];}
    this.start=point;
  }
  setShift(pressed:boolean){this.shift=pressed;if(this.start&&this.pointer)this.move(this.pointer);}
  private move(p:{x:number;y:number}){
    if(!this.start||this.restoring)return;
    this.pointer=p;
    let end=this.point(p);
    if(this.shift&&['rectangle','ellipse','line','arrow'].includes(this.tool))end=constrainedEnd(this.start,end,this.crop,['line','arrow'].includes(this.tool)?'angle':'square');
    if(this.tool==='crop'){
      if(this.selectionShape==='freehand'){this.vertices.push(end);this.previewPolygon();return;}
      if(this.selectionShape==='polygon'){this.previewPolygon(end);return;}
      const r=box(this.start,end);this.cropDraft=r;this.preview(r);return;
    }
    if(!shapeTools.has(this.tool))return;
    this.gestureEnd=end;
    if(this.previewFrame)return;
    this.previewFrame=requestAnimationFrame(()=>{this.previewFrame=0;if(this.start&&this.gestureEnd)this.paintPreview(this.gestureEnd);});
  }
  private paintPreview(end:{x:number;y:number}){
    const ctx=this.canvas.contextTop;if(!ctx||!this.start)return;
    this.canvas.clearContext(ctx);
    const start=this.start,r=box(start,end);
    ctx.save();ctx.transform(...this.matrix);ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle=this.style.color;ctx.lineWidth=this.style.width;
    ctx.fillStyle=this.tool==='redact'||this.tool==='mosaic'||this.tool==='blur'?'#171717':this.style.color;
    if(this.tool==='line'||this.tool==='arrow'){
      ctx.beginPath();ctx.moveTo(start.x,start.y);ctx.lineTo(end.x,end.y);
      if(this.tool==='arrow')for(const [a,b,c] of arrowPoints(start,end,this.style)){ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.lineTo(c.x,c.y);}
      ctx.stroke();
    }else if(this.tool==='ellipse'){ctx.beginPath();ctx.ellipse(r.x+r.width/2,r.y+r.height/2,Math.max(.5,r.width/2),Math.max(.5,r.height/2),0,0,Math.PI*2);ctx.stroke();}
    else if(this.tool==='highlight'){ctx.globalAlpha=.3;ctx.fillRect(r.x,r.y,r.width,r.height);}
    else if(this.tool==='rectangle')ctx.strokeRect(r.x,r.y,r.width,r.height);
    else if((this.tool==='mosaic'||this.tool==='blur')&&r.width&&r.height)ctx.drawImage(this.pixelEffect(r,this.tool),r.x,r.y);
    else ctx.fillRect(r.x,r.y,r.width,r.height);
    ctx.restore();
  }
  private clearPreview(){
    if(this.previewFrame){cancelAnimationFrame(this.previewFrame);this.previewFrame=0;}
    const ctx=this.canvas.contextTop;if(ctx)this.canvas.clearContext(ctx);
  }
  private up(){
    if(this.previewFrame){cancelAnimationFrame(this.previewFrame);this.previewFrame=0;}
    if(!this.start){if(this.tool==='select'||this.tool==='pen')this.commit();return;}
    if(this.tool==='crop'&&this.selectionShape==='polygon')return;
    const start=this.start,end=this.gestureEnd??this.pointer??start;
    this.start=null;this.pointer=null;this.gestureEnd=null;this.clearPreview();
    if(this.tool==='crop'&&this.selectionShape==='freehand'){this.finishPolygon();return;}
    if(this.tool==='crop'&&this.selectionShape==='multi-rect'){const r=this.cropDraft;this.cropDraft=null;this.preview(null);if(r&&r.width>=2&&r.height>=2){this.cropPolygons.push([{x:r.x,y:r.y},{x:r.x+r.width,y:r.y},{x:r.x+r.width,y:r.y+r.height},{x:r.x,y:r.y+r.height}]);this.finishMaskedCrop();}else this.changed();return;}
    if(this.tool==='crop'){this.cropPolygons=[];this.multiBounds=null;const r=this.cropDraft;this.cropDraft=null;this.preview(null);if(r&&r.width>=2&&r.height>=2)this.applyCrop(r);else this.changed();return;}
    if(!shapeTools.has(this.tool)){this.changed();return;}
    if(Math.hypot(end.x-start.x,end.y-start.y)<2){this.changed();return;}
    this.commitShape(start,end);
  }
  private commitShape(start:{x:number;y:number},end:{x:number;y:number}){
    const r=box(start,end);
    if(!['line','arrow'].includes(this.tool)&&(r.width<2||r.height<2)){this.changed();return;}
    const options={originX:'left' as const,originY:'top' as const,fill:'transparent',stroke:this.style.color,strokeWidth:this.style.width,selectable:false,evented:false};
    let o:FabricObject;
    if(this.tool==='line')o=new Line([start.x,start.y,end.x,end.y],options);
    else if(this.tool==='arrow'){
      const heads=arrowPoints(start,end,this.style).map(([a,b,c])=>`M ${a.x} ${a.y} L ${b.x} ${b.y} L ${c.x} ${c.y}`).join(' ');
      o=new Path(`M ${start.x} ${start.y} L ${end.x} ${end.y} ${heads}`,{...options,strokeLineCap:'round',strokeLineJoin:'round'});
    }else if(this.tool==='ellipse')o=new Ellipse({...options,left:r.x,top:r.y,rx:r.width/2,ry:r.height/2});
    else if(this.tool==='spotlight'){const c=this.crop;o=new Path(`M ${c.x} ${c.y} h ${c.width} v ${c.height} h ${-c.width} Z M ${r.x} ${r.y} h ${r.width} v ${r.height} h ${-r.width} Z`,{fill:'rgba(20, 20, 19, 0.6)',fillRule:'evenodd'});}
    else if(this.tool==='magnifier'||this.tool==='inpaint')o=new FabricImage(this.advancedPixels(r,this.tool),{left:r.x,top:r.y,originX:'left',originY:'top'});
    else if(this.tool==='mosaic'||this.tool==='blur')o=new FabricImage(this.pixelEffect(r,this.tool),{left:r.x,top:r.y,originX:'left',originY:'top'});
    else if(this.tool==='highlight')o=new Rect({...options,left:r.x,top:r.y,width:r.width,height:r.height,fill:this.style.color,strokeWidth:0,opacity:.3});
    else if(this.tool==='redact')o=new Rect({...options,left:r.x,top:r.y,width:r.width,height:r.height,fill:'#171717',strokeWidth:0});
    else o=new Rect({...options,left:r.x,top:r.y,width:r.width,height:r.height});
    this.decorate(o,this.tool);const bounds=o.getBoundingRect();
    if(bounds.width<2||bounds.height<2){o.dispose();this.changed();return;}
    this.canvas.add(o);o.setCoords();this.commit();this.canvas.requestRenderAll();
  }
  private pixelEffect(region:CaptureRect,tool:'mosaic'|'blur'){
    const raw=this.compose(region),pixels=document.createElement('canvas');pixels.width=region.width;pixels.height=region.height;const ctx=pixels.getContext('2d')!;
    if(tool==='mosaic'){
      const small=document.createElement('canvas');small.width=Math.max(1,Math.ceil(raw.width/this.style.mosaicSize));small.height=Math.max(1,Math.ceil(raw.height/this.style.mosaicSize));
      small.getContext('2d')!.drawImage(raw,0,0,small.width,small.height);ctx.imageSmoothingEnabled=false;ctx.drawImage(small,0,0,pixels.width,pixels.height);
    }else{
      // Fill the edges before blurring so the mask stays fully opaque.
      const padding=Math.ceil(this.style.blurRadius*1.5);
      ctx.drawImage(raw,0,0);ctx.filter=`blur(${this.style.blurRadius}px)`;ctx.drawImage(raw,-padding,-padding,raw.width+padding*2,raw.height+padding*2);
    }
    return pixels;
  }
  private previewPolygon(end?:{x:number;y:number}){const ctx=this.canvas.contextTop;this.canvas.clearContext(ctx);ctx.save();ctx.transform(...this.matrix);ctx.strokeStyle=this.style.color;ctx.lineWidth=2;ctx.beginPath();[...this.vertices,...(end?[end]:[])].forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();ctx.restore();}
  finishPolygon(){this.start=null;this.pointer=null;this.gestureEnd=null;this.clearPreview();const vertices=this.vertices;this.vertices=[];if(vertices.length<3){this.changed();return;}this.cropPolygons=[vertices];this.finishMaskedCrop();}
  private finishMaskedCrop(){const points=this.cropPolygons.flat(),xs=points.map(p=>p.x),ys=points.map(p=>p.y);if(Math.max(...xs)-Math.min(...xs)<2||Math.max(...ys)-Math.min(...ys)<2){this.cropPolygons=[];this.changed();return;}this.multiBounds=this.selectionBounds;this.applyCrop({x:Math.floor(Math.min(...xs)),y:Math.floor(Math.min(...ys)),width:Math.ceil(Math.max(...xs))-Math.floor(Math.min(...xs)),height:Math.ceil(Math.max(...ys))-Math.floor(Math.min(...ys))});}
  setSelectionShape(shape:typeof this.selectionShape){if(this.selectionShape==='polygon')this.finishPolygon();else if(this.start)this.up();this.selectionShape=shape;this.vertices=[];this.multiBounds=null;this.cropPolygons=[];this.syncView();this.commit();}
  watermark(text:string,opacity:number){
    if(!text.trim())return;this.invalidate();const r=this.crop,marks:FabricText[]=[];
    for(let y=r.y-120;y<r.y+r.height+120;y+=140)for(let x=r.x-100;x<r.x+r.width+100;x+=Math.max(220,text.length*20))marks.push(new FabricText(text,{left:x,top:y,angle:-28,fontSize:28,fill:this.style.color,opacity}));
    this.canvas.add(this.decorate(new Group(marks,{selectable:false,evented:false}),'watermark'));this.commit();this.canvas.requestRenderAll();
  }
  autoMosaic(lines:OCRLine[],word:string){
    word=word.trim();if(!word)return 0;const matches:CaptureRect[]=[];
    for(const line of lines){let at=0,index:number;while((index=line.text.indexOf(word,at))>=0){const glyphs=line.glyphs.filter((_,i)=>{const start=line.glyphs.slice(0,i).reduce((n,g)=>n+g.text.length,0);return start<index+word.length&&start+line.glyphs[i].text.length>index;});if(glyphs.length){const x=Math.min(...glyphs.map(g=>g.x)),y=Math.min(...glyphs.map(g=>g.y));matches.push({x,y,width:Math.max(...glyphs.map(g=>g.x+g.width))-x,height:Math.max(...glyphs.map(g=>g.y+g.height))-y});}else matches.push(line);at=index+word.length;}}
    if(!matches.length)return 0;this.invalidate();for(const r of matches)this.canvas.add(this.decorate(new Rect({left:r.x,top:r.y,originX:'left',originY:'top',width:r.width,height:r.height,strokeWidth:0,fill:'rgba(20, 20, 19, 1)',selectable:false,evented:false}),'redact'));this.commit();this.canvas.requestRenderAll();return matches.length;
  }
  private advancedPixels(r:CaptureRect,tool:'magnifier'|'inpaint'){
    const canvas=document.createElement('canvas');canvas.width=r.width;canvas.height=r.height;const ctx=canvas.getContext('2d')!,raw=this.compose({x:0,y:0,width:this.source.width,height:this.source.height});
    if(tool==='magnifier'){ctx.save();ctx.beginPath();if(this.magnifierShape==='circle')ctx.arc(r.width/2,r.height/2,Math.min(r.width,r.height)/2,0,Math.PI*2);else ctx.rect(0,0,r.width,r.height);ctx.clip();ctx.drawImage(raw,r.x+r.width/4,r.y+r.height/4,r.width/2,r.height/2,0,0,r.width,r.height);ctx.restore();ctx.strokeStyle=this.style.color;ctx.lineWidth=3;ctx.stroke();}
    else {const source=raw.getContext('2d')!,data=source.getImageData(0,0,raw.width,raw.height),out=ctx.createImageData(r.width,r.height);for(let y=0;y<r.height;y++)for(let x=0;x<r.width;x++){const u=(x+1)/(r.width+1),v=(y+1)/(r.height+1),pixel=(px:number,py:number,c:number)=>data.data[(Math.max(0,Math.min(raw.height-1,py))*raw.width+Math.max(0,Math.min(raw.width-1,px)))*4+c];for(let c=0;c<4;c++)out.data[(y*r.width+x)*4+c]=(pixel(r.x-1,r.y+y,c)*(1-u)+pixel(r.x+r.width,r.y+y,c)*u+pixel(r.x+x,r.y-1,c)*(1-v)+pixel(r.x+x,r.y+r.height,c)*v)/2;}ctx.putImageData(out,0,0);}
    return canvas;
  }
  applyCrop(r: CaptureRect,save=true){
    if(r.width<2||r.height<2)return;
    const x=Math.max(0,Math.min(this.source.width-2,Math.round(r.x))),y=Math.max(0,Math.min(this.source.height-2,Math.round(r.y)));
    this.crop={x,y,width:Math.min(Math.round(r.width),this.source.width-x),height:Math.min(Math.round(r.height),this.source.height-y)};
    this.syncView();if(save)this.commit();else this.changed();
  }
  commitCrop(){this.commit();}
  resetCrop(r?:CaptureRect){this.cropPolygons=[];this.multiBounds=null;this.crop=r?{...r}:{x:0,y:0,width:this.source.width,height:this.source.height};this.syncView();this.commit();}
  /** The clipboard belongs to this editor session. It never writes the system image clipboard. */
  copy(){
    if(this.restoring||this.disposed||this.isEditingText)return false;
    const objects=this.canvas.getActiveObjects();if(!objects.length)return false;
    this.objectClipboard=objects.map(serializeMark);
    this.pasteOffset=0;return true;
  }
  async paste(){
    if(!this.objectClipboard||this.restoring||this.disposed||this.start||this.isEditingText)return;
    this.restoring=true;this.invalidate();
    try{
      const objects=await util.enlivenObjects<Mark>(this.objectClipboard);
      if(this.disposed){objects.forEach(o=>o.dispose());return;}
      this.canvas.discardActiveObject();this.setTool('select');
      const offset=this.pasteOffset+16,rects=objects.map(o=>o.getBoundingRect());
      const left=Math.min(...rects.map(r=>r.left)),top=Math.min(...rects.map(r=>r.top)),right=Math.max(...rects.map(r=>r.left+r.width)),bottom=Math.max(...rects.map(r=>r.top+r.height));
      const dx=Math.max(this.crop.x-left,Math.min(offset,this.crop.x+this.crop.width-right)),dy=Math.max(this.crop.y-top,Math.min(offset,this.crop.y+this.crop.height-bottom));
      for(const o of objects){this.decorate(o,o.lassoTool);o.set({left:o.left+dx,top:o.top+dy,selectable:true,evented:true});this.canvas.add(o);o.setCoords();}
      this.canvas.setActiveObject(objects.length===1?objects[0]:new ActiveSelection(objects,{canvas:this.canvas}));
      this.pasteOffset=offset;this.canvas.requestRenderAll();
    }finally{this.restoring=false;if(!this.disposed)this.commit();}
  }
  async duplicate(){if(this.copy())await this.paste();}
  private constrainTransform({e,transform,target}:BasicTransformEvent & {target:FabricObject}){
    if(!e.shiftKey)return;
    const o=target as Mark,kind=o.lassoTool;
    const anchor=o.getPositionByOrigin(transform.originX,transform.originY);
    if((kind==='rectangle'||kind==='ellipse')&&transform.action!=='rotate'){
      const side=Math.max(o.width*o.scaleX,o.height*o.scaleY);
      if(o.width&&o.height)o.set({scaleX:side/o.width,scaleY:side/o.height});
    }else if(kind==='line'||kind==='arrow'){
      const path=o instanceof Path?o.path:null;
      const start=path?.[0],end=path?.[1];
      const dx=o instanceof Line?o.x2-o.x1:start?.[0]==='M'&&end?.[0]==='L'?end[1]-start[1]:0;
      const dy=o instanceof Line?o.y2-o.y1:start?.[0]==='M'&&end?.[0]==='L'?end[2]-start[2]:0;
      const angle=o.angle+Math.atan2(dy*o.scaleY*(o.flipY?-1:1),dx*o.scaleX*(o.flipX?-1:1))*180/Math.PI;
      o.rotate(o.angle+Math.round(angle/45)*45-angle);
    }else return;
    o.setPositionByOrigin(anchor,transform.originX,transform.originY);o.setCoords();
  }
  remove(){const objects=this.canvas.getActiveObjects();if(!objects.length||this.restoring)return;this.invalidate();this.canvas.discardActiveObject();this.canvas.remove(...objects);this.commit();this.canvas.requestRenderAll();}
  nudge(dx:number,dy:number){const object=this.canvas.getActiveObject();if(!object||this.restoring)return;this.invalidate();object.set({left:object.left+dx,top:object.top+dy});object.setCoords();this.canvas.requestRenderAll();this.commit();}
  private save(){
    const snapshot=this.snapshot();
    const json=JSON.stringify(snapshot);if(this.history[this.cursor]===json)return;
    this.history=this.history.slice(0,this.cursor+1);this.history.push(json);
    while(this.history.length>40||(this.history.length>1&&this.history.reduce((n,s)=>n+s.length,0)>16_000_000))this.history.shift();
    this.cursor=this.history.length-1;
  }
  private commit(){if(this.restoring||this.disposed)return;this.flat=null;this.sampled=null;this.save();this.changed();}
  async restore(delta:number){
    const next=this.cursor+delta;if(this.restoring||next<0||next>=this.history.length)return;
    this.flat=null;this.sampled=null;this.restoring=true;this.invalidate();
    try{
      const snap=JSON.parse(this.history[next]) as Snapshot;
      if(!await this.applySnapshot(snap,snap.crop))return;
      this.cursor=next;this.setTool(this.tool);this.canvas.requestRenderAll();
    }finally{this.restoring=false;if(!this.disposed)this.changed();}
  }
  private compose(crop=this.crop){
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,crop.width);canvas.height=Math.max(1,crop.height);
    const ctx=canvas.getContext('2d',{willReadFrequently:true})!;
    ctx.drawImage(this.source,crop.x,crop.y,crop.width,crop.height,0,0,crop.width,crop.height);
    if(this.canvas.getObjects().length){const view=this.canvas.viewportTransform;this.canvas.viewportTransform=[1,0,0,1,0,0];try{ctx.drawImage(this.canvas.toCanvasElement(1,{left:crop.x,top:crop.y,width:crop.width,height:crop.height}),0,0);}finally{this.canvas.viewportTransform=view;this.canvas.calcViewportBoundaries();}}
    if(this.cropPolygons.length){ctx.globalCompositeOperation='destination-in';ctx.beginPath();for(const p of this.cropPolygons){p.forEach((v,i)=>i?ctx.lineTo(v.x-crop.x,v.y-crop.y):ctx.moveTo(v.x-crop.x,v.y-crop.y));ctx.closePath();}ctx.fill();}
    return canvas;
  }
  private composed(){
    if(this.flat)return this.flat;
    const raw=this.compose(),canvas=document.createElement('canvas');Object.assign(canvas,this.outputSize);const ctx=canvas.getContext('2d')!,m=this.matrix;
    ctx.filter=this.filter;ctx.setTransform(m[0],m[1],m[2],m[3],m[4]-this.crop.x,m[5]-this.crop.y);ctx.drawImage(raw,this.crop.x,this.crop.y);return this.flat=canvas;
  }
  bitmap(){
    if(this.restoring||this.start||this.isEditingText)throw new Error('请先完成当前编辑。');
    const flat=this.composed();return new Uint8Array(flat.getContext('2d')!.getImageData(0,0,flat.width,flat.height).data);
  }
  async pixels(transformed=true){
    if(this.restoring||this.start||this.isEditingText)throw new Error('请先完成当前编辑。');
    const flat=transformed?this.composed():this.compose();
    const blob=await new Promise<Blob>((resolve,reject)=>flat.toBlob(b=>b?resolve(b):reject(Error('图片合成失败')),'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }
  dispose(){this.disposed=true;this.flat=null;this.sampled=null;this.clearPreview();this.objectClipboard=null;this.source.remove();void this.canvas.dispose().then(()=>{this.source.width=this.source.height=0;});this.history=[];}
}
