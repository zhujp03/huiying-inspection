UPDATE export_jobs SET expires_at = created_at + INTERVAL '7 days' WHERE expires_at IS NULL;
ALTER TABLE export_jobs ALTER COLUMN expires_at SET DEFAULT now() + INTERVAL '7 days';
ALTER TABLE export_jobs ALTER COLUMN expires_at SET NOT NULL;
