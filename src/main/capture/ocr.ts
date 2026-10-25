import { createHash } from 'node:crypto';
import type { OCRLine, OCRMode, OCRResult } from '../../shared/capture';

export interface VisionOCR {
  recognize(png: Buffer, token: number, mode: OCRMode, enhance: boolean): Promise<OCRLine[]>;
  cancel(token: number): void;
}
type Input = {id: string; revision: number; png: Buffer; mode: OCRMode; enhance: boolean; force?: boolean};
type Job = Input & {key: string; token: number; canceled: boolean; settle(result: OCRResult): void; fail(error: unknown): void};
let nextToken=0;

/** One running request and one replaceable pending request, scoped to an editor.
 * The cache contains only flattened-image OCR and is erased when that editor ends. */
export class OCRService {
  private active: Job | null=null;
  private pending: Job | null=null;
  private cache=new Map<string, {lines:OCRLine[];bytes:number}>();
  private cacheBytes=0;
  constructor(private driver:()=>VisionOCR, private current:(id:string,revision:number)=>boolean){}
  recognize(input:Input):Promise<OCRResult>{
    const key=createHash('sha256').update(input.png).update(input.mode+Number(input.enhance)).digest('hex');
    if(!this.current(input.id,input.revision))return Promise.resolve({id:input.id,revision:input.revision,lines:[]});
    this.invalidate(input.id,input.revision);
    const cached=!input.force&&this.cache.get(key);
    if(cached){this.cache.delete(key);this.cache.set(key,cached);return Promise.resolve({id:input.id,revision:input.revision,lines:cached.lines});}
    return new Promise((settle,fail)=>{
      this.drop(this.pending);this.pending={...input,key,token:nextToken=nextToken%2147483646+1,canceled:false,settle,fail};
      if(this.active)this.drop(this.active);
      this.pump();
    });
  }
  invalidate(id:string,revision:number){
    if(this.active&&(this.active.id!==id||this.active.revision<revision))this.drop(this.active);
    if(this.pending&&(this.pending.id!==id||this.pending.revision<revision)){this.drop(this.pending);this.pending=null;}
  }
  reset(){this.drop(this.active);this.drop(this.pending);this.pending=null;this.cache.clear();this.cacheBytes=0;}
  private drop(job:Job|null){
    if(!job||job.canceled)return;job.canceled=true;
    job.settle({id:job.id,revision:job.revision,lines:[]});
    if(this.active===job){try{this.driver().cancel(job.token);}catch{/* Completion still discards this request. */}}
  }
  private pump(){
    if(this.active||!this.pending)return;
    const job=this.pending;this.pending=null;this.active=job;
    void(async()=>{
      try{
        const lines=await this.driver().recognize(job.png,job.token,job.mode,job.enhance);
        if(job.canceled||!this.current(job.id,job.revision)){job.settle({id:job.id,revision:job.revision,lines:[]});return;}
        const bytes=JSON.stringify(lines).length*2;
        if(bytes<=2_000_000){const previous=this.cache.get(job.key);if(previous)this.cacheBytes-=previous.bytes;this.cache.delete(job.key);this.cache.set(job.key,{lines,bytes});this.cacheBytes+=bytes;
          while(this.cache.size>8||this.cacheBytes>2_000_000){const first=this.cache.keys().next().value!;this.cacheBytes-=this.cache.get(first)!.bytes;this.cache.delete(first);}}
        job.settle({id:job.id,revision:job.revision,lines});
      }catch(error){if(!job.canceled)job.fail(error);}
      finally{if(this.active===job)this.active=null;this.pump();}
    })();
  }
}
