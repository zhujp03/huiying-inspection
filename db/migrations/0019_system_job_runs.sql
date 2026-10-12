-- 系统任务运行记录：worker 心跳、数据库备份完成、保留清理等只读运维指标的数据源。
-- 只保存聚合/脱敏信息，不保存业务敏感值。
CREATE TABLE system_job_runs (
  id uuid PRIMARY KEY,
  job text NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  detail_json jsonb,
  CHECK (job IN ('worker_heartbeat', 'database_backup', 'restore_drill', 'retention', 'object_reconciliation'))
);

CREATE INDEX system_job_runs_job_completed_idx ON system_job_runs (job, completed_at DESC);
CREATE INDEX system_job_runs_heartbeat_idx ON system_job_runs (heartbeat_at DESC);
