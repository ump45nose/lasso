import type { CaptureDelay, CaptureDisplayBinding } from './capture-efficiency';

export interface RegionPreset {
  id: string;
  name: string;
  width: number;
  height: number;
  ratio: number | null;
  delay: CaptureDelay;
}
export interface CustomCaptureRequest {
  displayId: number;
  width: number;
  height: number;
  ratio: number | null;
  delay: CaptureDelay;
  presetId?: string;
}
export interface RegionConfiguration {
  presets: RegionPreset[];
  displays: (CaptureDisplayBinding & { label: string })[];
  /** Only valid local bindings; positions stay in capture-regions.json. */
  presetDisplayIds?: Record<string, number>;
}
export function validateRegionPreset(p: RegionPreset) {
  if (!p || typeof p.id !== 'string' || !p.id.trim() || p.id.length > 100 ||
    typeof p.name !== 'string' || !p.name.trim() || p.name.length > 80 ||
    ![p.width, p.height].every(n => Number.isSafeInteger(n) && n >= 2 && n <= 100000) ||
    !(p.ratio === null || (Number.isFinite(p.ratio) && p.ratio > 0)) || ![0, 3, 5, 10].includes(p.delay)) {
    throw Error('区域预设需要名称、至少 2 × 2 的整数像素尺寸和有效延时');
  }
}
export function validateCustomCapture(r: CustomCaptureRequest) {
  if (!r || !Number.isSafeInteger(r.displayId) ||
    (r.presetId !== undefined && (typeof r.presetId !== 'string' || !r.presetId.trim() || r.presetId.length > 100))) {
    throw Error('请选择有效显示器和区域预设');
  }
  validateRegionPreset({ id: r.presetId ?? 'custom', name: '自定义', width: r.width, height: r.height, ratio: r.ratio, delay: r.delay });
}
