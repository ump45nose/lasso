import { clipboard, ClipboardItem, nativeImage, type NativeImage } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureFrame } from '../../shared/capture';
import type { ScreenshotSettings } from '../../shared/screenshot-settings';

const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function assertPng(png: Uint8Array | undefined, width: number, height: number) {
  if (!(png instanceof Uint8Array) || png.byteLength < 24 || png.byteLength > 64 * 1024 * 1024) throw Error('无效的合成图片');
  const bytes = Buffer.from(png);
  if (!bytes.subarray(0, 8).equals(pngMagic) || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) throw Error('合成图片尺寸与裁剪范围不符');
  return bytes;
}

/** Canvas bytes are straight RGBA. Electron bitmaps are premultiplied BGRA. */
export function rgbaToPremulBgra(rgba: Buffer): Buffer {
  const bgra = Buffer.allocUnsafe(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    if (a === 255) { bgra[i] = rgba[i + 2]; bgra[i + 1] = rgba[i + 1]; bgra[i + 2] = rgba[i]; bgra[i + 3] = 255; }
    else if (a === 0) bgra[i] = bgra[i + 1] = bgra[i + 2] = bgra[i + 3] = 0;
    else {
      const scale = a / 255;
      bgra[i] = Math.round(rgba[i + 2] * scale); bgra[i + 1] = Math.round(rgba[i + 1] * scale); bgra[i + 2] = Math.round(rgba[i] * scale); bgra[i + 3] = a;
    }
  }
  return bgra;
}

/** One flattened image, either raw pixels from the editor or a PNG. */
export function decodeFrameImage(frame: Pick<CaptureFrame, 'crop' | 'png' | 'pixels'>): NativeImage {
  const r = frame.crop;
  if (!r || ![r.x, r.y, r.width, r.height].every(Number.isSafeInteger) || r.x < 0 || r.y < 0 || r.width < 1 || r.height < 1 || r.width * r.height > 40_000_000) throw Error('无效的裁剪范围');
  if (frame.pixels) {
    const data = Buffer.from(frame.pixels);
    if (data.byteLength !== r.width * r.height * 4) throw Error('无效的合成图片');
    const image = nativeImage.createFromBitmap(rgbaToPremulBgra(data), { width: r.width, height: r.height, scaleFactor: 1 });
    if (image.isEmpty()) throw Error('图片合成失败');
    return image;
  }
  const png = assertPng(frame.png, r.width, r.height);
  const image = nativeImage.createFromBuffer(png), size = image.getSize();
  if (image.isEmpty() || size.width !== r.width || size.height !== r.height) throw Error('图片合成失败');
  return image;
}

/** Write PNG bytes that are already encoded. Callers with a NativeImage use copyImage. */
export async function copyPng(bytes: Uint8Array | Buffer) {
  await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) })]);
}
export async function copyImage(image: NativeImage) {
  await copyPng(image.toPNG());
}

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
