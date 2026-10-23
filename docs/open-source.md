# 开源复用

## selection-hook 2.1.2 · MIT

上游：https://github.com/0xfullex/selection-hook

直接依赖 npm 包及其 macOS arm64 N-API 预编译模块，不复制或改造取词引擎。API、许可与坐标语义以安装版本内的 `index.d.ts`、`docs/API.md`、`docs/GUIDE.md` 和 `LICENSE` 为准。

- macOS 优先使用辅助功能 API，需用户授予辅助功能权限。
- 上游默认开启复制兜底；本应用明确传入 `enableClipboard: false`，只有用户勾选兼容选项才开启。
- macOS 坐标已是逻辑点，不再做 Retina 缩放。
- `programName` 在 macOS 是应用 bundle identifier，用于按应用匹配额外提示词。
- Chrome / Electron 未暴露辅助功能树时，上游会尝试开启其辅助功能支持，当前首次划词可能取不到，后续选择才生效；这会增加目标应用的辅助功能树开销。
- 不开启高频鼠标移动事件；不记录键盘输入。只用 Escape 隐藏动作条。

预编译包必须保持为外部依赖，主进程构建使用 `--external:selection-hook`，不能将其打进单个 JavaScript 文件后丢失 `.node` 模块路径。

## 网页适配

Electron 的 `WebContents.insertText` 向真实网页编辑器填入纯文本，不使用剪贴板或 URL 参数。ChatGPT 的编辑器定位与提交判据集中在 `src/main/adapters/chatgpt.ts`；网站结构不是公开稳定 API，变化时应在这一处修正。

React、Electron、Lucide 沿用各自 npm 包与许可；未引入 PopClip 商业依赖，也没有实现 PopClip 扩展格式。

## 多任务与回收

沿用 Electron 的 [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view) 和原生 Menu，不新增标签页框架。每个任务持有独立 WebContents，共享已有持久化登录分区。后台页面关闭节流，只有通过回收条件和恢复检查后才关闭 WebContents。

ChatGPT 完成状态依据当前页面明确的 `data-talvt-turn-state=complete`；最新回答用 `data-chatgpt-selection-message-id` 对照恢复页，并检查浏览器资源时序中最新的对应历史请求成功。只观察网站自己的请求，不自行获取令牌或调用私有接口。停止按钮、待确认界面、草稿及附件优先保护。网站不再提供这些标记时不回收，在适配器集中更新。隔离世界仅记录交互时间与页面状态，不向网站开放本地 IPC。

## CLI、聊天展示与打包

- Codex：调用已安装 CLI 的官方 app-server 协议，不复制其执行引擎。
- Pi：调用已安装 `@earendil-works/pi-coding-agent` 的 RPC；以随包文档为准，参考其客户端与 CodexHost 的原生接口边界，未复制 CodexHost 产品代码。
- react-markdown / remark-gfm：MIT，渲染 Markdown 与表格，不启用任意 HTML。
- @electron/packager：BSD-2-Clause，生成固定应用身份的 macOS 包。
- Gemini 选择器独立封装，上传共用 Electron CDP 文件输入能力。图片入口不依赖某个截图软件或付费功能。

## S1 截图与区域候选

- Electron desktopCapturer：沿用现有 Electron，按显示器匹配取图；CoreGraphics/AX 的薄 N-API 桥接仅返回窗口和界面矩形。桥接随主应用签名，不创建另一款需独立授权的工具。
- edge_det 0.1.3（Apache-2.0）：直接依赖 npm 包，编入独立工作线程，参数参考 eSearch 的视觉候选实现；不是完整区域识别引擎。
- 同色连通区域、候选合并与截图交互由本项目实现。S1 没有复制 eSearch 的 GPL 标注代码；后续提取标注时另行保留其许可。
- 原尺寸图片登记扩展现有 Images，不更改剪贴板读取契约。识别使用缩小副本，输出从原图裁剪。
