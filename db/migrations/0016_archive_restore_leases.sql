ALTER TABLE archive_restore_jobs
  ADD COLUMN storage_key text,
  ADD COLUMN storage_version_id text,
  ADD COLUMN locked_by uuid,
  ADD COLUMN locked_at timestamptz,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN completed_at timestamptz;

CREATE INDEX archive_restore_jobs_claim_idx ON archive_restore_jobs(created_at,id) WHERE status IN ('queued','restoring');
