import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign } from '@electron/osx-sign';
import { packager } from '@electron/packager';
import './icons.mjs';
const identity = 'Lasso Local Development';
// Fail closed: never silently replace the stable identity with ad-hoc signing.
try { execFileSync('/usr/bin/security', ['find-certificate', '-c', identity], { stdio: 'ignore' }); }
catch { throw new Error('请先运行 npm run signing:setup 创建本机固定开发签名。'); }
const paths = await packager({
  icon: 'assets/lasso.icns',
  dir: '.', out: 'release', name: 'Lasso', executableName: 'MacAIPrompt',
  appBundleId: 'local.mac-ai-prompt', appCategoryType: 'public.app-category.productivity',
  platform: 'darwin', arch: process.arch, overwrite: true, asar: false, prune: true,
  ignore: [/^\/release(?:\/|$)/, /^\/src(?:\/|$)/, /^\/docs(?:\/|$)/, /^\/scripts(?:\/|$)/, /^\/\.git(?:\/|$)/, /\.tsbuildinfo$/],
  extendInfo: { NSScreenCaptureUsageDescription: '选择屏幕区域并截图。', NSMicrophoneUsageDescription: '在 AI 网页中使用语音输入。', NSCameraUsageDescription: '在 AI 网页中添加相机内容。' }
});
for (const path of paths) {
  // Packager ties the display name to executableName; keep the stable executable
  // while exposing the chosen name to Finder, Dock and system permissions.
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleDisplayName Lasso', path + '/Lasso.app/Contents/Info.plist']);
  const scratch = mkdtempSync(join(tmpdir(), 'lasso-sign-'));
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
