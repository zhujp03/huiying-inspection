-- 父任务三时间字段：新增"问卷最终截止时间"（探店结束后仍可在截止前补录提交问卷）。
-- 存量数据允许 NULL（提交时限回退到 due_at，保持旧行为）；新创建必填且 >= due_at。
ALTER TABLE audit_campaigns
  ADD COLUMN questionnaire_deadline_at timestamptz,
  ADD CONSTRAINT campaign_deadline_after_due CHECK (questionnaire_deadline_at IS NULL OR questionnaire_deadline_at >= due_at);

-- 个人分配继承父任务问卷截止（探员提交时限按此判断）
ALTER TABLE audit_assignments
  ADD COLUMN questionnaire_deadline_at timestamptz;
