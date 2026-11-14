import { join } from 'node:path';
import type { CaptureRect } from '../shared/capture';

export type WindowRect = CaptureRect & { pid: number; id: number; bundleId: string };

export interface NativeAx {
  query(pid: number, x: number, y: number): Promise<{ rects: CaptureRect[]; error: number }>;
  windows(): WindowRect[];
  windowOnScreen(windowId: number): boolean;
  requestScreen(): Promise<boolean>;
  frontmostApp(): { bundleId: string; name: string; pid: number };
  paste(): void;
  pasteboardMeta(): { changeCount: number; concealed: boolean };
  pasteToProcess(pid: number): boolean;
  startCopyWatch(cb: (event: { doubleCopy: boolean; timestamp: number }) => void): void;
  stopCopyWatch(): void;
  setWindowDragSnapEnabled(enabled: boolean, dwellMs?: number): void;
  setGlow(enabled: boolean): void;
  startBridge(cb: (event: { name: string; payload: string }) => void): void;
  stopBridge(): void;
  postBridge(name: string, payload: string): void;
  snapWindow(x: number, y: number, w: number, h: number): boolean;
  focusedWindowFrame(): CaptureRect | null;
  startFinderTrigger(cb: (point: { x: number; y: number; trigger: 'middle' | 'right-hold' }) => void): void;
  stopFinderTrigger(): void;
  setFinderTriggerOptions(middleClick: boolean, rightHold: boolean): void;
  tileTwoWindows(x1: number, y1: number, w1: number, h1: number, x2: number, y2: number, w2: number, h2: number): number;
  notchGeometry(active?: boolean): { hasNotch: boolean; width: number; height: number; menuBarHeight: number; leftSafeWidth?: number; rightSafeWidth?: number; anchorX?: number };
  startIslandStatusClick(cb: () => void): void;
  setStationaryWindow(handle: Buffer): void;
}

let ax: NativeAx | undefined;
export const nativeAx = (): NativeAx => ax ??= require(join(__dirname, 'native/capture-ax.node'));
