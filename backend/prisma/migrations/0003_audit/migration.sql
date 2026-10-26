-- Audit trail and actor-context enforcement (data-model.md, research R6, ADR-0016).
-- Runs as po_owner, which owns the table and the functions. The functions are SECURITY
-- INVOKER with a fixed search_path; triggers fire without an EXECUTE grant, so EXECUTE is
-- revoked from PUBLIC and granted to nobody.
--
-- Custom SQLSTATEs (class PO), mapped by code in backend/src/db/errors.ts:
--   PO001 ACTOR_CONTEXT_REQUIRED  no actor context, or an incomplete or inconsistent one
--   PO002 ACTOR_CONTEXT_MISMATCH  an explicit audit value contradicts the context
--   PO004 AUDIT_RETENTION_ACTIVE  deleting an audit entry inside its 8-year retention

CREATE TABLE audit_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Always the database clock: the fill trigger overwrites any supplied value.
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL
    CONSTRAINT audit_entries_actor_type_valid CHECK (actor_type IN ('USER', 'SYSTEM', 'OPERATOR')),
  -- No foreign key: users are never deleted, and an entry must stand on its own.
  actor_user_id uuid,
  actor_name text,
  actor_email text,
  acting_role text,
  action text NOT NULL
    CONSTRAINT audit_entries_action_present CHECK (action <> ''),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  order_id uuid,
  po_number text,
  details jsonb NOT NULL DEFAULT '{}'
    CONSTRAINT audit_entries_details_object CHECK (jsonb_typeof(details) = 'object'),
  request_id text,
  CONSTRAINT audit_entries_actor_matches_type CHECK (
    (actor_type = 'USER'
      AND actor_user_id IS NOT NULL AND actor_name IS NOT NULL
      AND actor_email IS NOT NULL AND acting_role IS NOT NULL)
    OR (actor_type = 'SYSTEM'
      AND actor_user_id IS NULL AND actor_name IS NULL
      AND actor_email IS NULL AND acting_role IS NULL)
    OR (actor_type = 'OPERATOR'
      AND actor_user_id IS NULL AND details ? 'osUser' AND details ? 'host')
  )
);

CREATE INDEX audit_entries_occurred_at_id_idx ON audit_entries (occurred_at, id);

-- Statement-level guard for audited tables and for audit_entries itself: refuses any
-- change made without a complete, consistent actor context. The context is transaction-local (set_config(..., true)),
-- set by withTransaction.
CREATE FUNCTION require_actor_context() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ctx_type text := nullif(current_setting('app.actor_type', true), '');
  ctx_user_id text := nullif(current_setting('app.actor_user_id', true), '');
  ctx_name text := nullif(current_setting('app.actor_name', true), '');
  ctx_email text := nullif(current_setting('app.actor_email', true), '');
  ctx_role text := nullif(current_setting('app.acting_role', true), '');
  ctx_os_user text := nullif(current_setting('app.os_user', true), '');
  ctx_os_host text := nullif(current_setting('app.os_host', true), '');
BEGIN
  IF ctx_type IS NULL THEN
    RAISE EXCEPTION 'ACTOR_CONTEXT_REQUIRED' USING
      ERRCODE = 'PO001',
      DETAIL = format('%s on %s needs an actor context', TG_OP, TG_TABLE_NAME);
  END IF;
  IF NOT (
    (ctx_type = 'USER'
      -- coalesce: a missing id makes the match NULL, which must count as a failure.
      AND coalesce(ctx_user_id ~ '^[0-9A-Fa-f]{8}-([0-9A-Fa-f]{4}-){3}[0-9A-Fa-f]{12}$', false)
      AND ctx_name IS NOT NULL
      AND ctx_email IS NOT NULL AND ctx_role IS NOT NULL
      AND ctx_os_user IS NULL AND ctx_os_host IS NULL)
    OR (ctx_type = 'SYSTEM'
      AND num_nonnulls(ctx_user_id, ctx_name, ctx_email, ctx_role, ctx_os_user, ctx_os_host) = 0)
    OR (ctx_type = 'OPERATOR'
      AND ctx_os_user IS NOT NULL AND ctx_os_host IS NOT NULL
      AND num_nonnulls(ctx_user_id, ctx_name, ctx_email, ctx_role) = 0)
  ) THEN
    RAISE EXCEPTION 'ACTOR_CONTEXT_REQUIRED' USING
      ERRCODE = 'PO001',
      DETAIL = format('incomplete or inconsistent actor context for %s on %s', TG_OP, TG_TABLE_NAME);
  END IF;
  RETURN NULL;
END
$$;

