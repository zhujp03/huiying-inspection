ALTER TABLE survey_attempts
  ADD CONSTRAINT survey_attempts_id_assignment_uq UNIQUE (id, assignment_id);

ALTER TABLE assignment_dish_requirements
  ADD CONSTRAINT assignment_dish_requirements_id_assignment_uq UNIQUE (id, assignment_id);

CREATE TABLE dish_records (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES survey_attempts(id) ON DELETE RESTRICT,
  assignment_id uuid NOT NULL REFERENCES audit_assignments(id) ON DELETE RESTRICT,
  requirement_id uuid,
  sort_order integer NOT NULL CHECK (sort_order > 0),
  planned_name text,
  planned_quantity integer CHECK (planned_quantity BETWEEN 1 AND 999),
  actual_name text,
  quantity integer CHECK (quantity BETWEEN 1 AND 999),
  required_snapshot boolean NOT NULL DEFAULT false,
  allow_substitution_snapshot boolean NOT NULL DEFAULT false,
  max_unit_price_cents_snapshot integer CHECK (max_unit_price_cents_snapshot IS NULL OR max_unit_price_cents_snapshot >= 0),
  instruction_snapshot text NOT NULL DEFAULT '',
  unit_price_cents integer CHECK (unit_price_cents IS NULL OR unit_price_cents >= 0),
  line_total_cents integer CHECK (line_total_cents IS NULL OR line_total_cents >= 0),
  fulfillment_status text NOT NULL CHECK (fulfillment_status IN ('ordered','substituted','unavailable','skipped','extra')),
  substitution_reason text,
  unavailable_reason text,
  evaluation text,
  fully_satisfied boolean NOT NULL DEFAULT false,
  source text NOT NULL CHECK (source IN ('manual','ocr')),
  receipt_ocr_candidate_id uuid,
  manually_modified boolean NOT NULL DEFAULT false,
  price_derived boolean NOT NULL DEFAULT false,
  review_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (attempt_id, assignment_id) REFERENCES survey_attempts(id, assignment_id) ON DELETE RESTRICT,
  FOREIGN KEY (requirement_id, assignment_id) REFERENCES assignment_dish_requirements(id, assignment_id) ON DELETE RESTRICT,
  CHECK ((requirement_id IS NULL) = (planned_name IS NULL)),
  CHECK ((fulfillment_status <> 'extra') OR requirement_id IS NULL),
  CHECK ((fulfillment_status <> 'skipped') OR NOT required_snapshot),
  CHECK ((fulfillment_status <> 'substituted') OR allow_substitution_snapshot)
);
CREATE UNIQUE INDEX dish_records_one_requirement_uq ON dish_records(attempt_id, requirement_id) WHERE requirement_id IS NOT NULL;
CREATE INDEX dish_records_attempt_sort_idx ON dish_records(attempt_id, sort_order, id);

CREATE TABLE other_records (
  attempt_id uuid PRIMARY KEY REFERENCES survey_attempts(id) ON DELETE RESTRICT,
  highlight text NOT NULL DEFAULT '',
  suggestion text NOT NULL DEFAULT '',
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(highlight) <= 2000 AND length(suggestion) <= 2000)
);

CREATE TABLE receipt_attachments (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES survey_attempts(id) ON DELETE RESTRICT,
  client_file_id uuid NOT NULL,
  display_order integer NOT NULL CHECK (display_order BETWEEN 1 AND 9),
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
  UNIQUE (attempt_id, client_file_id),
  UNIQUE (attempt_id, display_order),
  CHECK ((status = 'ready') = (verified_at IS NOT NULL)),
  CHECK ((status = 'deleted') = (deleted_at IS NOT NULL))
);
CREATE UNIQUE INDEX receipt_attachments_active_sha_uq ON receipt_attachments(attempt_id, sha256) WHERE status <> 'deleted' AND sha256 IS NOT NULL;
CREATE INDEX receipt_attachments_attempt_status_idx ON receipt_attachments(attempt_id, status, display_order);
