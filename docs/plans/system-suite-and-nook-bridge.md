# 常驻系统工具集与 Nook 联动计划

2026-11-05 启动。范围、跨仓边界、关键决定与进度在此维护；恢复任务先读本文件。

## 背景与目标

将日常高频使用的独立小工具（Raycast Notes、Shottr、EdgeMark、iRightMouse、Rectangle、launchd-ui）收编进个人常驻双核体系，减少后台常驻进程与认知切换，同时实现 100% 个人化定制：

- **Lasso**（`/Users/sm5145/WorkSpace/Code/Github/mac-ai-prompt`）：macOS 全局交互壳（划词、截图/贴图、刘海岛、快速 API 原位气泡、边缘抽屉便签、Finder 超级面板、窗口快捷键分屏）。
- **Nook**（`/Users/sm5145/WorkSpace/Code/Github/personal-data-hub/apps/macos`）：个人数据与本机运维台（日程/任务、提醒规则与番茄钟数据源、本机 `launchd` 守护进程管理）。

## 已确认架构与边界决定

| 编号 | 模块 | 归属仓库 | 核心决定 |
| --- | --- | --- | --- |
| 1 | 定时提醒 + Nook 任务联动 + 番茄钟 / 摸鱼提醒 | **Nook**（数据与调度）+ **Lasso**（刘海岛 & 四边光效呈现） | 任务与提醒规则留在 Nook（扩展 `Reminders.swift` / `ReminderSettings.swift` 支持番茄钟会话与 `interval` 间歇摸鱼规则）；通过 macOS `DistributedNotificationCenter` 双向通信，由 Lasso 刘海岛与屏幕四边 28pt 呼吸微光 (`ReminderGlow`) 负责强触达与快捷回调（完成任务 / 延后 10m / 进入休息）。 |
| 2 | 翻译与快速直连 API 预设 (`Fast API`) | **Lasso** | 复用现有 `media-service.ts` 的 `New API`（`baseURL` + `safeStorage` 加密 Key），向文本预设开放 `target: 'api'`。主进程直连 `/v1/chat/completions`（SSE 流式，关闭推理），在动作条或截图 OCR 旁原位展开轻量结果卡片，支持 `↵ 替换选中文本`、`⌘C 复制`、`Pin 钉为贴图`。 |
| 3 | 便签（Raycast Notes + EdgeMark 融合） | **Lasso** | 采用「一主一抽屉，共用本地 `.md` 目录」：顶部固定 `Scratchpad.md` 零负担速记（支持动作条/截图一键追加），交互采用屏幕左/右边缘滑出抽屉（带防误触延迟、四角排除、`Pin` 保持展开），单篇便签可撕下转为桌面 `Pin` 贴图。 |
| 4 | 刘海岛 (`Notch Island`) | **Lasso** | 屏幕顶部中央高于菜单栏层级的无边框透明窗口，形态内命中测试、透明区鼠标穿透。承接 4 类状态：常驻微状态（番茄钟/CLI 任务）、瞬态吐司（复制/保存/分屏反馈）、强提醒挂起（Nook 任务/摸鱼/额度重置/服务异常）、点击展开控制板 (`IslandBoard`)。 |
| 5 | Finder 超级动作面板（替代 iRightMouse） | **Lasso** | 采用**路线 B（自绘超级面板 + 系统服务兜底）**：在 Finder 内按鼠标中键 / 长按右键 / 快捷键，通过原生 AX / `ScriptingBridge` 秒读当前选中路径与所在目录，弹出墨色定制面板（新建模板文件、指定 IDE/终端打开、复制路径、剪切/彻底删除、图片原地转 WebP/OCR、发给 AI、移至常用目录或活跃 Worktree），不引入高维护负担的 `.appex` 插件。 |
| 6 | 窗口分屏与工作区排布（替代 Rectangle） | **Lasso** | 在现有 `native/` AX 模块上扩展 `kAXPositionAttribute` / `kAXSizeAttribute` 控制，实现全局快捷键分屏（兼容现有 Rectangle `⌃⌥` 键位）、跨显示器移动及「多窗口工作区一键排布」；不做 macOS 15+ 已内置的鼠标拖拽撞边缘预览。 |
| 7 | `launchd-ui` 本机守护进程管理 | **Nook** | 并入 Nook macOS 客户端：扫描 `~/Library/LaunchAgents/*.plist` 并结合 `launchctl print gui/$UID/<label>` 展示实时 PID、上次退出码与触发规则，支持一键 `kickstart -k` 重启、`bootstrap/bootout` 启停、尾部日志预览，以及关键服务非 0 退出时联动刘海岛告警。 |