-- Fills an audit entry's actor fields, request id and time from the context, and refuses
-- explicit values that contradict it. require_actor_context runs first (a statement-level
-- BEFORE INSERT trigger fires before row triggers), so the context here is known to be
-- complete and consistent.
CREATE FUNCTION audit_fill_actor() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ctx_type text := nullif(current_setting('app.actor_type', true), '');
  ctx_user_id text := nullif(current_setting('app.actor_user_id', true), '');
  ctx_name text := nullif(current_setting('app.actor_name', true), '');
  ctx_email text := nullif(current_setting('app.actor_email', true), '');
  ctx_role text := nullif(current_setting('app.acting_role', true), '');
  ctx_os_user text := nullif(current_setting('app.os_user', true), '');
  ctx_os_host text := nullif(current_setting('app.os_host', true), '');
  ctx_request_id text := nullif(current_setting('app.request_id', true), '');
BEGIN
  IF (NEW.actor_type IS NOT NULL AND NEW.actor_type IS DISTINCT FROM ctx_type)
    OR (NEW.actor_user_id IS NOT NULL AND NEW.actor_user_id IS DISTINCT FROM ctx_user_id::uuid)
    OR (NEW.actor_name IS NOT NULL AND NEW.actor_name IS DISTINCT FROM ctx_name)
    OR (NEW.actor_email IS NOT NULL AND NEW.actor_email IS DISTINCT FROM ctx_email)
    OR (NEW.acting_role IS NOT NULL AND NEW.acting_role IS DISTINCT FROM ctx_role)
    OR (NEW.request_id IS NOT NULL AND NEW.request_id IS DISTINCT FROM ctx_request_id)
    OR (NEW.details ? 'osUser' AND NEW.details ->> 'osUser' IS DISTINCT FROM ctx_os_user)
    OR (NEW.details ? 'host' AND NEW.details ->> 'host' IS DISTINCT FROM ctx_os_host)
    -- Only an operator's entry may name an OS user or host, even with a null value.
    OR (ctx_type <> 'OPERATOR' AND (NEW.details ? 'osUser' OR NEW.details ? 'host'))
  THEN
    RAISE EXCEPTION 'ACTOR_CONTEXT_MISMATCH' USING
      ERRCODE = 'PO002', DETAIL = 'an explicit audit value contradicts the actor context';
  END IF;

  NEW.actor_type := ctx_type;
  NEW.actor_user_id := ctx_user_id::uuid;
  NEW.actor_name := ctx_name;
  NEW.actor_email := ctx_email;
  NEW.acting_role := ctx_role;
  NEW.request_id := ctx_request_id;
  NEW.occurred_at := now();
  IF ctx_type = 'OPERATOR' THEN
    NEW.details := NEW.details || jsonb_build_object('osUser', ctx_os_user, 'host', ctx_os_host);
  END IF;
  RETURN NEW;
END
$$;

-- Audit entries are kept 8 years (ADR-0020). Deleting a younger entry is refused for
-- every role, the owner included; this is what limits po_maintenance's DELETE to the
-- purge.
CREATE FUNCTION audit_retention_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.occurred_at >= now() - interval '8 years' THEN
    RAISE EXCEPTION 'AUDIT_RETENTION_ACTIVE' USING
      ERRCODE = 'PO004',
      DETAIL = format('audit entry %s is inside its 8-year retention', OLD.id);
  END IF;
  RETURN OLD;
END
$$;

REVOKE ALL ON FUNCTION require_actor_context() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_fill_actor() FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_retention_guard() FROM PUBLIC;

CREATE TRIGGER require_actor_context
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON users
  FOR EACH STATEMENT EXECUTE FUNCTION require_actor_context();

CREATE TRIGGER require_actor_context
  BEFORE INSERT ON audit_entries
  FOR EACH STATEMENT EXECUTE FUNCTION require_actor_context();

CREATE TRIGGER audit_fill_actor
  BEFORE INSERT ON audit_entries
  FOR EACH ROW EXECUTE FUNCTION audit_fill_actor();

CREATE TRIGGER audit_retention_guard
  BEFORE DELETE ON audit_entries
  FOR EACH ROW EXECUTE FUNCTION audit_retention_guard();

-- po_app writes entries but never changes or removes them. po_maintenance purges entries
-- past retention and, from slice 1, records USER_PHONE_PURGED. INSERT is granted on every
-- column except id, so no writer can choose an entry's id (OVERRIDING SYSTEM VALUE).
GRANT SELECT ON TABLE audit_entries TO po_app;
GRANT SELECT, DELETE ON TABLE audit_entries TO po_maintenance;
GRANT INSERT (occurred_at, actor_type, actor_user_id, actor_name, actor_email, acting_role,
              action, entity_type, entity_id, order_id, po_number, details, request_id)
  ON TABLE audit_entries TO po_app, po_maintenance;
