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
        id: 'launchd:com.wonderwhy-er.desktop-commander',
        kind: 'launchd',
        title: 'Desktop Commander 未运行',
        subtitle: '后台服务异常 · 点击重启',
        target: 'com.wonderwhy-er.desktop-commander'
      }
    ];
    const nookReviewBadge = { label: '写日报', hot: true };
    const nookTaskLists = [
      { id: 'list-general', title: '一般性', shortTitle: '一般性', openCount: 3 },
      { id: 'list-routine', title: '循环任务', shortTitle: '循环', openCount: 3 },
      { id: 'list-hobby', title: '兴趣开发', shortTitle: '兴趣开发', openCount: 2 },
      { id: 'list-ongoing', title: '持续性任务', shortTitle: '持续', openCount: 1 },
      { id: 'list-blocked', title: '阻塞任务', shortTitle: '阻塞', openCount: 1 }
    ];
    const nookTasks = [
      {
        id: 'routine-morning',
        title: '早起洗漱',
        listId: 'list-routine',
        listTitle: '循环任务',
        notes: '刷牙 2 分钟，轻刷舌苔\n洗脸用洗面奶，涂保湿乳与防晒\n出门前整理头发、胡茬',
        completed: false,
        isRoutine: true,
        routineSlot: '早间',
        inFocus: true
      },
      {
        id: 'nook-1',
        title: '替换 hermes 与整理工作流',
        listId: 'list-general',
        listTitle: '一般性',
        completed: false,
        dueLabel: '逾期 2 天',
        overdue: true,
        inFocus: true
      },
      {
        id: 'nook-2',
        title: '检查 WebDAV 同步与刘海推送状态',
        listId: 'list-general',
        listTitle: '一般性',
        completed: false,
        dueLabel: '今天',
        inFocus: true
      },
      {
        id: 'nook-block-1',
        title: '谷歌账号改密码和支付验证',
        listId: 'list-blocked',
        listTitle: '阻塞任务',
        completed: false,
        dueLabel: '逾期 5 天',
        overdue: true,
        inFocus: true
      },
      {
        id: 'nook-general-3',
        title: 'review 我的开发方式',
        listId: 'list-general',
        listTitle: '一般性',
        completed: false,
        inFocus: true
      },
      {
        id: 'nook-done-1',
        title: '通过硬盘盒迁移数据',
        listId: 'list-general',
        listTitle: '一般性',
        completed: true,
        inFocus: true
      },
      {
        id: 'routine-work',
        title: '下班前整理',
        listId: 'list-routine',
        listTitle: '循环任务',
        notes: '擦眼镜\n清理桌面临时文件',
        completed: false,
        isRoutine: true,
        inFocus: false
      },
      {
        id: 'routine-train',
        title: '一三五七',
        listId: 'list-routine',
        listTitle: '循环任务',
        notes: '俯卧撑: 4 组 × 8~15 次\n弹力带划船: 4 组 × 10~15 次\n哑铃肩推: 3 组 × 8~12 次',
        completed: false,
        isRoutine: true,
        inFocus: false
      },
      {
        id: 'hobby-1',
        title: '媒体库的 skill 优化',
        listId: 'list-hobby',
        listTitle: '兴趣开发',
        completed: false,
        inFocus: false
      },
      {
        id: 'hobby-2',
        title: 'image-caption 重构',
        listId: 'list-hobby',
        listTitle: '兴趣开发',
        completed: false,
        inFocus: false
      },
      {
        id: 'ongoing-1',
        title: '沉淀工作流，事务自动化',
        listId: 'list-ongoing',
        listTitle: '持续性任务',
        completed: false,
        inFocus: false
      }
    ];

    Object.defineProperty(globalThis, '__uiShotsFixtures', {
      value: {
        islandStates(base) {
          return {
            focusCapsule: {
              ...base,
              mode: 'focus',
              alerts: [],
              toast: null,
              nookReviewBadge,
              nookTaskLists,
              nookTasks,
              nookCompletedCount: 1,
              nookTotalCount: 6,
              pomodoro: { ...focusPomodoro, active: false }
            },
            pomodoroCapsule: {
              ...base,
              mode: 'focus',
              alerts: [],
              toast: null,
              nookReviewBadge,
              nookTaskLists,
              nookTasks,
              nookCompletedCount: 1,
              nookTotalCount: 6,
              pomodoro: focusPomodoro
            },
            alertCapsule: {
              ...base,
              mode: 'focus',
              alerts,
              toast: null,
              nookReviewBadge,
              nookTaskLists,
              nookTasks,
              nookCompletedCount: 1,
              nookTotalCount: 6,
              pomodoro: { ...focusPomodoro, active: false }
            },
            board: {
              ...base,
              mode: 'board',
              alerts,
              toast: null,
              nookReviewBadge,
              nookTaskLists,
              nookTasks,
              nookCompletedCount: 1,
              nookTotalCount: 6,
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
            sourceText: variant === 'expanded'
              ? '## Design Principle\n\nGood tools stay out of the way until you reach for `npm run build`:\n- **Focused**: keep clutter off the screen\n- **Reversible**: preserve structure across edits'
              : 'Good tools stay out of the way until the moment you reach for them, then disappear again without leaving clutter on the screen.',
            translatedText: variant === 'expanded'
              ? '## 设计原则\n\n好工具平时安静退在后台，直到你运行 `npm run build` 的那一刻：\n- **克制聚焦**：不在屏幕上留下一堆杂物\n- **结构无损**：多段文本与 Markdown 格式完整保留'
              : '好工具平时不露面，伸手去够的那一刻刚好在手边，用完又干干净净地退开，不在屏幕上留一堆摊子。'
          };
          if (variant === 'markdown') {
            return {
              ...common,
              fromSelection: true,
              canReplace: true,
              sourceText: 'Other notes\\\n\\- The local test instance was still pointing at the repo\'s old folder and created \\~/WorkSpace by accident while I was testing. I fixed its settings and deleted that folder. All temporary screenshots and scripts are cleaned up.\\\n\\- The code changes are not committed yet; the NAS is running the uncommitted version. The 4-hourly release builds only pick up main. Should I commit and merge into main?',
              translatedText: '其他说明\\\n\\- 本地测试实例仍指向仓库的旧目录，测试时意外创建了 \\~/WorkSpace。我已修正设置并删除该目录。所有临时截图和脚本均已清理。\\\n\\- 代码改动尚未提交；NAS 运行的是未提交的版本。每 4 小时一次的发布构建只会采用 main 分支。是否需要提交并合并到 main？'
            };
          }
          if (variant === 'markdown-code') {
            return {
              ...common,
              fromSelection: true,
              sourceText: 'Markdown preview with headings, lists, links, tables, and literal code.',
              translatedText: '## 格式保留\n\n正文第一行\\\n正文第二行\n\n1. **列表**与[链接](https://example.com)\n2. 行内代码 `\\- literal`\n\n> 引用内容\n\n| 项目 | 状态 |\n| --- | --- |\n| Markdown | 已预览 |\n\n````text\n\\- literal\n```\n\\# literal heading\n````'
            };
          }
          if (variant === 'selection') {
            return {
              ...common,
              fromSelection: true,
              canReplace: true,
              sourceText: 'Switch AIDE and import again. Other issues:\n\n1. Check why orca is called twice.\n2. Harden ape so the operation completes fully.\n\nBoth Macs should retain these separate paragraphs. Commit: `6eb89c3`.',
              translatedText: '切换 AIDE 后重新导入。其他问题：\n\n1. 检查为什么 orca 被调用了两次。\n2. 加固 ape，确保操作能够完整完成。\n\n两台 Mac 都应保留这些独立段落。提交：`6eb89c3`。'
            };
          }
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
