CREATE TABLE legal_holds (
  id uuid PRIMARY KEY,
  subject_type text NOT NULL CHECK (subject_type IN ('submission','user')),
  subject_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL DEFAULT now(),
  hold_until timestamptz NOT NULL,
  released_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  released_at timestamptz,
  release_reason text,
  CHECK (requested_by<>approved_by),
  CHECK (hold_until>starts_at),
  CHECK ((released_at IS NULL) = (released_by IS NULL)),
  CHECK (released_at IS NULL OR length(trim(release_reason)) BETWEEN 1 AND 1000)
);
CREATE INDEX legal_holds_active_idx ON legal_holds(subject_type,subject_id,hold_until) WHERE released_at IS NULL;

CREATE TABLE retention_runs (
  id uuid PRIMARY KEY,
  policy_version text NOT NULL CHECK (length(trim(policy_version)) BETWEEN 1 AND 100),
  status text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  locked_by uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  counts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  CHECK ((status='running') = (completed_at IS NULL)),
  CHECK ((status='failed') = (error_code IS NOT NULL))
);
CREATE INDEX retention_runs_claim_idx ON retention_runs(status,lease_expires_at,started_at);
