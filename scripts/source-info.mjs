import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function sourceInfo() {
  const git = args => execFileSync('git', args, { encoding: 'utf8' });
  // The icns file is generated from lasso-icon.png by scripts/icons.mjs at packaging time.
  const files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(file => file && file !== 'assets/lasso.icns');
  const hash = createHash('sha256');
  for (const file of [...new Set(files)].sort()) {
    hash.update(file + '\0');
    try {
      const stat = lstatSync(file);
      hash.update(String(stat.mode & 0o777) + '\0');
      hash.update(stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('<deleted>');
    }
    hash.update('\0');
  }
  return {
    sourceCommit: git(['rev-parse', 'HEAD']).trim(),
    sourceDirty: Boolean(git(['status', '--porcelain', '--untracked-files=normal']).trim()),
    inputDigest: hash.digest('hex'), arch: process.arch,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--record') throw new Error('Usage: node scripts/source-info.mjs --record');
  mkdirSync('dist', { recursive: true });
  writeFileSync('dist/build-source.json', JSON.stringify(sourceInfo(), null, 2) + '\n');
}
