import { clipboard, nativeImage, type NativeImage } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ImagePreview } from '../shared/contracts';
export interface ImageInput extends ImagePreview { path: string }
export class Images {
  private images = new Map<string, ImageInput>();
  constructor(private directory: string) {
    // This directory contains only this application's disposable input copies.
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: true });
  }
  async capture(): Promise<ImageInput> {
    const items = await clipboard.read();
    const item = items.find(item => item.types.includes('image/png'));
    if (!item) throw new Error('剪贴板中没有图片，请先复制一张截图。');
    const blob = await item.getType('image/png');
    const image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
    if (image.isEmpty()) throw new Error('剪贴板中没有图片，请先复制一张截图。');
    return this.add(image);
  }
  add(image: NativeImage): ImageInput {
    if (image.isEmpty()) throw new Error('图片内容为空');
    const id = randomUUID(); const size = image.getSize();
    const path = join(this.directory, id + '.png');
    writeFileSync(path, image.toPNG());
    const preview = image.resize({ width: Math.min(360, size.width) }).toDataURL();
    const input = { id, path, width: size.width, height: size.height, thumbnail: preview };
    this.images.set(id, input); return input;
  }
  get(id: string) { return this.images.get(id); }
  preview(image: ImageInput): ImagePreview { const { path: _, ...preview } = image; return preview; }
  base64(image: ImageInput) { return readFileSync(image.path).toString('base64'); }
  remove(image: ImageInput | null) {
    if (!image) return;
    rmSync(image.path, { force: true }); this.images.delete(image.id);
  }
  dispose() { for (const image of this.images.values()) this.remove(image); }
}
