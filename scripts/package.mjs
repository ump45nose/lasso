import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireSigningIdentity, signApp } from './sign-app.mjs';
import { sourceInfo } from './source-info.mjs';
import { packager } from '@electron/packager';
const unsigned = process.argv.includes('--unsigned');
const releaseBuild = process.argv.includes('--release');
const identity = releaseBuild ? '-' : 'Lasso Local Development';
if (unsigned && releaseBuild) throw new Error('--unsigned 与 --release 不能同时使用。');
if (!unsigned) requireSigningIdentity(identity);
const built = JSON.parse(readFileSync('dist/build-source.json', 'utf8'));
if (built.inputDigest !== sourceInfo().inputDigest || built.arch !== process.arch) {
  throw new Error('构建产物与当前源码不一致，请先运行 npm run build。');
}
await import('./icons.mjs');
const paths = await packager({
  icon: 'assets/lasso.icns',
  dir: '.', out: process.env.LASSO_PACKAGE_OUT || 'release', name: 'Lasso', executableName: 'MacAIPrompt',
  appBundleId: 'local.mac-ai-prompt', appCategoryType: 'public.app-category.productivity',
  platform: 'darwin', arch: process.arch, overwrite: true, asar: false, prune: true,
  download: {
    ...(existsSync(resolve('outputs/.electron-cache')) ? { cacheRoot: resolve('outputs/.electron-cache') } : {}),
    checksums: JSON.parse(readFileSync('node_modules/electron/checksums.json', 'utf8')),
  },
  ignore: [/^\/release(?:\/|$)/, /^\/outputs(?:\/|$)/, /^\/src(?:\/|$)/, /^\/docs(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/\.git(?:\/|$)/, /^\/\.(?:github|claude|worktree)(?:\/|$)/, /\.tsbuildinfo$/],
  extendInfo: {
    LSUIElement: true,
    LSMinimumSystemVersion: '14.2',
    NSScreenCaptureUsageDescription: '选择屏幕区域截图、录屏并录制系统声音。', NSMicrophoneUsageDescription: '录屏时录制麦克风声音，或在 AI 网页中使用语音输入。', NSCameraUsageDescription: '录屏时添加摄像头画中画，或在 AI 网页中添加相机内容。',
    CFBundleDocumentTypes: [{ CFBundleTypeName: 'PNG / JPEG 图片', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.png', 'public.jpeg'] }],
    NSServices: [{ NSMenuItem: { default: '使用 Lasso 生图' }, NSMessage: 'generateImage', NSPortName: 'Lasso', NSSendTypes: ['public.file-url', 'NSFilenamesPboardType'], NSSendFileTypes: ['public.png', 'public.jpeg'], NSRequiredContext: {}, NSTimeout: '10000' }]
  }
});
for (const path of paths) {
  // Packager ties the display name to executableName; keep the stable executable
  // while exposing the chosen name to Finder, Dock and system permissions.
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleDisplayName Lasso', path + '/Lasso.app/Contents/Info.plist']);
  writeFileSync(path + '/Lasso.app/Contents/Resources/lasso-build.json', JSON.stringify(built, null, 2) + '\n');
  if (!unsigned) await signApp(path + '/Lasso.app', identity, resolve('outputs/.packaging'));
  console.log(path);
}
