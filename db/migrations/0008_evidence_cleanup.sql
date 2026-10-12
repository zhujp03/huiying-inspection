ALTER TABLE question_evidence_attachments
  ADD COLUMN cleanup_after timestamptz;

CREATE INDEX question_evidence_attachments_cleanup_idx
  ON question_evidence_attachments(cleanup_after)
  WHERE status = 'deleted' AND cleanup_after IS NOT NULL;
