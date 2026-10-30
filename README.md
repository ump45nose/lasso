# Lasso

Mac 上随手处理轻任务的 AI 小窗。选中文字，点击附近的预设动作，把完整内容交给 ChatGPT、Gemini、Codex 或 Pi；没有选区，也能打开小窗直接提问。

当前版本 **0.8.0**。支持划词预设、网页与本地 CLI 对话、原生截图、标注、图上选字、贴图和生图。

## 日常使用

- **划词**：拖选文字后选择「问 AI / 解释 / 总结 / 翻译」。前四个启用的预设在动作条，其余收进 `···`。
- **无选区**：菜单栏打开小窗，或选择「运行预设…」。顶部 `＋` 新建任务，目标也可在预设中固定。
- **先编辑 / 直接发送**：网页直接填入网站输入框；本地 CLI 填入图形聊天输入框。预设可以指定模型和思考强度。
- **图片**：截图工具复制单张图片，再从菜单栏选择「使用剪贴板图片」，或在本地入口粘贴。图片可预览、替换、移除。
- **截图与编辑**：支持框选、智能区域、窗口、前台窗口、全屏和滚动截图，以及延时截图和重截上次区域。截图后可裁剪、标注、遮挡、取色、直接选取图中文字，再复制、保存、贴图或用于生图。
- **生图**：在预设中选择 ChatGPT、Gemini 或兼容 Images API 的服务，配置模型、尺寸和张数。API 生图支持参考图、版本历史和结果再次编辑。
- **任务**：顶部标签优先，放不下才显示溢出下拉。隐藏或切换不打断后台任务；置顶后点击窗外不隐藏。

设置中统一管理预设、应用背景、CLI 路径、快捷键和截图选项。默认不绑定全局快捷键；`⌥Space` 留给 Raycast。应用背景只跟随明确的划词来源，无选区、图片和普通追问不注入。

## 在新 Mac 构建

要求 macOS **14.2+**、Node.js **22.12+**、npm、Xcode Command Line Tools。当前通过验证的架构为 Apple Silicon；打包按本机架构生成，不提供通用包。

```sh
gh repo clone ump45nose/lasso
cd lasso
npm ci
npm run signing:setup  # 新 Mac 创建本机固定开发签名，已有时复用
npm run package
open release/Lasso-darwin-$(node -p process.arch)
```

若未安装 Command Line Tools，先运行 `xcode-select --install`。原生模块会查找当前 Node 安装及 Homebrew 的开发头文件；自定义安装可通过 `NODE_INCLUDE_DIR` 指定包含 `node_api.h` 的目录。

打包签名需要登录钥匙串处于解锁且允许 `codesign` 使用本机证书的状态。

GitHub Actions 在主线推送、PR 和手动触发时构建 Apple Silicon、Intel 两套 ZIP / DMG，并附 SHA-256 校验文件。推送与 `package.json` 版本一致的 `v*` 标签（例如 `v0.8.5`）后，自动发布到 GitHub Releases。CI 使用显式的 `npm run package -- --release` 临时签名，不读取本机证书；下载包尚未经过 Apple 公证。本机构建继续复用固定签名。

将产物 `Lasso.app` 放到 `~/Applications/`，从 Finder 启动。首次授予辅助功能权限，使用截图时再授予屏幕录制权限；在各网站登录，并配置本机 Codex / Pi CLI 的绝对路径。详细的数据取舍与验收顺序见 [迁移步骤](docs/handoff.md#新-mac-迁移步骤)。

源码调试用 `npm start`，已有构建用 `npm run start:built`。调试进程使用 Electron 身份，但与安装版共用数据目录；不能用调试运行替代安装版的权限验收，也不要同时运行两者。

## 实现边界

- Electron + React + TypeScript；通用取词复用 `selection-hook`，无需购买 PopClip。
- 网站保留自己的账号、模型、附件与聊天界面；本地只管理预设、任务、窗口和适配。不复制浏览器凭据，不静默切到 API。
- Codex 使用独立 `app-server`，Pi 使用 `--mode rpc`，沿用各 CLI 的用户配置、登录与权限，不接管 Codex Desktop 的开发任务。
- 后台闲置 **10 分钟** 且已完成、无草稿/附件/待处理操作、可恢复，才释放资源。网页恢复原链接，CLI 恢复原生会话，不重发提示词。退出后不恢复本次任务列表。
- 本地外壳采用暖白、柔橙 `#C57556` 和衬线字体；远程网页样式由网站控制。窗口与设置过渡跟随 macOS「减少动态效果」。

数据目录固定为 `~/Library/Application Support/mac-ai-prompt/`，应用身份固定为 `local.mac-ai-prompt`。预设和设置可私下迁移；网站登录、CLI 凭据、签名私钥、运行数据与安装产物不进入 Git。

## 文档与代码入口

- [方案、进度、验收缺口与迁移](docs/handoff.md)：接手工作的主入口。
- [阶段 0—6 实施路线](docs/implementation-plan.md)、[阶段 4—6 设计](docs/next-phases-design.md)。
- [截图 S1—S4 方案](docs/screenshot-implementation-plan.md)：包括免费开源复用研究与原型证据。
- [已确认的交互原型](docs/design/index.html)：可直接用浏览器打开；历史设计参考，不代表功能已完成。
- [开源复用与许可](docs/open-source.md)。

主进程入口 `src/main/index.ts`，任务与资源所有者 `tasks.ts`；网站操作集中在 `adapters/`，CLI 协议在 `agents/`，截图在 `capture/` 与 `native/`。本地界面在 `src/renderer/`，受限 IPC 在 `src/preload/`。

## 许可

Lasso 采用 [MIT 许可证](LICENSE)。第三方依赖、字体、品牌素材及内置提示词遵循各自的许可；复用说明见 [开源复用](docs/open-source.md) 和 [提示词署名](assets/third-party-prompts.txt)。
