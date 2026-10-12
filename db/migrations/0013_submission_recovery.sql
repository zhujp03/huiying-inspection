ALTER TABLE idempotency_keys
  ADD COLUMN attempt_id uuid REFERENCES survey_attempts(id) ON DELETE RESTRICT;
CREATE INDEX idempotency_keys_attempt_idx ON idempotency_keys(attempt_id, status, lease_expires_at);
