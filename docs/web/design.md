# H5 探员端设计系统（design.md）

> 三阶段流水线第 2 段产物。视觉契约来源：`apps/miniapp/miniprogram/app.wxss`、`app.json`、各页 `index.wxss`（只读提取，rpx→px 按 2:1 换算，375px 逻辑宽基准）。
> 落地文件：`src/design/tokens.css`（design tokens）、`src/design/base.css`（基础+组件皮肤）、`src/design/components.jsx`（组件结构）。本文档是三者之上的**唯一视觉法律**：改动必须先改本文。

---

## 0. 设计原则

1. **品牌一致**：与小程序同品牌（主色 `#f25f42`「汇盈红」、墨色标题 `#26272a`、浅灰底 `#f6f7f8`）；不引入小程序没有的颜色与形状语言。
2. **移动优先**：主目标 ≤480px 竖屏；兼容至 768px（>480px 时应用限宽 480px 居中，两侧留白）。
3. **Web 触控优化**：所有可交互元素命中区 ≥44px（小程序 88rpx 主按钮恰为 44px，天然对齐）；底部导航与固定操作栏 respect `env(safe-area-inset-bottom)`。
4. **零域名（R0）**：设计层不含任何外部资源地址；图标用字符符号实现（第 3 段如需升级为 SVG，需保持同语义）。
5. **骨架阶段纪律**：组件只承载结构与状态位，不承载业务逻辑；数据经 props 注入，回调由页面透传。

## 1. Design Tokens（src/design/tokens.css）

### 1.1 色彩（值 = 小程序实取）

| Token | 值 | 来源 |
|---|---|---|
| `--hy-primary` | `#f25f42` | 主色：tab 选中（app.json selectedColor）、主按钮、eyebrow、active chip |
| `--hy-primary-disabled` | `#f2a18f` | 主按钮禁用（app.wxss `.primary[disabled]`） |
| `--hy-primary-tint` | `#fff0ec` | 主色浅底（`.tag`） |
| `--hy-ink` | `#26272a` | 主文本 / dark 徽标底 / 首页 Hero 底 |
| `--hy-ink-secondary` | `#5f6369` | 次级文本（`.secondary` 按钮、neutral 徽标） |
| `--hy-ink-tertiary` | `#70747b` | 弱文本（`.muted`、muted 徽标） |
| `--hy-ink-hint` | `#9a9da3` | 流程条未激活 label |
| `--hy-ink-faint` | `#c8c9cc` | Hero 副文案 |
| `--hy-bg-page` | `#f6f7f8` | 页面底（app.wxss `page`） |
| `--hy-bg-input` | `#f7f7f7` | 输入底（`.input`；app.json backgroundColor） |
| `--hy-bg-card` | `#ffffff` | 卡片/导航/主按钮文字 |
| `--hy-bg-neutral` | `#eef0f2` | neutral 徽标底 |
| `--hy-bg-muted` | `#f0f1f2` | muted 徽标底 |
| `--hy-bg-secondary` | `#eceeef` | 次按钮底 |
| `--hy-border-card` | `#ededed` | 卡片描边 |
| `--hy-border-input` | `#dedfe2` | 输入描边 |
| `--hy-border-light` | `#e6e7ea` | chip 描边/流程条底轨 |
| `--hy-border-hairline` | `#e8e9eb` | 分隔线（= 骨架色） |
| `--hy-danger` | `#c83e2b` | 行内错误 |
| `--hy-danger-strong` | `#d9482f` | tag 文字 |
| `--hy-warning` | `#b45309` | 警示文字（逾期/审核中徽标） |
| `--hy-warning-bg` | `#fdf1e3` | 警示底 |
| `--hy-skeleton` | `#e8e9eb` | 骨架屏 |
| `--hy-chevron` | `#b7bac0` | 箭头 |
| `--hy-tab-inactive` | `#8a8d92` | tabBar 未选中（app.json color） |
| `--hy-mask` | `rgba(38,39,42,0.55)` | Toast 蒙层文字底 |

### 1.2 字号（rpx→px 2:1）

| Token | 值 | 用途 |
|---|---|---|
| `--hy-font-title` | 21px（42rpx） | 页面主标题（.title / schedule-title） |
| `--hy-font-section` | 16px（32rpx） | 区块标题/空态标题 |
| `--hy-font-body` | 14px（28rpx） | 正文/按钮 |
| `--hy-font-md` | 13px（26rpx） | 输入/说明/Toast |
| `--hy-font-sm` | 12px（24rpx） | 辅助说明 |
| `--hy-font-xs` | 11px（22rpx） | eyebrow/徽标 |

### 1.3 圆角 / 间距 / 尺寸

