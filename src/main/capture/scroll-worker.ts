import { parentPort, workerData } from 'node:worker_threads';
import { ScrollStitcher } from './scroll-stitch';
import type { ScrollDirection } from '../../shared/capture';

const stitcher = new ScrollStitcher(workerData?.maxHeight);
parentPort!.on('message', (message: { id: number; type: string; width?: number; height?: number; data?: Uint8Array; direction?: ScrollDirection; index?: number; delta?: number }) => {
  const { id, type } = message;
  try {
    const result = type === 'frame'
      ? stitcher.add({ width: message.width!, height: message.height!, data: message.data! })
      : type === 'snapshot' ? stitcher.snapshot()
      : type === 'undo' ? stitcher.undo()
      : type === 'direction' ? stitcher.setDirection(message.direction!)
      : type === 'remove-segment' ? stitcher.removeSegment(message.index!)
      : type === 'adjust-seam' ? stitcher.adjustSeam(message.index!, message.delta!)
      : type === 'reset' || type === 'cancel' ? stitcher.reset()
      : undefined;
    if (!result) throw new Error('未知的滚动拼接请求');
    if (result.data) parentPort!.postMessage({ id, type, ...result }, [result.data.buffer]);
    else parentPort!.postMessage({ id, type, ...result });
  } catch (error) {
    parentPort!.postMessage({ id, type: 'error', reason: error instanceof Error ? error.message : '滚动拼接失败' });
  }
});
