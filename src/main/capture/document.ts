import type { NativeImage } from 'electron';
import type { AnnotationSnapshot, CaptureRect } from '../../shared/capture';

export interface PinnedDocument { pixelScale?: { x: number; y: number }; source: NativeImage; image: NativeImage; annotations: AnnotationSnapshot }
export function validateAnnotations(value: AnnotationSnapshot | undefined, source: Pick<NativeImage,'getSize'>, crop: CaptureRect): AnnotationSnapshot {
  if(!value||!Array.isArray(value.objects)||value.objects.length>3000||!Number.isSafeInteger(value.nextNumber)||value.nextNumber<1||value.nextNumber>1000000)throw Error('贴图标注数据无效');
  const size=source.getSize(),r=value.crop;
  if(!r||![r.x,r.y,r.width,r.height].every(Number.isSafeInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>size.width||r.y+r.height>size.height||['x','y','width','height'].some(k=>r[k as keyof CaptureRect]!==crop[k as keyof CaptureRect]))throw Error('贴图裁剪范围无效');
  if(!Array.isArray(value.privacy)||value.privacy.length>3000||value.privacy.some(r=>!r||![r.x,r.y,r.width,r.height].every(Number.isFinite)||r.width<0||r.height<0))throw Error('隐私区域数据无效');
  const allowed=new Set(['Rect','Circle','Ellipse','Line','Path','Group','Text','IText','Image','layoutManager','fit-content','fixed']);
  let count=0;
  const visit=(v:unknown,depth=0)=>{
    if(depth>40||++count>300000)throw Error('贴图标注过多');
    if(typeof v==='number'&&!Number.isFinite(v))throw Error('贴图标注坐标无效');
    if(!v||typeof v!=='object')return;
    for(const [key,child] of Object.entries(v)){
      if(key==='__proto__'||key==='constructor'||key==='prototype')throw Error('贴图标注属性无效');
      if(key==='type'&&typeof child==='string'&&!allowed.has(child))throw Error('不支持的贴图标注：'+child);
      if(key==='src'&&(typeof child!=='string'||!child.startsWith('data:image/png;base64,')))throw Error('贴图只允许内嵌图片');
      visit(child,depth+1);
    }
  };
  const json=JSON.stringify(value);if(json.length>16_000_000)throw Error('贴图标注数据过大');
  visit(value);return JSON.parse(json) as AnnotationSnapshot;
}

/** Screen-edit snapshots use canvas-space top-level positions; nested Group/Path geometry stays local. */
export function normalizeRegionAnnotations(snapshot:AnnotationSnapshot,crop:CaptureRect):AnnotationSnapshot {
  const overlap=(a:CaptureRect)=>({x:Math.max(a.x,crop.x),y:Math.max(a.y,crop.y),width:Math.max(0,Math.min(a.x+a.width,crop.x+crop.width)-Math.max(a.x,crop.x)),height:Math.max(0,Math.min(a.y+a.height,crop.y+crop.height)-Math.max(a.y,crop.y))});
  const objects=snapshot.objects.filter(object=>{
    const b=object.lassoBounds as CaptureRect|undefined;
    if(!b||![b.x,b.y,b.width,b.height,object.left,object.top].every(n=>typeof n==='number'&&Number.isFinite(n))||b.width<0||b.height<0)throw Error('贴图标注范围无效');
    const hit=overlap(b);return hit.width>0&&hit.height>0;
  }).map(object=>{const {lassoBounds,...mark}=object;return {...mark,left:Number(object.left)-crop.x,top:Number(object.top)-crop.y};});
  const privacy=snapshot.privacy.map(overlap).filter(r=>r.width>0&&r.height>0).map(r=>({...r,x:r.x-crop.x,y:r.y-crop.y}));
  return {...snapshot,objects,privacy,crop:{x:0,y:0,width:crop.width,height:crop.height}};
}
