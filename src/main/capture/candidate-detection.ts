import { systemPreferences } from 'electron';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { CaptureRect, RegionCandidate, ScreenshotState } from '../../shared/capture';
import type { NativeAx, WindowRect } from '../native-ax';
import type { NativeCapture, NativeFrame } from './native';
import { clip, contains, rank } from './candidates';

export interface CandidateDetectionDeps {
  native: NativeCapture;
  ax: NativeAx;
  state: () => Pick<ScreenshotState, 'id' | 'phase' | 'mode' | 'candidates'> | null;
  /** Global bounds of the session display; candidates are relative to it. */
  bounds: () => CaptureRect;
}

export class CandidateDetection {
  private worker: Worker | null=null;
  private starting=false;
  private windows: WindowRect[]=[];
  private fixed: RegionCandidate[]=[];
  private elements: RegionCandidate[]=[];
  private colors: RegionCandidate[]=[];
  private edges: RegionCandidate[]=[];
  private seq=0;
  private pending: {x:number;y:number}|null=null;
  private hoverTimer: ReturnType<typeof setTimeout>|null=null;
  private colorBusy=false;
  private axBusy=false;
  private colorSeq=-1;
  private axSeq=-1;
  private hoverPoint={x:-100,y:-100};
  private detectScale={x:1,y:1};
  constructor(private deps: CandidateDetectionDeps) {}
  private get state(){return this.deps.state();}
  private get bounds(){return this.deps.bounds();}
  begin(windows:WindowRect[],wholeScreen:boolean){
    this.windows=windows;
    const local=(r:CaptureRect):CaptureRect=>({x:r.x-this.bounds.x,y:r.y-this.bounds.y,width:r.width,height:r.height});
    this.fixed=this.windows.map(r=>clip(local(r),{x:0,y:0,width:this.bounds.width,height:this.bounds.height})).filter((r):r is CaptureRect=>Boolean(r)).map(r=>({...r,source:'window'}));
    if(wholeScreen)this.fixed.push({x:0,y:0,width:this.bounds.width,height:this.bounds.height,source:'screen'});
    this.elements=[];this.edges=[];this.colors=[];this.hoverPoint={x:-100,y:-100};
    return {candidates:this.fixed,windows:this.windows.map(w=>({id:w.id,...local(w)})).filter(w=>clip(w,{x:0,y:0,width:this.bounds.width,height:this.bounds.height}))};
  }
  async start(frame:NativeFrame|null){
    const id=this.state?.id;
    if(!id||this.state?.phase!=='selecting'||(this.state.mode==='rect'||this.state.mode==='window')||!frame||this.worker||this.starting)return;
    this.starting=true;
    let reduced;
    try{reduced=await this.deps.native.pixels(frame.id,{format:'rgba',maxWidth:1440});}
    finally{if(this.state?.id===id)this.starting=false;}
    if(this.state?.id!==id||this.state.phase!=='selecting')return;
    const size={width:reduced.width,height:reduced.height},bitmap=new Uint8Array(reduced.data);
    const sx=this.bounds.width/size.width,sy=this.bounds.height/size.height;
    const worker=new Worker(join(__dirname,'regions-worker.cjs'));this.worker=worker;
    worker.on('message',m=>{if(this.worker!==worker||this.state?.id!==id)return;
      const mapped=m.regions.map((r:RegionCandidate)=>({...r,x:r.x*sx,y:r.y*sy,width:r.width*sx,height:r.height*sy}));
      if(m.type==='edges')this.edges=mapped;
      if(m.type==='color'){this.colorBusy=false;if(m.seq===this.seq)this.colors=mapped;}
      this.updateCandidates();if(this.pending)this.scheduleHover();
    });
    const workerStopped=()=>{if(this.worker!==worker)return;this.worker=null;this.colorBusy=false;if(this.pending)this.scheduleHover();};
    worker.on('error',error=>{console.warn('[screenshot] region worker',error.message);workerStopped();});
    worker.on('exit',workerStopped);
    worker.postMessage({type:'init',bytes:bitmap,width:size.width,height:size.height});
    this.detectScale={x:1/sx,y:1/sy};
  }
  /** Keeps `starting`: a start still reading pixels clears it itself while its session lasts, so a return to selecting cannot start a second worker. */
  stop(){this.seq++;this.pending=null;this.fixed=[];this.windows=[];this.elements=[];this.edges=[];this.colors=[];this.colorBusy=false;this.axBusy=false;if(this.hoverTimer)clearTimeout(this.hoverTimer);this.hoverTimer=null;void this.worker?.terminate();this.worker=null;}
  /** Session end: that start no longer clears `starting`. */
  release(){this.starting=false;this.stop();}
  hover(x:number,y:number){
    if(!this.state||this.state.phase!=='selecting'||this.state.mode==='rect')return;
    if(Math.hypot(x-this.hoverPoint.x,y-this.hoverPoint.y)<5)return;
    this.hoverPoint={x,y};this.pending={x,y};this.seq++;
    // Keep still-hit regions until their replacement is ready, rather than
    // briefly flashing the whole window on every hover query.
    this.colors=this.colors.filter(r=>contains(r,x,y));this.elements=this.elements.filter(r=>contains(r,x,y));this.updateCandidates();
    this.scheduleHover();
  }
  private updateCandidates(){if(!this.state)return;this.state.candidates=rank([...this.fixed,...this.elements,...this.edges,...this.colors],this.hoverPoint.x,this.hoverPoint.y);if(this.state.phase==='selecting')this.deps.native.update({session:this.state.id,candidates:this.state.candidates});}
  private scheduleHover(){if(this.hoverTimer)return;this.hoverTimer=setTimeout(()=>{this.hoverTimer=null;void this.queryHover();},110);}
  private queryHover(){
    if(!this.pending||!this.state||this.state.phase!=='selecting')return;
    const {x,y}=this.pending;const seq=this.seq,id=this.state.id;
    const global={x:x+this.bounds.x,y:y+this.bounds.y};
    const owner=this.windows.find(w=>contains(w,global.x,global.y));
    const localBounds=owner?clip({x:owner.x-this.bounds.x,y:owner.y-this.bounds.y,width:owner.width,height:owner.height},{x:0,y:0,width:this.bounds.width,height:this.bounds.height}):{x:0,y:0,width:this.bounds.width,height:this.bounds.height};
    // AX and visual queries have independent queues: a slow app must not hold
    // back color candidates at a new pointer position (or vice versa).
    let waiting=false;
    if(this.worker&&localBounds&&this.colorSeq!==seq){
      if(this.colorBusy)waiting=true;
      else {this.colorBusy=true;this.colorSeq=seq;this.worker.postMessage({type:'color',seq,x:Math.round(x*this.detectScale.x),y:Math.round(y*this.detectScale.y),bounds:{x:localBounds.x*this.detectScale.x,y:localBounds.y*this.detectScale.y,width:localBounds.width*this.detectScale.x,height:localBounds.height*this.detectScale.y}});}
    }
    if(owner&&systemPreferences.isTrustedAccessibilityClient(false)&&this.axSeq!==seq){
      if(this.axBusy)waiting=true;
      else {this.axBusy=true;this.axSeq=seq;void this.deps.ax.query(owner.pid,global.x,global.y).then(result=>{
        if(this.state?.id===id&&seq===this.seq){this.elements=result.rects.map(r=>clip({x:r.x-this.bounds.x,y:r.y-this.bounds.y,width:r.width,height:r.height},{x:0,y:0,width:this.bounds.width,height:this.bounds.height})).filter((r):r is CaptureRect=>Boolean(r)).map(r=>({...r,source:'element'}));this.updateCandidates();}
      }).catch(error=>{console.warn('[screenshot] AX query',String(error));}).finally(()=>{if(this.state?.id===id){this.axBusy=false;if(this.pending)this.scheduleHover();}});}
    }
    if(waiting)this.scheduleHover();else this.pending=null;
  }
}
