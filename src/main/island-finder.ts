import { app, clipboard, ipcMain, nativeImage, screen } from 'electron';
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent, NativeImage } from 'electron';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, lstatSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { FinderActionReq, FinderMoveTarget, FinderPanelState, IslandState } from '../shared/contracts';
import { encodeWebp } from './capture/output';
import { visionOCR } from './capture/ocr';
import { createIslandWindow } from './island-window';

const FINDER_W = 384, FINDER_H = 430;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.heic', '.bmp', '.gif', '.tiff']);
const FILE_TEMPLATES: Record<'md' | 'txt' | 'py' | 'json' | 'sh', string> = {
  md: '# 新建笔记\n\n', txt: '', py: '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n\n',
  json: '{\n  \n}\n', sh: '#!/usr/bin/env zsh\nset -euo pipefail\n\n'
};
type FileTemplate = keyof typeof FILE_TEMPLATES;
let ocrToken = 2147483647;

function defaultFinderFolder(): string {
  return app.getPath('desktop');
}

function uniqueDestPath(dir: string, fileName: string): string {
  const ext = extname(fileName), stem = fileName.slice(0, fileName.length - ext.length);
  for (let index = 0; ; index++) {
    const path = join(dir, index ? `${stem}-${index}${ext}` : fileName);
    try { lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path;
      throw error;
    }
  }
}

function movePath(source: string, targetDir: string) {
  if (resolve(dirname(source)) === resolve(targetDir)) return;
  const dest = uniqueDestPath(targetDir, basename(source));
  try { renameSync(source, dest); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    cpSync(source, dest, { recursive: true, dereference: false, force: false, errorOnExist: true });
    rmSync(source, { recursive: true, force: true });
  }
}

