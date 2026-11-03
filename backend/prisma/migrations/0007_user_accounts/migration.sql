-- Completes users for slice 1 (data-model.md, ADR-0016, ADR-0017): login bookkeeping and
-- the per-account lockout, plus the admin user list's indexes. No phone column (ADR-0016,
-- amended 2026-11-03). Runs as po_owner.

ALTER TABLE users
  -- Set on each successful login; shown in the admin user list.
  ADD COLUMN last_login_at timestamptz,
  -- Consecutive wrong passwords. Reaching LOCKOUT_THRESHOLD (5, auth/constants.ts) locks
  -- the account and resets the count, so it never holds more than 4.
  ADD COLUMN failed_login_count integer NOT NULL DEFAULT 0
    CONSTRAINT users_failed_login_count_range CHECK (failed_login_count BETWEEN 0 AND 4),
  ADD COLUMN locked_until timestamptz;

-- Admin user list (research R13): sorted by name then id, optionally by status, and a
-- case-insensitive prefix search on name or email.
CREATE INDEX users_name_id_idx ON users (name, id);
CREATE INDEX users_status_name_id_idx ON users (status, name, id);
CREATE INDEX users_lower_name_prefix_idx ON users (lower(name) text_pattern_ops);
CREATE INDEX users_lower_email_prefix_idx ON users (lower(email) text_pattern_ops);

-- Grants are unchanged: po_app keeps SELECT, INSERT, UPDATE; po_maintenance has none.
