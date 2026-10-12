CREATE TABLE object_reconciliation_runs (
  id uuid PRIMARY KEY,
  policy_version text NOT NULL CHECK (length(trim(policy_version)) BETWEEN 1 AND 100),
  status text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  locked_by uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  sampled_count integer NOT NULL DEFAULT 0 CHECK (sampled_count >= 0),
  matched_count integer NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  mismatch_count integer NOT NULL DEFAULT 0 CHECK (mismatch_count >= 0),
  error_code text,
  CHECK (matched_count + mismatch_count <= sampled_count),
  CHECK ((status='running') = (completed_at IS NULL)),
  CHECK ((status='failed') = (error_code IS NOT NULL))
);
CREATE INDEX object_reconciliation_runs_daily_idx ON object_reconciliation_runs(policy_version,status,started_at DESC);
