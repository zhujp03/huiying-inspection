# 题目证据配置全栈方案（照片上限 + 录音时长）

> 状态：方案稿，未实施。日期：2026-08-13。
> 需求：每道题创建时可配置是否需要①照片、②录音；需要照片时**每题最多 3 张**；需要录音时**小程序录音最长 10 秒**。全栈全量修改（数据库/契约/后端/探员小程序/管理后台）。

## 0. 现状（已调研）

| 层 | 现状 |
|---|---|
| 数据模型 | `question_evidence_requirements`：evidence_required / image_required / audio_required / image_min_count(0|1) / audio_min_count(0|1)；CHECK 约束 `image_min_count IN (0,1)` |
| 契约 | `EvidenceRequirementWriteSchema` = { evidenceRequired, imageRequired, audioRequired }（无数量/时长） |
| 后端校验 | 编辑会话确认：`image < image_min_count || audio < audio_min_count` 拒绝（batch3:319）；提交：缺必填证据拒绝（batch3:153） |
| 小程序端 | 已支持图片上传 + 录音（RecorderManager）；**上限写死**：图片 ≤9 张、音频 ≤3 段、录音仅下限 1 秒无上限（issue/index.js） |
| 管理后台 | 证据配置只有开关（图片/音频）；创建问卷时题目**不带**证据配置（创建后逐题 PATCH） |

**差距**：数量/时长不可按题配置；小程序上限写死且与需求不符（9 张/3 段 → 应 3 张/10 秒）；创建问卷时不能直接配证据。

## 1. 数据模型（migration 0023）

`question_evidence_requirements` 加两列（默认值兼容存量）：

```sql
ALTER TABLE question_evidence_requirements
  ADD COLUMN image_max_count integer NOT NULL DEFAULT 3 CHECK (image_max_count BETWEEN 1 AND 9),
  ADD COLUMN audio_max_duration_seconds integer NOT NULL DEFAULT 10 CHECK (audio_max_duration_seconds BETWEEN 1 AND 60);
```

- `image_max_count`：每题照片上限（1-9，需求默认 3）；
- `audio_max_duration_seconds`：每题录音上限（1-60，需求默认 10）；
- 存量数据自动获得默认 3 张 / 10 秒；`image_min_count` CHECK 不变。

## 2. 契约（packages/contracts）

```js
// 证据配置扩展（管理端 + 创建问卷共用）
EvidenceRequirementWriteSchema = {
  evidenceRequired, imageRequired, audioRequired,           // 不变
  imageMaxCount: 1..9 默认 3,                                // 新增
  audioMaxDurationSeconds: 1..60 默认 10,                    // 新增
}

// 创建问卷：题目可带证据配置（无需创建后再 PATCH）
QuestionnaireQuestionWriteSchema += evidence?: EvidenceRequirementWriteSchema

// 返回结构（管理端题目、探员端问卷、提交详情）统一扩展：
evidence: { imageRequired, audioRequired, imageMinCount, imageMaxCount, audioMaxDurationSeconds }
```

## 3. 后端（apps/api）

**查询透出**（5 处 SQL + row 映射）：
- batch2 `questionRow`（管理端题目列表）
- batch3 草稿问卷 questions（探员端，38/46 行）
- batch3 提交校验 questions（143 行）
- batch3 编辑会话确认 question（231 行）
- batch3 提交快照 evidence_snapshot（透出配置供回看）

**写路径**：
- PATCH 题目：`evidence` 写入扩展两列；
- POST 创建问卷：接受 `questions[].evidence`，插入 requirements 时带 max 列；
- 发布守卫：`imageMaxCount >= imageMinCount`、duration 范围已由 CHECK 保证。

**强校验（核心新增）**：
| 位置 | 规则 |
|---|---|
| 证据上传 init（batch3:381） | 按 questionId 查配置：① 该题 active/staged 图片数 ≥ imageMaxCount → 409"照片已达上限"；② audio 的 `durationSeconds > audioMaxDurationSeconds` → 422"录音超长" |
| 编辑会话确认（batch3:319） | 数量下限（现有）+ **图片数 ≤ imageMaxCount**、**音频时长 ≤ audioMaxDurationSeconds** → 超限 422 |
| 提交（batch3:153） | 必填下限（现有）+ 上限校验（超限附件拒绝提交） |

## 4. 探员小程序（apps/miniapp）

**issue 页（不得分）**：
- 图片：`wx.chooseMedia count = min(剩余额度, question.evidence.imageMaxCount)`；提示文案改"最多 N 张照片"（N 来自每题配置）；
- 录音：`RecorderManager.start({ duration: audioMaxDurationSeconds * 1000 })`——**到时长自动停止**（onStop 自动触发）；提示文案"录音最长 N 秒"；
- 本地/上传校验均使用每题配置值（不再写死 9/3）；
- 证据是否满足条件判断（`imageRequired` 且至少 1 张成功）保持，加时长/数量上限提示。

**问卷数据流**：`services/api.js` 草稿问卷返回的 `question.evidence` 结构扩展（imageMaxCount/audioMaxDurationSeconds），`store/survey.js` 透传，issue 页读取。

**上传服务**：`services/api.js` evidence upload 调用不变（时长由后端校验，前端提前提示）。

## 5. 管理后台（apps/admin）

**题目编辑器**（QuestionEvidenceEditor）：
- 证据配置区新增两个输入：**照片最多（张，1-9 默认 3）**、**录音最长（秒，1-60 默认 10）**；
- 仅在"需要图片/需要录音"开启时可编辑；保存 PATCH 带扩展字段。

**新建问卷编辑器**（QuestionnaireEditor）：
- 每行题目加证据配置：**照片开关 + 张数**、**录音开关 + 秒数**（默认 3 张 / 10 秒）；
- 创建请求 `questions[].evidence` 随题提交——**创建时即可配好**（用户核心诉求）。

**提交详情**：音频证据展示时长（现有 audio controls + durationSeconds 已有）。

## 6. 测试与验收

- **契约**：扩展字段漂移检查；
- **后端集成测试（独立库）**：配置保存、上传超 3 张 409、录音超 10 秒 422、确认/提交上下限校验、发布守卫；
- **小程序单测**：issue 页上限逻辑（图片 count 计算、录音时长停止）——`tests/unit` 现有 miniapp 业务测试模式；
- **前端**：build + admin E2E（题目编辑器新字段）；
- **手动验收**：后台建题配"照片 3 张 + 录音 10 秒"→ 小程序不得分：上传第 4 张被拦、录音 10 秒自动停止 → 确认/提交通过。

## 7. 兼容与边界

- 存量题目无配置 → 默认 3 张 / 10 秒（新列默认值），行为收紧但合理（之前 9 张/不限时是写死默认）；
- `image_max_count` 上限 9 保留扩展空间；录音 60 秒上限（需求 10 秒为默认）；
- 已提交数据不受影响（快照已存）。
