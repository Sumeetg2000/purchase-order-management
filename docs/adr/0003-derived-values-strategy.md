# ADR-0003: Derived values: stored and trigger-maintained

- **Status:** Accepted · 2026-10-16 (store-vs-calculate confirmed by owner) · amended
  2026-10-20 (database-role, request-body and attack-suite details moved here from the
  constitution)
- **Brief:** §3.3, §3.6, §4, §6 · Gaps G5, G10, Q6
- **Principles:** I, VII

## Context
Brief §4 asks whether the total and outstanding quantities are calculated when needed or
stored and kept in sync, and how drift is made impossible under a direct bypass.

## Decision
- `line_total` is a generated column (`quantity × unit_price`).
- `order.total`, `line.received_quantity` and `order.open_line_count` (lines with
  received < ordered; see ADR-0015) are stored. They are maintained only by
  statement-level triggers (with transition tables) in the same transaction as the source
  change. The triggers recompute each affected row once and exit early when their input
  columns didn't change. PostgreSQL doesn't allow transition tables together with column
  lists, so they use a column list where possible and otherwise compare old and new values
  first. A receipt never recomputes the total.
- The application role has no write privilege on derived columns.
- An overwrite guard (`BEFORE UPDATE` on orders) raises `DERIVED_VALUE_READ_ONLY` if
  `total` or `open_line_count` changes without the recompute function's transaction-local
  flag. It does nothing for status or timestamp updates.
- The receipt trigger locks the line row before checking `received ≤ ordered`.
- The reconciliation query recomputes all three (and checks INV-1 to INV-6) and must
  return zero rows after the full test suite, after every load-test seed and after every
  integrity-attack attempt.

### Database roles
- The application connects as a least-privilege role. It owns no tables, isn't a
  superuser and has no `BYPASSRLS`.
- It has no `INSERT`/`UPDATE` privilege on stored derived columns. It therefore can't
  disable triggers, alter constraints or set `session_replication_role`.
- Migrations run as a separate owner role. Retention purges run as a separate maintenance
  role, limited to the deletes and the one column update listed in ADR-0020.
- Receipts and audit entries are append-only for the app role (`INSERT`/`SELECT` only).

### Request bodies
A body containing a derived or system-assigned field is rejected with
`400 VALIDATION_FAILED`, never silently ignored. The fields: `total`, `lineTotal`,
`receivedQuantity`, `outstandingQuantity`, `openLineCount`, `poNumber`, `position`,
`version`.

### Integrity attack suite
It tries every known bypass through the API, the service layer and raw SQL, as the app role
and as a privileged role:
- writing `total` or `poNumber` in a request body
- `UPDATE … SET total` (app role → permission denied; privileged role →
  `DERIVED_VALUE_READ_ONLY`)
- changing lines without the order, or deleting the last line
- over-receiving, or updating or deleting a receipt
- deleting a non-draft order
- changing a locked order's lines or vendor
- fractional-price drift: `0.1 × 3 lines = 0.3000`; `7 × 0.0125 = 0.0875`; 500 fractional
  lines summed exactly in the DB, TypeScript and the API; values at the size limits
  not overflowing
- the suite ends with the reconciliation query

## Alternatives
- Calculate on read (views): drift is impossible by construction, but the outstanding
  report would aggregate about 1.5M receipts per query at production scale, which conflicts
  with the 200 ms target.
- Application-maintained stored values: any raw SQL or bug causes drift. Rejected.
- Row-level triggers: lesson 7 (300 trigger runs for a 150-line replace).
- A guard that silently restores the total: hides bugs in privileged scripts. Rejected for
  a loud error.

## Tests
The integrity attack suite (app role → permission denied; privileged role →
`DERIVED_VALUE_READ_ONLY`); trigger counts (a 500-line PATCH = 1 recompute; receipt = 0;
status update = 0); reconciliation = 0 rows after the suites and seeds.
