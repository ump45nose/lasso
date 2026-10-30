import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sign } from '@electron/osx-sign';
import { packager } from '@electron/packager';
import './icons.mjs';
const releaseBuild = process.argv.includes('--release');
const identity = releaseBuild ? '-' : 'Lasso Local Development';
// Fail closed: never silently replace the stable identity with ad-hoc signing.
try { if (!releaseBuild) execFileSync('/usr/bin/security', ['find-certificate', '-c', identity], { stdio: 'ignore' }); }
catch { throw new Error('请先运行 npm run signing:setup 创建本机固定开发签名。'); }
const paths = await packager({
  icon: 'assets/lasso.icns',
  dir: '.', out: process.env.LASSO_PACKAGE_OUT || 'release', name: 'Lasso', executableName: 'MacAIPrompt',
  appBundleId: 'local.mac-ai-prompt', appCategoryType: 'public.app-category.productivity',
  platform: 'darwin', arch: process.arch, overwrite: true, asar: false, prune: true,
  ignore: [/^\/release(?:\/|$)/, /^\/outputs(?:\/|$)/, /^\/src(?:\/|$)/, /^\/docs(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/\.git(?:\/|$)/, /^\/\.(?:github|claude|worktree)(?:\/|$)/, /\.tsbuildinfo$/],
  extendInfo: {
    LSUIElement: true,
    LSMinimumSystemVersion: '14.2',
    NSScreenCaptureUsageDescription: '选择屏幕区域并截图。', NSMicrophoneUsageDescription: '在 AI 网页中使用语音输入。', NSCameraUsageDescription: '在 AI 网页中添加相机内容。',
    CFBundleDocumentTypes: [{ CFBundleTypeName: 'PNG / JPEG 图片', CFBundleTypeRole: 'Viewer', LSHandlerRank: 'Alternate', LSItemContentTypes: ['public.png', 'public.jpeg'] }],
    NSServices: [{ NSMenuItem: { default: '使用 Lasso 生图' }, NSMessage: 'generateImage', NSPortName: 'Lasso', NSSendTypes: ['public.file-url', 'NSFilenamesPboardType'], NSSendFileTypes: ['public.png', 'public.jpeg'], NSRequiredContext: {}, NSTimeout: '10000' }]
  }
});
for (const path of paths) {
  // Packager ties the display name to executableName; keep the stable executable
  // while exposing the chosen name to Finder, Dock and system permissions.
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleDisplayName Lasso', path + '/Lasso.app/Contents/Info.plist']);
  mkdirSync('outputs/.packaging', {recursive:true});
  const scratch = mkdtempSync(join(resolve('outputs/.packaging'), 'lasso-sign-'));
  const entitlements = join(scratch, 'entitlements.plist');
  writeFileSync(entitlements, '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict/></plist>');
  try { await sign({
    app: path + '/Lasso.app', identity, identityValidation: false,
    platform: 'darwin', type: 'development',
    preAutoEntitlements: false, preEmbedProvisioningProfile: false,
    optionsForFile: () => ({ hardenedRuntime: false, entitlements, timestamp: 'none' })
  }); } finally { rmSync(scratch, { recursive: true, force: true }); }
  console.log(path);
}
