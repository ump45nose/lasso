import type { DesktopAPI, Settings } from './contracts';
import type { ScreenshotSettings } from './screenshot-settings';
import type { RecordingAction, RecordingSessionState } from './recording';
import type { CaptureDisplayBinding } from './capture-efficiency';
import type { RegionPreset, RegionConfiguration } from './capture-regions';
import type { PinContentPayload, PinGroup, PinKind, PinWheelAction, PinWorkspaceState } from './history-sync';
import type { AnnotationStyleMemory, ScreenshotExportContentMode, ScreenshotKind, ScreenshotOutputFormat } from './screenshot-settings';
import type { IntelligenceKind, IntelligenceResult } from './intelligence';
export interface CaptureRect { x: number; y: number; width: number; height: number }
export interface RegionCandidate extends CaptureRect { source: 'window' | 'element' | 'edge' | 'color' | 'screen' }
export const sameRegion = (a: CaptureRect, b: CaptureRect) => Math.abs(a.x-b.x)<3 && Math.abs(a.y-b.y)<3 && Math.abs(a.width-b.width)<5 && Math.abs(a.height-b.height)<5;
export interface OCRGlyph extends CaptureRect { text: string }
export interface OCRLine extends CaptureRect { text: string; glyphs: OCRGlyph[]; confidence: number }
export interface BarcodeItem extends CaptureRect { symbology: string; payload: string }
export interface OCRResult { id: string; revision: number; lines: OCRLine[]; barcodes?: BarcodeItem[] }
export interface AnnotationSnapshot { effects?: { turns:number; flipX:boolean; flipY:boolean; grayscale:boolean; brightness:number }; cropPolygons?: {x:number;y:number}[][]; objects: Record<string, unknown>[]; crop: CaptureRect; nextNumber: number; privacy: CaptureRect[] }
export interface EditorCheckpoint {
  revision: number;
  regionRatio?: number | null;
  history: string[];
  cursor: number;
  tool: string;
  style: { color: string; width: number; fontSize: number };
  objectClipboard: Record<string, unknown>[] | null;
  zoom: number;
  scrollLeft: number;
  scrollTop: number;
  format: ScreenshotOutputFormat;
  ocrMode: OCRMode;
  enhance: boolean;
}
export interface CaptureFrame { outputSize?: {width:number;height:number}; id: string; revision: number; crop: CaptureRect; png?: Uint8Array; pixels?: Uint8Array; annotations?: AnnotationSnapshot }
export type OCRMode = 'text' | 'code';
export interface OCRRequest extends CaptureFrame { mode: OCRMode; enhance: boolean; force?: boolean }
export type ExportAction = 'copy' | 'save' | 'quick-save' | 'copy-file' | 'copy-path' | 'image' | 'pin' | 'media';
/** Rect only drags a manual selection. Area drags or picks regions, window picks whole windows, screen takes the display, front takes the frontmost app window. */
export type CaptureMode = 'rect' | 'area' | 'window' | 'screen' | 'front';
export const captureModes: CaptureMode[] = ['rect', 'area', 'window', 'screen', 'front'];
export const captureModeLabels: Record<CaptureMode, string> = { rect: '框选截图', area: '区域截图', window: '窗口截图', screen: '全屏截图', front: '前台窗口截图' };
/** An on-screen window in overlay coordinates, front to back. */
export interface CaptureWindow extends CaptureRect { id: number }
export type ScrollDirection = 'vertical' | 'horizontal' | 'auto';
export interface ScrollCaptureState { status: 'running' | 'paused' | 'review'; width: number; height: number; segments: number; seams: number[]; message: string; direction?: ScrollDirection; segmentSizes?: number[]; reversedTrimmed?: number }
type ScrollSimpleAction = 'pause' | 'resume' | 'finish' | 'cancel' | 'undo' | 'edit';
export type ScrollCaptureAction = ScrollSimpleAction | { type: ScrollSimpleAction } | { type: 'direction'; direction: ScrollDirection } | { type: 'remove-segment'; index: number } | { type: 'adjust-seam'; index: number; delta: number };
export interface EditableRegion { display:CaptureDisplayBinding; sourceSize:{width:number;height:number}; initialCrop:CaptureRect; currentCrop:CaptureRect; ratio:number|null }
export interface ScreenshotState { screenshotSettings?: ScreenshotSettings; toolbarTools?: string[]; mouseActions?: Settings['mouseActions']; checkpoint?: EditorCheckpoint; editableRegion?:EditableRegion; copyIntent?:number; pointer?: { x: number; y: number }; captureKind?: ScreenshotKind; presentation?: 'inline' | 'window'; pixelScale?: { x: number; y: number }; saveFormat?: ScreenshotOutputFormat; annotationMemory?: AnnotationStyleMemory; editorShortcuts?: Record<string, string>; outputStatus?: string; outputError?: string; id: string; editId: string; imageCrop?: CaptureRect; imageFrame?: string; backdropFrame?: string; placement?: CaptureRect; mode?: 'rect' | 'area' | 'window' | 'scroll'; windows?: CaptureWindow[]; width: number; height: number; pixelWidth: number; pixelHeight: number; candidates: RegionCandidate[]; phase: 'selecting' | 'result' | 'scrolling' | 'review'; scroll?: ScrollCaptureState; selection: CaptureRect | null; status: string; origin?: 'screen' | 'clipboard' | 'pin'; pinId?: string; annotations?: AnnotationSnapshot }
export interface PinState { id: string; revision: number; image: string; width: number; height: number; lines: OCRLine[]; barcodes?: BarcodeItem[]; status: string; topmost: boolean; opacity: number; passthrough: boolean; editing?: boolean; editId?: string; kind?: PinKind; title?: string; groupId?: string; locked?: boolean; thumbnail?: boolean; zoomPercent?: number; wheelAction?: PinWheelAction; groups?: PinGroup[]; payload?: PinContentPayload }
export interface PinSource { screenshotSettings?: ScreenshotSettings; toolbarTools?: string[]; mouseActions?: Settings['mouseActions']; editId: string; width: number; height: number; bgra: Uint8Array; annotations: AnnotationSnapshot; pixelScale?: { x: number; y: number }; saveFormat: ScreenshotOutputFormat; annotationMemory?: AnnotationStyleMemory; editorShortcuts?: Record<string, string> }
export type PinAction = 'recognize' | 'edit' | 'image' | 'copy' | 'close' | 'hide' | 'topmost' | 'opacity' | 'zoom-in' | 'zoom-out' | 'passthrough' | 'lock' | 'thumbnail' | 'reset-zoom' | 'save' | 'quick-save' | 'copy-file' | 'copy-path';
/** Pin opacity steps; the options row cycles through them. */
export const pinOpacities = [1, 0.85, 0.65, 0.4];
export interface PinAPI {
  state(): Promise<PinState>;
  onState(callback: (state: PinState) => void): () => void;
  action(action: PinAction): Promise<{error: string | null}>;
  text(text: string, send: boolean, revision: number): Promise<{error: string | null}>;
  source(): Promise<PinSource>;
  setOpacity(opacity: number): Promise<{ error: string | null }>;
  setZoom(factor: number): Promise<{ error: string | null }>;
  setGroup(groupId: string): Promise<{ error: string | null }>;
  updateText(text: string): Promise<{ error: string | null }>;
  startDrag(): void;
  drag(): void;
  endDrag(): void;
}
export type PinWorkspaceCalls = Pick<DesktopAPI, 'pinWorkspace' | 'savePinWorkspace' | 'createPin' | 'pinClipboard' | 'reopenClosedPin' | 'arrangePins' | 'actPin'>;
export interface PinWorkspaceAPI extends PinWorkspaceCalls {
  onChanged(callback: (state: PinWorkspaceState) => void): () => void;
  dropFiles(files: File[], text: string, groupId?: string): Promise<{ error: string | null }>;
  setToolbarHeight(height: number): void;
}
export function pixelRect(r: CaptureRect, width: number, height: number, pixelWidth: number, pixelHeight: number): CaptureRect {
  const x=Math.round(r.x*pixelWidth/width),y=Math.round(r.y*pixelHeight/height);
  return {x,y,width:Math.max(1,Math.min(pixelWidth-x,Math.round(r.width*pixelWidth/width))),height:Math.max(1,Math.min(pixelHeight-y,Math.round(r.height*pixelHeight/height)))};
}
export interface ScreenshotAPI {
  recordingState(): Promise<RecordingSessionState | null>;
  recordingAction(action: RecordingAction): Promise<{ state: RecordingSessionState | null; path?: string | null; error: string | null }>;
  onRecording(callback: (state: RecordingSessionState | null) => void): () => void;
  onSuspend(callback: () => EditorCheckpoint | null): () => void;
  updateRegion(request:{id:string;revision:number;crop:CaptureRect}):Promise<void>;
  lastRegion():Promise<CaptureRect|null>;
  clearRegion():Promise<void>;
  startScroll(crop:CaptureRect):Promise<{error:string|null}>;
  regions():Promise<RegionConfiguration>;
  saveRegionPreset(preset:RegionPreset):Promise<void>;

