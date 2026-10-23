import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A local development identity, created once and reused by every build.
// The private key lives in Keychain; no identity/key material enters the repository.
const identity = 'Lasso Local Development';
const keychain = execFileSync('/usr/bin/security', ['default-keychain', '-d', 'user'], { encoding: 'utf8' }).trim().replace(/^"|"$/g, '');
const found = spawnSync('/usr/bin/security', ['find-certificate', '-c', identity, keychain], { stdio: 'ignore' });
if (found.status === 0) {
  console.log(`${identity} 已存在，继续复用；不会生成替代身份。`);
} else if (found.status !== 44) {
  throw new Error('无法检查登录钥匙串，请解锁后重试。');
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'lasso-signing-'));
  chmodSync(scratch, 0o700);
  try {
    const config = join(scratch, 'certificate.cnf');
    writeFileSync(config, `[req]\nprompt = no\ndistinguished_name = dn\nx509_extensions = signing\n[dn]\nCN = ${identity}\n[signing]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = critical,codeSigning\nsubjectKeyIdentifier = hash\nauthorityKeyIdentifier = keyid:always\n`, { mode: 0o600 });
    const key = join(scratch, 'private.key');
    const cert = join(scratch, 'certificate.pem');
    const pem = join(scratch, 'identity.pem');
    execFileSync('/usr/bin/openssl', ['req', '-new', '-newkey', 'rsa:3072', '-x509', '-sha256', '-days', '3650', '-nodes', '-keyout', key, '-out', cert, '-config', config], { stdio: 'ignore' });
    chmodSync(key, 0o600);
    // PEM sequence avoids PKCS#12 empty-password incompatibilities on macOS.
    // These newly generated key bytes never leave this owner-only temporary directory.
    writeFileSync(pem, Buffer.concat([readFileSync(cert), readFileSync(key)]), { mode: 0o600 });
    execFileSync('/usr/bin/security', ['import', pem, '-k', keychain, '-f', 'pemseq', '-t', 'agg', '-x', '-T', '/usr/bin/codesign'], { stdio: 'inherit' });
    console.log(`${identity} 已导入登录钥匙串，私钥不可导出，仅授权 codesign 使用。`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
