import type { ScreenshotKind } from './screenshot-settings';
export interface CaptureRect { x: number; y: number; width: number; height: number }
export interface RegionCandidate extends CaptureRect { source: 'window' | 'element' | 'edge' | 'color' | 'screen' }
export const sameRegion = (a: CaptureRect, b: CaptureRect) => Math.abs(a.x-b.x)<3 && Math.abs(a.y-b.y)<3 && Math.abs(a.width-b.width)<5 && Math.abs(a.height-b.height)<5;
export interface OCRGlyph extends CaptureRect { text: string }
export interface OCRLine extends CaptureRect { text: string; glyphs: OCRGlyph[]; confidence: number }
export interface OCRResult { id: string; revision: number; lines: OCRLine[] }
export interface AnnotationSnapshot { objects: Record<string, unknown>[]; crop: CaptureRect; nextNumber: number; privacy: CaptureRect[] }
export interface CaptureFrame { id: string; revision: number; crop: CaptureRect; png: Uint8Array; annotations?: AnnotationSnapshot }
export type OCRMode = 'text' | 'code';
export interface OCRRequest extends CaptureFrame { mode: OCRMode; enhance: boolean; force?: boolean }
export type ExportAction = 'copy' | 'save' | 'image' | 'pin' | 'media';
/** Rect only drags a manual selection. Area drags or picks regions, window picks whole windows, screen takes the display, front takes the frontmost app window. */
export type CaptureMode = 'rect' | 'area' | 'window' | 'screen' | 'front';
export const captureModes: CaptureMode[] = ['rect', 'area', 'window', 'screen', 'front'];
export const captureModeLabels: Record<CaptureMode, string> = { rect: '框选截图', area: '区域截图', window: '窗口截图', screen: '全屏截图', front: '前台窗口截图' };
/** An on-screen window in overlay coordinates, front to back. */
export interface CaptureWindow extends CaptureRect { id: number }
export interface ScrollCaptureState { status: 'running' | 'paused' | 'review'; width: number; height: number; segments: number; seams: number[]; message: string }
export type ScrollCaptureAction = 'pause' | 'resume' | 'finish' | 'cancel' | 'undo' | 'edit';
export interface ScreenshotState { pointer?: { x: number; y: number }; captureKind?: ScreenshotKind; presentation?: 'inline' | 'window'; pixelScale?: { x: number; y: number }; saveFormat?: 'png' | 'jpeg'; outputStatus?: string; outputError?: string; id: string; editId: string; imageCrop?: CaptureRect; imageFrame?: string; backdropFrame?: string; placement?: CaptureRect; mode?: 'rect' | 'area' | 'window' | 'scroll'; windows?: CaptureWindow[]; width: number; height: number; pixelWidth: number; pixelHeight: number; candidates: RegionCandidate[]; phase: 'selecting' | 'result' | 'scrolling' | 'review'; scroll?: ScrollCaptureState; selection: CaptureRect | null; status: string; origin?: 'screen' | 'clipboard' | 'pin'; pinId?: string; annotations?: AnnotationSnapshot }
export interface PinState { id: string; revision: number; image: string; width: number; height: number; lines: OCRLine[]; status: string; topmost: boolean; opacity: number; passthrough: boolean }
export type PinAction = 'recognize' | 'edit' | 'image' | 'copy' | 'close' | 'hide' | 'topmost' | 'opacity' | 'zoom-in' | 'zoom-out' | 'passthrough';
/** Pin opacity steps; the options row cycles through them. */
export const pinOpacities = [1, 0.85, 0.65, 0.4];
export interface PinAPI {
  state(): Promise<PinState>;
  onState(callback: (state: PinState) => void): () => void;
  action(action: PinAction): Promise<{error: string | null}>;
  text(text: string, send: boolean, revision: number): Promise<{error: string | null}>;
}
export function pixelRect(r: CaptureRect, width: number, height: number, pixelWidth: number, pixelHeight: number): CaptureRect {
  const x=Math.round(r.x*pixelWidth/width),y=Math.round(r.y*pixelHeight/height);
  return {x,y,width:Math.max(1,Math.min(pixelWidth-x,Math.round(r.width*pixelWidth/width))),height:Math.max(1,Math.min(pixelHeight-y,Math.round(r.height*pixelHeight/height)))};
}
export interface ScreenshotAPI {
  ready(id: string, editId: string): void;
  loadError(editId: string): void;
  requestPixels(request: {sessionId:string;frameId:string}): string;
  state(): Promise<ScreenshotState | null>;
  onState(callback: (state: ScreenshotState | null) => void): () => void;
  scrollAction(action: ScrollCaptureAction): Promise<{error: string | null}>;
  action(action: 'cancel' | 'reselect' | 'screen' | 'retry'): Promise<{ error: string | null }>;
  recognize(request: OCRRequest): Promise<OCRResult>;
  invalidateOCR(request: {id: string; revision: number}): void;
  export(frame: CaptureFrame, action: ExportAction, format: 'png' | 'jpeg'): Promise<{error: string | null}>;
  copyText(request: {id: string; revision: number; text: string}): Promise<void>;
  sendText(request: {id: string; revision: number; text: string}): Promise<{error: string | null}>;
}
