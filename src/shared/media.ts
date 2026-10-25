import type { Settings } from './contracts';

/** Independent image generation data. These inputs never become pending chat images. */
export type MediaAspect = '1:1' | '3:2' | '2:3';
export const mediaAspects: readonly MediaAspect[] = ['1:1', '3:2', '2:3'];
export type MediaDestination = 'api' | 'chatgpt' | 'gemini';
export type MediaQuality = 'auto' | 'low' | 'medium' | 'high';
export type MediaBackground = 'auto' | 'opaque' | 'transparent';
export type MediaFormat = 'png' | 'jpeg' | 'webp';
export interface MediaPreset { id: string; name: string; template: string }
export interface MediaPreferences {
  destination: MediaDestination;
  presets: MediaPreset[];
  defaultPresetId: string;
  quality: MediaQuality;
  background: MediaBackground;
  outputFormat: MediaFormat;
  webMode: 'edit' | 'send';
}
export function defaultMediaPreferences(): MediaPreferences {
  return { destination: 'api', defaultPresetId: 'draw', quality: 'auto', background: 'auto', outputFormat: 'png', webMode: 'send', presets: [
    { id: 'draw', name: '自由作图', template: '请直接生成一张图片，而不是只写绘画建议。画面宽高比为 {{aspect}}。有参考图时结合参考图完成。\n\n{{prompt}}' },
    { id: 'illustration', name: '内容配图', template: '请根据以下内容生成一张清晰、重点突出的配图，宽高比 {{aspect}}。避免添加无关文字。\n\n{{prompt}}' },
    { id: 'edit', name: '修改参考图', template: '请直接修改附带的参考图，保留未要求更改的主体和细节，宽高比 {{aspect}}。修改要求：\n\n{{prompt}}' }
  ] };
}
export function mediaPrompt(template: string, prompt: string, aspect: MediaAspect): string {
  const text = template.replace(/\{\{(prompt|aspect)\}\}/g, (_match, key: string) => key === 'prompt' ? prompt : aspect);
  return template.includes('{{prompt}}') ? text : text + '\n\n' + prompt;
}
export interface MediaConfig extends MediaPreferences {
  baseURL: string;
  generationModel: string;
  editModel: string;
  hasCredential: boolean;
}
export interface MediaConfigInput extends Partial<MediaPreferences> {
  baseURL: string;
  generationModel: string;
  editModel: string;
  /** Omit to preserve the saved credential; an empty string explicitly clears it. */
  credential?: string;
}
export interface MediaReference { id: string; width: number; height: number; thumbnail: string }
export type MediaJobStatus = 'running' | 'succeeded' | 'handed-off' | 'failed' | 'interrupted';
export interface MediaJob {
  id: string;
  requestId: string;
  prompt: string;
  aspect: MediaAspect;
  destination?: MediaDestination;
  presetId?: string;
  renderedPrompt?: string;
  quality?: MediaQuality;
  background?: MediaBackground;
  outputFormat?: MediaFormat;
  webMode?: 'edit' | 'send';
  parentId?: string;
  referenceId?: string;
  /** Frozen preview of the one input used by this request, retained after failures. */
  reference?: MediaReference;
  status: MediaJobStatus;
  createdAt: string;
  updatedAt: string;
  image?: MediaReference;
  error?: string;
}
export type MediaFontSettings = Pick<Settings, 'fonts' | 'importedFonts'>;
export interface MediaState extends MediaFontSettings { jobs: MediaJob[]; reference: MediaReference | null; config: MediaConfig }
export interface MediaGenerateRequest { requestId: string; prompt: string; aspect: MediaAspect; parentId?: string; referenceId?: string; destination?: MediaDestination; presetId?: string; quality?: MediaQuality; background?: MediaBackground; outputFormat?: MediaFormat }
export type MediaOutputAction = 'copy' | 'save' | 'pin' | 'edit';
export interface MediaAPI {
  state(): Promise<MediaState>;
  onState(callback: (state: MediaState) => void): () => void;
  configure(input: MediaConfigInput): Promise<MediaState>;
  checkConnection(): Promise<{ message: string }>;
  models(): Promise<string[]>;
  openFile(): Promise<{ error: string | null }>;
  setReference(id: string | null): Promise<MediaState>;
  /** Opens the existing editor. Only its flattened, privacy-processed PNG is accepted. */
  prepareReference(): Promise<{ error: string | null }>;
  generate(request: MediaGenerateRequest): Promise<MediaState>;
  output(id: string, action: MediaOutputAction): Promise<{ error: string | null }>;
  remove(id: string): Promise<MediaState>;
  hide(): Promise<void>;
}
