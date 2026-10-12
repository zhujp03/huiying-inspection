CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (scope IN ('questionnaire_submit')),
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('processing','succeeded','terminal_failed','retryable_failed')),
  response_status integer,
  response_body_json jsonb,
  failure_code text,
  locked_by uuid,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + INTERVAL '30 days',
  UNIQUE (actor_id, scope, idempotency_key),
  CHECK ((status = 'processing') = (locked_by IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = 'succeeded') = (response_status IS NOT NULL AND response_body_json IS NOT NULL))
);
CREATE INDEX idempotency_keys_recovery_idx ON idempotency_keys(lease_expires_at, id) WHERE status='processing';

CREATE TABLE submission_versions (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE REFERENCES survey_attempts(id) ON DELETE RESTRICT,
  assignment_id uuid NOT NULL REFERENCES audit_assignments(id) ON DELETE RESTRICT,
  campaign_id uuid NOT NULL REFERENCES audit_campaigns(id) ON DELETE RESTRICT,
  questionnaire_version_id uuid NOT NULL REFERENCES questionnaire_versions(id) ON DELETE RESTRICT,
  submitted_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  submitted_at timestamptz NOT NULL,
  total_score integer NOT NULL CHECK (total_score >= 0),
  max_score integer NOT NULL CHECK (max_score > 0),
  issue_count integer NOT NULL CHECK (issue_count >= 0),
  answer_snapshot_json jsonb NOT NULL,
  dish_snapshot_json jsonb NOT NULL,
  other_snapshot_json jsonb NOT NULL,
  evidence_snapshot_json jsonb NOT NULL,
  receipt_snapshot_json jsonb NOT NULL,
  ocr_snapshot_json jsonb NOT NULL,
  integrity_hash text NOT NULL CHECK (integrity_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX submission_versions_assignment_idx ON submission_versions(assignment_id, submitted_at DESC);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY,
  actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  data_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_subject_idx ON audit_logs(subject_type, subject_id, created_at DESC);
