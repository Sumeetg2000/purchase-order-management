# ADR-0005: Shared vendor list, uniqueness, snapshot and deactivation

- **Status:** Accepted · 2026-10-16 · amended 2026-11-06 (slice 2 clarifications, **owner
  decisions**: one contact person; list defaults to active vendors; the duplicate-name
  `409` names the existing vendor) · amended 2026-11-11 (name key folds case with
  PostgreSQL's builtin collation; the upgrade step below, **owner decision**) · amended
  2026-11-12 (the upgrade step rewrites only stale keys, **owner decision**)
- **Brief:** §3.1, §3.5 · Q3c, private-orders decision
- **Principles:** III, IV, VII

## Decision
- One shared vendor list. Every Buyer maintains all vendors. Create, edit, deactivate and
  reactivate are audited with the actor.
- Unique on a normalised name (case- and whitespace-insensitive) across active and inactive
  vendors → `409 DUPLICATE_VENDOR_NAME`, carrying `existingVendor: { id, name }`
  (ADR-0007) so the web app can link to it; a retried create gets the same answer.
  Vendors are never deleted.
- The normalised name is a stored key computed by PostgreSQL (`vendor_name_key`: NFC,
  whitespace runs collapsed, trimmed, `lower()` under `pg_c_utf8`, PostgreSQL 17's builtin
  collation), so it doesn't depend on glibc or the database's ctype. Its Unicode tables
  can change with a PostgreSQL **major** upgrade, so after one, recompute the stored keys
  that no longer match, as an operator, in one transaction (current rows are left alone):

  ```sql
  BEGIN;
  SELECT set_config('app.actor_txid', txid_current()::text, true),
         set_config('app.actor_type', 'OPERATOR', true),
         set_config('app.os_user', '<your OS user>', true),
         set_config('app.os_host', '<this host>', true);
  UPDATE vendors SET name = name WHERE name_key IS DISTINCT FROM vendor_name_key(name);
  COMMIT;
  ```

  A unique violation on `vendors_name_key_key` there is a real new clash (two names the new
  tables fold to one): resolve it by renaming one vendor, then run the step again.
- Contact: one contact person, `contactName`, `contactEmail` (stored lower-cased, not
  unique) and an optional `contactPhone` (`null` when absent). No address: the brief has
  no use for one. Field limits are in ADR-0007.
- The vendor list shows active vendors by default; inactive and all are filter choices.
- Deactivate and reactivate are separate actions from editing, each valid only from the
  other state (`409 INVALID_STATE_TRANSITION`). An inactive vendor can still be edited.
  Every change requires `If-Match` (ADR-0006).
- Payment terms are structured, one of:
  - `NET` with `netDays` 0–180
  - `ADVANCE`: 100% payable upfront
  - `PARTIAL_ADVANCE` with `advancePercent` 1–99, plus `netDays` 0–180 for the balance
  Ranges are validated by schema. Terms are part of the vendor snapshot.
- The vendor must be active at create, edit, submit and approve (`409 VENDOR_INACTIVE`;
  missing vendor → `400` with field code `VENDOR_NOT_FOUND`).
- Deactivation never changes existing orders. Approved orders stay receivable and
  cancellable.
- On submit, the order snapshots the vendor's name, contacts and payment terms. Non-draft
  orders display the snapshot, so later vendor edits never change a locked order (§3.5).
- The outstanding report's definition lives in ADR-0015.

## Tests
Both buyers use the same vendor; each payment-term type valid, plus out-of-range
`netDays`/`advancePercent` → 400; a duplicate name with different case or spacing → 409; a
vendor edit after approval leaves the snapshot unchanged; submit of a draft with a
deactivated vendor → 409; receipt and cancel are still allowed after deactivation.
