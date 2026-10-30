import { ActiveSelection, Canvas, Circle, Ellipse, FabricImage, FabricObject, FabricText, Group, IText, Line, Path, PencilBrush, Rect, util, type BasicTransformEvent } from 'fabric';
import type { AnnotationSnapshot, CaptureRect, EditorCheckpoint } from '../../shared/capture';
import { constrainedEnd } from './annotation-geometry';

export type Tool = 'text-select' | 'select' | 'arrow' | 'line' | 'rectangle' | 'ellipse' | 'pen' | 'highlight' | 'text' | 'number' | 'redact' | 'mosaic' | 'blur' | 'crop' | 'picker';
export type Style = { color: string; width: number; fontSize: number };
type Mark = FabricObject & { lassoTool?: Tool };
type Snapshot = AnnotationSnapshot;
const box = (a: { x: number; y: number }, b: { x: number; y: number }): CaptureRect => ({ x: Math.round(Math.min(a.x,b.x)), y: Math.round(Math.min(a.y,b.y)), width: Math.round(Math.abs(b.x-a.x)), height: Math.round(Math.abs(b.y-a.y)) });
export const intersects = (a: CaptureRect,b: CaptureRect) => a.x < b.x+b.width && a.x+a.width > b.x && a.y < b.y+b.height && a.y+a.height > b.y;
// ActiveSelection stores children in group coordinates; history and clipboard always store image coordinates.
const serializeMark=(o:FabricObject):Record<string,unknown>=>{
  const {translateX,translateY,scaleX,scaleY,...transform}=util.qrDecompose(o.calcTransformMatrix());
  return {...o.toObject(['lassoTool']),...transform,scaleX:Math.abs(scaleX),scaleY:Math.abs(scaleY),left:translateX,top:translateY,originX:'center',originY:'center',flipX:scaleX<0,flipY:scaleY<0};
};

/** Fabric owns object editing; this adapter owns tools, bounded history and pixels.
 * No eSearch application/tool source is copied into this module. */