async function queryFinderContext(): Promise<{ folder: string; selection: string[] }> {
  const fallback = { folder: defaultFinderFolder(), selection: [] };
  if (process.env.LASSO_DATA_ROOT) return fallback;
  try {
    const script = `
      tell application "Finder"
        set folderPath to ""
        if (count of Finder windows) > 0 then
          set folderPath to POSIX path of (target of front Finder window as alias)
        else
          set folderPath to POSIX path of (desktop as alias)
        end if
        set selPaths to {}
        set selList to selection as alias list
        repeat with itemRef in selList
          set end of selPaths to POSIX path of itemRef
        end repeat
        set AppleScript's text item delimiters to "\\n"
        return folderPath & "\\n" & (selPaths as string)
      end tell
    `;
    const out = await new Promise<string>((resolve, reject) => {
      execFile('osascript', ['-e', script], { encoding: 'utf8', timeout: 900 }, (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
    });
    const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
    return { folder: lines[0] || fallback.folder, selection: lines.slice(1) };
  } catch {
    return fallback;
  }
}

export interface FinderPanelDeps {
  check: (event: IpcMainEvent | IpcMainInvokeEvent) => void;
  toast: (text: string, badge?: string) => void;
  pinImage: (image: NativeImage, title?: string) => Promise<void>;
  pinText: (text: string, title?: string) => Promise<void>;
}

export class FinderPanel {
  readonly window: BrowserWindow;
  private state: FinderPanelState;
  private cutPaths: string[] = [];
  private summonSeq = 0;

  constructor(fonts: IslandState['fonts'], private deps: FinderPanelDeps) {
    this.state = {
      folder: defaultFinderFolder(), selection: [], hasImageSelection: false,
      cutPaths: [], moveTargets: [], fonts
    };
    this.state.moveTargets = this.scanMoveTargets();
    this.window = createIslandWindow(FINDER_W, FINDER_H, { focusable: true });
    this.window.setAlwaysOnTop(true, 'pop-up-menu');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.on('blur', () => {
      if (!this.window.isDestroyed()) this.window.hide();
    });

    const { check } = deps;
    ipcMain.handle('finder:state', event => {
      check(event);
      return this.state;
    });
    ipcMain.on('finder:close', event => {
      check(event);
      if (!this.window.isDestroyed()) this.window.hide();
    });
    ipcMain.handle('island:finder-action', async (event, req: FinderActionReq) => {
      check(event);
      await this.runAction(req);
      return this.state;
    });
    void this.window.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'finder-panel' } });
  }

  private scanMoveTargets(): FinderMoveTarget[] {
    const home = homedir();
    const targets: FinderMoveTarget[] = [
      { id: 'downloads', label: '下载', path: join(home, 'Downloads'), kind: 'common' },
      { id: 'desktop', label: '桌面', path: join(home, 'Desktop'), kind: 'common' },
      { id: 'notes', label: 'LassoNotes', path: join(home, 'Documents/LassoNotes'), kind: 'common' }
    ];
    for (const category of ['Personal', 'ThirdParty', 'Work']) {
      const root = join(home, 'Developer/Repos', category);
      if (!existsSync(root)) continue;
      for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const path = join(root, entry.name);
        if (entry.name.endsWith('.worktrees')) {
          for (const worktree of readdirSync(path, { withFileTypes: true })) {
            if (!worktree.isDirectory() || worktree.name.startsWith('.')) continue;
            const worktreePath = join(path, worktree.name);
            targets.push({ id: worktreePath, label: `${entry.name.slice(0, -10)} / ${worktree.name}`, path: worktreePath, kind: 'worktree' });
          }
        } else targets.push({ id: path, label: `${category} / ${entry.name}`, path, kind: 'repo' });
      }
    }
    return targets;
  }

  async summon() {
    const seq = ++this.summonSeq;
    const ctx = await queryFinderContext();
    if (seq !== this.summonSeq || this.window.isDestroyed()) return;
    this.state = {
      ...this.state, ...ctx,
      hasImageSelection: ctx.selection.some(path => IMAGE_EXTENSIONS.has(extname(path).toLowerCase())),
      cutPaths: [...this.cutPaths], moveTargets: this.scanMoveTargets()
    };
    const cursor = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const x = Math.min(Math.max(area.x + 12, cursor.x - Math.round(FINDER_W / 2)), area.x + area.width - FINDER_W - 12);
    const y = Math.min(Math.max(area.y + 12, cursor.y - 24), area.y + area.height - FINDER_H - 12);
    this.window.setBounds({ x, y, width: FINDER_W, height: FINDER_H });
    this.publish();
    this.window.show();
    this.window.focus();
  }

  updateFonts(fonts: IslandState['fonts']) {
    this.state = { ...this.state, fonts };
    this.publish();
  }

  destroy() {
    if (!this.window.isDestroyed()) this.window.destroy();
  }

  private publish() {
    this.state.cutPaths = [...this.cutPaths];
    if (!this.window.isDestroyed()) this.window.webContents.send('finder:changed', this.state);
  }

  private imagePaths(): string[] {
    return this.state.selection.filter(path => IMAGE_EXTENSIONS.has(extname(path).toLowerCase()));
  }

  private loadImage(path: string): NativeImage {
    const image = nativeImage.createFromPath(path);
    if (image.isEmpty()) throw new Error(`无法读取图片：${basename(path)}`);
    return image;
  }

  private async openApp(app: string, path: string) {
    await new Promise<void>((resolve, reject) => {
      execFile('open', ['-a', app, path], error => error ? reject(error) : resolve());
    });
  }

  private async runAction(action: FinderActionReq) {
    if (!this.window.isDestroyed()) this.window.hide();
    try {
      const targets = this.state.selection.length ? this.state.selection : [this.state.folder];
      switch (action.kind) {
        case 'new-file': {
          if (!action.name || basename(action.name) !== action.name || action.name === '.' || action.name === '..') throw new Error('文件名无效');
          const path = uniqueDestPath(this.state.folder, action.name), ext = extname(path).slice(1);
          writeFileSync(path, action.content ?? FILE_TEMPLATES[ext as FileTemplate] ?? '', { encoding: 'utf8', flag: 'wx', mode: ext === 'sh' || ext === 'py' ? 0o755 : 0o644 });
          this.deps.toast(`已创建 ${basename(path)}`, `.${ext}`);
          break;
        }
        case 'copy-paths': {
          const style = action.style;
          const text = targets.map(path => style === 'filename' ? basename(path) : style === 'quoted' ? `'${path.replace(/'/g, "'\\''")}'` : path).join('\n');
          clipboard.writeText(text);
          this.deps.toast('已复制路径', '⌘C');
          break;
        }
        case 'open-terminal':
          await this.openApp(action.app ?? 'Terminal', this.state.folder);
          break;
        case 'open-editor':
          await this.openApp(action.app === 'VSCode' ? 'Visual Studio Code' : action.app, targets[0]);
          break;
        case 'cut-selection':
          this.cutPaths = [...this.state.selection];
          this.deps.toast(`已剪切 ${this.cutPaths.length} 项`, 'Cut');
          break;
        case 'paste-move':
          for (const path of [...this.cutPaths]) {
            movePath(path, this.state.folder);
            this.cutPaths = this.cutPaths.filter(item => item !== path);
          }
          this.deps.toast('已移动剪切项目', 'Move');
          break;
        case 'delete-permanent':
          for (const path of this.state.selection) {
            rmSync(path, { recursive: true, force: true });
            this.cutPaths = this.cutPaths.filter(item => item !== path);
          }
          this.state.selection = [];
          this.state.hasImageSelection = false;
          this.deps.toast('已彻底删除所选项目', 'Delete');
          break;
        case 'convert-webp':
          for (const path of this.imagePaths()) {
            const dest = uniqueDestPath(dirname(path), `${basename(path, extname(path))}.webp`);
            writeFileSync(dest, encodeWebp(this.loadImage(path)), { flag: 'wx' });
          }
          this.deps.toast('已转换为 WebP', 'WebP');
          break;
        case 'ocr-copy':
        case 'ocr-pin': {
          const parts: string[] = [];
          const ocr = visionOCR(), languages = ['zh-Hans', 'en-US'];
          for (const path of this.imagePaths()) {
            const result = await ocr.recognize(this.loadImage(path).toPNG(), ocrToken--, 'text', false, languages);
            const text = result.lines.map(line => line.text).join('\n').trim();
            if (text) parts.push(text);
          }
          const text = parts.join('\n\n');
          if (!text) throw new Error('未识别到文字');
          if (action.kind === 'ocr-copy') clipboard.writeText(text);
          else await this.deps.pinText(text, 'Finder OCR');
          this.deps.toast(action.kind === 'ocr-copy' ? '已复制识别文字' : '已钉为文字贴图', 'OCR');
          break;
        }
        case 'pin-image':
          for (const path of this.imagePaths()) await this.deps.pinImage(this.loadImage(path), basename(path));
          break;
        case 'move-to-target':
        case 'symlink-to-target': {
          if (!statSync(action.targetDir).isDirectory()) throw new Error('目标不是文件夹');
          for (const path of this.state.selection) {
            if (action.kind === 'move-to-target') {
              movePath(path, action.targetDir);
              this.cutPaths = this.cutPaths.filter(item => item !== path);
            } else symlinkSync(resolve(path), uniqueDestPath(action.targetDir, basename(path)));
          }
          this.deps.toast(action.kind === 'move-to-target' ? '已移动到目标目录' : '已创建软链', 'Finder');
          break;
        }
        default:
          throw new Error('不支持的 Finder 操作');
      }
    } catch (error) {
      this.deps.toast(`操作失败：${(error as Error).message}`, 'Error');
    } finally {
      this.publish();
    }
  }
}
