export interface CaptureRect { x: number; y: number; width: number; height: number }
export interface RegionCandidate extends CaptureRect { source: 'window' | 'element' | 'edge' | 'color' | 'screen' }
export interface ScreenshotState { id: string; image: string; width: number; height: number; candidates: RegionCandidate[]; phase: 'selecting' | 'result'; selection: CaptureRect | null; status: string }
export interface ScreenshotAPI {
  state(): Promise<ScreenshotState | null>;
  onState(callback: (state: ScreenshotState) => void): () => void;
  hover(x: number, y: number): void;
  select(rect: CaptureRect): Promise<void>;
  action(action: 'cancel' | 'copy' | 'save' | 'image' | 'reselect' | 'screen'): Promise<{ error: string | null }>;
}
