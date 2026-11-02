-- At most one open token per user and purpose (data-model.md, ADR-0017): only the newest
-- link may work. issueToken already serialises on the user's row before superseding; this
-- makes the rule hold in the database too. Runs as po_owner.

DROP INDEX one_time_tokens_open_idx;

CREATE UNIQUE INDEX one_time_tokens_open_idx ON one_time_tokens (user_id, purpose)
  WHERE used_at IS NULL AND superseded_at IS NULL;
