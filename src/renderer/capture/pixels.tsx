import { useEffect, useRef } from 'react';
import type { ScreenshotState } from '../../shared/capture';
const images=new Map<string,Promise<HTMLCanvasElement>>();
const pending=new Map<string,{resolve:(frame:{width:number;height:number;data:ArrayBuffer})=>void;reject:(error:Error)=>void}>();
window.addEventListener('message',event=>{
  if(event.source!==window||event.data?.source!=='lasso-pixels')return;
  const request=pending.get(event.data.ticket);if(!request)return;pending.delete(event.data.ticket);
  if(event.data.error){request.reject(Error(event.data.error));return;}
  const {width,height,data}=event.data;
  if(!(data instanceof ArrayBuffer)||data.byteLength!==width*height*4){request.reject(Error('图片像素不完整'));return;}
  request.resolve({width,height,data});
});
export function clearCapturePixels(){
  for(const request of pending.values())request.reject(Error('截图会话已结束'));pending.clear();
  for(const image of images.values())void image.then(canvas=>{canvas.width=canvas.height=0;}).catch(()=>{});
  images.clear();
}
export function captureCanvas(state:ScreenshotState,frameId:string):Promise<HTMLCanvasElement>{
  const key=state.id+':'+frameId,existing=images.get(key);if(existing)return existing;
  const task=new Promise<{width:number;height:number;data:ArrayBuffer}>((resolve,reject)=>{const ticket=window.screenshot.requestPixels({sessionId:state.id,frameId});pending.set(ticket,{resolve,reject});}).then(pixels=>{
    const canvas=document.createElement('canvas');canvas.width=pixels.width;canvas.height=pixels.height;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pixels.data),pixels.width,pixels.height),0,0);
    return canvas;
  });images.set(key,task);void task.catch(()=>images.delete(key));return task;
}
export function CapturePixels({state,frameId,className,onReady}:{state:ScreenshotState;frameId:string;className:string;onReady?:()=>void}){
  const canvas=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{let current=true;const node=canvas.current;void captureCanvas(state,frameId).then(source=>{if(!current||!canvas.current)return;const node=canvas.current;node.width=source.width;node.height=source.height;node.getContext('2d')!.drawImage(source,0,0);onReady?.();}).catch(()=>{if(current)window.screenshot.loadError(state.editId);});return()=>{current=false;if(node)node.width=node.height=0;};},[state.id,frameId]);
  return <canvas ref={canvas} className={className}/>;
}
