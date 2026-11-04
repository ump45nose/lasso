import { ActiveSelection, Canvas, Circle, Ellipse, FabricImage, FabricObject, FabricText, Group, IText, Line, Path, PencilBrush, Rect, util, type BasicTransformEvent } from 'fabric';
import type { AnnotationSnapshot, CaptureRect, EditorCheckpoint } from '../../shared/capture';
import { screenshotDefaults, type AnnotationStyleConfig } from '../../shared/screenshot-settings';
import { constrainedEnd } from './annotation-geometry';

export type Tool = 'text-select' | 'select' | 'arrow' | 'line' | 'rectangle' | 'ellipse' | 'pen' | 'highlight' | 'text' | 'number' | 'redact' | 'mosaic' | 'blur' | 'crop' | 'picker';
export type Style = AnnotationStyleConfig;
type Mark = FabricObject & { lassoTool?: Tool };
type Snapshot = AnnotationSnapshot;
const box = (a: { x: number; y: number }, b: { x: number; y: number }): CaptureRect => ({ x: Math.round(Math.min(a.x,b.x)), y: Math.round(Math.min(a.y,b.y)), width: Math.round(Math.abs(b.x-a.x)), height: Math.round(Math.abs(b.y-a.y)) });
const shapeTools = new Set<Tool>(['arrow', 'line', 'rectangle', 'ellipse', 'highlight', 'redact', 'mosaic', 'blur']);
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
  private loupe: HTMLCanvasElement | null = null;
  private shift = false;
  constructor(element: HTMLCanvasElement, readonly source: HTMLCanvasElement, private changed: () => void, private invalidate: () => void, private preview: (r: CaptureRect | null) => void, initialCrop?:CaptureRect, selected?:()=>void) {
    this.crop = initialCrop?{...initialCrop}:{ x:0,y:0,width:source.width,height:source.height };
    this.canvas = new Canvas(element, { width:source.width,height:source.height,enableRetinaScaling:false,preserveObjectStacking:true,selection:false,altActionKey:undefined,backgroundColor:'',renderOnAddRemove:false });
    const wrapper=this.canvas.wrapperEl;
    wrapper.style.position='absolute';wrapper.style.left='0';wrapper.style.top='0';
    source.classList.add('editor-source');source.setAttribute('aria-hidden','true');
    wrapper.parentElement?.insertBefore(source,wrapper);
    this.canvas.on('mouse:down',e=>this.down(e.scenePoint,e.target));
    this.canvas.on('mouse:move',e=>{this.shift=e.e.shiftKey;this.move(e.scenePoint);});
    this.canvas.on('mouse:up',()=>this.up());
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
  snapshot(visibleOnly=false): Snapshot {return {objects:this.canvas.getObjects().filter(o=>{const r=o.getBoundingRect();return !visibleOnly||intersects({x:r.left,y:r.top,width:r.width,height:r.height},this.crop);}).map(o=>({...serializeMark(o),...(visibleOnly?{lassoBounds:(()=>{const r=o.getBoundingRect();return {x:r.left,y:r.top,width:r.width,height:r.height};})()}: {})})),crop:{...this.crop},nextNumber:this.number,privacy:this.privacy};}
  async load(snapshot: Snapshot){
    this.flat=null;this.restoring=true;
    try{
      const objects=await util.enlivenObjects<FabricObject>(snapshot.objects);
      if(this.disposed){objects.forEach(o=>o.dispose());return;}
      this.canvas.discardActiveObject();this.canvas.remove(...this.canvas.getObjects());objects.forEach(o=>this.canvas.add(this.decorate(o,(o as Mark).lassoTool)));
      this.crop={...snapshot.crop};this.number=snapshot.nextNumber;this.history=[];this.cursor=-1;
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
  get privacy(){return this.canvas.getObjects().filter(o=>['redact','mosaic','blur'].includes((o as Mark).lassoTool||'')).map(o=>{const r=o.getBoundingRect();return {x:r.left,y:r.top,width:r.width,height:r.height};});}
  /** Warm the flattened pixels after the tool changes, so the first loupe move does not composite. */
  prepareSample(){if(!this.disposed&&!this.flat)this.flat=this.compose();}
  sample(x:number,y:number){
    x=Math.floor(x);y=Math.floor(y);if(x<this.crop.x||y<this.crop.y||x>=this.crop.x+this.crop.width||y>=this.crop.y+this.crop.height)return null;
    const flat=this.flat??=this.compose(),sx=x-this.crop.x,sy=y-this.crop.y,pixel=flat.getContext('2d')!.getImageData(sx,sy,1,1).data;
    const loupe=this.loupe??=Object.assign(document.createElement('canvas'),{width:17,height:17}),preview=loupe.getContext('2d')!;
    preview.imageSmoothingEnabled=false;preview.clearRect(0,0,17,17);preview.drawImage(flat,sx-8,sy-8,17,17,0,0,17,17);
    return {color:'#'+[pixel[0],pixel[1],pixel[2]].map(v=>v.toString(16).padStart(2,'0')).join(''),rgb:`rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`,image:loupe,x,y};
  }
  private decorate(o: Mark, tool: Tool | undefined){o.lassoTool=tool;o.set({borderColor:'#bd7658',cornerColor:'#bd7658',cornerStrokeColor:'#fff',transparentCorners:false,cornerSize:10});return o;}
  setTool(tool: Tool){
    if(this.start)this.up();
    this.clearPreview();
    if(this.isEditingText)(this.canvas.getActiveObject() as IText).exitEditing();
    this.tool=tool;this.canvas.discardActiveObject();this.canvas.selection=tool==='select';this.canvas.skipTargetFind=tool!=='select';
    this.canvas.isDrawingMode=tool==='pen';
    if(this.canvas.isDrawingMode){const brush=new PencilBrush(this.canvas);brush.color=this.style.color;brush.width=this.style.width;this.canvas.freeDrawingBrush=brush;}
    for(const o of this.canvas.getObjects())o.set({selectable:tool==='select',evented:tool==='select'});
    this.canvas.defaultCursor=tool==='select'?'default':'crosshair';this.canvas.requestRenderAll();
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
  private point(p:{x:number;y:number}){return {x:Math.max(this.crop.x,Math.min(this.crop.x+this.crop.width,p.x)),y:Math.max(this.crop.y,Math.min(this.crop.y+this.crop.height,p.y))};}
  private down(p:{x:number;y:number},target?: FabricObject){
    if(this.restoring)return;
    if(this.tool==='select'){if(target)this.invalidate();return;}
    if(this.tool==='text-select'||this.tool==='picker')return;
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
    this.start=point;
  }
  setShift(pressed:boolean){this.shift=pressed;if(this.start&&this.pointer)this.move(this.pointer);}
  private move(p:{x:number;y:number}){
    if(!this.start||this.restoring)return;
    this.pointer=p;
    let end=this.point(p);
    if(this.shift&&['rectangle','ellipse','line','arrow'].includes(this.tool))end=constrainedEnd(this.start,end,this.crop,['line','arrow'].includes(this.tool)?'angle':'square');
    if(this.tool==='crop'){const r=box(this.start,end);this.cropDraft=r;this.preview(r);return;}
    if(!shapeTools.has(this.tool))return;
    this.gestureEnd=end;
    if(this.previewFrame)return;
    this.previewFrame=requestAnimationFrame(()=>{this.previewFrame=0;if(this.start&&this.gestureEnd)this.paintPreview(this.gestureEnd);});
  }
  private paintPreview(end:{x:number;y:number}){
    const ctx=this.canvas.contextTop;if(!ctx||!this.start)return;
    this.canvas.clearContext(ctx);
    const start=this.start,r=box(start,end);
    ctx.save();ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle=this.style.color;ctx.lineWidth=this.style.width;
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
    const start=this.start,end=this.gestureEnd??start;
    this.start=null;this.pointer=null;this.gestureEnd=null;this.clearPreview();
    if(this.tool==='crop'){const r=this.cropDraft;this.cropDraft=null;this.preview(null);if(r&&r.width>=2&&r.height>=2)this.applyCrop(r);else this.changed();return;}
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
  applyCrop(r: CaptureRect,save=true){
    if(r.width<2||r.height<2)return;
    const x=Math.max(0,Math.min(this.source.width-2,Math.round(r.x))),y=Math.max(0,Math.min(this.source.height-2,Math.round(r.y)));
    this.crop={x,y,width:Math.min(Math.round(r.width),this.source.width-x),height:Math.min(Math.round(r.height),this.source.height-y)};
    if(save)this.commit();else this.changed();
  }
  commitCrop(){this.commit();}
  resetCrop(){this.crop={x:0,y:0,width:this.source.width,height:this.source.height};this.commit();}
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
  private commit(){if(this.restoring||this.disposed)return;this.flat=null;this.save();this.changed();}
  async restore(delta:number){
    const next=this.cursor+delta;if(this.restoring||next<0||next>=this.history.length)return;
    this.flat=null;this.restoring=true;this.invalidate();
    try{
      const snap=JSON.parse(this.history[next]) as Snapshot;
      const objects=await util.enlivenObjects<FabricObject>(snap.objects);
      if(this.disposed){objects.forEach(o=>o.dispose());return;}
      this.canvas.discardActiveObject();this.canvas.remove(...this.canvas.getObjects());objects.forEach(o=>this.canvas.add(this.decorate(o,(o as Mark).lassoTool)));this.crop=snap.crop;this.number=snap.nextNumber;this.cursor=next;this.setTool(this.tool);this.canvas.requestRenderAll();
    }finally{this.restoring=false;if(!this.disposed)this.changed();}
  }
  private compose(crop=this.crop){
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,crop.width);canvas.height=Math.max(1,crop.height);
    const ctx=canvas.getContext('2d',{willReadFrequently:true})!;
    ctx.drawImage(this.source,crop.x,crop.y,crop.width,crop.height,0,0,crop.width,crop.height);
    if(this.canvas.getObjects().length)ctx.drawImage(this.canvas.toCanvasElement(1,{left:crop.x,top:crop.y,width:crop.width,height:crop.height}),0,0);
    return canvas;
  }
  private composed(){return this.flat??=this.compose();}
  bitmap(){
    if(this.restoring||this.start||this.isEditingText)throw new Error('请先完成当前编辑。');
    const flat=this.composed();return new Uint8Array(flat.getContext('2d')!.getImageData(0,0,flat.width,flat.height).data);
  }
  async pixels(){
    if(this.restoring||this.start||this.isEditingText)throw new Error('请先完成当前编辑。');
    const flat=this.composed();
    const blob=await new Promise<Blob>((resolve,reject)=>flat.toBlob(b=>b?resolve(b):reject(Error('图片合成失败')),'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }
  dispose(){this.disposed=true;this.flat=null;this.clearPreview();this.objectClipboard=null;this.source.remove();void this.canvas.dispose().then(()=>{this.source.width=this.source.height=0;});this.history=[];}
}
