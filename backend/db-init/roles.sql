-- Idempotent role provisioning (ADR-0003, research R7). Run as the PostgreSQL superuser
-- by the migrate step. Passwords arrive as session settings set just before this script
-- (po.owner_password, po.app_password, po.maintenance_password), so they never appear in
-- the file or the statement text sent by the client.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('po_owner', 'po.owner_password'),
      ('po_app', 'po.app_password'),
      ('po_maintenance', 'po.maintenance_password')
    ) AS v(role_name, password_setting)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role_name) THEN
      EXECUTE format('CREATE ROLE %I', r.role_name);
    END IF;
    -- Re-applied on every run, so a changed password or a tampered attribute is corrected.
    EXECUTE format(
      'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT PASSWORD %L',
      r.role_name,
      current_setting(r.password_setting)
    );
  END LOOP;
END
$$;
