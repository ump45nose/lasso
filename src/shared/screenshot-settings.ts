import { validateRegionPreset, type RegionPreset } from './capture-regions';
import type { CaptureMode } from './capture';
export type ScreenshotKind = CaptureMode | 'scroll';
export const screenshotKinds: ScreenshotKind[] = ['rect', 'area', 'window', 'front', 'screen', 'scroll'];
export interface ScreenshotActions { show: boolean; copy: boolean; save: boolean }
export interface ScreenshotSettings {
  rememberRegionAcrossLaunches: boolean;
  regionPresets: RegionPreset[];
  actions: Record<ScreenshotKind, ScreenshotActions>;
  directory: string;
  format: 'png' | 'jpeg';
  resizeTo1x: boolean;
  background: 'transparent' | 'solid';
  backgroundColor: string;
  shadow: boolean;
  scrollMaxHeight: number;
  languages: string[];
}
export function screenshotDefaults(directory = ''): ScreenshotSettings {
  return { rememberRegionAcrossLaunches:true,regionPresets:[],actions: Object.fromEntries(screenshotKinds.map(kind => [kind, { show: true, copy: false, save: false }])) as ScreenshotSettings['actions'], directory, format: 'png', resizeTo1x: false, background: 'transparent', backgroundColor: '#ffffff', shadow: false, scrollMaxHeight: 16384, languages: ['zh-Hans', 'en-US', 'zh-Hant'] };
}
/** Merge missing fields independently so old installations keep their capture habits. */
export function migrateScreenshotSettings(value: Partial<ScreenshotSettings> | undefined, directory: string): ScreenshotSettings {
  const defaults = screenshotDefaults(directory);
  return { ...defaults, ...value, actions: Object.fromEntries(screenshotKinds.map(kind => [kind, { ...defaults.actions[kind], ...value?.actions?.[kind] }])) as ScreenshotSettings['actions'] };
}
export function validateScreenshotSettings(value: ScreenshotSettings, supported: string[]): void {
  if (!value || typeof value.directory !== 'string' || !value.directory.startsWith('/') || !['png', 'jpeg'].includes(value.format) || typeof value.resizeTo1x !== 'boolean' || !['transparent', 'solid'].includes(value.background) || !/^#[\da-f]{6}$/i.test(value.backgroundColor) || typeof value.shadow !== 'boolean' || !Number.isSafeInteger(value.scrollMaxHeight) || value.scrollMaxHeight < 1) throw Error('截图配置无效');
  if(typeof value.rememberRegionAcrossLaunches!=='boolean'||!Array.isArray(value.regionPresets)||value.regionPresets.length>100)throw Error('区域预设配置无效');
  value.regionPresets.forEach(validateRegionPreset);
  if(new Set(value.regionPresets.map(p=>p.id)).size!==value.regionPresets.length)throw Error('区域预设重复');
  for (const kind of screenshotKinds) {
    const actions = value.actions?.[kind];
    if (!actions || [actions.show, actions.copy, actions.save].some(v => typeof v !== 'boolean') || !(actions.show || actions.copy || actions.save)) throw Error('每种截图至少保留一项完成操作');
  }
  if (!Array.isArray(value.languages) || !value.languages.length || new Set(value.languages).size !== value.languages.length || value.languages.some(v => !supported.includes(v))) throw Error('请选择本机支持的 OCR 语言');
}
