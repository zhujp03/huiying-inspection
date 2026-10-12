ALTER TABLE receipt_attachments
  ADD CONSTRAINT receipt_attachments_id_attempt_uq UNIQUE (id, attempt_id);

CREATE TABLE receipt_ocr_jobs (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES survey_attempts(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('queued','processing','succeeded','partial','failed','cancelled')),
  provider text NOT NULL DEFAULT 'paddleocr',
  model_version text NOT NULL,
  parser_version text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  request_idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  locked_by uuid,
  locked_at timestamptz,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  cancellation_requested_at timestamptz,
  failure_code text,
  failure_detail_redacted text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  CHECK ((status = 'processing') = (locked_by IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((status IN ('succeeded','partial','failed','cancelled')) = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX receipt_ocr_jobs_attempt_input_uq ON receipt_ocr_jobs(attempt_id, input_hash);
CREATE UNIQUE INDEX receipt_ocr_jobs_attempt_key_uq ON receipt_ocr_jobs(attempt_id, request_idempotency_key);
CREATE INDEX receipt_ocr_jobs_claim_idx ON receipt_ocr_jobs(next_attempt_at, created_at, id) WHERE status IN ('queued','processing');

CREATE TABLE receipt_ocr_job_attachments (
  job_id uuid NOT NULL REFERENCES receipt_ocr_jobs(id) ON DELETE RESTRICT,
  attachment_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  display_order integer NOT NULL CHECK (display_order BETWEEN 1 AND 9),
  sha256_snapshot text NOT NULL CHECK (sha256_snapshot ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (job_id, attachment_id),
  FOREIGN KEY (attachment_id, attempt_id) REFERENCES receipt_attachments(id, attempt_id) ON DELETE RESTRICT
);

CREATE TABLE receipt_ocr_lines (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES receipt_ocr_jobs(id) ON DELETE RESTRICT,
  attachment_id uuid NOT NULL REFERENCES receipt_attachments(id) ON DELETE RESTRICT,
  page_order integer NOT NULL DEFAULT 1 CHECK (page_order > 0),
  line_order integer NOT NULL CHECK (line_order > 0),
  text text NOT NULL,
  confidence numeric(5,4) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  bounding_box_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, attachment_id, page_order, line_order)
);

CREATE TABLE receipt_ocr_candidates (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES receipt_ocr_jobs(id) ON DELETE RESTRICT,
  attachment_id uuid NOT NULL REFERENCES receipt_attachments(id) ON DELETE RESTRICT,
  raw_name text NOT NULL,
  normalized_name text NOT NULL,
  quantity integer CHECK (quantity BETWEEN 1 AND 999),
  unit_price_cents integer CHECK (unit_price_cents IS NULL OR unit_price_cents >= 0),
  line_total_cents integer CHECK (line_total_cents IS NULL OR line_total_cents >= 0),
  currency text NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  name_confidence numeric(5,4) NOT NULL CHECK (name_confidence BETWEEN 0 AND 1),
  quantity_confidence numeric(5,4),
  unit_price_confidence numeric(5,4),
  line_total_confidence numeric(5,4),
  source_text text NOT NULL,
  source_bounding_box jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order integer NOT NULL CHECK (sort_order > 0),
  status text NOT NULL CHECK (status IN ('proposed','applied','rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX receipt_ocr_candidates_job_idx ON receipt_ocr_candidates(job_id, attachment_id, sort_order);

CREATE TABLE receipt_ocr_summaries (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES receipt_ocr_jobs(id) ON DELETE RESTRICT,
  attachment_id uuid NOT NULL REFERENCES receipt_attachments(id) ON DELETE RESTRICT,
  subtotal_cents integer,
  discount_cents integer,
  service_charge_cents integer,
  payable_total_cents integer,
  calculated_item_total_cents integer,
  difference_cents integer,
  UNIQUE (job_id, attachment_id)
);

CREATE TABLE receipt_ocr_applications (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES survey_attempts(id) ON DELETE RESTRICT,
  job_id uuid NOT NULL REFERENCES receipt_ocr_jobs(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  base_revision bigint NOT NULL CHECK (base_revision >= 0),
  result_revision bigint,
  applied_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  UNIQUE (attempt_id, idempotency_key),
  UNIQUE (attempt_id, job_id),
  CHECK ((result_revision IS NULL) = (applied_at IS NULL))
);

ALTER TABLE dish_records
  ADD CONSTRAINT dish_records_candidate_fk FOREIGN KEY (receipt_ocr_candidate_id) REFERENCES receipt_ocr_candidates(id) ON DELETE RESTRICT;
