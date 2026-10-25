import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Official Node, Homebrew and version-manager installs keep headers under their
// installation prefix. A custom headers directory can be selected explicitly.
const candidates = process.env.NODE_INCLUDE_DIR
  ? [process.env.NODE_INCLUDE_DIR]
  : [join(dirname(dirname(realpathSync(process.execPath))), 'include/node'), '/opt/homebrew/include/node', '/usr/local/include/node'];
const headers = candidates.find(path => existsSync(join(path, 'node_api.h')));
if (!headers) throw new Error('未找到 node_api.h。请安装 Node 开发头文件，或通过 NODE_INCLUDE_DIR 指定包含该文件的目录。');
mkdirSync('dist/native', { recursive: true });
execFileSync('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-O2', '-shared', '-undefined', 'dynamic_lookup', '-I' + headers, '-framework', 'Cocoa', '-framework', 'ApplicationServices', 'native/capture-ax.mm', '-o', 'dist/native/capture-ax.node'], { stdio: 'inherit' });
execFileSync('/usr/bin/xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-O2', '-shared', '-undefined', 'dynamic_lookup', '-I' + headers, '-framework', 'Cocoa', '-framework', 'Vision', '-framework', 'ImageIO', '-framework', 'CoreImage', 'native/capture-vision.mm', '-o', 'dist/native/capture-vision.node'], { stdio: 'inherit' });
