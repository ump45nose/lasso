import type { CaptureRect, OCRLine } from './capture';

export type IntelligenceKind = 'translate' | 'table' | 'formula';
export function webURL(value: string): string | null {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
export interface VisionServiceConfig { baseURL: string; model: string; targetLanguage: string; hasCredential: boolean; useMediaCredential: boolean }
export interface VisionServiceInput { baseURL: string; model: string; targetLanguage: string; credential?: string; useMediaCredential?: boolean }
export interface TranslationBlock { original: string; translated: string; box?: CaptureRect }
export interface IntelligenceResult { kind: IntelligenceKind; blocks?: TranslationBlock[]; translatedText?: string; table?: string[][]; latex?: string; formulaSvg?: string }
export interface IntelligenceRequest { kind: IntelligenceKind; targetLanguage?: string; png: Uint8Array; crop: CaptureRect; lines?: OCRLine[] }
export const visionDefaults = (): Omit<VisionServiceConfig, 'hasCredential'> => ({ baseURL: '', model: '', targetLanguage: '简体中文', useMediaCredential: true });

export function validateVisionConfig(input: VisionServiceInput): void {
  if (!input || typeof input.baseURL !== 'string' || typeof input.model !== 'string' || input.model.length > 200 ||
    typeof input.targetLanguage !== 'string' || !input.targetLanguage.trim() || input.targetLanguage.length > 100 ||
    (input.useMediaCredential !== undefined && typeof input.useMediaCredential !== 'boolean') ||
    (input.credential !== undefined && (typeof input.credential !== 'string' || input.credential.length > 16000))) throw Error('智能识别服务配置无效');
  if (input.baseURL.trim()) {
    let url: URL;
    try { url = new URL(input.baseURL.trim()); } catch { throw Error('智能识别地址须为 HTTP 或 HTTPS URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('智能识别地址不能包含凭据、查询或片段');
  }
}

export function normalizeVisionConfig(value: unknown): Omit<VisionServiceConfig, 'hasCredential'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('智能识别服务配置无效');
  const input = { ...visionDefaults(), ...value } as VisionServiceInput;
  validateVisionConfig(input);
  return { baseURL: input.baseURL.trim().replace(/\/+$/, ''), model: input.model.trim(), targetLanguage: input.targetLanguage.trim(), useMediaCredential: input.useMediaCredential ?? true };
}
