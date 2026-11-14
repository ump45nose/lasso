import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync, chmodSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { sourceInfo } from './source-info.mjs';
import { inventory, payloadDigest } from './delivery-integrity.mjs';

const repository = process.cwd();
const args = process.argv.slice(2);
const action = args.shift();
let output;
let app;
let dryRun = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--dry-run') dryRun = true;
  else if (args[index] === '--output' && args[index + 1]) output = args[++index];
  else if (args[index] === '--app' && args[index + 1]) app = args[++index];
  else throw new Error('Usage: scripts/delivery.sh build --output ABS_DIR [--dry-run] | stage --app ABS_APP --output ABS_DIR [--dry-run]');
}
if (!['build', 'stage'].includes(action) || !output || !isAbsolute(output)) throw new Error('必须指定 build/stage 和 --output 绝对目录。');
output = resolve(output);
if (action === 'stage' && (!app || !isAbsolute(app))) throw new Error('stage 需要 --app 绝对路径。');
if (action === 'build' && app) throw new Error('build 不接受 --app。');
if (existsSync(output) && readdirSync(output).length) throw new Error('交付目录非空，拒绝覆盖：' + output);
if (dryRun) {
  console.log(JSON.stringify({ action, dryRun: true, output, app: app || null, project: 'lasso', source: sourceInfo(), install: 'install.sh', signing: 'on target with Lasso Local Development' }));
  process.exit(0);
}

function ensureDependencies() {
  const receipt = join(repository, 'outputs/.delivery-dependencies.json');
  const digest = createHash('sha256').update(readFileSync('package-lock.json')).update(process.version).update(process.arch).digest('hex');
  const required = ['node_modules/@electron/osx-sign/package.json', 'node_modules/@electron/packager/package.json', 'node_modules/.bin/vite', 'node_modules/.bin/esbuild', 'node_modules/electron/checksums.json'];
  let current;
  try { current = JSON.parse(readFileSync(receipt, 'utf8')).digest; } catch { /* Fresh worktree. */ }
  if (action === 'stage') {
    if (!existsSync('node_modules/@electron/osx-sign/package.json')) throw new Error('stage 需要现有的签名依赖。');
    return;
  }
  if (current === digest && required.every(path => existsSync(path))) return;
  execFileSync('npm', ['ci', '--prefer-offline'], { stdio: 'inherit', env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '' } });
  if (!required.every(path => existsSync(path))) throw new Error('依赖安装完成但缺少构建工具或 Electron。');
  mkdirSync(dirname(receipt), { recursive: true });
  writeFileSync(receipt, JSON.stringify({ digest }) + '\n');
}

function copySigningDependencies(support) {
  // Preserve each package's physical npm layout and resources, including entitlements.
  // Only production dependencies reachable from osx-sign are copied.
  const modulesRoot = realpathSync(join(repository, 'node_modules'));
  const copied = new Set();
  function packageRoot(name, from) {
    const require = createRequire(join(from, 'package.json'));
    let path;
    try { path = require.resolve(name + '/package.json'); }
    catch { path = require.resolve(name); }
    let directory = dirname(realpathSync(path));
    while (directory !== dirname(directory)) {
      const metadata = join(directory, 'package.json');
      if (existsSync(metadata) && JSON.parse(readFileSync(metadata, 'utf8')).name === name) return directory;
      directory = dirname(directory);
    }
    throw new Error('找不到签名依赖包：' + name);
  }
  function copyPackage(name, from, optional = false) {
    let source;
    try { source = packageRoot(name, from); }
    catch (error) { if (optional && error.code === 'MODULE_NOT_FOUND') return; throw error; }
    if (copied.has(source)) return;
    const location = relative(modulesRoot, source);
    if (location.startsWith('..') || isAbsolute(location)) throw new Error('签名依赖位于 npm 目录之外：' + source);
    copied.add(source);
    const destination = join(support, 'node_modules', location);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: true, filter: path => path === source || basename(path) !== 'node_modules' });
    const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(metadata.dependencies || {})) copyPackage(dependency, source, Boolean(metadata.optionalDependencies?.[dependency]));
    for (const dependency of Object.keys(metadata.optionalDependencies || {})) copyPackage(dependency, source, true);
    for (const dependency of Object.keys(metadata.peerDependencies || {})) copyPackage(dependency, source, Boolean(metadata.peerDependenciesMeta?.[dependency]?.optional));
  }
  copyPackage('@electron/osx-sign', repository);
}

ensureDependencies();
if (action === 'build') {
  const before = sourceInfo();
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  if (sourceInfo().inputDigest !== before.inputDigest) throw new Error('构建期间源码发生变化，请重新提交构建任务。');
  const packageOut = join(repository, 'outputs/.delivery-package');
  execFileSync('npm', ['run', 'package:built', '--', '--unsigned'], { stdio: 'inherit', env: { ...process.env, LASSO_PACKAGE_OUT: packageOut } });
  app = join(packageOut, 'Lasso-darwin-' + process.arch, 'Lasso.app');
}
app = resolve(app);
const provenancePath = join(app, 'Contents/Resources/lasso-build.json');
if (!existsSync(provenancePath)) throw new Error('应用缺少构建来源记录；请先通过更新后的 build/package 入口生成产物。');
const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
const plist = key => execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
if (plist('CFBundleIdentifier') !== 'local.mac-ai-prompt') throw new Error('不是 Lasso 应用。');
const manifest = {
  project: 'lasso', artifact: 'Lasso.app', version: plist('CFBundleShortVersionString'),
  sourceCommit: provenance.sourceCommit, sourceDirty: provenance.sourceDirty, inputDigest: provenance.inputDigest,
  arch: provenance.arch, minimumSystemVersion: plist('LSMinimumSystemVersion'),
};
mkdirSync(dirname(output), { recursive: true });
const scratch = mkdtempSync(join(dirname(output), '.lasso-delivery-'));
try {
  execFileSync('/usr/bin/ditto', [app, join(scratch, 'Lasso.app')], { stdio: 'inherit' });
  const support = join(scratch, 'support');
  mkdirSync(support);
  cpSync('scripts/sign-app.mjs', join(support, 'sign-app.mjs'));
  cpSync('scripts/app-install.py', join(support, 'app-install.py'));
  cpSync('scripts/delivery-integrity.mjs', join(support, 'delivery-integrity.mjs'));
  cpSync('scripts/install-delivery.mjs', join(support, 'install.mjs'));
  cpSync('scripts/install-delivery.sh', join(scratch, 'install.sh'));
  chmodSync(join(scratch, 'install.sh'), 0o755);
  copySigningDependencies(support);
  manifest.files = inventory(scratch);
  manifest.payloadSHA256 = payloadDigest(manifest.files);
  writeFileSync(join(scratch, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  if (existsSync(output)) rmdirSync(output);
  renameSync(scratch, output);
  console.log(JSON.stringify({ action, status: 'ready', output, manifest }));
} finally { rmSync(scratch, { recursive: true, force: true }); }
