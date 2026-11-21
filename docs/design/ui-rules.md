# Lasso 界面规则

所有界面改动都要遵守本文。`npm run build` 会运行 `scripts/check-ui.mjs`，静态检查其中能机器判断的部分；其余靠 `npm run ui:shots` 截图自查。视觉基准是 [`docs/design/v4/index.html`](v4/index.html) 与 [`docs/design/v4/v4.css`](v4/v4.css)，v5 在此基础上加入手绘图标与更完整的动效（见下文「图标」「动效」）。规则服务于好看：确有更好看的做法时可以突破，但要在全局保持一致。

## 气质

纸上的套索：暖白纸面（`#FAF9F5`）、墨色文字（`#141413`）、克制的陶土色强调（`#D97757`）、衬线标题与长文 + 无衬线控件。克制、安静、贴近内容。不要渐变、霓虹、玻璃拟态、彩色阴影或大圆角卡片堆叠，也不要 emoji 和装饰性插图。

## 颜色与陶土色预算

- 只用 `src/renderer/styles/tokens.css` 里的令牌：纸面 `--bg` `--surface` `--sunken` `--sand` `--oat` `--desk`，墨色 `--ink` … `--ink-6`，线条 `--line*`，强调 `--clay*`，语义色 `--olive` `--danger*`，墨底色 `--on-ink*`。
- 需要透明度时写成令牌底色加 alpha，例如 `rgba(20, 20, 19, 0.5)`（ink）、`rgba(250, 249, 245, 0.1)`（ivory）。检查脚本只认令牌底色、纯白和纯黑。
- 缺少某个颜色时，先在 `tokens.css` 里加语义令牌，再引用它。不要在组件里写十六进制色值。TSX 里不写颜色，通过 class 引用。
- **陶土色克制但不吝啬：**
  - 大块实心 `--clay` 留给主按钮（发送、复制译文、开始生成）、墨色表面的悬停与高优状态（剪切待移条、专注倒计时）。
  - 手绘图标里的一小处陶土点缀是图标的一部分，不计入预算。
  - 开关（`.l-switch`）和复选框打开态使用 `--ink`，分段控件当前项使用白色纸片（`--surface`）落于 `--sand` 底槽。
- **交互反馈：**
  - 浅色纸面：悬停用 `--clay-wash` + `--clay-ink`，选中或按下用 `--clay-wash-2`，描边用 `--clay-line`。不用灰色悬停。
  - 墨色表面（动作条、刘海看板、访达面板、截图与贴图工具条）：悬停是实心 `--clay` 配白字，按下是 `--clay-press`，激活开关是 `--clay` 图标/文字。不要在墨色上叠半透明陶土。

## 字体分工（v4 核心规则）

- `font-family` 只能写 `var(--font-display | --font-text | --font-ui | --font-mono)`。用户可以在设置里改字体，不要写死字体名。
- **`--font-display` / `--font-text`（衬线，默认 `Anthropic Serif Text`）**：只用于页面大标题（18–26px，`font-weight: 400`）、空状态主标题、以及 AI 回答正文和翻译译文（15–16px，行高 1.75，永不加粗）。
- **`--font-ui`（无衬线，默认 `Anthropic Sans`）**：用于全部按钮、标签、菜单、列表、表单、状态说明（12 / 12.5 / 13.5 / 14px）。
- **`--font-mono`（等宽，默认 `JetBrains Mono`）**：用于数字、尺寸、计时、耗时、快捷键、路径与代码（`tabular-nums`）。

## 组件与图标

- **先复用**：`Segmented`（滑块分段控件）、`Glide`（共享 layoutId 的滑动高亮）、`Switch`（`.l-switch` 开关，`src/renderer/Switch.tsx`）、`.l-btn`、`.l-ghost`、`Badge`、`BrandMark`。
- **图标一律从 `src/renderer/icons` 引入，不直接引 `lucide-react`。** 默认是手绘风格（墨线略带手抖、留缺口，加一处陶土点缀），设置里可切回 lucide 线性风格（`Settings.iconStyle`）。按钮里统一 14–16px。
  - 新增图标：在 `icons/index.tsx` 加 lucide 对应项，在 `icons/sketch/*.tsx` 画 24×24 的手绘版本。墨线不带 class；点缀用 `ska`（描边）/ `skf`（填充）/ `skm`（底层马克笔）。纯功能符号（关闭、勾、箭头、折叠）不加点缀。
  - 图标落在实心陶土底上时，把该状态的选择器加进 `icons/icons.css` 的反色规则，点缀改为墨色。
  - 动作条动作图标用 `ActionIcon`，可选集合是 `ACTION_ICON_IDS`。
  - 不要在其他地方写内联 `<svg>`；品牌标记用 `BrandMark`。
- **渠道图标只用官方素材**，放在 `src/renderer/assets/targets/<target>.png|svg`；API 渠道使用 `Zap` / `Image` 图标。
- **不用系统原生菜单、`<select>` 和对话框：**
  - 菜单、下拉选择、确认都在窗口内绘制。需要确认时用原地二次确认（点一次变危险色，再点一次执行），不用 `confirm()` / `alert()` / `prompt()`。
  - 例外只有系统菜单栏托盘菜单和应用菜单栏本身。
- 图标按钮必须有 `aria-label`。

## 布局与动效

- 关键状态、错误、待办直接可见；次要信息按需展开，无用信息删除。
- 圆角：窗口 12–14px，胶囊和工具条 10–13px，按钮 7–8px，卡片 10–12px。阴影用 `--shadow-*` 令牌。
- 浮层（工具条、菜单、提示）靠近边缘时翻到另一侧或贴边内收，不超出窗口或屏幕。
- 动效用 `motion/react` 和 `src/renderer/motion.tsx` 预设（`spring`、`rise`、`pop`、`collapse`）；悬停、按下和颜色过渡交给 CSS（`--t-fast` / `--t-base` / `--t-slow`、`--ease-out`）。
- **v5 动效语汇**（统一使用，不各自发明）：
  - 出现：浮层与窗口内容轻弹放大（`pop` / `rise`）；列表与按钮组依次进入，每项错开 20–40ms，最多错开 8 项。
  - 图标描线：浮层出现时给主图标容器加 `sk-draw`，图标线条一笔笔描出，点缀最后弹出；用 `--sk-delay` 错开。
  - 悬停：工具条、列表里的图标按钮加 `sk-wiggle`，图标轻晃一下；高亮底块用 `Glide` 弹簧滑动跟随。
  - 按下：缩到 95–96%；关闭只做 100ms 内淡出。
  - 尊重系统「减少动态效果」（`tokens.css` 已统一处理）。
- **质感**：墨色表面加 1px 顶部内高光（`inset 0 1px 0 rgba(250, 249, 245, 0.07)`）和分层阴影；纸面卡片用细线 + 柔和阴影；留白宁多勿挤，标题用衬线。

## 自查流程（每次改界面都要做）

1. `npm run build`：类型检查、UI 规则检查和构建都要通过。
2. `npm run ui:shots`：截取全部窗口与状态保存到 `outputs/ui-shots/`，逐张打开对照 v4 设计稿检查字体分工、陶土色克制、对齐和截断。
3. 新增界面或状态同步补进 `scripts/ui-shots/run.mjs`。
4. 报告时区分截图实测与需在打包版手动验收的系统能力（屏幕录制、划词、网页交互、跨应用粘贴）。
