-- Access requests from verified users with no role (data-model.md, ADR-0016). Resolved
-- and dismissed rows never change again; a new request is a new row. Runs as po_owner.

CREATE TABLE access_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL
    CONSTRAINT access_requests_user_id_fkey REFERENCES users (id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- ACCESS_REQUEST_MESSAGE_MAX_LENGTH (@po/contracts).
  message text NOT NULL
    CONSTRAINT access_requests_message_length CHECK (char_length(message) BETWEEN 1 AND 500),
  -- ACCESS_REQUEST_STATUSES (@po/contracts), in the same order.
  status text NOT NULL
    CONSTRAINT access_requests_status_valid CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
  -- ACCESS_REQUEST_NOTE_MAX_LENGTH (@po/contracts).
  admin_note text
    CONSTRAINT access_requests_admin_note_length CHECK (char_length(admin_note) <= 500),
  -- Null while open, and for a request dismissed by a deactivation.
  decided_by uuid
    CONSTRAINT access_requests_decided_by_fkey REFERENCES users (id)
      ON DELETE RESTRICT ON UPDATE RESTRICT,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT access_requests_decided_when_closed CHECK ((status = 'OPEN') = (decided_at IS NULL)),
  CONSTRAINT access_requests_note_only_when_dismissed
    CHECK (admin_note IS NULL OR status = 'DISMISSED'),
  CONSTRAINT access_requests_decider_only_when_closed
    CHECK (decided_by IS NULL OR status <> 'OPEN')
);

-- At most one open request per user.
CREATE UNIQUE INDEX access_requests_one_open_idx ON access_requests (user_id)
  WHERE status = 'OPEN';

-- The admin list (newest activity first, optionally by status) and a user's latest request.
CREATE INDEX access_requests_status_updated_idx
  ON access_requests (status, updated_at DESC, id DESC);
CREATE INDEX access_requests_updated_idx ON access_requests (updated_at DESC, id DESC);
CREATE INDEX access_requests_user_latest_idx ON access_requests (user_id, created_at DESC);

CREATE TRIGGER access_requests_set_updated_at
  BEFORE UPDATE ON access_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Never deleted: po_app gets no DELETE, and po_maintenance nothing.
GRANT SELECT, INSERT, UPDATE ON TABLE access_requests TO po_app;
