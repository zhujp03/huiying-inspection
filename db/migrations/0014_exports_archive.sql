CREATE TABLE export_jobs (
  id uuid PRIMARY KEY,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scope_snapshot_json jsonb NOT NULL,
  filters_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','processing','succeeded','failed','expired')),
  storage_key text UNIQUE,
  file_name text,
  failure_code text,
  locked_by uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz,
  CHECK ((status='processing') = (locked_by IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status='succeeded') = (storage_key IS NOT NULL AND file_name IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX export_jobs_claim_idx ON export_jobs(created_at,id) WHERE status='queued';

CREATE TABLE archive_restore_jobs (
  id uuid PRIMARY KEY,
  submission_id uuid NOT NULL REFERENCES submission_versions(id) ON DELETE RESTRICT,
  attachment_type text NOT NULL CHECK (attachment_type IN ('evidence','receipt')),
  attachment_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('queued','restoring','ready','failed','expired')),
  restore_expires_at timestamptz,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (submission_id, attachment_type, attachment_id)
);
