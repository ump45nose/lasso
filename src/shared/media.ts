import type { Settings } from './contracts';

/** Independent image generation data. These inputs never become pending chat images. */
export type MediaAspect = '1:1' | '3:2' | '2:3';
export const mediaAspects: readonly MediaAspect[] = ['1:1', '3:2', '2:3'];
export interface MediaConfig {
  baseURL: string;
  generationModel: string;
  editModel: string;
  hasCredential: boolean;
}
export interface MediaConfigInput {
  baseURL: string;
  generationModel: string;
  editModel: string;
  /** Omit to preserve the saved credential; an empty string explicitly clears it. */
  credential?: string;
}
export interface MediaReference { id: string; width: number; height: number; thumbnail: string }
export type MediaJobStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';
export interface MediaJob {
  id: string;
  requestId: string;
  prompt: string;
  aspect: MediaAspect;
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
export interface MediaGenerateRequest { requestId: string; prompt: string; aspect: MediaAspect; parentId?: string; referenceId?: string }
export type MediaOutputAction = 'copy' | 'save' | 'pin' | 'edit';
export interface MediaAPI {
  state(): Promise<MediaState>;
  onState(callback: (state: MediaState) => void): () => void;
  configure(input: MediaConfigInput): Promise<MediaState>;
  checkConnection(): Promise<{ message: string }>;
  setReference(id: string | null): Promise<MediaState>;
  /** Opens the existing editor. Only its flattened, privacy-processed PNG is accepted. */
  prepareReference(): Promise<{ error: string | null }>;
  generate(request: MediaGenerateRequest): Promise<MediaState>;
  output(id: string, action: MediaOutputAction): Promise<{ error: string | null }>;
  remove(id: string): Promise<MediaState>;
  hide(): Promise<void>;
}
