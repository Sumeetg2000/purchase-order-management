-- Rate-limit counters (data-model.md, ADR-0017 amended 2026-11-02): fixed windows kept in
-- PostgreSQL, so every API instance shares one limit. Runs as po_owner.

CREATE TABLE rate_limit_counters (
  -- RATE_LIMIT_BUCKET_NAMES (rate-limit/buckets.ts), in the same order.
  bucket text NOT NULL
    CONSTRAINT rate_limit_counters_bucket_valid CHECK (bucket IN (
      'login-ip', 'login-account', 'signup-ip', 'signup-email', 'resend-email',
      'forgot-email', 'access-request-user')),
  -- A client IP, a lower-cased email or a user id, depending on the bucket.
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  -- Stored rather than computed: timestamptz + interval is only STABLE, so an index
  -- can't use it, and the purge needs one.
  window_end timestamptz NOT NULL,
  hits integer NOT NULL CONSTRAINT rate_limit_counters_hits_positive CHECK (hits >= 1),
  CONSTRAINT rate_limit_counters_pkey PRIMARY KEY (bucket, key, window_start),
  CONSTRAINT rate_limit_counters_window_order CHECK (window_end > window_start)
);

-- The purge deletes windows that have ended.
CREATE INDEX rate_limit_counters_window_end_idx ON rate_limit_counters (window_end);

GRANT SELECT, INSERT, UPDATE ON TABLE rate_limit_counters TO po_app;
GRANT SELECT, DELETE ON TABLE rate_limit_counters TO po_maintenance;
