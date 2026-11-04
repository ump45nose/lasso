import { validateRegionPreset, type RegionPreset } from './capture-regions';
import type { CaptureMode } from './capture';
import { recordingDefaults, migrateRecordingSettings, validateRecordingSettings, type RecordingSettings } from './recording';
import { captureHistoryDefaults, pinWorkspaceDefaults, validateCaptureHistoryPolicy, validatePinWorkspaceSettings, type CaptureHistoryPolicy, type PinWorkspaceSettings } from './history-sync';
export type ScreenshotKind = CaptureMode | 'scroll';
export const screenshotKinds: ScreenshotKind[] = ['rect', 'area', 'window', 'front', 'screen', 'scroll'];
export type ScreenshotOutputFormat = 'png' | 'jpeg' | 'webp' | 'bmp' | 'pdf';
export const screenshotOutputFormats: ScreenshotOutputFormat[] = ['png', 'jpeg', 'webp', 'bmp', 'pdf'];
export type ScreenshotCopyMode = 'image' | 'file' | 'path';
export type ScreenshotExportContentMode = 'result' | 'original' | 'display';
export type ScreenshotAfterSaveAction = 'none' | 'reveal' | 'copy-path' | 'copy-file';
export interface AnnotationStyleConfig {
  color: string;
  width: number;
  fontSize: number;
  mosaicSize: number;
  blurRadius: number;
  arrowType: 'single' | 'double';
  textBackground: boolean;
}
export interface AnnotationStyleMemory {
  rememberToolStyles: boolean;
  lastTool: string;
  defaultStyle: AnnotationStyleConfig;
  perTool: Record<string, Partial<AnnotationStyleConfig>>;
}
export interface ScreenshotActions { show: boolean; copy: boolean; save: boolean }
export interface ScreenshotSettings {
  selectionShape: 'rect' | 'freehand' | 'polygon' | 'multi-rect';
  cornerRadius: number;
  borderWidth: number;
  borderColor: string;
  includeCursor: boolean;
  showCrosshair: boolean;
  loupeMagnification: 4 | 8 | 12;
  loupeColorFormat: 'hex' | 'rgb' | 'hsl';
  watermarkText: string;
  watermarkOpacity: number;
  recording: RecordingSettings;
  history: CaptureHistoryPolicy;
  pinWorkspace: PinWorkspaceSettings;
  rememberRegionAcrossLaunches: boolean;
  regionPresets: RegionPreset[];
  actions: Record<ScreenshotKind, ScreenshotActions>;
  directory: string;
  format: ScreenshotOutputFormat;
  jpegQuality: number;
  quickSaveDirectory: string;
  fileNameTemplate: string;
  copyMode: ScreenshotCopyMode;
  exportContentMode: ScreenshotExportContentMode;
  afterSaveAction: ScreenshotAfterSaveAction;
  annotationMemory: AnnotationStyleMemory;
  resizeTo1x: boolean;
  background: 'transparent' | 'solid';
  backgroundColor: string;
  shadow: boolean;
  scrollMaxHeight: number;
  /** Show a pin at its on-screen size and keep the window edges fixed. */
  pinKeepsSize: boolean;
  languages: string[];
}
export function screenshotDefaults(directory = ''): ScreenshotSettings {
  return {
    selectionShape: 'rect', cornerRadius: 0, borderWidth: 0, borderColor: '#bd7658',
    includeCursor: false, showCrosshair: true, loupeMagnification: 8, loupeColorFormat: 'hex',
    watermarkText: 'Lasso', watermarkOpacity: 0.15,
    recording: recordingDefaults(),
    history: captureHistoryDefaults(), pinWorkspace: pinWorkspaceDefaults(),
    rememberRegionAcrossLaunches: true, regionPresets: [],
    actions: Object.fromEntries(screenshotKinds.map(kind => [kind, { show: true, copy: false, save: false }])) as ScreenshotSettings['actions'],
    directory, format: 'png', jpegQuality: 92, quickSaveDirectory: directory,
    fileNameTemplate: 'Lasso-{YYYY}-{MM}-{DD}-{HH}{mm}{ss}', copyMode: 'image', exportContentMode: 'result', afterSaveAction: 'none',
    annotationMemory: {
      rememberToolStyles: true, lastTool: 'text-select',
      defaultStyle: { color: '#e24a35', width: 4, fontSize: 32, mosaicSize: 16, blurRadius: 12, arrowType: 'single', textBackground: false },
      perTool: {}
    },
    resizeTo1x: false, background: 'transparent', backgroundColor: '#ffffff', shadow: false,
    scrollMaxHeight: 16384, pinKeepsSize: true, languages: ['zh-Hans', 'en-US', 'zh-Hant']
  };
}
/** Merge missing fields independently so old installations keep their capture habits. */
export function migrateScreenshotSettings(value: Partial<ScreenshotSettings> | undefined, directory: string): ScreenshotSettings {
  const defaults = screenshotDefaults(directory);
  return {
    ...defaults, ...value,
    recording: migrateRecordingSettings(value?.recording),
    history: { ...defaults.history, ...value?.history },
    pinWorkspace: { ...defaults.pinWorkspace, ...value?.pinWorkspace },
    quickSaveDirectory: value?.quickSaveDirectory ?? value?.directory ?? directory,
    annotationMemory: {
      ...defaults.annotationMemory, ...value?.annotationMemory,
      defaultStyle: { ...defaults.annotationMemory.defaultStyle, ...value?.annotationMemory?.defaultStyle },
      perTool: { ...value?.annotationMemory?.perTool }
    },
    actions: Object.fromEntries(screenshotKinds.map(kind => [kind, { ...defaults.actions[kind], ...value?.actions?.[kind] }])) as ScreenshotSettings['actions']
  };
}
/** Only relative directory segments and supported variable names are accepted. */
export function validateScreenshotFileNameTemplate(template: string): void {
  if (typeof template !== 'string' || !template.trim() || template.includes('..') || /^[\/\\]/.test(template) ||
    /[\\\x00-\x1f\x7f]/.test(template) || template.split('/').some(part => !part.trim() || part === '.' || /^[a-z]:/i.test(part)) ||
    /[{}]/.test(template.replace(/\{(?:YYYY|MM|DD|HH|mm|ss|app|width|height|seq)\}/g, ''))) {
    throw Error('文件名模板需使用相对路径和支持的变量，不能包含 .. 或绝对路径');
  }
}
export function validateAnnotationMemory(memory: AnnotationStyleMemory): void {
  if (!memory || typeof memory.rememberToolStyles !== 'boolean' || typeof memory.lastTool !== 'string' || !memory.lastTool.trim() ||
    !memory.defaultStyle || !memory.perTool || typeof memory.perTool !== 'object' || Array.isArray(memory.perTool)) throw Error('标注样式记忆无效');
  const valid = (style: Partial<AnnotationStyleConfig>, partial: boolean) => {
    if (!style || typeof style !== 'object' || Array.isArray(style)) return false;
    const checks: { [K in keyof AnnotationStyleConfig]: (value: unknown) => boolean } = {
      color: v => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v),
      width: v => typeof v === 'number' && Number.isFinite(v) && v > 0,
      fontSize: v => typeof v === 'number' && Number.isFinite(v) && v > 0,
      mosaicSize: v => typeof v === 'number' && Number.isFinite(v) && v > 0,
      blurRadius: v => typeof v === 'number' && Number.isFinite(v) && v >= 0,
      arrowType: v => v === 'single' || v === 'double', textBackground: v => typeof v === 'boolean'
    };
    return (Object.keys(checks) as (keyof AnnotationStyleConfig)[]).every(key => (partial && style[key] === undefined) || checks[key](style[key]));
  };
  if (!valid(memory.defaultStyle, false) || Object.values(memory.perTool).some(style => !valid(style, true))) throw Error('标注颜色、尺寸或工具样式无效');
}
export function validateScreenshotSettings(value: ScreenshotSettings, supported: string[]): void {
  if (!value || typeof value.directory !== 'string' || !value.directory.startsWith('/') || typeof value.quickSaveDirectory !== 'string' || !value.quickSaveDirectory.startsWith('/') || !screenshotOutputFormats.includes(value.format) || typeof value.resizeTo1x !== 'boolean' || !['transparent', 'solid'].includes(value.background) || !/^#[\da-f]{6}$/i.test(value.backgroundColor) || typeof value.shadow !== 'boolean' || typeof value.pinKeepsSize !== 'boolean' || !Number.isSafeInteger(value.scrollMaxHeight) || value.scrollMaxHeight < 1) throw Error('截图配置无效');
  if (!Number.isInteger(value.jpegQuality) || value.jpegQuality < 10 || value.jpegQuality > 100) throw Error('JPEG 质量需为 10–100 的整数');
  if (!['image', 'file', 'path'].includes(value.copyMode) || !['result', 'original', 'display'].includes(value.exportContentMode) || !['none', 'reveal', 'copy-path', 'copy-file'].includes(value.afterSaveAction)) throw Error('截图输出配置无效');
  if (!['rect','freehand','polygon','multi-rect'].includes(value.selectionShape) ||
    !Number.isFinite(value.cornerRadius) || value.cornerRadius < 0 || value.cornerRadius > 64 ||
    !Number.isFinite(value.borderWidth) || value.borderWidth < 0 || value.borderWidth > 16 || !/^#[\da-f]{6}$/i.test(value.borderColor) ||
    typeof value.includeCursor !== 'boolean' || typeof value.showCrosshair !== 'boolean' || ![4,8,12].includes(value.loupeMagnification) ||
    !['hex','rgb','hsl'].includes(value.loupeColorFormat) || typeof value.watermarkText !== 'string' || value.watermarkText.length > 500 ||
    !Number.isFinite(value.watermarkOpacity) || value.watermarkOpacity < 0 || value.watermarkOpacity > 1) throw Error('高级截图配置无效');
  validateScreenshotFileNameTemplate(value.fileNameTemplate);
  validateAnnotationMemory(value.annotationMemory);
  validateRecordingSettings(value.recording);
  validateCaptureHistoryPolicy(value.history);
  validatePinWorkspaceSettings(value.pinWorkspace);
  if(typeof value.rememberRegionAcrossLaunches!=='boolean'||!Array.isArray(value.regionPresets)||value.regionPresets.length>100)throw Error('区域预设配置无效');
  value.regionPresets.forEach(validateRegionPreset);
  if(new Set(value.regionPresets.map(p=>p.id)).size!==value.regionPresets.length)throw Error('区域预设重复');
  for (const kind of screenshotKinds) {
    const actions = value.actions?.[kind];
    if (!actions || [actions.show, actions.copy, actions.save].some(v => typeof v !== 'boolean') || !(actions.show || actions.copy || actions.save)) throw Error('每种截图至少保留一项完成操作');
  }
  if (!Array.isArray(value.languages) || !value.languages.length || new Set(value.languages).size !== value.languages.length || value.languages.some(v => !supported.includes(v))) throw Error('请选择本机支持的 OCR 语言');
}
