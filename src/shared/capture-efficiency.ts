import type { CaptureMode, CaptureRect } from './capture';

export type CaptureDelay = 0 | 3 | 5 | 10;
export type EfficiencyCaptureMode = CaptureMode | 'repeat';
/** A display signature, including its global DIP bounds. A changed signature requires a new selection. */
export interface CaptureDisplayBinding {
  id: number;
  bounds: CaptureRect;
  scaleFactor: number;
  rotation: number;
}
/** The area is local to the bound display, in DIP, never global desktop coordinates or image pixels. */
export interface SuccessfulCaptureArea {
  display: CaptureDisplayBinding;
  rect: CaptureRect;
}
export interface CaptureEfficiencyState {
  phase: 'idle' | 'countdown' | 'capturing' | 'canceling';
  mode: EfficiencyCaptureMode | null;
  remaining: number;
  hasLastArea: boolean;
  error: string | null;
}
export type CaptureEfficiencyResult =
  | { status: 'captured' | 'canceled' }
  | { status: 'reselect-required' | 'failed'; error: string };
