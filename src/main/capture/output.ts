import { dialog, type BrowserWindow, clipboard, ClipboardItem, nativeImage, shell, type NativeImage } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import type { RecordingFormat } from '../../shared/recording';
import type { CaptureFrame } from '../../shared/capture';
import { validateScreenshotFileNameTemplate, type ScreenshotAfterSaveAction, type ScreenshotOutputFormat, type ScreenshotSettings } from '../../shared/screenshot-settings';

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
/** Return straight BGRA for formats that do not accept premultiplied color. */
function straightBitmap(image: NativeImage): Buffer {
  const bytes = image.toBitmap();
  for (let i = 0; i < bytes.length; i += 4) {
    const alpha = bytes[i + 3];
    if (alpha === 255) continue;
    for (let c = 0; c < 3; c++) bytes[i + c] = alpha ? Math.min(255, Math.round(bytes[i + c] * 255 / alpha)) : 0;
  }
  return bytes;
}

function encodeBmp(image: NativeImage): Buffer {
  const { width, height } = image.getSize(), pixels = image.toBitmap(), stride = (width * 3 + 3) & ~3;
  const bytes = Buffer.alloc(54 + stride * height);
  bytes.write('BM'); bytes.writeUInt32LE(bytes.length, 2); bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(width, 18); bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28); bytes.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (y * width + x) * 4, target = 54 + (height - y - 1) * stride + x * 3;
    pixels.copy(bytes, target, source, source + 3);
  }
  return bytes;
}

/** Minimal VP8L literal encoder: fixed 8-bit channel codes, no transforms or native dependency.
 * https://developers.google.com/speed/webp/docs/webp_lossless_bitstream_specification
 */
function encodeWebp(image: NativeImage): Buffer {
  const { width, height } = image.getSize();
  if (width > 16384 || height > 16384) throw Error('WebP 图片宽高不能超过 16384 像素');
  const pixels = straightBitmap(image), data = Buffer.alloc(pixels.length + 128);
  let position = 0;
  const bits = (value: number, count: number) => {
    for (let i = 0; i < count; i++, position++) data[position >> 3] |= ((value >>> i) & 1) << (position & 7);
  };
  bits(width - 1, 14); bits(height - 1, 14); bits(1, 1); bits(0, 3);
  bits(0, 1); bits(0, 1); bits(0, 1); // No transforms, color cache or entropy image.
  for (let channel = 0; channel < 4; channel++) {
    bits(0, 1); bits(8, 4); // Normal tree; twelve code-length code lengths.
    for (let i = 0; i < 12; i++) bits(i === 11 ? 1 : 0, 3); // Only code length 8 is present.
    bits(1, 1); bits(3, 3); bits(254, 8); // Exactly 256 symbols, all with length 8.
  }
  bits(1, 1); bits(0, 1); bits(0, 1); bits(0, 1); // Unused distance tree: symbol zero.
  const reversed = Uint8Array.from({ length: 256 }, (_, value) => {
    let result = 0;
    for (let i = 0; i < 8; i++) result = (result << 1) | ((value >>> i) & 1);
    return result;
  });
  // Canonical Huffman codes are MSB-first, packed into the LSB-first bitstream.
  const channels = [1, 2, 0, 3];
  for (let i = 0; i < pixels.length; i += 4) for (const channel of channels) {
    const value = reversed[pixels[i + channel]], offset = position >> 3, shift = position & 7;
    data[offset] |= value << shift; data[offset + 1] |= value >>> (8 - shift); position += 8;
  }
  const size = 1 + Math.ceil(position / 8), bytes = Buffer.alloc(20 + size + (size & 1));
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WEBPVP8L', 8);
  bytes.writeUInt32LE(size, 16); bytes[20] = 0x2f; data.copy(bytes, 21, 0, size - 1);
  return bytes;
}

