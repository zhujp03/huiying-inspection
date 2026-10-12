-- 管理后台数据看板：提交时物化逐题得分明细（含历史回填），支撑按月/门店/分类/考核点的得分率聚合。
-- 口径与提交校验一致：只统计启用题（enabled）；得分率 = SUM(awarded_score) / SUM(max_score)。
CREATE TABLE submission_question_scores (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES submission_versions(id) ON DELETE CASCADE,
  question_id uuid NOT NULL,
  question_key text NOT NULL,
  question_number integer NOT NULL CHECK (question_number >= 1),
  question_text text NOT NULL,
  category text NOT NULL,
  answer text NOT NULL CHECK (answer IN ('scored', 'unscored')),
  awarded_score integer NOT NULL CHECK (awarded_score >= 0),
  max_score integer NOT NULL CHECK (max_score >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, question_id)
);
CREATE INDEX submission_question_scores_question_idx ON submission_question_scores(question_id);
CREATE INDEX submission_question_scores_category_idx ON submission_question_scores(category);

-- 历史提交回填：从 question_answers × questions 还原逐题明细（幂等，可重跑）。
INSERT INTO submission_question_scores (id, submission_id, question_id, question_key, question_number, question_text, category, answer, awarded_score, max_score)
SELECT gen_random_uuid(), sv.id, q.id, q.question_key, q.question_number, q.text, q.category, qa.answer, qa.awarded_score, q.max_score
FROM submission_versions sv
JOIN question_answers qa ON qa.attempt_id = sv.attempt_id
JOIN questions q ON q.id = qa.question_id AND q.version_id = sv.questionnaire_version_id AND q.enabled
ON CONFLICT (submission_id, question_id) DO NOTHING;

CREATE INDEX submission_versions_submitted_at_idx ON submission_versions(submitted_at);

-- 数据看板导出复用 export_jobs 异步链路，job_kind 区分提交导出与看板统计导出。
ALTER TABLE export_jobs ADD COLUMN job_kind text NOT NULL DEFAULT 'submissions';

-- 新权限码补种（存量库已 seed 过，迁移内幂等补插；rbac.mjs 种子同步维护）。
INSERT INTO permissions (id, code, name) VALUES (gen_random_uuid(), 'stats:read', '查看数据看板') ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
CROSS JOIN (SELECT id FROM permissions WHERE code = 'stats:read') p
WHERE r.code IN ('admin', 'super_admin', 'operations_admin')
ON CONFLICT DO NOTHING;
