-- 0034: 闪光点结构化（多条文字 + 每条可选照片）。
-- 既有 other_records.highlight（单条文字，≤2000）保持不动作为历史兼容列：
-- 新表是结构化真源，旧提交/旧草稿继续可读（迁移纯增量，不回填不改写历史数据）。
-- 照片走与小票/题目证据同构的三步签名直传（init → 直传 → complete），
-- 每条闪光点最多 4 张（display_order 1..4），单张 ≤10MB、jpeg/png。

CREATE TABLE other_record_highlights (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES survey_attempts(id) ON DELETE RESTRICT,
  assignment_id uuid NOT NULL REFERENCES audit_assignments(id) ON DELETE RESTRICT,
  sort_order integer NOT NULL CHECK (sort_order > 0),
  text text NOT NULL DEFAULT '' CHECK (length(text) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (attempt_id, assignment_id) REFERENCES survey_attempts(id, assignment_id) ON DELETE RESTRICT
);
CREATE INDEX other_record_highlights_attempt_idx ON other_record_highlights(attempt_id, sort_order, id);

CREATE TABLE other_record_highlight_photos (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES survey_attempts(id) ON DELETE RESTRICT,
  assignment_id uuid NOT NULL REFERENCES audit_assignments(id) ON DELETE RESTRICT,
  highlight_id uuid NOT NULL REFERENCES other_record_highlights(id) ON DELETE RESTRICT,
  client_file_id uuid NOT NULL,
  display_order integer NOT NULL CHECK (display_order BETWEEN 1 AND 4),
  storage_key text NOT NULL UNIQUE,
  storage_version_id text,
  upload_nonce uuid NOT NULL UNIQUE,
  declared_content_type text NOT NULL CHECK (declared_content_type IN ('image/jpeg','image/png')),
  declared_size_bytes bigint NOT NULL CHECK (declared_size_bytes BETWEEN 1 AND 10485760),
  original_file_name text NOT NULL,
  mime_type text,
  size_bytes bigint CHECK (size_bytes > 0),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('uploading','ready','failed','deleted')),
  verification_locked_by uuid,
  verification_lease_expires_at timestamptz,
  failure_code text,
  upload_target_expires_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (highlight_id, client_file_id),
  UNIQUE (highlight_id, display_order),
  CHECK ((status = 'ready') = (verified_at IS NOT NULL)),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE UNIQUE INDEX other_highlight_photos_sha_uq ON other_record_highlight_photos(highlight_id, sha256) WHERE status <> 'deleted' AND sha256 IS NOT NULL;
CREATE INDEX other_highlight_photos_attempt_idx ON other_record_highlight_photos(attempt_id, status);
