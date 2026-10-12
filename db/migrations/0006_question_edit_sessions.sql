CREATE TABLE question_answer_edit_sessions (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES survey_attempts(id) ON DELETE RESTRICT,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  base_answer_revision bigint NOT NULL CHECK (base_answer_revision >= 0),
  status text NOT NULL CHECK (status IN ('open', 'confirmed', 'cancelled', 'expired')),
  draft_issue_remark text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (id, attempt_id, question_id),
  CHECK (expires_at > created_at),
  CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
CREATE UNIQUE INDEX question_answer_edit_sessions_one_open_uq ON question_answer_edit_sessions(attempt_id, question_id) WHERE status='open';

CREATE TABLE question_evidence_attachments (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES survey_attempts(id) ON DELETE RESTRICT,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  type text NOT NULL CHECK (type IN ('image', 'audio')),
  storage_key text NOT NULL UNIQUE,
  storage_version_id text,
  edit_session_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('staged_uploading', 'staged_ready', 'active', 'failed', 'deleted')),
  mime_type text,
  size_bytes bigint CHECK (size_bytes > 0),
  duration_seconds integer CHECK (duration_seconds BETWEEN 1 AND 60),
  sha256 text,
  verification_locked_by uuid,
  verification_lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, attempt_id, question_id),
  FOREIGN KEY (edit_session_id, attempt_id, question_id) REFERENCES question_answer_edit_sessions(id, attempt_id, question_id) ON DELETE RESTRICT
);
CREATE INDEX question_evidence_attachments_attempt_question_idx ON question_evidence_attachments(attempt_id, question_id, status);

CREATE TABLE question_answer_edit_session_removals (
  edit_session_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  question_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (edit_session_id, attachment_id),
  FOREIGN KEY (edit_session_id, attempt_id, question_id) REFERENCES question_answer_edit_sessions(id, attempt_id, question_id) ON DELETE RESTRICT,
  FOREIGN KEY (attachment_id, attempt_id, question_id) REFERENCES question_evidence_attachments(id, attempt_id, question_id) ON DELETE RESTRICT
);
