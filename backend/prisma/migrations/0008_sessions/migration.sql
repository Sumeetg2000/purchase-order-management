-- Sessions and refresh tokens (data-model.md, ADR-0017). A session is one login on one
-- device; each refresh token is one link of its rotation chain, siblings included. Only
-- SHA-256 hashes of refresh tokens are stored. Runs as po_owner.

CREATE TABLE sessions (
  -- Also the access token's sid claim.
  id uuid PRIMARY KEY,
  -- Users are never deleted, so RESTRICT never fires in practice.
  user_id uuid NOT NULL
    CONSTRAINT sessions_user_id_fkey REFERENCES users (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- Times come from the API's injected clock, so lifetimes are testable.
  created_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL,
  -- 30 days after login; rotation never moves it.
  absolute_expires_at timestamptz NOT NULL,
  -- The latest refresh token's expiry: at most 7 days ahead, never past the absolute one.
  expires_at timestamptz NOT NULL,
  -- Truncated by the service to USER_AGENT_MAX_LENGTH (auth/constants.ts).
  user_agent text NOT NULL
    CONSTRAINT sessions_user_agent_length CHECK (char_length(user_agent) <= 512),
  ip inet NOT NULL,
  revoked_at timestamptz,
  -- SESSION_REVOKE_REASONS (auth/constants.ts), in the same order.
  revoke_reason text
    CONSTRAINT sessions_revoke_reason_valid CHECK (revoke_reason IN (
      'PASSWORD_CHANGED', 'PASSWORD_RESET', 'ROLES_CHANGED', 'DEACTIVATED', 'LOGOUT',
      'LOGOUT_ALL', 'USER_REVOKED', 'REUSE_DETECTED')),
  CONSTRAINT sessions_absolute_after_creation CHECK (absolute_expires_at > created_at),
  CONSTRAINT sessions_expiry_within_absolute CHECK (expires_at <= absolute_expires_at),
  CONSTRAINT sessions_revocation_complete CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);

-- A user's active sessions, most recently used first (list, revoke-all).
CREATE INDEX sessions_user_active_idx ON sessions (user_id, last_used_at DESC, id DESC)
  WHERE revoked_at IS NULL;

-- The purge deletes sessions that ended more than 90 days ago; ended means revoked, or
-- past the latest token's expiry. Same expression as the purge.
CREATE INDEX sessions_ended_idx ON sessions ((COALESCE(revoked_at, expires_at)));

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL
    CONSTRAINT refresh_tokens_session_id_fkey REFERENCES sessions (id)
      ON DELETE CASCADE ON UPDATE RESTRICT,
  token_hash bytea NOT NULL
    CONSTRAINT refresh_tokens_token_hash_sha256 CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  -- Set once, when the token is rotated; never cleared. Reuse after the sibling window
  -- revokes the session.
  rotated_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT refresh_tokens_expires_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX refresh_tokens_session_id_idx ON refresh_tokens (session_id);

-- po_app creates sessions and tokens, rotates tokens, and touches, extends or revokes a
-- session; it can never change a token's hash, a session's owner, device or absolute
-- expiry, or delete either. po_maintenance purges ended sessions with their tokens.
GRANT SELECT, INSERT ON TABLE sessions, refresh_tokens TO po_app;
GRANT UPDATE (last_used_at, expires_at, revoked_at, revoke_reason) ON TABLE sessions TO po_app;
GRANT UPDATE (rotated_at) ON TABLE refresh_tokens TO po_app;
GRANT SELECT, DELETE ON TABLE sessions, refresh_tokens TO po_maintenance;
