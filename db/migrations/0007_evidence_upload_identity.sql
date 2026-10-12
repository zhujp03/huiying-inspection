ALTER TABLE question_evidence_attachments
  ADD COLUMN client_file_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN upload_nonce uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN declared_content_type text NOT NULL DEFAULT 'application/octet-stream',
  ADD COLUMN declared_size_bytes bigint NOT NULL DEFAULT 1 CHECK (declared_size_bytes BETWEEN 1 AND 10485760),
  ADD COLUMN upload_target_expires_at timestamptz;

ALTER TABLE question_evidence_attachments
  ADD CONSTRAINT question_evidence_attachments_session_client_file_uq UNIQUE (edit_session_id, client_file_id),
  ADD CONSTRAINT question_evidence_attachments_upload_nonce_uq UNIQUE (upload_nonce);
