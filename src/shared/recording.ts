import type { CaptureRect } from './capture';

export type RecordingMode = 'rect' | 'window' | 'screen';
export type RecordingFormat = 'mp4' | 'gif' | 'webp';
export type RecordingQuality = 'low' | 'medium' | 'high';
export type CameraCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
export interface RecordingSettings {
  fps: 15 | 24 | 30 | 60; quality: RecordingQuality; format: RecordingFormat; countdown: 0 | 3 | 5;
  systemAudio: boolean; microphone: boolean; showKeystrokes: boolean; showMouseClicks: boolean;
  cameraOverlay: boolean; cameraPosition: CameraCorner;
}
export interface KeystrokeCue { key: string; modifiers: string[]; timestampMs: number }
export interface MouseClickCue { x: number; y: number; button: 'left' | 'right'; timestampMs: number }
export interface RecordingMediaInterval {
  hostStartMs: number; hostEndMs: number; activeStartMs: number; activeEndMs: number;
}
export interface RecordingAudioSegment {
  source: 'system' | 'microphone'; file: string; startMs: number; durationMs: number; sampleRate: number; channels: number;
}
export interface RecordingMediaManifest {
  version: 1; sessionId: string; durationMs: number; intervals: RecordingMediaInterval[]; audio: RecordingAudioSegment[];
}
export interface RecordingSessionState {
  id: string; status: 'countdown' | 'recording' | 'paused' | 'review' | 'recoverable'; mode: RecordingMode;
  bounds: CaptureRect; countdownLeft: number; durationMs: number; frameCount: number; settings: RecordingSettings;
  trimStartMs: number; trimEndMs: number; previewFrames: string[]; previewTimestampsMs?: number[]; recentKeys: KeystrokeCue[]; recentClicks: MouseClickCue[]; message: string;
}
export type RecordingExportAction = 'save' | 'quick-save' | 'copy-file' | 'pin';
export type RecordingAction =
  | { type: 'start'; mode: RecordingMode; bounds?: CaptureRect }
  | { type: 'pause' | 'resume' | 'stop' | 'cancel' }
  | { type: 'camera'; enabled: boolean }
  | { type: 'trim'; startMs: number; endMs: number }
  | { type: 'export'; format: RecordingFormat; action: RecordingExportAction }
  | { type: 'recover' | 'discard-recovery'; sessionId?: string };
export const recordingFormats: RecordingFormat[] = ['mp4', 'gif', 'webp'];
export function recordingDefaults(): RecordingSettings {
  return { fps: 30, quality: 'high', format: 'gif', countdown: 3, systemAudio: false, microphone: false,
    showKeystrokes: true, showMouseClicks: true, cameraOverlay: false, cameraPosition: 'bottom-right' };
}
export function validateRecordingSettings(value: RecordingSettings): void {
  if (!value || ![15, 24, 30, 60].includes(value.fps) || !['low', 'medium', 'high'].includes(value.quality) ||
    !recordingFormats.includes(value.format) || ![0, 3, 5].includes(value.countdown) ||
    !['bottom-right', 'bottom-left', 'top-right', 'top-left'].includes(value.cameraPosition) ||
    [value.systemAudio, value.microphone, value.showKeystrokes, value.showMouseClicks, value.cameraOverlay].some(v => typeof v !== 'boolean')) throw Error('录制配置无效');
}
export function migrateRecordingSettings(value?: Partial<RecordingSettings>): RecordingSettings {
  const result = { ...recordingDefaults(), ...value };
  validateRecordingSettings(result);
  return result;
}
