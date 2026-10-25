// Static checks for the Lasso design rules in docs/design/ui-rules.md. Runs as part of `npm run build`.
// A line may opt out with a `ui-check-ignore: <reason>` comment; the reason is required.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const walk = dir => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
const files = walk(join(root, 'src'));
const tokensPath = join(root, 'src/renderer/styles/tokens.css');
const tokens = readFileSync(tokensPath, 'utf8');

// Every rgba() must be a token's base colour at some alpha; pure white and black are allowed for highlights and shadows.
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',');
const bases = new Set(['255,255,255', '0,0,0']);
for (const [, hex] of tokens.matchAll(/:\s*(#[0-9A-Fa-f]{6})\b/g)) bases.add(rgb(hex));
for (const [, r, g, b] of tokens.matchAll(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/g)) bases.add([r, g, b].join(','));

const problems = [];
const report = (file, line, message) => problems.push(`${relative(root, file)}:${line}  ${message}`);

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const css = file.endsWith('.css'), tsx = file.endsWith('.tsx'), main = file.includes('/src/main/');
  lines.forEach((line, index) => {
    if (/ui-check-ignore:\s*\S/.test(line)) return;
    const at = index + 1;
    if (css && file !== tokensPath) {
      for (const [hex] of line.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)) if (!/^#F{3}(F{3})?$/i.test(hex)) report(file, at, `raw colour ${hex}: add or use a token in tokens.css`);
      for (const [, r, g, b] of line.matchAll(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/g)) if (!bases.has([r, g, b].join(','))) report(file, at, `rgba(${r}, ${g}, ${b}) is not a token colour`);
      if (/font-family:(?!\s*(var\(--font-|inherit))/.test(line)) report(file, at, 'font-family must be var(--font-*)');
      if (/!important/.test(line)) report(file, at, '!important: raise the selector instead');
    }
    if (tsx) {
      for (const [hex] of line.matchAll(/['"]#[0-9A-Fa-f]{3,8}['"]/g)) report(file, at, `colour ${hex} in TSX: use a CSS class and tokens`);
      if (/(?<![.\w])(?:window\.)?(?:confirm|alert|prompt)\(/.test(line)) report(file, at, 'native dialog: use an inline confirm or a toast');
      if (/<svg\b/.test(line) && !file.endsWith('BrandMark.tsx')) report(file, at, 'inline <svg>: use lucide-react icons or BrandMark');
    }
    if (main && /\.popup\(/.test(line)) report(file, at, 'native popup menu: draw the menu in the window (see ActionBar ··· menu)');
  });
}

if (problems.length) {
  console.error(`UI rule check failed (${problems.length}). See docs/design/ui-rules.md.\n` + problems.join('\n'));
  process.exit(1);
}
console.log('UI rule check passed.');
