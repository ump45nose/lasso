import type { Settings } from './contracts';

export const mediaAspects = ['1:1', '4:5', '3:4', '2:3', '9:16', '9:21', '5:4', '4:3', '3:2', '16:9', '21:9'] as const;
export type MediaAspect = typeof mediaAspects[number];
export type MediaResolution = '1K' | '2K' | '4K';
export interface ImageSizeOptions {
  /** Empty means the model chooses the aspect ratio. */
  aspect: MediaAspect | '';
  resolution?: MediaResolution;
  count?: number;
  customSize?: { width: number; height: number };
}
export type MediaDestination = 'api' | 'chatgpt' | 'gemini';
export type MediaQuality = 'auto' | 'low' | 'medium' | 'high';
export type MediaBackground = 'auto' | 'opaque' | 'transparent';
export type MediaFormat = 'png' | 'jpeg' | 'webp';
export interface ImageOptions extends ImageSizeOptions {
  generationModel: string;
  editModel: string;
  quality: MediaQuality;
  background: MediaBackground;
  outputFormat: MediaFormat;
}
export const defaultImageOptions = (): ImageOptions => ({ aspect: '', generationModel: '', editModel: '', quality: 'auto', background: 'auto', outputFormat: 'png' });
export function validImageSize(value: ImageSizeOptions): boolean {
  return !!value && (value.aspect === '' || mediaAspects.includes(value.aspect))
    && (value.resolution === undefined || ['1K', '2K', '4K'].includes(value.resolution))
    && (value.count === undefined || Number.isInteger(value.count) && value.count >= 1 && value.count <= 4)
    && (value.customSize === undefined || !!value.customSize && [value.customSize.width, value.customSize.height].every(n => Number.isInteger(n) && n >= 64 && n <= 8192) && value.customSize.width * value.customSize.height <= 40_000_000);
}
export function validImageOptions(value: ImageOptions): boolean {
  return validImageSize(value) && typeof value.generationModel === 'string' && value.generationModel.length <= 512 && typeof value.editModel === 'string' && value.editModel.length <= 512
    && ['auto', 'low', 'medium', 'high'].includes(value.quality) && ['auto', 'opaque', 'transparent'].includes(value.background) && ['png', 'jpeg', 'webp'].includes(value.outputFormat);
}
// 1K aspect presets follow Google's image-size table; 9:21 uses the equivalent
// approximately one-megapixel canvas. Actual supported sizes depend on the model.
const imageSizes: Record<MediaAspect, readonly [number, number]> = {
  '1:1': [1024, 1024], '4:5': [928, 1152], '3:4': [896, 1200], '2:3': [848, 1264], '9:16': [768, 1376], '9:21': [672, 1568],
  '5:4': [1152, 928], '4:3': [1200, 896], '3:2': [1264, 848], '16:9': [1376, 768], '21:9': [1584, 672]
};
export function imagePixels(value: ImageSizeOptions): { width: number; height: number } | null {
  if (value.customSize) return value.customSize;
  if (!value.aspect) return null;
  // Preserve the existing Images API dimensions for presets without a new resolution choice.
  const legacy: Partial<Record<MediaAspect, readonly [number, number]>> = { '3:2': [1536, 1024], '2:3': [1024, 1536] };
  const [width, height] = !value.resolution && legacy[value.aspect] || imageSizes[value.aspect];
  const scale = value.resolution === '4K' ? 4 : value.resolution === '2K' ? 2 : 1;
  return { width: width * scale, height: height * scale };
}
export function imageRequestSize(value: ImageSizeOptions): string | undefined {
  const pixels = imagePixels(value);
  return pixels ? `${pixels.width}x${pixels.height}` : value.resolution;
}
export function imageOptionsSummary(value: ImageSizeOptions): string {
  return [value.customSize ? `${value.customSize.width} × ${value.customSize.height} px` : value.aspect, !value.customSize && value.resolution, value.count && `${value.count} 张`].filter(Boolean).join(' · ') || '尺寸与张数跟随模型';
}
export function imagePromptOptions(value: ImageSizeOptions, includeAspect = true): string {
  return [value.customSize ? `输出尺寸：${value.customSize.width} × ${value.customSize.height} 像素` : includeAspect && value.aspect && `图片比例：${value.aspect}`,
    !value.customSize && value.resolution && `分辨率：${value.resolution}`, value.count && `生成数量：${value.count} 张独立图片`].filter(Boolean).join('\n');
}
export interface MediaConfig { baseURL: string; hasCredential: boolean }
export interface MediaConfigInput {
  baseURL: string;
  /** Omit to preserve the saved credential; an empty string explicitly clears it. */
  credential?: string;
}
export interface MediaReference { id: string; width: number; height: number; thumbnail: string }
export type MediaJobStatus = 'running' | 'succeeded' | 'handed-off' | 'failed' | 'interrupted';
export interface MediaJob extends ImageSizeOptions {
  id: string;
  requestId: string;
  prompt: string;
  /** Historical web deliveries remain readable; new jobs are API-only. */
  destination?: MediaDestination;
  presetId?: string;
  presetName?: string;
  renderedPrompt?: string;
  quality?: MediaQuality;
  background?: MediaBackground;
  outputFormat?: MediaFormat;
  generationModel?: string;
  editModel?: string;
  webMode?: 'edit' | 'send';
  parentId?: string;
  referenceId?: string;
  reference?: MediaReference;
  status: MediaJobStatus;
  createdAt: string;
  updatedAt: string;
  images?: MediaReference[];
  error?: string;
}
export interface MediaDraft {
  id: string;
  presetId: string;
  presetName: string;
  prompt: string;
  options: ImageOptions;
}
export type MediaFontSettings = Pick<Settings, 'fonts' | 'importedFonts'>;
export interface MediaState extends MediaFontSettings { jobs: MediaJob[]; reference: MediaReference | null; draft: MediaDraft | null }
export interface MediaGenerateRequest { requestId: string; draftId: string; prompt: string }
export type MediaOutputAction = 'copy' | 'save' | 'pin' | 'edit';
export interface MediaAPI {
  saveDraft(id: string, prompt: string): Promise<void>;
  state(): Promise<MediaState>;
  onState(callback: (state: MediaState) => void): () => void;
  setReference(id: string | null): Promise<MediaState>;
  restore(id: string, edit: boolean, imageId?: string): Promise<MediaState>;
  choosePreset(): Promise<void>;
  generate(request: MediaGenerateRequest): Promise<MediaState>;
  output(id: string, action: MediaOutputAction, imageId?: string): Promise<{ error: string | null }>;
  remove(id: string): Promise<MediaState>;
  hide(): Promise<void>;
}
