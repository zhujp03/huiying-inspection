ALTER TABLE audit_assignments
  ADD COLUMN last_extended_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  ADD COLUMN last_extended_at timestamptz,
  ADD COLUMN last_extension_reason text;

ALTER TABLE audit_assignments
  ADD CONSTRAINT audit_assignments_extension_audit_check
  CHECK (
    (last_extended_at IS NULL AND last_extended_by IS NULL AND last_extension_reason IS NULL)
    OR (last_extended_at IS NOT NULL AND last_extended_by IS NOT NULL AND length(trim(last_extension_reason)) > 0)
  );
