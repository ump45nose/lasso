# 开源复用

## selection-hook 2.1.2 · MIT

上游：https://github.com/0xfullex/selection-hook

直接依赖 npm 包及其 macOS arm64 N-API 预编译模块，不复制或改造取词引擎。API、许可与坐标语义以安装版本内的 `index.d.ts`、`docs/API.md`、`docs/GUIDE.md` 和 `LICENSE` 为准。

- macOS 优先使用辅助功能 API，需用户授予辅助功能权限。
- 上游默认开启复制兜底；本应用明确传入 `enableClipboard: false`，只有用户勾选兼容选项才开启。
- macOS 坐标已是逻辑点，不再做 Retina 缩放。
- `programName` 在 macOS 是应用 bundle identifier，保留用于后续按应用补充提示词。
- Chrome / Electron 未暴露辅助功能树时，上游会尝试开启其辅助功能支持，当前首次划词可能取不到，后续选择才生效；这会增加目标应用的辅助功能树开销。
- 不开启高频鼠标移动事件；不记录键盘输入。只用 Escape 隐藏动作条。

预编译包必须保持为外部依赖，主进程构建使用 `--external:selection-hook`，不能将其打进单个 JavaScript 文件后丢失 `.node` 模块路径。

## 网页适配

Electron 的 `WebContents.insertText` 向真实网页编辑器填入纯文本，不使用剪贴板或 URL 参数。ChatGPT 的编辑器定位与提交判据集中在 `src/main/adapters/chatgpt.ts`；网站结构不是公开稳定 API，变化时应在这一处修正。

React、Electron、Lucide 沿用各自 npm 包与许可；未引入 PopClip 商业依赖，也没有实现 PopClip 扩展格式。

## 多任务与回收

沿用 Electron 的 [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view) 和原生 Menu，不新增标签页框架。每个任务持有独立 WebContents，共享已有持久化登录分区。后台页面关闭节流，只有通过回收条件和恢复检查后才关闭 WebContents。

ChatGPT 完成状态依据当前页面明确的 `data-talvt-turn-state=complete`；最新回答用 `data-chatgpt-selection-message-id` 对照恢复页，并检查浏览器资源时序中最新的对应历史请求成功。只观察网站自己的请求，不自行获取令牌或调用私有接口。停止按钮、待确认界面、草稿及附件优先保护。网站不再提供这些标记时不回收，在适配器集中更新。隔离世界仅记录交互时间与页面状态，不向网站开放本地 IPC。
