import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../../shared/contracts';
import type { CaptureRect, RegionCandidate, CaptureWindow } from '../../shared/capture';
export interface NativeFrame { id: string; width: number; height: number; scale: number; bounds: CaptureRect; captureMs: number; queueMs: number; completionMs: number; workMs: number }
export interface NativePixels { width: number; height: number; data: Uint8Array }
export interface NativeCaptureEvent { session: string; type: 'copy'|'last'|'shown'|'hover'|'mode'|'select'|'window'|'scroll'|'screen'|'cancel'|'retry'; x?: number; y?: number; mode?: 'area'|'window'|'scroll'; rect?: CaptureRect; kind?: 'rect'|'area'; id?: number; shadow?: boolean; nativeReadyMs?: number }
export interface NativeCapture {
  warmup(theme: Record<string, unknown>, callback?: (event: NativeCaptureEvent) => void): void;
  createFrame(options: {width:number;height:number;data:Buffer;logicalX?:number;logicalY?:number;logicalWidth?:number;logicalHeight?:number}): NativeFrame;
  capture(options: { displayId: number; bounds: CaptureRect; windowId?: number; shadow?: boolean; exclude: number[] }): Promise<NativeFrame>;
  pixels(frameId: string, options: { format: 'rgba'|'bgra'; rect?: CaptureRect; maxWidth?: number }): Promise<NativePixels>;
  show(options: { frameId: string; session: string; mode: 'rect'|'area'|'window'|'scroll'; windows: CaptureWindow[]; candidates: RegionCandidate[];fixedSize?:{width:number;height:number} }): void;
  update(options: { session: string; candidates?: RegionCandidate[]; message?: string; resume?: boolean }): void;
  hide(): void; focus(): void; release(id: string): void; invalidate(): void;
  windowID(handle: Buffer): number;
  snapshot(): { visible: number; focused: number; frameCount: number; windowId: number; session: string; mode: string; selection: CaptureRect };
}
export function loadNativeCapture(callback: (event: NativeCaptureEvent) => void): NativeCapture {
  const native = require(join(__dirname, 'native/capture-native.node')) as NativeCapture;
  const theme = JSON.parse(readFileSync(join(__dirname, 'native/capture-theme.json'), 'utf8'));
  theme.icons = Object.fromEntries(Object.entries(theme.icons).map(([name, path]) => [name, join(__dirname, 'native', path as string)]));
  native.warmup(theme, callback);
  return native;
}
/** Register actual Lasso surface windows, preserving normal windows such as pins. */
export function excludedCaptureWindows(native: NativeCapture): number[] {
  return BrowserWindow.getAllWindows().filter(window => {
    const url = window.webContents.getURL();
    return !url.includes('surface=pin') && (url.includes('surface=action-bar') || url.includes('surface=screenshot') || !url.includes('surface='));
  }).map(window => native.windowID(window.getNativeWindowHandle()));
}

export function updateNativeAppearance(native:NativeCapture,settings:Pick<Settings,'fonts'|'importedFonts'>){
  const theme=JSON.parse(readFileSync(join(__dirname,'native/capture-theme.json'),'utf8'));
  theme.icons=Object.fromEntries(Object.entries(theme.icons).map(([name,path])=>[name,join(__dirname,'native',path as string)]));
  if(settings.fonts.ui)theme.uiFonts.unshift(settings.fonts.ui);
  if(settings.fonts.mono)theme.monoFonts.unshift(settings.fonts.mono);
  theme.fontFiles=settings.importedFonts.map(font=>join(app.getPath('userData'),'fonts',font.file));
  native.warmup(theme,()=>{});
}

export function prewarmNativeCapture(){
  const native=require(join(__dirname,'native/capture-native.node')) as NativeCapture;
  const theme=JSON.parse(readFileSync(join(__dirname,'native/capture-theme.json'),'utf8'));
  theme.icons=Object.fromEntries(Object.entries(theme.icons).map(([name,path])=>[name,join(__dirname,'native',path as string)]));
  native.warmup(theme);
}
