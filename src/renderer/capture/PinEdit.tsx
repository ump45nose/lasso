import { useEffect, useState } from 'react';
import type { ScreenshotState } from '../../shared/capture';
import { Editor } from './Editor';

function canvasFromBGRA(width: number, height: number, bgra: Uint8Array) {
  if (bgra.byteLength !== width * height * 4) throw Error('图片像素不完整');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const image = new ImageData(width, height), dst = image.data;
  for (let i = 0; i < bgra.length; i += 4) {
    const b = bgra[i], g = bgra[i + 1], r = bgra[i + 2], a = bgra[i + 3];
    if (a === 0 || a === 255) { dst[i] = r; dst[i + 1] = g; dst[i + 2] = b; dst[i + 3] = a; }
    else {
      dst[i] = Math.min(255, Math.round(r * 255 / a));
      dst[i + 1] = Math.min(255, Math.round(g * 255 / a));
      dst[i + 2] = Math.min(255, Math.round(b * 255 / a));
      dst[i + 3] = a;
    }
  }
  canvas.getContext('2d')!.putImageData(image, 0, 0);
  return canvas;
}

/** The pin window becomes the editor. Esc or a finished output returns to the same pin. */
export function PinEdit({editId, pinId}:{editId:string; pinId:string}) {
  const [source, setSource] = useState<HTMLCanvasElement | null>(null), [shot, setShot] = useState<ScreenshotState | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void window.pin.source().then(payload => {
      if (!alive || payload.editId !== editId) return;
      setSource(canvasFromBGRA(payload.width, payload.height, payload.bgra));
      setShot({presentation:'window', id:pinId, editId, width:payload.width, height:payload.height, pixelWidth:payload.width, pixelHeight:payload.height, candidates:[], phase:'result', selection:{x:0, y:0, width:payload.width, height:payload.height}, origin:'pin', pinId, annotations:payload.annotations, pixelScale:payload.pixelScale, saveFormat:payload.saveFormat, annotationMemory:payload.annotationMemory, editorShortcuts:payload.editorShortcuts,screenshotSettings:payload.screenshotSettings,toolbarTools:payload.toolbarTools,mouseActions:payload.mouseActions});
    }).catch(e => { if (alive) setError((e as Error).message); });
    return () => { alive = false; };
  }, [editId, pinId]);
  if (!shot || !source) return <section className="ed ed-window" aria-label="贴图编辑"><p className={'ed-toast' + (error ? '' : ' ed-toast-success')} role={error ? 'alert' : 'status'}>{error || '正在打开编辑'}</p></section>;
  return <Editor key={editId} state={shot} source={source} />;
}