  ready(id: string, editId: string): void;
  loadError(editId: string): void;
  requestPixels(request: {sessionId:string;frameId:string}): string;
  state(): Promise<ScreenshotState | null>;
  onState(callback: (state: ScreenshotState | null) => void): () => void;
  scrollAction(action: ScrollCaptureAction): Promise<{error: string | null}>;
  action(action: 'cancel' | 'reselect' | 'screen' | 'retry'): Promise<{ error: string | null }>;
  recognize(request: OCRRequest): Promise<OCRResult>;
  analyze(request: { id: string; revision: number; kind: IntelligenceKind; targetLanguage?: string; png: Uint8Array; crop: CaptureRect; lines?: OCRLine[] }): Promise<{ result: IntelligenceResult | null; error: string | null }>;
  visionLanguage(): Promise<string>;
  previewFormula(request: { id: string; revision: number; latex: string }): Promise<{ svg: string | null; error: string | null }>;
  openURL(request: { id: string; revision: number; url: string }): Promise<{ error: string | null }>;
  exportTable(rows: string[][]): Promise<{ path: string | null; error: string | null }>;
  pinFormula(latex: string): Promise<{ error: string | null }>;
  invalidateOCR(request: {id: string; revision: number}): void;
  export(frame: CaptureFrame, action: ExportAction, format: ScreenshotOutputFormat, contentMode?: ScreenshotExportContentMode): Promise<{error: string | null}>;
  saveAnnotationMemory(memory: AnnotationStyleMemory): Promise<void>;
  copyText(request: {id: string; revision: number; text: string}): Promise<void>;
  sendText(request: {id: string; revision: number; text: string}): Promise<{error: string | null}>;
}