## 跨进程通信协议（Lasso ↔ Nook Bridge）

本机两应用通过 macOS `DistributedNotificationCenter.default()` 通信（无需网络端口与额外权限）：

- `com.lasso.island.present`（Nook → Lasso）：推送强提醒、番茄钟状态更新或守护进程异常告警（Payload JSON：`id`, `kind: 'task' | 'pomodoro' | 'slacking' | 'reset' | 'launchd'`, `title`, `body`, `taskId`, `remainingSeconds`, `glow: boolean`, `actions: []`）。
- `com.lasso.island.dismiss`（Nook → Lasso）：任务在 Nook 内已完成或提醒已撤销时同步收起刘海岛挂起项。
- `com.nook.bridge.action`（Lasso → Nook）：用户在刘海岛点击「完成任务」「延后 10 分钟」「开始番茄钟」「重启 LaunchAgent」或从便签「提取为 Nook 待办」时回传执行。

## 详细设计稿

交互式规范与原型位于 [`docs/design/v3/index.html`](../design/v3/index.html)（含 `suite.css` 与 `app.js`）。涵盖全部 7 个模块的正常态、悬停/展开态、异常态、设置项、像素尺寸与代码映射。

## 分批实施路线与进度

| 阶段 | 范围 | 状态 |
| --- | --- | --- |
| 设计阶段 | 7 大模块交互规范、状态清单、跨进程协议与 HTML 原型 (`docs/design/v3/`) | 完成 |
| 第一批（高频立竿见影） | ① 快速 API 预设与原位翻译卡片 · ② 刘海岛 & 屏幕四边光效 · ③ Nook 提醒/番茄钟/摸鱼联动 · ④ Nook `launchd-ui` 模块 | 完成 |
| 第二批（桌面工具收编） | ⑤ 边缘抽屉便签 (`EdgeNotes`) · ⑥ 窗口快捷键分屏 (`WindowSnap`) · ⑦ Finder 超级动作面板 (`FinderActionPanel`) | 完成 |

## 验收标准

1. **视觉与交互合规**：严格遵守 [`docs/design/ui-rules.md`](../design/ui-rules.md)，所有颜色走 `tokens.css`，字体走 `var(--font-*)`，图标走 `lucide-react`（Nook 端遵循 `Theme.swift` 与 `Typo`），无原生系统弹窗菜单、无 emoji。
2. **第一批验收**：
   - 划词翻译与 OCR 翻译通过 `target: 'api'` 流式返回，原位卡片可一键替换原选中文本或复制。
   - 刘海岛在静默、吐司、番茄钟倒计时、强提醒挂起及 `IslandBoard` 展开态下鼠标穿透区域准确，不抢夺前台应用焦点。
   - Nook 任务/摸鱼提醒触发时同步点亮四边 `ReminderGlow` 与刘海岛，刘海岛点击「完成」可同步勾选 Nook 任务。
   - Nook `Launchd` 页面准确列出 `~/Library/LaunchAgents` 状态，可执行重启/启停并读取错误日志尾部。
3. **第二批验收**：
   - 屏幕边缘停靠或快捷键可滑出便签抽屉，读写本地 `.md` 目录并支持撕下为桌面 `Pin`。
   - `⌃⌥` 分屏快捷键准确调整焦点窗口位置/尺寸及跨屏移动，支持一键排布双窗工作区。
   - Finder 内触发超级动作面板可读取当前选中文件与所在目录，完成新建模板文件、指定编辑器打开、图片格式转换与 AI 投递。
