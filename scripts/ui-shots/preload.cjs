// Registered before every renderer preload. Chromium clipboard APIs and W2 suite fixtures stay in memory.
const { contextBridge } = require('electron');
contextBridge.executeInMainWorld({ func: () => {
  let items = [];
  const calls = [];
  class MemoryClipboardItem {
    constructor(values) { this.values = values; this.types = Object.keys(values); }
    async getType(type) {
      if (!this.types.includes(type)) throw new DOMException('Missing fixture clipboard type', 'NotFoundError');
      const value = await this.values[type];
      return value instanceof Blob ? value : new Blob([value], { type });
    }
    static supports() { return true; }
  }
  Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: MemoryClipboardItem });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    read: async () => { calls.push('read'); return items; },
    write: async value => { calls.push('write'); items = value; },
    readText: async () => { calls.push('readText'); const item = items.find(value => value.types.includes('text/plain')); return item ? (await item.getType('text/plain')).text() : ''; },
    writeText: async value => { calls.push('writeText'); items = [new MemoryClipboardItem({ 'text/plain': String(value) })]; }
  } });
  Object.defineProperty(globalThis, '__uiShotsClipboard', { value: { calls, systemReads: 0, systemWrites: 0 } });

  const cliTasks = [
    { id: 'cli-1', target: 'codex', title: '重构浮动便签与 Finder 面板', activity: 'running' },
    { id: 'cli-2', target: 'pi', title: '执行回归测试与构建验证', activity: 'waiting' }
  ];
  const focusPomodoro = {
    active: true,
    paused: false,
    kind: 'focus',
    taskId: 'nook-1',
    taskTitle: '核对 API 翻译流式延迟与回填',
    remainingSeconds: 1125,
    totalSeconds: 1500
  };
  const alerts = [
    { id: 'alert-1', kind: 'task', title: '下午 16:00 复盘 Nook 提醒桥接', subtitle: 'Nook · 今日重点待办', target: 'nook-1' },
    { id: 'alert-2', kind: 'launchd', title: 'com.personalhub.app 异常退出 (Exit 1)', subtitle: '~/Library/LaunchAgents · 点击一键重启', target: 'com.personalhub.app' }
  ];
  Object.defineProperty(globalThis, '__uiShotsFixtures', {
    value: {
      cliTasks,
      focusPomodoro,
      alerts,
      islandStates(base) {
        return {
          idle: { ...base, mode: 'idle', glow: false, cliTasks: [], alerts: [], toast: null, pomodoro: { ...base.pomodoro, active: false } },
          focusCapsule: { ...base, mode: 'focus', glow: false, cliTasks: [], alerts: [], pomodoro: focusPomodoro },
          focusHover: { ...base, mode: 'focus-hover', glow: false, cliTasks: [], alerts: [], pomodoro: focusPomodoro },
          nookAlert: { ...base, mode: 'nook-alert', glow: true, alerts },
          slacking: { ...base, mode: 'slacking', pomodoro: { active: true, paused: false, kind: 'slacking', taskId: null, taskTitle: '休息提醒 · 起身活动喝水', remainingSeconds: 300, totalSeconds: 300 } },
          cliCapsule: { ...base, mode: 'idle', glow: true, cliTasks },
          board: {
            ...base,
            mode: 'board',
            glow: true,
            cliTasks,
            nookTasks: (base.nookTasks || []).slice(0, 1),
            nookPrefs: { enabled: true, gitWaiting: true, prFeedback: true, prBlocked: false },
            copyTranslateEnabled: true
          }
        };
      },
      translatorState(base, variant = 'done') {
        const common = {
          ...base,
          open: true,
          targetLang: 'zh',
          connectionName: 'DeepSeek 极速翻译',
          model: 'deepseek-chat',
          canReplace: true,
          pinnedOnTop: true,
          sourceText: 'The menu bar notch island drops below the system status bar so capsules and control panels never obscure camera housing or system icons.'
        };
        if (variant === 'streaming') {
          return { ...common, status: 'streaming', error: null, firstTokenMs: 118, translatedText: '菜单栏刘海岛下沉至系统状态栏下方，使专注胶囊与控制面板…' };
        }
        return {
          ...common,
          status: 'done',
          error: null,
          firstTokenMs: 142,
          translatedText: '菜单栏刘海岛下沉至系统状态栏下方，使专注胶囊与控制面板始终避开摄像头刘海与系统图标。'
        };
      },
      clipboardState(base, { safariIcon = null, finderIcon = null, thumbnailDataUrl = null } = {}) {
        const now = Date.now();
        return {
          ...base,
          open: true,
          pinnedOnTop: true,
          entries: [
            {
              id: 'clip-1', kind: 'text',
              preview: 'git worktree add ../lasso.worktrees/product-followup -b feat/stage-2',
              text: 'git worktree add ../lasso.worktrees/product-followup -b feat/stage-2\nnpm run build && npm run ui:shots',
              lineCount: 2, charCount: 102, favorite: true,
              createdAt: now - 120000,
              sourceAppName: 'Safari', sourceBundleId: 'com.apple.Safari', sourceAppIcon: safariIcon
            },
            {
              id: 'clip-2', kind: 'image',
              preview: '设计评审标注切图 · 1440×900 PNG',
              text: '',
              imageThumbnail: thumbnailDataUrl, imageWidth: 1440, imageHeight: 900,
              lineCount: 1, charCount: 0, favorite: false,
              createdAt: now - 300000,
              sourceAppName: '访达', sourceBundleId: 'com.apple.finder', sourceAppIcon: finderIcon
            },
            {
              id: 'clip-3', kind: 'text',
              preview: '菜单栏刘海岛下沉至系统状态栏下方，避免遮挡状态栏图标与摄像头区域。',
              text: '菜单栏刘海岛下沉至系统状态栏下方，避免遮挡状态栏图标与摄像头区域。',
              lineCount: 1, charCount: 34, favorite: false,
              createdAt: now - 900000,
              sourceAppName: 'Lasso', sourceBundleId: 'com.yuwk.lasso', sourceAppIcon: null
            },
            {
              id: 'clip-4', kind: 'files',
              preview: 'architecture.md · stage-2.md',
              text: '/Users/yuwk/Developer/Repos/Personal/lasso/.spec/architecture.md\n/Users/yuwk/Developer/Repos/Personal/lasso/.spec/stage-2.md',
              lineCount: 2, charCount: 125, favorite: false,
              createdAt: now - 3600000,
              sourceAppName: '访达', sourceBundleId: 'com.apple.finder', sourceAppIcon: finderIcon
            }
          ]
        };
      }
    }
  });
} });