/** PDF 1.4 with lossless RGB and a soft alpha mask. Tall captures continue on subsequent pages. */
function encodePdf(image: NativeImage): Buffer {
  const { width, height } = image.getSize(), pixels = straightBitmap(image), objects: Buffer[] = [];
  const add = (value: string | Buffer) => { objects.push(typeof value === 'string' ? Buffer.from(value) : value); return objects.length; };
  const stream = (dictionary: string, bytes: Buffer) => Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`), bytes, Buffer.from('\nendstream')]);
  add('<< /Type /Catalog /Pages 2 0 R >>'); add('');
  const pages: number[] = [], scale = Math.min(1, 14400 / width), pageRows = Math.max(1, Math.floor(14400 / scale));
  for (let top = 0; top < height; top += pageRows) {
    const rows = Math.min(pageRows, height - top), rgb = Buffer.allocUnsafe(width * rows * 3), alpha = Buffer.allocUnsafe(width * rows);
    let transparent = false;
    for (let i = 0; i < width * rows; i++) {
      const source = (top * width + i) * 4;
      rgb[i * 3] = pixels[source + 2]; rgb[i * 3 + 1] = pixels[source + 1]; rgb[i * 3 + 2] = pixels[source];
      alpha[i] = pixels[source + 3]; transparent ||= alpha[i] !== 255;
    }
    const page = add(''), content = add(stream('', Buffer.from(`q ${width * scale} 0 0 ${rows * scale} 0 0 cm /Im0 Do Q`)));
    const mask = transparent ? add(stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${rows} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, deflateSync(alpha))) : 0;
    const picture = add(stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${rows} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${mask ? ` /SMask ${mask} 0 R` : ''}`, deflateSync(rgb)));
    objects[page - 1] = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width * scale} ${rows * scale}] /Resources << /XObject << /Im0 ${picture} 0 R >> >> /Contents ${content} 0 R >>`);
    pages.push(page);
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map(page => `${page} 0 R`).join(' ')}] >>`);
  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')], offsets = [0];
  let length = chunks[0].length;
  objects.forEach((object, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    chunks.push(chunk); length += chunk.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

export function encodeScreenshot(image: NativeImage, settings: ScreenshotSettings, format: ScreenshotOutputFormat = settings.format, scale?: { x: number; y: number }): Buffer {
  if (image.isEmpty()) throw Error('图片内容为空');
  let output = image;
  if (format === 'jpeg' || format === 'bmp') output = flattenBackground(output, settings.background === 'solid' ? settings.backgroundColor : '#ffffff');
  if (settings.resizeTo1x && scale && (scale.x > 1 || scale.y > 1)) {
    const size = output.getSize();
    output = output.resize({ width: Math.max(1, Math.round(size.width / scale.x)), height: Math.max(1, Math.round(size.height / scale.y)), quality: 'best' });
  }
  switch (format) {
    case 'png': return output.toPNG();
    case 'jpeg': return output.toJPEG(settings.jpegQuality);
    case 'webp': return encodeWebp(output);
    case 'bmp': return encodeBmp(output);
    case 'pdf': return encodePdf(output);
  }
}

interface ScreenshotNameMeta { date?: Date; app?: string; width?: number; height?: number; seq?: number }
const defaultNameTemplate = 'Lasso-{YYYY}-{MM}-{DD}-{HH}{mm}{ss}';
export function formatScreenshotName(template: string, format: ScreenshotOutputFormat | RecordingFormat, meta: ScreenshotNameMeta = {}): { subDir: string; fileName: string; ext: string } {
  validateScreenshotFileNameTemplate(template);
  const date = meta.date ?? new Date(), pad = (n: number) => String(n).padStart(2, '0');
  const app = (meta.app ?? 'Lasso').replace(/[\x00-\x1f\x7f/\\:<>"|?*]/g, '_').replace(/\.\./g, '_').trim() || 'Lasso';
  const values: Record<string, string | number> = { YYYY: date.getFullYear(), MM: pad(date.getMonth() + 1), DD: pad(date.getDate()), HH: pad(date.getHours()), mm: pad(date.getMinutes()), ss: pad(date.getSeconds()), app: app === '.' ? '_' : app, width: meta.width ?? 0, height: meta.height ?? 0, seq: meta.seq ?? 1 };
  const parts = template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key])).split('/'), name = parts.pop()!;
  const ext = format === 'jpeg' ? 'jpg' : format;
  return { subDir: parts.join('/'), fileName: `${name}.${ext}`, ext };
}
export function screenshotName(format: ScreenshotOutputFormat): string {
  return formatScreenshotName(defaultNameTemplate, format).fileName;
}
export async function saveAutomaticScreenshot(bytes: Buffer, directory: string, format: ScreenshotOutputFormat | RecordingFormat, template = defaultNameTemplate, meta: Omit<ScreenshotNameMeta, 'seq'> = {}): Promise<string> {
  const metadata = { ...meta, date: meta.date ?? new Date() }, hasSequence = template.includes('{seq}');
  for (let count = 0; ; count++) {
    const { subDir, fileName, ext } = formatScreenshotName(template, format, { ...metadata, seq: count + 1 });
    const target = join(directory, subDir);
    await mkdir(target, { recursive: true });
    const name = count && !hasSequence ? `${fileName.slice(0, -ext.length - 1)}-${count}.${ext}` : fileName;
    const path = join(target, name);
    try { await writeFile(path, bytes, { flag: 'wx' }); return path; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
}
export async function copyFile(filePath: string): Promise<void> {
  await clipboard.write([new ClipboardItem({ 'text/uri-list': pathToFileURL(filePath).href })]);
}
export async function copyPath(filePath: string): Promise<void> {
  await clipboard.writeText(filePath);
}
export async function runAfterSaveAction(filePath: string, action: ScreenshotAfterSaveAction): Promise<void> {
  switch (action) {
    case 'none': return;
    case 'reveal': shell.showItemInFolder(filePath); return;
    case 'copy-path': await copyPath(filePath); return;
    case 'copy-file': await copyFile(filePath); return;
  }
}

/** Recording files share screenshot naming, collision handling and post-save preferences. */
export async function saveRecordingOutput(output: { bytes: Buffer; format: RecordingFormat; width: number; height: number }, action: 'save'|'quick-save'|'copy-file'|'copy-path', settings: ScreenshotSettings, owner?: BrowserWindow): Promise<string|null> {
  let path: string;
  if(action==='save'){
    const name=formatScreenshotName(settings.fileNameTemplate,output.format,output),options={title:'保存录制',defaultPath:join(settings.directory,name.subDir,name.fileName),filters:[{name:output.format.toUpperCase(),extensions:[name.ext]}]};
    const saved=owner?await dialog.showSaveDialog(owner,options):await dialog.showSaveDialog(options);
    if(saved.canceled||!saved.filePath)return null;
    path=saved.filePath;await mkdir(dirname(path),{recursive:true});await writeFile(path,output.bytes);
  }else path=await saveAutomaticScreenshot(output.bytes,settings.quickSaveDirectory,output.format,settings.fileNameTemplate,output);
  if(action==='copy-file')await copyFile(path);else if(action==='copy-path')await copyPath(path);else await runAfterSaveAction(path,settings.afterSaveAction);
  return path;
}
