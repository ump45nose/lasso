import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireSigningIdentity, signApp } from './sign-app.mjs';
import { inventory, payloadDigest } from './delivery-integrity.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let destination = join(homedir(), 'Applications/Lasso.app');
let dryRun = false;
let launch = true;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--dry-run') dryRun = true;
  else if (args[index] === '--no-launch') launch = false;
  else if (args[index] === '--destination' && args[index + 1]) destination = args[++index];
  else throw new Error('Usage: ./install.sh [--dry-run] [--no-launch] [--destination ABS_APP_PATH]');
}
if (!isAbsolute(destination) || !destination.endsWith('.app')) throw new Error('安装路径必须为绝对 .app 路径。');
destination = resolve(destination);
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (manifest.project !== 'lasso' || manifest.artifact !== 'Lasso.app') throw new Error('不是 Lasso 交付目录。');
const files = inventory(root);
if (JSON.stringify(files) !== JSON.stringify(manifest.files) || payloadDigest(files) !== manifest.payloadSHA256) throw new Error('交付文件校验失败。');
const source = join(root, manifest.artifact);
if (!existsSync(join(source, 'Contents/MacOS/MacAIPrompt'))) throw new Error('交付目录缺少应用主程序。');
if (source === destination) throw new Error('交付目录不能同时作为安装目录。');
if (existsSync(destination) && lstatSync(destination).isSymbolicLink()) throw new Error('安装目标为符号链接，请显式传入真实应用路径。');
const hostArch = execFileSync('/usr/bin/uname', ['-m'], { encoding: 'utf8' }).trim();
const supportedArch = { arm64: 'arm64', x64: 'x86_64' }[manifest.arch];
if (hostArch !== supportedArch) throw new Error('产物架构与当前 Mac 不一致。');
const osVersion = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim().split('.').map(Number);
const minimum = manifest.minimumSystemVersion.split('.').map(Number);
let supportedOS = true;
for (let index = 0; index < Math.max(osVersion.length, minimum.length); index++) {
  if ((osVersion[index] || 0) !== (minimum[index] || 0)) {
    supportedOS = (osVersion[index] || 0) > (minimum[index] || 0);
    break;
  }
}
if (!supportedOS) throw new Error('此产物要求 macOS ' + manifest.minimumSystemVersion + ' 或更高版本。');
const identity = 'Lasso Local Development';
// Read-only preflight also runs in dry-run; signing and writes remain below it.
requireSigningIdentity(identity);
if (dryRun) {
  console.log(JSON.stringify({ action: 'install', dryRun: true, destination, identity, launch, sourceCommit: manifest.sourceCommit, version: manifest.version }));
  process.exit(0);
}
mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
try { chmodSync(dirname(destination), 0o755); } catch {}
const scratch = mkdtempSync(join(dirname(destination), '.lasso-install-'));
const staged = join(scratch, 'Lasso.app');
try {
  execFileSync('/usr/bin/ditto', [source, staged], { stdio: 'inherit' });
  await signApp(staged, identity, scratch);
  // Electron's menu-bar process may ignore SIGTERM. Send its ordinary Quit event
  // so recording shutdown and the app's before-quit cleanup can finish first.
  const executable = join(destination, 'Contents/MacOS/MacAIPrompt');
  const running = execFileSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n')
    .some(line => line.trim() === executable || line.trim().startsWith(executable + ' '));
  if (running) {
    try {
      execFileSync('/usr/bin/osascript', ['-e', 'on run argv\n tell application (item 1 of argv) to quit\nend run', destination], { stdio: 'inherit', timeout: 20000 });
    } catch (error) {
      if (error.code !== 'ETIMEDOUT') throw error;
      console.log('Normal Quit request timed out; continuing with the approved force-exit policy.');
    }
  }
  const installerArgs = [join(root, 'support/app-install.py'), staged, destination, '--force-exit'];
  if (!launch) installerArgs.push('--no-launch');
  execFileSync('/usr/bin/python3', installerArgs, { stdio: 'inherit' });
  try {
    execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', destination], { stdio: 'ignore' });
    execFileSync('/usr/bin/mdimport', [destination], { stdio: 'ignore' });
  } catch {}
} finally { rmSync(scratch, { recursive: true, force: true }); }
