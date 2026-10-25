import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root: resolve(root, 'src/renderer'),
  base: './',
  // Fonts stay files: CSP font-src allows 'self', not data: URLs.
  build: { outDir: resolve(root, 'dist/renderer'), emptyOutDir: true, assetsInlineLimit: file => file.endsWith('.woff2') || file.endsWith('.woff') ? false : undefined }
});
