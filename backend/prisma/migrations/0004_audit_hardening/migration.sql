-- Audit hardening after the US4 review (research R6). Runs as po_owner; CREATE OR
-- REPLACE keeps the function's owner, its SECURITY INVOKER search_path and its revoked
-- EXECUTE.
--
-- Custom SQLSTATEs (class PO), mapped by code in backend/src/db/errors.ts:
--   PO001 ACTOR_CONTEXT_REQUIRED  now also: a context not bound to the current transaction

-- The actor context must be bound to the transaction that uses it: withTransaction sets
-- app.actor_txid to txid_current() alongside the other settings, all transaction-local.
-- A session-level SET (which would outlive the transaction and leak one actor onto the
-- next user of a pooled connection) can't name a later transaction's id, so it is refused.
CREATE OR REPLACE FUNCTION require_actor_context() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  ctx_type text := nullif(current_setting('app.actor_type', true), '');
  ctx_txid text := nullif(current_setting('app.actor_txid', true), '');
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
  IF ctx_txid IS DISTINCT FROM txid_current()::text THEN
    RAISE EXCEPTION 'ACTOR_CONTEXT_REQUIRED' USING
      ERRCODE = 'PO001',
      DETAIL = format('the actor context for %s on %s is not bound to this transaction',
                      TG_OP, TG_TABLE_NAME);
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
