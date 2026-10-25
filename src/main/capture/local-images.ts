import { nativeImage } from 'electron';
import type { NativeImage } from 'electron';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { open, realpath, stat, writeFile } from 'node:fs/promises';

/** Identity of the file actually read, retained even if the source is moved later. */
export interface LocalImageSource {
  realpath: string;
  dev: number;
  ino: number;
}

/** Read a PNG/JPEG without changing the source or allocating an editor session. */
export async function readLocalImage(path: string): Promise<{ image: NativeImage; source: LocalImageSource }> {
  const resolved = await realpath(path);
  if (!['.png', '.jpg', '.jpeg'].includes(extname(resolved).toLowerCase())) throw Error('请选择不超过 64 MB 的 PNG 或 JPEG 图片');
  const file = await open(resolved, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw Error('请选择不超过 64 MB 的 PNG 或 JPEG 图片');
    const bytes = await file.readFile();
    if (bytes.byteLength > 64 * 1024 * 1024) throw Error('图片文件过大，请选择不超过 64 MB 的图片');
    if (!(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255))) throw Error('文件不是有效的 PNG 或 JPEG 图片');
    const image = nativeImage.createFromBuffer(bytes), size = image.getSize();
    if (image.isEmpty() || size.width * size.height > 40_000_000) throw Error('图片为空或尺寸过大');
    return { image, source: { realpath: resolved, dev: info.dev, ino: info.ino } };
  } finally { await file.close(); }
}

export function defaultLocalImageCopyPath(source: LocalImageSource, format: 'png' | 'jpeg'): string {
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  return join(dirname(source.realpath), basename(source.realpath, extname(source.realpath)) + '-副本.' + ext);
}

/** Save only to a new file. The original identity protects moved files and aliases;
 * exclusive creation also rejects existing files and dangling symlinks without overwriting. */
export async function saveLocalImageCopy(source: LocalImageSource, destination: string, bytes: Uint8Array): Promise<void> {
  if (!destination) throw Error('请为副本选择新文件');
  const target = resolve(destination);
  const existing = await stat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (target === source.realpath || (existing && existing.dev === source.dev && existing.ino === source.ino)) throw Error('请为副本选择新文件，不能覆盖原图片');
  try { await writeFile(target, bytes, { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw Error('该文件已存在，请为副本选择新文件名'); throw error; }
}
