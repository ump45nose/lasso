# 前端重构实施

2026-10-25 启动。设计依据见 [ui-redesign](ui-redesign.md) 与 `docs/design/v2/`。恢复任务先读本文件的进度表。

## 范围

按详细设计重做全部本地界面：小窗外壳、⌘K 指令面板、投递进度、CLI 对话、图片入口、设置（含「外观 · 字体」）、动作条、截图覆盖层；同步改动主进程布局与 IPC。产品规则不变（网页先编辑不加本地中转、默认无全局快捷键、失败保留内容、不重复提交）。

## 关键决定

1. **布局常量共享**：`contracts.ts` 导出 `HEADER_HEIGHT = 44`、`FOOTER_ROW = 48`。网页视图 `y = 44`，高度扣除底部行（应用提示行；投递行仅任务视图）。显示条件 `!settingsOpen && !imageOpen && !paletteOpen`。
2. **⌘K 状态在主进程**：焦点在网页内时 React 收不到按键，所以由「窗口」菜单的 ⌘K / ⌘N 菜单项触发。`openPalette(scope)` 先 `capturePage()` 当前可见网页，再隐藏视图，并经 `shell:palette` 通道发 `{ scope, backdrop }`；截图不进 ShellState。`closePalette()` 恢复视图与焦点，窗口隐藏时自动关闭。删除 `showPresetMenu`、`showNewTaskMenu`、`shell:task-overflow`；全局快捷键（有选区）与托盘「运行预设…」「新对话」改为打开面板。托盘菜单仍为系统菜单。
3. **投递步骤**：`DeliveryStatus` 增加 `steps` 与 `step`（open / model / fill / upload / send / edit），顺序跟随实际执行：打开 →（模型）→ 填入 →（图片）→ 发送 / 交给你。恢复与准备新对话不带步骤。
4. **应用提示与图片标签**：`screenshotError` 改为 `notice`，剪贴板图片读取失败也写入。新增 `imageOpen` 与 action `show-image`，图片作为临时标签。
5. **字体**：`settings.fonts`（display / text / ui / mono，默认 Anthropic Serif Text ×3 + JetBrains Mono）与 `importedFonts`。导入文件复制到 `userData/fonts/`，经特权协议 `lasso-font://` 提供；CSP 增加 `font-src`；defaultSession 只放行本地窗口的 `local-fonts`。内置 Newsreader 与 JetBrains Mono（fontsource，Vite 打包），中文后备系统宋体。
6. **样式**：`styles/tokens.css` + `styles/app.css`（移植 `docs/design/v2/lasso.css` 的 `l-*` / `ab-*`），`capture/capture.css` 重写。旧 `style.css` 在全部组件改用新类名后删除。
7. **与详细设计的差异**：截图 Esc 保持「取消」；不做双击标题栏放大（入口在 ⌘K 与「窗口」菜单）；动作条悬停提示用原生 `title`；「交付中」由动作条渲染层本地显示，靠现有淡出让位；审批后不新增记录行；本地 CLI 设置不显示「已找到」。

## 验收

- `npm run typecheck`、`npm run build` 通过。
- 网页视图与 44px 标题栏、底部提示行对齐，无遮挡；焦点在网页内 ⌘K 可用，关闭后焦点恢复。
- 投递步骤与 TaskManager 阶段一致，失败重试不重复已完成步骤，恢复不重发。
- 四个字体角色可单独更换；导入字体重启后仍生效；字体缺失时正常显示并标出。
- 动作条、截图交互与现有行为一致；减少动态效果时无位移动画；按钮可键盘操作。

## 进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 0 | 记录计划 | 完成 |
| 1 | 契约与主进程：布局、notice、imageOpen、投递步骤、⌘K、菜单清理 | 完成 |
| 2 | 样式基础与字体：tokens / app.css、fontsource、协议、CSP、权限 | 完成（旧 style.css 在组件重写完后于阶段 7 删除） |
| 3 | 小窗外壳：TitleBar、Launcher、Footer、Palette | 未开始 |
| 4 | CLI 对话与图片入口 | 未开始 |
| 5 | 设置：预设、应用背景、本地 CLI、通用、外观 | 未开始 |
| 6 | 动作条与截图 | 未开始 |
| 7 | 收尾：清理、标志颜色、设计说明回写、实测 | 未开始 |
