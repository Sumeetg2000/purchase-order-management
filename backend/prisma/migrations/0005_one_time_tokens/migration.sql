-- One-time tokens for set-password links, and from slice 1 email verification
-- (data-model.md, ADR-0017). Runs as po_owner, which owns the table.
--
-- Only the SHA-256 hash of a token is stored; the 256-bit token itself is shown once and
-- never kept. A token is valid while used_at and superseded_at are null and expires_at is
-- in the future.

CREATE TABLE one_time_tokens (
  id uuid PRIMARY KEY,
  -- Users are never deleted, so RESTRICT never fires in practice.
  user_id uuid NOT NULL
    CONSTRAINT one_time_tokens_user_id_fkey REFERENCES users (id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  purpose text NOT NULL
    CONSTRAINT one_time_tokens_purpose_valid CHECK (purpose IN ('RESET', 'VERIFY_EMAIL')),
  token_hash bytea NOT NULL
    CONSTRAINT one_time_tokens_token_hash_sha256 CHECK (octet_length(token_hash) = 32),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT one_time_tokens_token_hash_key UNIQUE (token_hash),
  CONSTRAINT one_time_tokens_expires_after_creation CHECK (expires_at > created_at)
);

-- Superseding looks up a user's open tokens of one purpose.
CREATE INDEX one_time_tokens_open_idx ON one_time_tokens (user_id, purpose)
  WHERE used_at IS NULL AND superseded_at IS NULL;

-- The purge deletes tokens whose COALESCE(used_at, superseded_at, expires_at) is more than
-- 7 days old; the index uses the same expression so the purge can use it.
CREATE INDEX one_time_tokens_purge_idx
  ON one_time_tokens ((COALESCE(used_at, superseded_at, expires_at)));

-- po_app issues tokens and marks them used or superseded, and can never change a token's
-- hash, owner, purpose or expiry, or delete one. po_maintenance purges old tokens.
GRANT SELECT, INSERT ON TABLE one_time_tokens TO po_app;
GRANT UPDATE (used_at, superseded_at) ON TABLE one_time_tokens TO po_app;
GRANT SELECT, DELETE ON TABLE one_time_tokens TO po_maintenance;
