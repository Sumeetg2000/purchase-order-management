-- Minimal users table for the bootstrap admin (data-model.md). Slice 1 adds phone, login
-- and lockout columns through new migrations. Runs as po_owner, which owns the table.

CREATE TABLE users (
  id uuid PRIMARY KEY,
  name text NOT NULL
    CONSTRAINT users_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
  email text NOT NULL
    CONSTRAINT users_email_lower CHECK (email = lower(email)),
  -- Sorted, so {APPROVER,BUYER} is normalised to {BUYER,APPROVER} before insert.
  roles text[] NOT NULL DEFAULT '{}'
    CONSTRAINT users_roles_valid CHECK (
      roles IN ('{}'::text[], '{BUYER}'::text[], '{APPROVER}'::text[],
                '{BUYER,APPROVER}'::text[], '{ADMIN}'::text[])
    ),
  status text NOT NULL
    CONSTRAINT users_status_valid CHECK (status IN ('UNVERIFIED', 'ACTIVE', 'DEACTIVATED')),
  deactivated_at timestamptz,
  -- Null until a password is set; the bootstrap admin starts without one.
  password_hash text,
  -- Optimistic concurrency (ADR-0016): incremented on profile, role and status changes.
  version integer NOT NULL DEFAULT 1
    CONSTRAINT users_version_positive CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_deactivated_at_matches_status
    CHECK ((status = 'DEACTIVATED') = (deactivated_at IS NOT NULL))
);

-- updated_at always comes from the database clock, on every update path.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION set_updated_at() FROM PUBLIC;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Users are never deleted (ADR-0016), so po_app gets no DELETE. po_maintenance gets
-- nothing in slice 0.
GRANT SELECT, INSERT, UPDATE ON TABLE users TO po_app;
