# 创建父任务三时间字段方案（探店日期 / 探店时间段 / 问卷最终截止）

> 状态：方案稿，未实施。日期：2026-08-13。
> 需求：创建父任务时设置三个时间：①探店日期 ②探店时间段 ③问卷最终截止日期时间。

## 0. 现状（已调研）

| 项 | 现状 |
|---|---|
| 数据模型 | `audit_campaigns.starts_at / due_at`（父任务整体窗口）；`audit_assignments.starts_at / due_at`（个人窗口，须落在父窗口内，batch2:382/424 校验） |
| 契约 | `CampaignWriteSchema`：startsAt / dueAt 两个 datetime（无日期/时段/截止拆分） |
| 提交时限 | batch3:143 `assignmentRow.due_at <= now()` → TASK_OVERDUE（**提交截止 = 探店结束时间**，探员探店结束后无法再补录问卷） |
| 逾期推进 | worker `advanceCampaignOverdue`：`assigned/in_progress AND due_at 过期` → overdue |

**差距**：没有"问卷最终截止"概念——探店结束（due_at）即提交超时；表单也没有日期/时间段/截止的拆分布局。

## 1. 语义映射（核心设计）

| 用户字段 | 落库 |
|---|---|
| 探店日期（date） | 与时间段合并 → `campaigns.starts_at = 日期 + 时段开始` |
| 探店时间段（time range） | `campaigns.due_at = 日期 + 时段结束`（复用现有列） |
| 问卷最终截止（datetime） | **新列 `campaigns.questionnaire_deadline_at`**（必须 ≥ due_at，可晚于探店结束） |

- `starts_at/due_at` 语义保持"探店执行窗口"（打卡/开始任务校验、逾期推进继续使用）；
- `questionnaire_deadline_at` 语义：**探员提交问卷（含菜品/小票/其他记录）的最晚时限**——探店结束后仍可在截止前补录提交；
- 个人分配（assignment）创建时**继承**父任务的问卷截止（不做个人覆盖，保持简单）。

## 2. 数据模型（migration 0024）

```sql
ALTER TABLE audit_campaigns
  ADD COLUMN questionnaire_deadline_at timestamptz,          -- 存量可空；新创建必填
  ADD CONSTRAINT campaign_deadline_after_due CHECK (questionnaire_deadline_at IS NULL OR questionnaire_deadline_at >= due_at);
ALTER TABLE audit_assignments
  ADD COLUMN questionnaire_deadline_at timestamptz;          -- 创建时继承 campaign
```

## 3. 行为改动

| 位置 | 现状 → 新 |
|---|---|
| **提交时限**（batch3:143） | `assignment.due_at 过期` → **`assignment.questionnaire_deadline_at 过期`**（消息改为"问卷已过最终截止时间"） |
| **逾期推进**（campaign-state.js） | `assigned/in_progress AND due_at 过期 → overdue` → 拆分：`assigned AND due_at 过期`（探店时段过而未开始）或 `in_progress AND questionnaire_deadline_at 过期`（已开始但问卷超期）→ overdue |
| **开始任务**（batch3 start） | 不变（仍用 starts_at/due_at 校验探店时段） |
| **创建/编辑父任务**（batch2） | INSERT/UPDATE 写 `questionnaire_deadline_at`；assignment 创建继承 |
| **个人窗口校验**（382/424） | 不变（探店窗口仍须在父窗口内）；deadline 继承无需校验 |
| **任务列表/详情** | 透出 questionnaireDeadlineAt（前端展示） |

## 4. 契约（packages/contracts）

```js
CampaignWriteSchema += {
  questionnaireDeadlineAt: z.string().min(1, "请选择问卷最终截止时间"),
}
// superRefine 增加：deadlineAt 必须 ≥ dueAt
CampaignRowSchema / CampaignDetailSchema += questionnaireDeadlineAt: z.string().nullable().optional()
```

前端提交时组装：`startsAt = 日期 + 时段开始`、`dueAt = 日期 + 时段结束`、`questionnaireDeadlineAt`。

## 5. 管理后台表单（CampaignWizard）

创建/编辑父任务表单改为三个字段：

```
探店日期      [date 选择器]
探店时间段    [开始时间] ~ [结束时间]        （当天；结束 > 开始）
问卷最终截止  [datetime-local]               （必须 ≥ 时段结束）
```

- 保存时组装 startsAt/dueAt/deadlineAt 提交；
- 编辑回显：现有 startsAt/dueAt 拆回日期+时段；deadlineAt 直接回显；
- 校验提示：结束晚于开始、截止不早于时段结束。

## 6. 测试与验收

- **后端集成（独立库）**：三字段创建父任务；deadline < dueAt → 422；assignment 继承 deadline；**due_at 后、deadline 前提交成功**（探店结束补录问卷）；deadline 后提交 409/422；worker 逾期推进（assigned+due 过 → overdue；in_progress+deadline 过 → overdue；in_progress+due 过但 deadline 未过 → 不逾期）；
- **前端**：build + E2E（任务表单三字段回显/校验）；
- **手动验收**：建任务（日期=今天、时段 10:00-14:00、截止=今天 20:00）→ 探员 14:00 后仍可提交问卷 → 20:00 后提交被拒。

## 7. 兼容与边界

- 存量父任务 `questionnaire_deadline_at = NULL` → 提交时限回退到 `due_at`（旧行为，兼容）；
- 存量 assignment NULL → 继承父任务值或回退 due_at；
- 问卷截止用于**提交**时限；打卡/开始任务仍按探店窗口（due_at）——"探店时段过而未开始"仍算逾期。

## 8. 待确认

1. 问卷截止是否允许跨天（如探店当天 10-14 点，截止次日 12:00）？——设计允许（无限制），仅要求 ≥ 时段结束；
2. 个人分配是否需要单独覆盖问卷截止？——设计为继承（不覆盖），如需可按同样方式扩展。
