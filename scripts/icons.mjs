import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// macOS icon family, regenerated from the committed full-resolution artwork (scripts/brand.mjs renders it from assets/lasso-icon.svg).
const scratch = mkdtempSync(join(tmpdir(), 'lasso-icons-'));
const iconset = join(scratch, 'lasso.iconset');
mkdirSync(iconset);
try {
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      execFileSync('/usr/bin/sips', ['-z', pixels, pixels, 'assets/lasso-icon.png', '--out', join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', resolve('assets/lasso.icns')]);
} finally {
  rmSync(scratch, { recursive: true });
}
