# ADR-0009: Line identity on draft edits

- **Status:** Accepted · 2026-10-16
- **Brief:** §3.2 · Gaps G7, G20 · Lesson 9
- **Principles:** I, IV, VI, VII

## Decision
- PATCH sends the full intended line set. A line with `id` updates that line (it must
  belong to the order, otherwise `400`, field code `LINE_NOT_FOUND`). A line without `id` is
  inserted. Lines left out are deleted.
- Display order is the array order. The server stores `position`, and clients never send
  it. Sort: `position`, `id`.
- A duplicate id → 400. More than 500 lines → 400. An empty set → 400 (so an edit can never
  leave zero lines; INV-5 backs this up in the DB).
- One insert, one update and one delete statement per PATCH.
- The audit diff lists added, removed and changed lines with field-level before/after.

## Alternatives
Full replacement (unstable IDs and a useless audit diff); per-line endpoints (500 requests
for a 500-line edit).