export class AnnotationEditor {
  readonly canvas: Canvas;
  crop: CaptureRect;
  tool: Tool = 'text-select';
  style: Style = { color: '#e24a35', width: 4, fontSize: 32 };
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
  private shift = false;
  constructor(element: HTMLCanvasElement, readonly source: HTMLCanvasElement, private changed: () => void, private invalidate: () => void, private preview: (r: CaptureRect | null) => void, initialCrop?:CaptureRect) {
    this.crop = initialCrop?{...initialCrop}:{ x:0,y:0,width:source.width,height:source.height };
    this.canvas = new Canvas(element, { width:source.width,height:source.height,enableRetinaScaling:false,preserveObjectStacking:true,selection:false,altActionKey:undefined,backgroundColor:'',renderOnAddRemove:false });
    this.canvas.backgroundImage = new FabricImage(source,{originX:'left',originY:'top'});
    this.canvas.on('mouse:down',e=>this.down(e.scenePoint,e.target));
    this.canvas.on('mouse:move',e=>{this.shift=e.e.shiftKey;this.move(e.scenePoint);});
    this.canvas.on('mouse:up',()=>this.up());
    this.canvas.on('path:created',({path})=>{(path as Mark).lassoTool=this.tool;this.commit();});
    this.canvas.on('object:modified',()=>this.commit());
    this.canvas.on('object:scaling',e=>this.constrainTransform(e));
    this.canvas.on('object:rotating',e=>this.constrainTransform(e));
    this.canvas.on('text:changed',()=>this.invalidate());
    this.canvas.on('text:editing:exited',()=>this.commit());
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
    this.restoring=true;
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
    this.style = {...checkpoint.style}; this.objectClipboard = checkpoint.objectClipboard;
    this.setTool(checkpoint.tool as Tool);
  }
  get isEditingText(){return this.canvas.getActiveObject() instanceof IText && (this.canvas.getActiveObject() as IText).isEditing;}
  get privacy(){return this.canvas.getObjects().filter(o=>['redact','mosaic','blur'].includes((o as Mark).lassoTool||'')).map(o=>{const r=o.getBoundingRect();return {x:r.left,y:r.top,width:r.width,height:r.height};});}
  sample(x:number,y:number){
    x=Math.floor(x);y=Math.floor(y);if(x<this.crop.x||y<this.crop.y||x>=this.crop.x+this.crop.width||y>=this.crop.y+this.crop.height)return null;
    // Fabric draws selection controls on its upper canvas; the lower canvas contains only image pixels.
    const canvas=this.canvas.lowerCanvasEl,ctx=canvas.getContext('2d')!,pixel=ctx.getImageData(x,y,1,1).data;
    const preview=document.createElement('canvas');preview.width=17;preview.height=17;preview.getContext('2d')!.drawImage(canvas,x-8,y-8,17,17,0,0,17,17);
    return {color:'#'+[pixel[0],pixel[1],pixel[2]].map(v=>v.toString(16).padStart(2,'0')).join(''),rgb:`rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`,image:preview.toDataURL(),x,y};
  }
  private decorate(o: Mark, tool: Tool | undefined){o.lassoTool=tool;o.set({borderColor:'#bd7658',cornerColor:'#bd7658',cornerStrokeColor:'#fff',transparentCorners:false,cornerSize:10});return o;}
  setTool(tool: Tool){
    if(this.start)this.up();
    if(this.isEditingText)(this.canvas.getActiveObject() as IText).exitEditing();
    this.tool=tool;this.canvas.discardActiveObject();this.canvas.selection=tool==='select';this.canvas.skipTargetFind=tool!=='select';
    this.canvas.isDrawingMode=tool==='pen';
    if(this.canvas.isDrawingMode){const brush=new PencilBrush(this.canvas);brush.color=this.style.color;brush.width=this.style.width;this.canvas.freeDrawingBrush=brush;}
    for(const o of this.canvas.getObjects())o.set({selectable:tool==='select',evented:tool==='select'});
    this.canvas.defaultCursor=tool==='select'?'default':'crosshair';this.canvas.requestRenderAll();
  }
  setStyle(style: Style){
    this.style=style;
    if(this.canvas.freeDrawingBrush){this.canvas.freeDrawingBrush.color=style.color;this.canvas.freeDrawingBrush.width=style.width;}
    const active=this.canvas.getActiveObjects();
    const paint=(o: Mark)=>{
      if(['mosaic','blur'].includes(o.lassoTool||''))return;
      if(o instanceof Group){o.getObjects().forEach(c=>{if((o as Mark).lassoTool==='number'&&c instanceof FabricText)c.set({fontSize:style.fontSize});else paint(c);});return;}
      if(o instanceof FabricText)o.set({fill:style.color,fontSize:style.fontSize});
      else if(['redact','highlight','number'].includes(o.lassoTool||''))o.set({fill:o.lassoTool==='redact'?'#171717':style.color});
      else o.set({stroke:style.color,strokeWidth:style.width});
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
      const text=new IText('输入文字',{left:point.x,top:point.y,originX:'left',originY:'top',fill:this.style.color,fontSize:this.style.fontSize,fontFamily:'-apple-system, PingFang SC, sans-serif'});
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
    const r=box(this.start,end);
    if(this.tool==='crop'){this.cropDraft=r;this.preview(r);return;}
    if(Math.hypot(end.x-this.start.x,end.y-this.start.y)<2){if(this.draft){this.canvas.remove(this.draft);this.draft=null;this.canvas.requestRenderAll();}return;}
    if(this.draft)this.canvas.remove(this.draft);
    const options={originX:'left' as const,originY:'top' as const,fill:'transparent',stroke:this.style.color,strokeWidth:this.style.width,selectable:false,evented:false,objectCaching:false};
    let o: FabricObject;
    if(this.tool==='line')o=new Line([this.start.x,this.start.y,end.x,end.y],options);
    else if(this.tool==='arrow'){
      const {x,y}=this.start,angle=Math.atan2(end.y-y,end.x-x),head=Math.max(14,this.style.width*4);
      o=new Path(`M ${x} ${y} L ${end.x} ${end.y} M ${end.x-head*Math.cos(angle-.5)} ${end.y-head*Math.sin(angle-.5)} L ${end.x} ${end.y} L ${end.x-head*Math.cos(angle+.5)} ${end.y-head*Math.sin(angle+.5)}`,{...options,strokeLineCap:'round',strokeLineJoin:'round'});
    }else if(this.tool==='ellipse')o=new Ellipse({...options,left:r.x,top:r.y,rx:r.width/2,ry:r.height/2});
    else o=new Rect({...options,left:r.x,top:r.y,width:r.width,height:r.height,...(this.tool==='highlight'?{fill:this.style.color,strokeWidth:0,opacity:.3}:['redact','mosaic','blur'].includes(this.tool)?{fill:'#171717',strokeWidth:0}:{} )});
    this.draft=this.decorate(o,this.tool);this.canvas.add(this.draft);this.canvas.requestRenderAll();
  }
  private up(){
    if(!this.start){if(this.tool==='select'||this.tool==='pen')this.commit();return;}
    this.start=null;this.pointer=null;
    if(this.tool==='crop'){const r=this.cropDraft;this.cropDraft=null;this.preview(null);if(r&&r.width>=2&&r.height>=2)this.applyCrop(r);else this.changed();return;}
    if(!this.draft){this.changed();return;}
    let o=this.draft;this.draft=null;
    const r=o.getBoundingRect();
    if(r.width<2||r.height<2){this.canvas.remove(o);this.canvas.requestRenderAll();this.changed();return;}
    if(this.tool==='mosaic'||this.tool==='blur'){
      this.canvas.remove(o);
      const region={x:Math.floor(r.left),y:Math.floor(r.top),width:Math.max(1,Math.round(r.width)),height:Math.max(1,Math.round(r.height))};
      const raw=this.canvas.toCanvasElement(1,{left:region.x,top:region.y,width:region.width,height:region.height});
      const pixels=document.createElement('canvas');pixels.width=region.width;pixels.height=region.height;const ctx=pixels.getContext('2d')!;
      if(this.tool==='mosaic'){
        const small=document.createElement('canvas');small.width=Math.max(1,Math.ceil(raw.width/16));small.height=Math.max(1,Math.ceil(raw.height/16));small.getContext('2d')!.drawImage(raw,0,0,small.width,small.height);
        ctx.imageSmoothingEnabled=false;ctx.drawImage(small,0,0,pixels.width,pixels.height);
      }else{
        // Fill the edges before blurring so the mask stays fully opaque.
        ctx.drawImage(raw,0,0);ctx.filter='blur(12px)';ctx.drawImage(raw,-16,-16,raw.width+32,raw.height+32);
      }
      o=this.decorate(new FabricImage(pixels,{left:region.x,top:region.y,originX:'left',originY:'top'}),this.tool);this.canvas.add(o);
    }
    o.setCoords();this.commit();this.canvas.requestRenderAll();
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
  private commit(){if(this.restoring||this.disposed)return;this.save();this.changed();}
  async restore(delta:number){
    const next=this.cursor+delta;if(this.restoring||next<0||next>=this.history.length)return;
    this.restoring=true;this.invalidate();
    try{
      const snap=JSON.parse(this.history[next]) as Snapshot;
      const objects=await util.enlivenObjects<FabricObject>(snap.objects);
      if(this.disposed){objects.forEach(o=>o.dispose());return;}
      this.canvas.discardActiveObject();this.canvas.remove(...this.canvas.getObjects());objects.forEach(o=>this.canvas.add(this.decorate(o,(o as Mark).lassoTool)));this.crop=snap.crop;this.number=snap.nextNumber;this.cursor=next;this.setTool(this.tool);this.canvas.requestRenderAll();
    }finally{this.restoring=false;if(!this.disposed)this.changed();}
  }
  async pixels(){
    if(this.restoring||this.start||this.isEditingText)throw new Error('请先完成当前编辑。');
    const {x,y,width,height}=this.crop;
    const flat=this.canvas.toCanvasElement(1,{left:x,top:y,width,height});
    const blob=await new Promise<Blob>((resolve,reject)=>flat.toBlob(b=>b?resolve(b):reject(Error('图片合成失败')),'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }
  dispose(){this.disposed=true;this.objectClipboard=null;void this.canvas.dispose().then(()=>{this.source.width=this.source.height=0;});this.history=[];}
}
