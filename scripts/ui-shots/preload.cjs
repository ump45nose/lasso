// Registered before every renderer preload. Chromium clipboard APIs and v4 suite fixtures stay in memory.
const { contextBridge } = require('electron');
contextBridge.executeInMainWorld({
  func: () => {
    let items = [];
    const calls = [];
    class MemoryClipboardItem {
      constructor(values) {
        this.values = values;
        this.types = Object.keys(values);
      }
      async getType(type) {
        if (!this.types.includes(type)) throw new DOMException('Missing fixture clipboard type', 'NotFoundError');
        const value = await this.values[type];
        return value instanceof Blob ? value : new Blob([value], { type });
      }
      static supports() {
        return true;
      }
    }
    Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: MemoryClipboardItem });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        read: async () => {
          calls.push('read');
          return items;
        },
        write: async value => {
          calls.push('write');
          items = value;
        },
        readText: async () => {
          calls.push('readText');
          const item = items.find(value => value.types.includes('text/plain'));
          return item ? (await item.getType('text/plain')).text() : '';
        },
        writeText: async value => {
          calls.push('writeText');
          items = [new MemoryClipboardItem({ 'text/plain': String(value) })];
        }
      }
    });
    Object.defineProperty(globalThis, '__uiShotsClipboard', { value: { calls, systemReads: 0, systemWrites: 0 } });

    const focusPomodoro = {
      active: true,
      paused: false,
      kind: 'focus',
      taskId: 'nook-1',
      taskTitle: '整理截图编辑器工具条层级',
      remainingSeconds: 1122,
      totalSeconds: 1500
    };
    const alerts = [
      {
        id: 'alert-1',
        kind: 'launchd',
        title: 'local.lasso.sync 异常退出',
        subtitle: 'LaunchAgents · Exit 1',
        target: 'local.lasso.sync'
      }
    ];
    const nookReview = {
      mainGoal: '完成 Lasso v4 全套界面改造与验收',
      items: ['把本地 CLI 从所有界面和文案里清干净', '核对截图「问 AI」分流与独立生图窗']
    };
    const nookTasks = [
      { id: 'nook-1', title: '整理截图编辑器工具条层级', listTitle: 'Lasso', completed: false, dueLabel: '已逾期 2h', overdue: true },
      { id: 'nook-2', title: '检查 WebDAV 同步无后台轮询', listTitle: 'Lasso', completed: false, dueLabel: '18:00' },
      { id: 'nook-3', title: '对齐暖白纸面与单一实心陶土规则', listTitle: 'Lasso', completed: true }
    ];

    Object.defineProperty(globalThis, '__uiShotsFixtures', {
      value: {
        islandStates(base) {
          return {
            focusCapsule: {
              ...base,
              mode: 'focus',
              glow: false,
              alerts: [],
              toast: null,
              nookReview,
              nookTasks,
              nookCompletedCount: 1,
              nookTotalCount: 3,
              pomodoro: { ...focusPomodoro, active: false }
            },
            pomodoroCapsule: {
              ...base,
              mode: 'focus',
              glow: false,
              alerts: [],
              toast: null,
              nookReview,
              nookTasks,
              nookCompletedCount: 1,
              nookTotalCount: 3,
              pomodoro: focusPomodoro
            },
            alertCapsule: {
              ...base,
              mode: 'focus',
              glow: true,
              alerts,
              toast: null,
              nookReview,
              nookTasks,
              nookCompletedCount: 1,
              nookTotalCount: 3,
              pomodoro: { ...focusPomodoro, active: false }
            },
            board: {
              ...base,
              mode: 'board',
              glow: true,
              alerts,
              toast: null,
              nookReview,
              nookTasks,
              nookCompletedCount: 1,
              nookTotalCount: 3,
              pomodoro: focusPomodoro,
              nookPrefs: { enabled: true, tasks: true, hubAttention: true, aiResets: true, localAndCustom: true }
            }
          };
        },
        translatorState(base, variant = 'folded') {
          const common = {
            ...base,
            open: true,
            targetLang: 'zh',
            connectionName: 'DeepSeek',
            model: 'deepseek-chat',
            canReplace: variant === 'folded',
            fromSelection: variant === 'folded',
            pinnedOnTop: true,
            status: 'done',
            error: null,
            firstTokenMs: 142,
            sourceText:
              'Good tools stay out of the way until the moment you reach for them, then disappear again without leaving clutter on the screen.',
            translatedText: '好工具平时不露面，伸手去够的那一刻刚好在手边，用完又干干净净地退开，不在屏幕上留一堆摊子。'
          };
          return common;
        },
        clipboardState(base, { safariIcon = null, finderIcon = null, thumbnailDataUrl = null } = {}) {
          const now = Date.now();
          return {
            ...base,
            open: true,
            pinnedOnTop: true,
            targetAppName: 'Safari',
            entries: [
              {
                id: 'clip-1',
                kind: 'text',
                preview: 'jq \'.shortcuts + .translation\' ~/.config/lasso/settings.json',
                text: 'jq \'.shortcuts + .translation\' \\\n  ~/.config/lasso/settings.json \\\n  | pbcopy',
                lineCount: 3,
                charCount: 186,
                favorite: true,
                createdAt: now - 120000,
                sourceAppName: 'Ghostty',
                sourceBundleId: 'com.mitchellh.ghostty',
                sourceAppIcon: null
              },
              {
                id: 'clip-2',
                kind: 'image',
                preview: '截图 · 1280 × 720',
                text: '',
                imageThumbnail: thumbnailDataUrl,
                imageWidth: 1280,
                imageHeight: 720,
                imageBytes: 421888,
                lineCount: 1,
                charCount: 0,
                favorite: false,
                createdAt: now - 300000,
                sourceAppName: 'Lasso',
                sourceBundleId: 'local.mac-ai-prompt',
                sourceAppIcon: null
              },
              {
                id: 'clip-3',
                kind: 'text',
                preview: '好工具平时不露面，伸手去够的那一刻刚好在手边…',
                text: '好工具平时不露面，伸手去够的那一刻刚好在手边，用完又干干净净地退开。',
                lineCount: 1,
                charCount: 36,
                favorite: false,
                createdAt: now - 900000,
                sourceAppName: 'Safari',
                sourceBundleId: 'com.apple.Safari',
                sourceAppIcon: safariIcon
              },
              {
                id: 'clip-4',
                kind: 'files',
                preview: 'product-ux-overhaul-spec.md（1 个文件）',
                text: '/Users/demo/Projects/lasso/docs/plans/product-ux-overhaul-spec.md',
                files: ['/Users/demo/Projects/lasso/docs/plans/product-ux-overhaul-spec.md'],
                lineCount: 1,
                charCount: 81,
                favorite: false,
                createdAt: now - 3600000,
                sourceAppName: '访达',
                sourceBundleId: 'com.apple.finder',
                sourceAppIcon: finderIcon
              }
            ]
          };
        }
      }
    });
  }
});
