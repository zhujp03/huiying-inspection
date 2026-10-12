CREATE TABLE regions (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  code text NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stores (
  id uuid PRIMARY KEY,
  business_no text NOT NULL UNIQUE,
  name text NOT NULL,
  region_id uuid NOT NULL REFERENCES regions(id) ON DELETE RESTRICT,
  address text NOT NULL,
  latitude_gcj02 double precision NOT NULL CHECK (latitude_gcj02 BETWEEN -90 AND 90),
  longitude_gcj02 double precision NOT NULL CHECK (longitude_gcj02 BETWEEN -180 AND 180),
  coordinate_provider text NOT NULL DEFAULT 'tencent' CHECK (coordinate_provider = 'tencent'),
  provider_poi_id text,
  coordinate_source text NOT NULL CHECK (coordinate_source IN ('poi', 'manual_adjusted')),
  checkin_radius_meters integer NOT NULL DEFAULT 300 CHECK (checkin_radius_meters BETWEEN 100 AND 1000),
  accuracy_allowance_max_meters integer NOT NULL DEFAULT 200 CHECK (accuracy_allowance_max_meters BETWEEN 0 AND 200),
  location_verified_at timestamptz,
  location_verified_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stores_region_active_idx ON stores(region_id, active, id);

CREATE TABLE questionnaire_templates (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('secret', 'overt')),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE questionnaire_versions (
  id uuid PRIMARY KEY,
  template_id uuid NOT NULL REFERENCES questionnaire_templates(id) ON DELETE RESTRICT,
  version_number integer NOT NULL CHECK (version_number > 0),
  effective_at timestamptz,
  status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  source_version_id uuid REFERENCES questionnaire_versions(id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  published_at timestamptz,
  UNIQUE (template_id, version_number),
  CHECK ((status = 'published') = (published_at IS NOT NULL AND published_by IS NOT NULL))
);
CREATE INDEX questionnaire_versions_template_status_idx ON questionnaire_versions(template_id, status, version_number DESC);

CREATE TABLE questions (
  id uuid PRIMARY KEY,
  version_id uuid NOT NULL REFERENCES questionnaire_versions(id) ON DELETE RESTRICT,
  question_key text NOT NULL,
  question_number integer NOT NULL CHECK (question_number BETWEEN 1 AND 50),
  category text NOT NULL CHECK (category IN ('environment', 'service', 'product')),
  text text NOT NULL CHECK (length(trim(text)) > 0),
  max_score integer NOT NULL CHECK (max_score >= 0),
  risk_level text NOT NULL DEFAULT 'normal' CHECK (risk_level IN ('normal', 'high')),
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL CHECK (sort_order > 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version_id, question_number),
  UNIQUE (version_id, question_key)
);

CREATE TABLE question_evidence_requirements (
  question_id uuid PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,
  evidence_required boolean NOT NULL DEFAULT false,
  image_required boolean NOT NULL DEFAULT false,
  audio_required boolean NOT NULL DEFAULT false,
  image_min_count integer NOT NULL DEFAULT 0 CHECK (image_min_count IN (0, 1)),
  audio_min_count integer NOT NULL DEFAULT 0 CHECK (audio_min_count IN (0, 1)),
  CHECK (
    (NOT evidence_required AND NOT image_required AND NOT audio_required AND image_min_count = 0 AND audio_min_count = 0)
    OR (evidence_required AND (image_required OR audio_required) AND image_min_count = CASE WHEN image_required THEN 1 ELSE 0 END AND audio_min_count = CASE WHEN audio_required THEN 1 ELSE 0 END)
  )
);

CREATE TABLE audit_campaigns (
  id uuid PRIMARY KEY,
  business_no text NOT NULL UNIQUE,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  store_id uuid NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  common_instruction text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('draft', 'published', 'in_progress', 'completed', 'cancelled')),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  published_at timestamptz,
  completed_at timestamptz,
  cancelled_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  cancel_reason text,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (due_at > starts_at),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE INDEX audit_campaigns_store_status_idx ON audit_campaigns(store_id, status, starts_at DESC);

CREATE TABLE audit_assignments (
  id uuid PRIMARY KEY,
  business_no text NOT NULL UNIQUE,
  campaign_id uuid NOT NULL REFERENCES audit_campaigns(id) ON DELETE RESTRICT,
  inspector_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  questionnaire_version_id uuid NOT NULL REFERENCES questionnaire_versions(id) ON DELETE RESTRICT,
  task_type text NOT NULL CHECK (task_type IN ('secret', 'overt')),
  starts_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  budget_limit_cents integer NOT NULL CHECK (budget_limit_cents >= 0),
  receipt_required boolean NOT NULL DEFAULT false,
  special_instruction text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('draft', 'assigned', 'in_progress', 'submitted', 'overdue', 'cancelled')),
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  assigned_at timestamptz,
  started_at timestamptz,
  checked_in_at timestamptz,
  submitted_at timestamptz,
  cancelled_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  cancelled_at timestamptz,
  cancel_reason text,
  checkin_id uuid,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, inspector_id),
  UNIQUE (id, inspector_id),
  CHECK (due_at > starts_at),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL))
);
CREATE INDEX audit_assignments_campaign_status_idx ON audit_assignments(campaign_id, status);
CREATE INDEX audit_assignments_active_due_idx ON audit_assignments(campaign_id, due_at, id) WHERE status IN ('assigned', 'in_progress');
CREATE INDEX audit_assignments_inspector_status_idx ON audit_assignments(inspector_id, status, due_at);

