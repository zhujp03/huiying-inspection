# 后台布局修复方案（68px 残留 + 问卷编辑器重构）

> 状态：方案稿，未实施。日期：2026-08-13。
> 问题：顶部工具栏已删除但 CSS 仍按"顶部 68px"布局（`calc(100dvh - 68px)`/`top: 68px`），后台整体悬空；`admin-content` 1440px 限宽导致超宽屏留白；新建问卷编辑器 grid 结构错误、行高过小、固定 670px。

## 1. 现状核实（已确认）

| 位置 | 问题 |
|---|---|
| `styles.css:227-228` | `.admin-shell`/`.admin-sidebar` 用 `calc(100dvh - 68px)` + `top: 68px`——顶部工具栏（`.studio-bar` 68px）已不在 DOM → 顶/底 68px 空带 |
| `styles.css:252` | `.admin-content { max-width: 1440px; margin: 0 auto }` → 超宽屏右侧大片空白 |
| `styles.css:28/561` | `.studio-bar` 残留（含移动端媒体查询） |
| `styles.css:316` | `.questionnaire-editor` grid `320px + 1fr` + `min-height: 670px`（新建页/详情页共用） |
| `AdminWorkbench.jsx:317` | 新建页 toolbar 在 `.questionnaire-editor` **容器外** → 掉到左栏下方；题目行 `padding: 6px` 过矮 |

## 2. 全局布局修复（styles.css）

采纳确认后的 CSS：

```css
html, body, #root { min-height: 100%; }
.admin-shell { min-height: 100dvh; }                              /* 去掉 -68px */
.admin-sidebar { top: 0; height: 100dvh; min-height: 100dvh; }   /* 侧栏贯穿全高 */
.admin-main { min-width: 0; min-height: 100dvh; }
.admin-content { width: 100%; max-width: none; margin: 0; padding: 32px clamp(24px, 3vw, 48px); }
```

同时清理：
- 删除 `.studio-bar`（28 行）与移动端媒体查询（561 行）残留；
- 删除 `.admin-topbar__actions` 残留（250-251 行，JSX 无对应元素）；
- `.admin-content` 去限宽后，**表格/问卷编辑器/地图占满可用宽度**；长文本表单（登录卡等）自身已有宽度限制，不受影响。

## 3. 问卷编辑器重构

### 3.1 新建问卷页（JSX 结构调整）

```
<section className="questionnaire-editor">
  <aside>草稿信息（题数统计）</aside>
  <div className="questionnaire-write-main">
    <div className="question-write-list">  题目行列表（flex:1，可滚动）
    <div className="question-write-toolbar">添加题目（N/50）</div>
  </div>
</section>
```

- toolbar **移入 grid 右列**（`questionnaire-write-main` 内），固定列表下方；
- 高度自适应：`height: clamp(480px, calc(100dvh - 210px), 1400px)`（替代固定 670px），`question-write-list { flex: 1; min-height: 0; overflow-y: auto }`；
- 题目行增高：`padding: 10px 12px`，控件 min-height 32px+，复选框与删除按钮可点区域放大。

### 3.2 详情页（题目设置）

- 保持现有结构（aside 题目列表 + `question-editor-panel` 右侧设置），共用 `.questionnaire-editor` grid；
- 同样的高度自适应替换 `min-height: 670px`（`min-height: clamp(...)` 移到容器级）。

## 4. 验收清单

- [ ] 1920×1080、1440×900、1280×720 三档正常；
- [ ] 侧栏从浏览器顶部到底部贯穿，无顶部/底部 68px 空带；
- [ ] 超宽屏内容占满（表格/编辑器/地图不再居中留白）；
- [ ] 新建问卷：题目区占满右列、toolbar 固定在列表下方（不在左栏下）；
- [ ] 题目行控件（输入/下拉/复选/删除）尺寸正常可点；
- [ ] 1280px 以上无横向滚动。

## 5. 影响面

- 仅 `styles.css` + `AdminWorkbench.jsx`（新建页 JSX 结构调整）；
- 后端/契约/小程序零改动；
- 现有 admin E2E（13 项）回归验证，新增 1280/1920 视口检查可后续补。

## 6. 待确认

1. 问卷编辑器高度公式 `calc(100dvh - 210px)`（页面头部+内边距估算）——可接受，或指定固定期望高度；
2. 侧栏是否保留 sticky（内容滚动时侧栏固定）——方案保留 `position: sticky; top: 0` 语义（侧栏本身 100dvh，滚动时视觉固定）。
