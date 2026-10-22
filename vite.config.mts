import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root: resolve(root, 'src/renderer'),
  base: './',
  build: { outDir: resolve(root, 'dist/renderer'), emptyOutDir: true }
});
