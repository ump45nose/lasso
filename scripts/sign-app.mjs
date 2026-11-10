import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// osx-sign treats binary resources (including WOFF fonts) as signing targets.
// Resource integrity is sealed by the enclosing bundle; only Mach-O files need
// their own code signature. Keep app/framework containers in the normal walk.
function resourceOnly(file) {
  if (!lstatSync(file).isFile()) return false;
  const fd = openSync(file, 'r');
  const magic = Buffer.alloc(4);
  try {
    if (readSync(fd, magic, 0, 4, 0) < 4) return true;
    return !['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic.toString('hex'));
  } finally { closeSync(fd); }
}

export function requireSigningIdentity(identity) {
  if (identity === '-') return;
  try { execFileSync('/usr/bin/security', ['find-certificate', '-c', identity], { stdio: 'ignore' }); }
  catch { throw new Error('缺少本机固定签名身份 ' + identity + '，请先运行 npm run signing:setup。'); }
}

export async function signApp(app, identity = 'Lasso Local Development', scratchRoot = dirname(app)) {
  requireSigningIdentity(identity);
  const { sign } = await import('@electron/osx-sign');
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, '.lasso-sign-'));
  const entitlements = join(scratch, 'entitlements.plist');
  writeFileSync(entitlements, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>');
  try {
    await sign({
      app, identity, identityValidation: false, platform: 'darwin', type: 'development',
      ignore: resourceOnly,
      preAutoEntitlements: false, preEmbedProvisioningProfile: false,
      optionsForFile: () => ({ hardenedRuntime: false, entitlements, timestamp: 'none' }),
    });
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
