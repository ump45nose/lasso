import { parentPort } from 'node:worker_threads';
import { detectBorders } from 'edge_det';
let bytes: Uint8Array, width=0, height=0;
function flood(cx: number, cy: number, tolerance: number, bounds: { x: number; y: number; width: number; height: number }) {
  const left=Math.max(0,Math.floor(bounds.x)),top=Math.max(0,Math.floor(bounds.y)),right=Math.min(width,Math.ceil(bounds.x+bounds.width)),bottom=Math.min(height,Math.ceil(bounds.y+bounds.height));
  const buckets=new Map<string,{ count:number; x:number; y:number; rgb:number[] }>();
  for(let dy=-10;dy<=10;dy+=2)for(let dx=-10;dx<=10;dx+=2){const x=Math.min(right-1,Math.max(left,cx+dx)),y=Math.min(bottom-1,Math.max(top,cy+dy)),i=(y*width+x)*4;const rgb=[bytes[i],bytes[i+1],bytes[i+2]],key=rgb.map(v=>Math.round(v/6)).join(',');const b=buckets.get(key)||{count:0,x,y,rgb};b.count++;buckets.set(key,b);}
  const seed=[...buckets.values()].sort((a,b)=>b.count-a.count)[0];
  const rw=right-left,rh=bottom-top,seen=new Uint8Array(rw*rh),queue=new Int32Array(rw*rh);let head=0,tail=0,minX=seed.x,maxX=seed.x,minY=seed.y,maxY=seed.y;
  const first=(seed.y-top)*rw+seed.x-left;queue[tail++]=first;seen[first]=1;
  while(head<tail){const n=queue[head++],x=n%rw+left,y=Math.floor(n/rw)+top;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    for(const q of [x>left?n-1:-1,x+1<right?n+1:-1,y>top?n-rw:-1,y+1<bottom?n+rw:-1]){if(q<0||seen[q])continue;seen[q]=1;const px=q%rw+left,py=Math.floor(q/rw)+top,i=(py*width+px)*4;if(Math.max(...seed.rgb.map((v,k)=>Math.abs(v-bytes[i+k])))<=tolerance)queue[tail++]=q;}
  }
  const w=maxX-minX+1,h=maxY-minY+1;
  // Text strokes and noisy photographs are poor background-region candidates.
  return w>=24&&h>=20&&tail/(w*h)>.42?{x:minX,y:minY,width:w,height:h,source:'color'}:null;
}
parentPort!.on('message', m => {
  if(m.type==='init') { bytes=new Uint8Array(m.bytes);width=m.width;height=m.height;
    try { const regions=detectBorders(bytes,width,height,{lowThreshold:20,highThreshold:60,minArea:200}).filter(r=>r.w>=24&&r.h>=20&&r.w*r.h>=1600).map(r=>({x:r.x,y:r.y,width:r.w,height:r.h,source:'edge'}));parentPort!.postMessage({type:'edges',regions}); } catch { parentPort!.postMessage({type:'edges',regions:[]}); }
  } else if(m.type==='color'&&bytes) { const regions=[4,12].map(t=>flood(m.x,m.y,t,m.bounds)).filter(Boolean);parentPort!.postMessage({type:'color',seq:m.seq,regions}); }
});
