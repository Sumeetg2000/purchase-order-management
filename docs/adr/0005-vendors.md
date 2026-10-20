# ADR-0005: Shared vendor list, uniqueness, snapshot and deactivation

- **Status:** Accepted · 2026-10-16
- **Brief:** §3.1, §3.5 · Q3c, private-orders decision
- **Principles:** III, IV, VII

## Decision
- One shared vendor list. Every Buyer maintains all vendors. Create, edit, deactivate and
  reactivate are audited with the actor.
- Unique on a normalised name (case- and whitespace-insensitive) across active and inactive
  vendors → `409 DUPLICATE_VENDOR_NAME`. Vendors are never deleted.
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
