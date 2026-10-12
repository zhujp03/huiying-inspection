CREATE TABLE survey_attempts (
  id uuid PRIMARY KEY,
  assignment_id uuid NOT NULL UNIQUE REFERENCES audit_assignments(id) ON DELETE RESTRICT,
  questionnaire_version_id uuid NOT NULL REFERENCES questionnaire_versions(id) ON DELETE RESTRICT,
  mode text NOT NULL CHECK (mode IN ('secret', 'overt')),
  status text NOT NULL CHECK (status IN ('draft', 'submitting', 'submitted', 'failed')),
  current_category text NOT NULL DEFAULT 'environment' CHECK (current_category IN ('environment', 'service', 'product')),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  submit_token uuid,
  submitting_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_saved_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  CHECK ((status = 'submitted') = (submitted_at IS NOT NULL)),
  CHECK ((status = 'submitting') = (submitting_since IS NOT NULL))
);
CREATE INDEX survey_attempts_version_status_idx ON survey_attempts(questionnaire_version_id, status);

CREATE TABLE question_answers (
  attempt_id uuid NOT NULL REFERENCES survey_attempts(id) ON DELETE RESTRICT,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE RESTRICT,
  answer text NOT NULL CHECK (answer IN ('scored', 'unscored')),
  awarded_score integer NOT NULL CHECK (awarded_score >= 0),
  issue_remark text NOT NULL DEFAULT '',
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (attempt_id, question_id),
  CHECK ((answer = 'scored' AND issue_remark = '') OR (answer = 'unscored' AND length(trim(issue_remark)) > 0))
);
CREATE INDEX question_answers_attempt_idx ON question_answers(attempt_id, question_id);