CREATE TABLE assignment_dish_requirements (
  id uuid PRIMARY KEY,
  assignment_id uuid NOT NULL REFERENCES audit_assignments(id) ON DELETE RESTRICT,
  planned_name text NOT NULL CHECK (length(trim(planned_name)) > 0),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  required boolean NOT NULL,
  allow_substitution boolean NOT NULL,
  max_unit_price_cents integer CHECK (max_unit_price_cents IS NULL OR max_unit_price_cents >= 0),
  instruction text NOT NULL DEFAULT '',
  sort_order integer NOT NULL CHECK (sort_order > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, sort_order)
);

CREATE TABLE audit_checkins (
  id uuid PRIMARY KEY,
  assignment_id uuid NOT NULL,
  inspector_id uuid NOT NULL,
  latitude_gcj02 double precision NOT NULL CHECK (latitude_gcj02 BETWEEN -90 AND 90),
  longitude_gcj02 double precision NOT NULL CHECK (longitude_gcj02 BETWEEN -180 AND 180),
  accuracy_meters double precision NOT NULL CHECK (accuracy_meters > 0),
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  store_latitude_snapshot double precision NOT NULL,
  store_longitude_snapshot double precision NOT NULL,
  base_radius_snapshot integer NOT NULL CHECK (base_radius_snapshot BETWEEN 100 AND 1000),
  accuracy_allowance_meters double precision NOT NULL CHECK (accuracy_allowance_meters >= 0),
  allowance_max_snapshot integer NOT NULL CHECK (allowance_max_snapshot BETWEEN 0 AND 200),
  effective_radius_meters double precision NOT NULL CHECK (effective_radius_meters >= base_radius_snapshot),
  computed_distance_meters double precision,
  result text NOT NULL CHECK (result IN ('accepted', 'outside_radius', 'stale', 'low_accuracy', 'rejected')),
  failure_code text,
  valid_until timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (assignment_id, inspector_id) REFERENCES audit_assignments(id, inspector_id) ON DELETE RESTRICT,
  CHECK ((result = 'accepted') = (valid_until IS NOT NULL)),
  CHECK (valid_until IS NULL OR valid_until > received_at)
);
CREATE INDEX audit_checkins_assignment_valid_idx ON audit_checkins(assignment_id, valid_until DESC) WHERE result = 'accepted' AND consumed_at IS NULL;

CREATE TABLE checkin_exemptions (
  id uuid PRIMARY KEY,
  assignment_id uuid NOT NULL REFERENCES audit_assignments(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  granted_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz NOT NULL,
  used_at timestamptz,
  used_by_attempt_id uuid,
  revoked_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  revoke_reason text,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  CHECK (valid_until > granted_at AND valid_until <= granted_at + INTERVAL '30 minutes'),
  CHECK ((status = 'used') = (used_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL))
);
CREATE UNIQUE INDEX checkin_exemptions_one_active_uq ON checkin_exemptions(assignment_id) WHERE status = 'active';
CREATE INDEX checkin_exemptions_active_expiry_idx ON checkin_exemptions(valid_until, id) WHERE status = 'active';
