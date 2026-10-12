CREATE TABLE users (
  id uuid PRIMARY KEY,
  username_display text NOT NULL,
  username_normalized text NOT NULL UNIQUE,
  display_name text NOT NULL,
  phone_ciphertext text NOT NULL,
  phone_lookup_hmac text NOT NULL UNIQUE,
  phone_verified_at timestamptz,
  password_hash text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  password_version integer NOT NULL DEFAULT 1 CHECK (password_version > 0),
  status text NOT NULL CHECK (status IN ('pending_approval', 'approved_active', 'rejected', 'disabled')),
  session_version integer NOT NULL DEFAULT 1 CHECK (session_version > 0),
  last_login_at timestamptz,
  disabled_at timestamptz,
  closed_at timestamptz,
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'approved_active' OR phone_verified_at IS NOT NULL)
);

CREATE TABLE inspector_registrations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('pending_approval', 'approved_active', 'rejected', 'disabled')),
  rejection_reason text,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  previous_registration_id uuid REFERENCES inspector_registrations(id) ON DELETE RESTRICT,
  CHECK ((status <> 'rejected') OR rejection_reason IS NOT NULL)
);
CREATE UNIQUE INDEX inspector_registrations_one_pending_per_user ON inspector_registrations(user_id) WHERE status = 'pending_approval';

CREATE TABLE roles (id uuid PRIMARY KEY, code text NOT NULL UNIQUE CHECK (code IN ('super_admin', 'operations_admin', 'reviewer', 'store_manager')), name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE permissions (id uuid PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE role_permissions (role_id uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE, permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE, PRIMARY KEY (role_id, permission_id));
CREATE TABLE user_roles (id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT, role_id uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT, granted_by uuid REFERENCES users(id) ON DELETE RESTRICT, granted_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz);
CREATE UNIQUE INDEX user_roles_one_active_role ON user_roles(user_id, role_id) WHERE revoked_at IS NULL;

CREATE TABLE user_data_scopes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scope_type text NOT NULL CHECK (scope_type IN ('all', 'region', 'store')),
  region_id uuid,
  store_id uuid,
  granted_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK ((scope_type = 'all' AND region_id IS NULL AND store_id IS NULL) OR (scope_type = 'region' AND region_id IS NOT NULL AND store_id IS NULL) OR (scope_type = 'store' AND store_id IS NOT NULL AND region_id IS NULL))
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hmac text NOT NULL UNIQUE,
  token_key_version integer NOT NULL DEFAULT 1,
  kind text NOT NULL CHECK (kind IN ('inspector', 'admin', 'application_status')),
  session_version integer NOT NULL,
  csrf_secret_hash text,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK ((kind = 'admin' AND csrf_secret_hash IS NOT NULL) OR kind <> 'admin')
);
CREATE INDEX auth_sessions_active_user ON auth_sessions(user_id, idle_expires_at) WHERE revoked_at IS NULL;

CREATE TABLE phone_verification_challenges (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('registration', 'password_reset')),
  phone_lookup_hmac text NOT NULL,
  phone_ciphertext text NOT NULL,
  code_hmac text NOT NULL,
  provider_message_id text,
  expires_at timestamptz NOT NULL,
  resend_available_at timestamptz NOT NULL,
  delivery_status text NOT NULL CHECK (delivery_status IN ('pending', 'sent', 'send_failed')),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 3),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts = 3),
  consumed_at timestamptz,
  invalidated_at timestamptz,
  captcha_provider text NOT NULL,
  captcha_verification_id text NOT NULL,
  created_ip_hmac text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX phone_challenges_active_lookup ON phone_verification_challenges(purpose, phone_lookup_hmac, expires_at DESC) WHERE consumed_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  token_hmac text NOT NULL UNIQUE,
  key_version integer NOT NULL DEFAULT 1,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_active_user ON password_reset_tokens(user_id, expires_at) WHERE consumed_at IS NULL;

CREATE TABLE rate_limit_buckets (
  scope text NOT NULL,
  key_hmac text NOT NULL,
  window_started_at timestamptz NOT NULL,
  count integer NOT NULL CHECK (count >= 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, key_hmac, window_started_at)
);
CREATE INDEX rate_limit_expiry ON rate_limit_buckets(expires_at);
