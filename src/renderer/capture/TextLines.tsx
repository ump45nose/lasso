import type { OCRLine } from '../../shared/capture';

export function TextLines({lines}:{lines:OCRLine[]}){
  return <>{lines.map((line,index)=><div key={index} className="editor-text-line" style={{left:line.x,top:line.y,width:line.width,height:line.height}}>{line.glyphs.map((g,i)=><span key={i} style={{left:g.x-line.x,top:g.y-line.y,width:g.width,height:g.height,fontSize:g.height*.95,lineHeight:`${g.height}px`}}>{g.text}</span>)}</div>)}</>;
}
