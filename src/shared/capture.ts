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
export type ExportAction = 'copy' | 'save' | 'image' | 'pin';
export interface ScreenshotState { id: string; editId: string; image: string; width: number; height: number; pixelWidth: number; pixelHeight: number; candidates: RegionCandidate[]; phase: 'selecting' | 'result'; selection: CaptureRect | null; status: string; origin?: 'screen' | 'clipboard' | 'pin'; pinId?: string; annotations?: AnnotationSnapshot }
export interface PinState { id: string; revision: number; image: string; width: number; height: number; lines: OCRLine[]; status: string; topmost: boolean; opacity: number; passthrough: boolean }
export type PinAction = 'menu' | 'edit' | 'image' | 'copy' | 'close' | 'hide';
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
  state(): Promise<ScreenshotState | null>;
  onState(callback: (state: ScreenshotState) => void): () => void;
  hover(x: number, y: number): void;
  select(rect: CaptureRect): Promise<void>;
  action(action: 'cancel' | 'reselect' | 'screen'): Promise<{ error: string | null }>;
  recognize(request: OCRRequest): Promise<OCRResult>;
  invalidateOCR(request: {id: string; revision: number}): void;
  export(frame: CaptureFrame, action: ExportAction, format: 'png' | 'jpeg'): Promise<{error: string | null}>;
  copyText(request: {id: string; revision: number; text: string}): Promise<void>;
  sendText(request: {id: string; revision: number; text: string}): Promise<{error: string | null}>;
}
