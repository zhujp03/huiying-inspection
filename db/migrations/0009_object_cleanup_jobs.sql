CREATE TABLE object_cleanup_jobs (
  id uuid PRIMARY KEY,
  attachment_id uuid NOT NULL UNIQUE REFERENCES question_evidence_attachments(id) ON DELETE RESTRICT,
  storage_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'retryable_failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_by uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'running') = (locked_by IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status = 'succeeded') = (completed_at IS NOT NULL))
);

CREATE INDEX object_cleanup_jobs_lease_idx
  ON object_cleanup_jobs(status, next_attempt_at, lease_expires_at, created_at);
