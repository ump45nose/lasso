# Lasso 工作说明（给编码代理）

Lasso 是一个 macOS 菜单栏工具，用 Electron 45、React 19 和 TypeScript 编写。功能是划词动作条、截图（区域/窗口/全屏）原地编辑、贴图，以及在 ChatGPT / Gemini 网页和 Codex / Pi CLI 之间分发任务。交接背景见 `docs/handoff.md`，进行中的计划在 `docs/plans/`。

## 结构

- `src/main`：主进程，包括窗口、任务、截图（`capture/`）、动作条（`action-bar.ts`）和贴图（`capture/pins.ts`）。
- `src/preload`：各窗口的 contextBridge API；类型在 `src/shared/contracts.ts` 和 `src/shared/capture.ts`。
- `src/renderer`：一个渲染入口，通过 `?surface=` 区分 screenshot / action-bar / pin / 主窗口。
- `native/`：Objective-C++ 原生模块（AX、窗口列表、Vision OCR），由 `scripts/build-capture.mjs` 编译。

## 命令

- `npm run build`：类型检查、UI 规则检查（`scripts/check-ui.mjs`）和构建。改完必须通过。
- `npm run ui:shots`：用独立配置运行构建产物，把所有界面截图到 `outputs/ui-shots/`。
- `npm run package`：打包到 `release/`。

## 界面改动：必须遵守

动手前先读 **`docs/design/ui-rules.md`**。要点：

1. 颜色只用 `tokens.css` 的令牌（透明度写成令牌底色加 alpha）；交互用陶土色回应：浅色表面用 `--clay-wash*` / `--clay-ink`，墨色表面用实心 `--clay`。
2. 字体只写 `var(--font-*)`；图标只用 lucide-react；渠道图标只用官方素材，放在 `src/renderer/assets/targets/`。
3. 不用原生菜单、`confirm()`、`alert()`，菜单和确认都在窗口内绘制。
4. 先复用 `Segmented` / `Glide` / `.l-btn` / `.l-switch` 等现有组件，动效用 `src/renderer/motion.tsx` 的预设。
5. 改完运行 `npm run ui:shots`，**打开相关截图逐张查看**后再报告；新增的界面或状态要补进 `scripts/ui-shots/run.mjs`。

检查脚本报错时修正代码，不要绕过。只有确属例外时才在该行写 `ui-check-ignore: <原因>`，原因不能省略。

## 工程约定

- 只引入当前需要的字段和状态；删除功能时，相关的字段、逻辑、配置和界面一起清掉。
- 从完整调用链找共同原因，不针对单个样例打补丁；不为假设的风险加多层 fallback。
- 报告要区分实测、推断和未验证。屏幕录制、划词、网页交互需要在打包版里手动验收，编译通过不等于联调通过。
- 提交只包含当前任务的改动，提交信息写清楚改了什么、为什么改。
