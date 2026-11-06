import { clipboard, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import type { CaptureFrame, CaptureRect, OCRRequest, OCRResult, ScreenshotAPI } from '../../shared/capture';
import type { Settings } from '../../shared/contracts';
import type { ScreenshotSettings } from '../../shared/screenshot-settings';
import { webURL } from '../../shared/intelligence';
import { exportTableXlsx, renderFormula, type IntelligenceService } from './intelligence';
import type { OCRService } from './ocr';

type Feature = 'recognize' | 'analyze' | 'visionLanguage' | 'previewFormula' | 'openURL' | 'exportTable' | 'pinFormula' | 'copyText' | 'sendText' | 'invalidateOCR';
/** IPC channel per editor feature; the screenshot and pin hosts keep their historical names. */
export type EditorChannels = Record<Feature, string>;
/** The live edit in the calling window. Each host supplies its own ownership and revision rules. */
export interface EditorSession {
  /** The live edit and its accepted revision; throws once editing ended. */
  edit(): { id: string; revision: number };
  /** Throws unless id is the live edit and revision is not older than the accepted one. */
  check(id: string, revision: number): void;
  accept(id: string, revision: number): void;
  /** Validates the frame crop against the edited source, decodes it, then accepts its revision. */
  frame(frame: CaptureFrame): void;
  /** Whether the calling window still holds exactly this edit and revision. */
  current(id: string, revision: number): boolean;
  ocr: OCRService;
  textSent(id: string): void;
  recognized?(result: OCRResult): void;
}
export interface EditorHost { settings(): ScreenshotSettings; intelligence(): IntelligenceService; suppress(): void; text(text: string): Promise<void> }

export function validCrop(crop: CaptureRect | undefined, size: { width: number; height: number }, min = 1): CaptureRect {
  if (!crop || ![crop.x, crop.y, crop.width, crop.height].every(Number.isSafeInteger) || crop.x < 0 || crop.y < 0 || crop.width < min || crop.height < min || crop.x + crop.width > size.width || crop.y + crop.height > size.height) throw Error('无效的裁剪范围');
  return crop;
}
/** Settings both hosts hand to the shared renderer Editor with each edit. */
export const editorSettings = (settings: ScreenshotSettings, general: Pick<Settings, 'editorShortcuts' | 'toolbarTools' | 'mouseActions'> | undefined) =>
  ({ annotationMemory: settings.annotationMemory, screenshotSettings: settings, editorShortcuts: general?.editorShortcuts, toolbarTools: general?.toolbarTools, mouseActions: general?.mouseActions });
const editorText = (value: unknown, message: string) => { if (typeof value !== 'string' || !value.trim() || value.length > 100000) throw Error(message); return value; };
const message = (error: unknown) => (error as Error).message;

/** Serves the editor features the shared renderer Editor calls in either host; returns the unregister function. */
export function handleEditorServices(channels: EditorChannels, session: (event: IpcMainEvent | IpcMainInvokeEvent) => EditorSession, host: EditorHost): () => void {
  ipcMain.handle(channels.recognize, (e, frame: OCRRequest) => {
    const s = session(e);
    if (!frame || !['text', 'code'].includes(frame.mode) || typeof frame.enhance !== 'boolean' || (frame.force !== undefined && typeof frame.force !== 'boolean') || !(frame.png instanceof Uint8Array)) throw Error('无效的识别选项');
    s.frame(frame);
    return s.ocr.recognize({ id: frame.id, revision: frame.revision, png: Buffer.from(frame.png), mode: frame.mode, enhance: frame.enhance, force: frame.force, languages: host.settings().languages }).then(result => { s.recognized?.(result); return result; });
  });
  ipcMain.handle(channels.analyze, async (e, request: Parameters<ScreenshotAPI['analyze']>[0]) => {
    const s = session(e);
    try { s.frame(request); const result = await host.intelligence().analyze(request); if (!s.current(request.id, request.revision)) throw Error('图片已变化，请重试'); return { result, error: null }; }
    catch (error) { return { result: null, error: message(error) }; }
  });
  ipcMain.handle(channels.visionLanguage, e => { session(e).edit(); return host.intelligence().connection().targetLanguage; });
  ipcMain.handle(channels.previewFormula, (e, r: { id: string; revision: number; latex: string }) => {
    const s = session(e);
    try { s.check(r?.id, r?.revision); return { svg: renderFormula(r.latex), error: null }; } catch (error) { return { svg: null, error: message(error) }; }
  });
  ipcMain.handle(channels.openURL, async (e, r: { id: string; revision: number; url: string }) => {
    const s = session(e);
    try { s.check(r?.id, r?.revision); const url = typeof r.url === 'string' && webURL(r.url); if (!url) throw Error('只能打开 HTTP 或 HTTPS 链接'); await shell.openExternal(url); return { error: null }; }
    catch (error) { return { error: message(error) }; }
  });
  ipcMain.handle(channels.exportTable, (e, rows: string[][]) => { session(e).edit(); return exportTableXlsx(rows, host.settings().directory); });
  ipcMain.handle(channels.pinFormula, async (e, latex: string) => {
    const s = session(e);
    try { const { id, revision } = s.edit(); await host.intelligence().pinFormula(latex, () => s.current(id, revision)); return { error: null }; }
    catch (error) { return { error: message(error) }; }
  });
  ipcMain.handle(channels.copyText, (e, r: { id: string; revision: number; text: string }) => {
    const s = session(e), text = editorText(r?.text, '没有可复制的文字');
    s.accept(r.id, r.revision); host.suppress(); clipboard.writeText(text);
  });
  ipcMain.handle(channels.sendText, async (e, r: { id: string; revision: number; text: string }) => {
    const s = session(e);
    try { const text = editorText(r?.text, '请先选择图中文字'); s.accept(r.id, r.revision); await host.text(text); s.textSent(r.id); return { error: null }; }
    catch (error) { return { error: message(error) }; }
  });
  ipcMain.on(channels.invalidateOCR, (e, r: { id: string; revision: number }) => {
    let s: EditorSession;
    try { s = session(e); s.accept(r?.id, r?.revision); } catch { return; }
    s.ocr.invalidate(r.id, r.revision);
  });
  return () => { for (const [feature, channel] of Object.entries(channels)) { if (feature === 'invalidateOCR') ipcMain.removeAllListeners(channel); else ipcMain.removeHandler(channel); } };
}