- 圆角：卡片 10px（20rpx）、按钮/输入 6px（12rpx）、徽标 4px（8rpx）、chip 999px。
- 间距：页面左右 12px（24rpx）；卡片间距 9px（18rpx）；表单项 13px（26rpx）。
- 尺寸：命中底线 `--hy-touch: 44px`；主按钮 44px（88rpx）；chip 28px（56rpx）；tabbar 50px；头像 52px（104rpx）；`--hy-page-bottom: calc(80px + safe-area)`（160rpx）避让 tabbar。
- 动效：`--hy-transition: 120ms ease`（tap-feedback）；`--hy-toast-duration: 2400ms`。
- 字体栈：`-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif`（app.wxss page 同栈）。

## 2. 导航架构

### 2.1 底部三 Tab（与小程序 tabBar 一致）

| 项 | 路由 | 文案 | 图标 |
|---|---|---|--- |
| home | `/home` | 首页 | ◎ |
| schedule | `/schedule` | 日程 | ▤ |
| profile | `/profile` | 我的 | ◍ |

选中色 `#f25f42` / 未选中 `#8a8d92`（app.json tabBar 原值）。tab 页不设返回栏。

### 2.2 非 tab 页顶栏（page-nav）

左返回（‹）、居中标题、右侧动作位；替代小程序默认导航栏（dishes/other 用自定义导航的对齐）。

## 3. 组件清单（components.jsx ↔ base.css ↔ 小程序对照）

| 组件 | Props（骨架阶段） | 小程序对应 |
|---|---| `.card` `surface-card` |
|---|---|---|
| Card | flush/gapless | `.card` / `.surface-card` |
| SectionHeading / Eyebrow / Muted | children | `.section-heading` / `.eyebrow` / `.muted` |
| Button | variant: primary/outline/secondary/link/danger, block, small, disabled | `.primary` / `.btn-outline` / `.secondary` / `.task-action` 链接色 |
| Field + TextInput / PasswordInput / TextArea | value/onChange/onFocus/onBlur/error/focusMark | `.field` / `.input` / 眼睛切换（login wxml:42） / `.textarea` |
| StatusBadge | tone: primary/dark/warning/neutral/muted | `.status-badge.*` 五 tone（app.wxss:24-29） |
| Skeleton | variant: line/short/mid/tag/btn/date/card | `.skeleton` 系列 |
| EmptyState | title/desc/action | `.empty-state` |
| ErrorState | title/message/onRetry/secondary | 首页/日程页完整错误卡 |
| ErrorBar | message/onRetry | `.schedule-error-bar` 非阻塞条 |
| Toast | message/visible | wx.showToast 等价结构位 |
| TabBar | active/onNavigate | tabBar（app.json:21-46） |
| PageNav | title/onBack/right | 导航栏（dishes/other 自定义导航） |
| FlowSteps | current: survey/dishes/other | `.flow-steps`（app.wxss:38-48） |
| FilterChips | chips/onselect | `.schedule-chip` |
| ListRow | label/onClick | `.profile-link-row` |
| NoticeBar | children | `.task-note` 提示条 |

## 4. 页面级视觉规则

- **首页 Hero**：墨色卡（`#26272a` 底白字，圆角 10px）——「汇盈探店」+「探店员工作台」，对齐小程序 home-hero。
- **登录页**：纯白底居中品牌区（红底「汇」logo 块 + 「汇盈探店」），对齐 login wxss 的 `.auth-brand`。
- **状态位渲染纪律**：每页按 inventory 的区块划分渲染 loading（骨架）/ error（阻断卡或非阻塞条）/ empty / content 互斥状态位；占位文案取小程序同语义文案。
- **门控挂载点**：login 页自助区块（注册/找回/重交）与 dishes 页 OCR 面板为独立子树，由第 3 段接 feature-flags 求值显隐；本阶段默认渲染结构并留 `data-gate="authSelfService" / "receiptOcr"` 标记。

## 5. 桌面适配（>480px）

- `.app-shell` 限宽 480px 居中，两侧留白并描 1px 边；主目标仍为竖屏手机。
- 底部 tabbar 内容同步限宽 480px 居中，不随视口拉伸。

## 6. 无障碍与触控

- 可交互元素 ≥44px 命中；图标按钮带 `aria-label`。
- 输入 font-size 16px 防 iOS 聚焦缩放。
- Toast `role="status" aria-live="polite"`。

## 7. 阶段边界（对第 3 段的移交说明）

- 组件无内部状态（Toast 的 visible 仅占位）；一切显隐由页面状态驱动。
- 图标暂用字符符号；如第 3 段引入 SVG 图标库，必须保持 tab 三项与页内语义不变。
- `TabBar`/`PageNav` 的导航回调 `onNavigate/onBack` 由路由壳注入（hash 路由），与 app-manifest 的 pages/tabs 声明对应。
