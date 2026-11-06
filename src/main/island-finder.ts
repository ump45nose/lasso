import { app, BrowserWindow, clipboard, ipcMain, screen } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { FinderPanelState, IslandState } from '../shared/contracts';

const FINDER_W = 384, FINDER_H = 430;

const FILE_TEMPLATES: Record<'md' | 'txt' | 'py' | 'json' | 'sh', string> = {
  md: '# 新建笔记\n\n',
  txt: '',
  py: '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\n\n',
  json: '{\n  \n}\n',
  sh: '#!/usr/bin/env zsh\nset -euo pipefail\n\n'
};
type FileTemplate = keyof typeof FILE_TEMPLATES;

const FINDER_ACTIONS = ['copy-path', 'open-terminal', 'open-cursor', 'open-vscode', 'send-to-lasso'] as const;
type FinderAction = typeof FINDER_ACTIONS[number];

function defaultFinderFolder(): string {
  return app.getPath('desktop');
}

function queryFinderContext(frontAppName: string): { folder: string; selection: string[]; frontmostApp: string } {
  const fallback = { folder: defaultFinderFolder(), selection: [], frontmostApp: frontAppName || 'Finder' };
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
    const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 900 }).trim();
    const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
    return {
      folder: lines[0] || fallback.folder,
      selection: lines.slice(1),
      frontmostApp: frontAppName || 'Finder'
    };
  } catch {
    return fallback;
  }
}

export interface FinderPanelDeps {
  check: (event: IpcMainEvent | IpcMainInvokeEvent) => void;
  toast: (text: string, badge?: string) => void;
  frontmostAppName: () => string;
  onSendTextToLasso: (text: string) => Promise<void>;
}

export class FinderPanel {
  readonly window: BrowserWindow;
  private state: FinderPanelState;

  constructor(fonts: IslandState['fonts'], private deps: FinderPanelDeps) {
    this.state = {
      folder: defaultFinderFolder(),
      selection: [],
      frontmostApp: 'Finder',
      fonts
    };

    this.window = new BrowserWindow({
      width: FINDER_W,
      height: FINDER_H,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      focusable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: { preload: join(__dirname, 'island-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    this.window.setAlwaysOnTop(true, 'pop-up-menu');
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', event => event.preventDefault());
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
    ipcMain.handle('finder:create-file', (event, ext: FileTemplate) => {
      check(event);
      if (!Object.hasOwn(FILE_TEMPLATES, ext)) throw new Error('不支持的文件模板');
      this.createFile(ext);
    });
    ipcMain.handle('finder:run-action', async (event, action: FinderAction) => {
      check(event);
      if (!FINDER_ACTIONS.includes(action)) throw new Error('不支持的 Finder 操作');
      await this.runAction(action);
    });

    void this.window.loadFile(join(__dirname, 'renderer/index.html'), { query: { surface: 'finder-panel' } });
  }

  summon() {
    const ctx = queryFinderContext(this.deps.frontmostAppName());
    this.state = { ...ctx, fonts: this.state.fonts };
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
    if (!this.window.isDestroyed()) {
      this.window.webContents.send('finder:changed', this.state);
    }
  }

  private createFile(ext: FileTemplate) {
    const folder = this.state.folder;
    let index = 1;
    let filePath = join(folder, `Untitled.${ext}`);
    while (existsSync(filePath)) {
      index += 1;
      filePath = join(folder, `Untitled-${index}.${ext}`);
    }
    try {
      writeFileSync(filePath, FILE_TEMPLATES[ext], { encoding: 'utf8', mode: ext === 'sh' || ext === 'py' ? 0o755 : 0o644 });
      this.window.hide();
      this.deps.toast(`已创建 ${basename(filePath)}`, `.${ext}`);
    } catch (error) {
      this.deps.toast(`新建失败：${(error as Error).message}`, 'Error');
    }
  }

  private async runAction(action: FinderAction) {
    const targets = this.state.selection.length ? this.state.selection : [this.state.folder];
    const primaryTarget = targets[0];
    this.window.hide();
    if (action === 'copy-path') {
      await Promise.resolve(clipboard.writeText(targets.join('\n')));
      this.deps.toast(`已复制路径：${basename(primaryTarget)}`, '⌘C');
      return;
    }
    if (action === 'open-terminal') {
      execFile('open', ['-a', 'Terminal', this.state.folder]);
      this.deps.toast(`已在终端打开 ${basename(this.state.folder)}`, 'Term');
      return;
    }
    if (action === 'open-cursor') {
      execFile('open', ['-a', 'Cursor', primaryTarget]);
      this.deps.toast(`已用 Cursor 打开 ${basename(primaryTarget)}`, 'Cursor');
      return;
    }
    if (action === 'open-vscode') {
      execFile('open', ['-a', 'Visual Studio Code', primaryTarget]);
      this.deps.toast(`已用 VS Code 打开 ${basename(primaryTarget)}`, 'Code');
      return;
    }
    if (action === 'send-to-lasso') {
      await this.deps.onSendTextToLasso(`请分析以下路径或文件：\n${targets.join('\n')}`);
      this.deps.toast('已发送到 Lasso 主窗口', 'AI');
    }
  }
}
