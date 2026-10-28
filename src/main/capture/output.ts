import { nativeImage, type NativeImage } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScreenshotSettings } from '../../shared/screenshot-settings';

/** Electron's native BGRA bitmap is premultiplied; composite once onto an opaque background. */
export function flattenBackground(image: NativeImage, color: string): NativeImage {
  const size = image.getSize(), data = image.toBitmap();
  const rgb = [parseInt(color.slice(5, 7), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(1, 3), 16)];
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha === 255) continue;
    for (let channel = 0; channel < 3; channel++) data[i + channel] = Math.min(255, Math.round(data[i + channel] + rgb[channel] * (255 - alpha) / 255));
    data[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(data, { ...size, scaleFactor: 1 });
}
export function encodeScreenshot(image: NativeImage, settings: ScreenshotSettings, format = settings.format, scale?: { x: number; y: number }): Buffer {
  let output = image;
  if (format === 'jpeg') output = flattenBackground(output, settings.background === 'solid' ? settings.backgroundColor : '#ffffff');
  if (settings.resizeTo1x && scale && (scale.x > 1 || scale.y > 1)) {
    const size = output.getSize();
    output = output.resize({ width: Math.max(1, Math.round(size.width / scale.x)), height: Math.max(1, Math.round(size.height / scale.y)), quality: 'best' });
  }
  return format === 'jpeg' ? output.toJPEG(92) : output.toPNG();
}
export function screenshotName(format: 'png' | 'jpeg'): string {
  const date = new Date(), pad = (n: number) => String(n).padStart(2, '0');
  return `Lasso-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.${format === 'jpeg' ? 'jpg' : 'png'}`;
}
export async function saveAutomaticScreenshot(bytes: Buffer, directory: string, format: 'png' | 'jpeg'): Promise<string> {
  await mkdir(directory, { recursive: true });
  const name = screenshotName(format), dot = name.lastIndexOf('.');
  for (let count = 0; ; count++) {
    const path = join(directory, count ? `${name.slice(0, dot)}-${count}${name.slice(dot)}` : name);
    try { await writeFile(path, bytes, { flag: 'wx' }); return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}
