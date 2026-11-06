-- The shared vendor list (data-model.md, ADR-0005). Vendors are never deleted: po_app has
-- no DELETE or TRUNCATE, and po_maintenance nothing. Every number and list below is a
-- constant in packages/contracts/src/vendors.ts; tests/integration/vendor-constants.test.ts
-- pins each copy. Runs as po_owner.

CREATE TABLE vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- VENDOR_NAME_MAX. Trimmed by the API.
  name text NOT NULL
    CONSTRAINT vendors_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  -- The uniqueness and search key (normaliseVendorName): NFC, every whitespace run
  -- collapsed to one space, trimmed, lower-case. The class is JavaScript's \s spelled out,
  -- so it doesn't depend on the locale (PostgreSQL's \s misses the no-break space).
  -- "C" so one btree serves ORDER BY and LIKE 'prefix%'.
  name_key text COLLATE "C"
    GENERATED ALWAYS AS (lower(btrim(regexp_replace(
      normalize(name, NFC),
      '[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+',
      ' ', 'g'))))
    STORED,
  -- CONTACT_NAME_MAX.
  contact_name text NOT NULL
    CONSTRAINT vendors_contact_name_length CHECK (char_length(contact_name) BETWEEN 1 AND 200),
  -- EMAIL_MAX_LENGTH. Lower-cased by the API; not unique.
  contact_email text NOT NULL
    CONSTRAINT vendors_contact_email_valid
      CHECK (contact_email = lower(contact_email) AND char_length(contact_email) <= 254),
  -- NULL is the only "no phone"; CONTACT_PHONE_PATTERN and CONTACT_PHONE_MAX, plus a digit.
  contact_phone text
    CONSTRAINT vendors_contact_phone_valid
      CHECK (contact_phone ~ '^[0-9 +()-]{1,30}$' AND contact_phone ~ '[0-9]'),
  -- PAYMENT_TERM_TYPES, in the same order.
  payment_term_type text NOT NULL
    CONSTRAINT vendors_payment_term_type_valid
      CHECK (payment_term_type IN ('NET', 'ADVANCE', 'PARTIAL_ADVANCE')),
  net_days smallint,
  advance_percent smallint,
  -- VENDOR_STATUSES, in the same order.
  status text NOT NULL DEFAULT 'ACTIVE'
    CONSTRAINT vendors_status_valid CHECK (status IN ('ACTIVE', 'INACTIVE')),
  deactivated_at timestamptz,
  version integer NOT NULL DEFAULT 1
    CONSTRAINT vendors_version_positive CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendors_name_key_key UNIQUE (name_key),
  -- NET_DAYS_MAX, ADVANCE_PERCENT_MIN, ADVANCE_PERCENT_MAX.
  -- coalesce: a missing number makes BETWEEN NULL, which a CHECK would let through.
  CONSTRAINT vendors_payment_terms_valid CHECK (coalesce(
    CASE payment_term_type
      WHEN 'NET' THEN net_days BETWEEN 0 AND 180 AND advance_percent IS NULL
      WHEN 'ADVANCE' THEN net_days IS NULL AND advance_percent IS NULL
      WHEN 'PARTIAL_ADVANCE' THEN advance_percent BETWEEN 1 AND 99 AND net_days BETWEEN 0 AND 180
    END,
    false)),
  CONSTRAINT vendors_deactivated_when_inactive
    CHECK ((status = 'INACTIVE') = (deactivated_at IS NOT NULL))
);

-- The default ACTIVE list, the INACTIVE filter, a prefix within a status, and their
-- counts. The ALL filter uses vendors_name_key_key.
CREATE INDEX vendors_status_name_key_idx ON vendors (status, name_key, id);

-- Vendor history now; order timelines and the Admin log's entity filter later.
CREATE INDEX audit_entries_entity_idx
  ON audit_entries (entity_type, entity_id, occurred_at DESC, id DESC);

CREATE TRIGGER require_actor_context
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON vendors
  FOR EACH STATEMENT EXECUTE FUNCTION require_actor_context();

CREATE TRIGGER vendors_set_updated_at
  BEFORE UPDATE ON vendors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- id, name_key and the timestamps are never written by the app.
GRANT SELECT ON TABLE vendors TO po_app;
GRANT INSERT (name, contact_name, contact_email, contact_phone,
              payment_term_type, net_days, advance_percent)
  ON TABLE vendors TO po_app;
GRANT UPDATE (name, contact_name, contact_email, contact_phone,
              payment_term_type, net_days, advance_percent,
              status, deactivated_at, version)
  ON TABLE vendors TO po_app;
