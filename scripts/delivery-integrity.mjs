import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, relative } from 'node:path';

export function inventory(root) {
  const files = {};
  function walk(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const key = relative(root, path);
      if (key === 'manifest.json') continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) files[key] = 'symlink:' + readlinkSync(path);
      else if (stat.isDirectory()) walk(path);
      else files[key] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  walk(root);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

export const payloadDigest = files => createHash('sha256').update(JSON.stringify(files)).digest('hex');
