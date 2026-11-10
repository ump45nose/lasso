import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const fileDigest = path => digest(readFileSync(path));
const deploymentTarget = '14.2';
process.env.MACOSX_DEPLOYMENT_TARGET = deploymentTarget;
const candidates = process.env.NODE_INCLUDE_DIR
  ? [process.env.NODE_INCLUDE_DIR]
  : [join(dirname(dirname(realpathSync(process.execPath))), 'include/node'), '/opt/homebrew/include/node', '/usr/local/include/node'];
const headers = candidates.find(path => existsSync(join(path, 'node_api.h')));
if (!headers) throw new Error('未找到 node_api.h。请通过 NODE_INCLUDE_DIR 指定 Node 开发头文件目录。');

function headerInputs(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return headerInputs(path);
    return /\.(h|hpp|hxx|inc)$/.test(entry.name) ? [[path, fileDigest(path)]] : [];
  });
}
const command = args => execFileSync('/usr/bin/xcrun', args, { encoding: 'utf8' }).trim();
const sdk = process.env.SDKROOT || command(['--show-sdk-path']);
const toolchain = {
  compiler: command(['clang++', '--version']), sdk, sdkVersion: command(['--show-sdk-version']),
  developerDir: process.env.DEVELOPER_DIR || '', arch: process.arch, node: process.version,
  environment: Object.fromEntries(['CPATH', 'CPLUS_INCLUDE_PATH', 'C_INCLUDE_PATH', 'LIBRARY_PATH', 'CCC_OVERRIDE_OPTIONS'].map(key => [key, process.env[key] || ''])),
  headers: headerInputs(resolve(headers)), localHeaders: headerInputs('native'),
  script: fileDigest(new URL(import.meta.url)),
};
const arch = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
if (!arch) throw new Error('不支持的原生模块架构：' + process.arch);
const common = ['clang++', '-std=c++17', '-fobjc-arc', '-O2', '-arch', arch, '-isysroot', sdk,
  '-mmacosx-version-min=' + deploymentTarget, '-shared', '-undefined', 'dynamic_lookup', '-I' + headers];
const modules = {
  'app-icons': ['Cocoa'],
  'file-services': ['Cocoa'],
  'capture-ax': ['Cocoa', 'ApplicationServices', 'QuartzCore'],
  'capture-vision': ['Cocoa', 'Vision', 'ImageIO', 'CoreImage'],
  'capture-native': ['Cocoa', 'ScreenCaptureKit', 'QuartzCore', 'CoreText', 'CoreImage', 'CoreMedia', 'CoreVideo'],
  'recording-media': ['Cocoa', 'ScreenCaptureKit', 'AVFoundation', 'CoreMedia', 'CoreVideo', 'AudioToolbox'],
};
const cacheRoot = resolve('outputs/.native-cache');
mkdirSync(cacheRoot, { recursive: true });
mkdirSync('dist/native', { recursive: true });
// Theme resources depend on CSS/icons and must refresh even when every binary is cached.
await import('./build-capture-theme.mjs');
let compiled = 0;
for (const [name, frameworks] of Object.entries(modules)) {
  const source = 'native/' + name + '.mm';
  const args = [...common, ...frameworks.flatMap(framework => ['-framework', framework]), source];
  const fingerprint = digest(JSON.stringify({ toolchain, args, source: fileDigest(source) }));
  const cached = join(cacheRoot, name + '.node');
  const receiptPath = join(cacheRoot, name + '.json');
  let receipt;
  try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); } catch { /* A missing/old receipt is a cache miss. */ }
  if (receipt?.fingerprint !== fingerprint || !existsSync(cached) || fileDigest(cached) !== receipt.outputDigest) {
    const scratch = mkdtempSync(join(cacheRoot, '.compile-'));
    try {
      const output = join(scratch, name + '.node');
      execFileSync('/usr/bin/xcrun', [...args, '-o', output], { stdio: 'inherit' });
      receipt = { fingerprint, outputDigest: fileDigest(output) };
      writeFileSync(join(scratch, 'receipt.json'), JSON.stringify(receipt) + '\n');
      renameSync(output, cached);
      renameSync(join(scratch, 'receipt.json'), receiptPath);
      compiled++;
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  const output = 'dist/native/' + name + '.node';
  if (!existsSync(output) || fileDigest(output) !== receipt.outputDigest) copyFileSync(cached, output);
}
console.log('Native modules: ' + compiled + ' compiled, ' + (Object.keys(modules).length - compiled) + ' cached.');
