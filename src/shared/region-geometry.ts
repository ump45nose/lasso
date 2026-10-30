import type { CaptureRect } from './capture';
export interface PixelSize { width: number; height: number }
const clamp=(n:number,a:number,b:number)=>Math.max(a,Math.min(b,n));
export function validPixelRegion(r:CaptureRect,b:PixelSize){return Boolean(r)&&[r.x,r.y,r.width,r.height].every(Number.isSafeInteger)&&r.x>=0&&r.y>=0&&r.width>=2&&r.height>=2&&r.x+r.width<=b.width&&r.y+r.height<=b.height;}
export function regionPixels(r:CaptureRect,logical:PixelSize,pixels:PixelSize):CaptureRect{
  const x=clamp(Math.round(r.x*pixels.width/logical.width),0,pixels.width-2),y=clamp(Math.round(r.y*pixels.height/logical.height),0,pixels.height-2);
  const right=clamp(Math.round((r.x+r.width)*pixels.width/logical.width),x+2,pixels.width),bottom=clamp(Math.round((r.y+r.height)*pixels.height/logical.height),y+2,pixels.height);
  return {x,y,width:right-x,height:bottom-y};
}
export const regionPoints=(r:CaptureRect,logical:PixelSize,pixels:PixelSize):CaptureRect=>({x:r.x*logical.width/pixels.width,y:r.y*logical.height/pixels.height,width:r.width*logical.width/pixels.width,height:r.height*logical.height/pixels.height});
export function moveRegion(r:CaptureRect,dx:number,dy:number,b:PixelSize):CaptureRect{return {...r,x:clamp(Math.round(r.x+dx),0,b.width-r.width),y:clamp(Math.round(r.y+dy),0,b.height-r.height)};}
/** Corners anchor the opposite corner; edge handles preserve the perpendicular center. */
export function resizeRegion(r:CaptureRect,handle:string,dx:number,dy:number,b:PixelSize,ratio:number|null=null):CaptureRect{
  if(!ratio){
    const left=handle.includes('w')?clamp(Math.round(r.x+dx),0,r.x+r.width-2):r.x;
    const top=handle.includes('n')?clamp(Math.round(r.y+dy),0,r.y+r.height-2):r.y;
    const right=handle.includes('e')?clamp(Math.round(r.x+r.width+dx),r.x+2,b.width):r.x+r.width;
    const bottom=handle.includes('s')?clamp(Math.round(r.y+r.height+dy),r.y+2,b.height):r.y+r.height;
    return {x:left,y:top,width:right-left,height:bottom-top};
  }
  let w=r.width+(handle.includes('w')?-dx:handle.includes('e')?dx:0),h=r.height+(handle.includes('n')?-dy:handle.includes('s')?dy:0);
  if(ratio){if(handle==='n'||handle==='s'||(handle.length===2&&Math.abs(dy)>Math.abs(dx)/ratio))w=h*ratio;else h=w/ratio;}
  let x=handle.includes('w')?r.x+r.width-w:handle==='n'||handle==='s'?r.x+(r.width-w)/2:r.x;
  let y=handle.includes('n')?r.y+r.height-h:handle==='w'||handle==='e'?r.y+(r.height-h)/2:r.y;
  if(ratio){
    const ax=handle.includes('w')?r.x+r.width:handle==='n'||handle==='s'?r.x+r.width/2:r.x;
    const ay=handle.includes('n')?r.y+r.height:handle==='w'||handle==='e'?r.y+r.height/2:r.y;
    const mw=handle.includes('w')?ax:handle==='n'||handle==='s'?2*Math.min(ax,b.width-ax):b.width-ax;
    const mh=handle.includes('n')?ay:handle==='w'||handle==='e'?2*Math.min(ay,b.height-ay):b.height-ay;
    const minimum=Math.max(2,2*ratio),maximum=Math.min(mw,mh*ratio);if(maximum<minimum)return {...r};
    w=clamp(w,minimum,maximum);h=w/ratio;
    x=handle.includes('w')?ax-w:handle==='n'||handle==='s'?ax-w/2:ax;y=handle.includes('n')?ay-h:handle==='w'||handle==='e'?ay-h/2:ay;
  }
  const left=clamp(Math.round(x),0,b.width-2),top=clamp(Math.round(y),0,b.height-2);
  return {x:left,y:top,width:clamp(Math.round(w),2,b.width-left),height:clamp(Math.round(h),2,b.height-top)};
}
export function drawRegion(a:{x:number;y:number},p:{x:number;y:number},b:PixelSize,ratio:number|null):CaptureRect{
  let w=Math.abs(p.x-a.x),h=Math.abs(p.y-a.y);
  if(ratio){if(w/Math.max(1,h)>ratio)h=w/ratio;else w=h*ratio;const f=Math.min(1,(p.x<a.x?a.x:b.width-a.x)/Math.max(1,w),(p.y<a.y?a.y:b.height-a.y)/Math.max(1,h));w*=f;h*=f;}
  return regionPixels({x:p.x<a.x?a.x-w:a.x,y:p.y<a.y?a.y-h:a.y,width:w,height:h},b,b);
}
