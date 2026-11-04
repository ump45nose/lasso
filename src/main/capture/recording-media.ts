import { join } from 'node:path';
import type { CameraCorner, RecordingMediaManifest } from '../../shared/recording';
export interface RecordingMedia {
  prepare(options: { sessionId: string; directory: string; displayId: number; systemAudio: boolean; microphone: boolean; camera: boolean }): Promise<void>;
  setCamera(options: { sessionId: string; enabled: boolean }): Promise<void>;
  nowMs(): number;
  begin(sessionId: string): Promise<{ hostTimeMs: number }>;
  pause(sessionId: string): Promise<{ activeTimeMs: number }>;
  resume(sessionId: string): Promise<{ activeTimeMs: number }>;
  composeCamera(options: { sessionId: string; bgra: Buffer; width: number; height: number; hostTimeMs: number; corner: CameraCorner }): Promise<Buffer>;
  snapshot(sessionId: string): Promise<RecordingMediaManifest>;
  stop(sessionId: string): Promise<RecordingMediaManifest>;
  cancel(sessionId: string): Promise<void>;
  muxMp4(options: { directory: string; videoPath: string; manifest: RecordingMediaManifest; trimStartMs: number; trimEndMs: number; outputPath: string }): Promise<void>;
}
/** Native capture stays off the JS thread; all methods reject device/storage errors. */
export class NativeRecordingMedia implements RecordingMedia {
  private get native(): RecordingMedia { return require(join(__dirname, 'native/recording-media.node')) as RecordingMedia; }
  prepare: RecordingMedia['prepare'] = options => this.native.prepare(options);
  setCamera: RecordingMedia['setCamera'] = options => this.native.setCamera(options);
  nowMs = () => this.native.nowMs();
  begin: RecordingMedia['begin'] = id => this.native.begin(id);
  pause: RecordingMedia['pause'] = id => this.native.pause(id);
  resume: RecordingMedia['resume'] = id => this.native.resume(id);
  composeCamera: RecordingMedia['composeCamera'] = options => this.native.composeCamera(options);
  snapshot: RecordingMedia['snapshot'] = id => this.native.snapshot(id);
  stop: RecordingMedia['stop'] = id => this.native.stop(id);
  cancel: RecordingMedia['cancel'] = id => this.native.cancel(id);
  muxMp4: RecordingMedia['muxMp4'] = options => this.native.muxMp4(options);
}
