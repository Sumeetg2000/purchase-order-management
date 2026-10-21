# ADR-0006: Concurrency and transaction strategy

- **Status:** Accepted · 2026-10-16 · amended 2026-10-20 (details moved here from the
  constitution)
- **Brief:** §8 · Gaps G2, G6 · Lessons 2, 8
- **Principles:** V

## Decision
- Lock, then read, then decide (`SELECT … FOR UPDATE`), or one conditional statement. Never
  decide on an unlocked read. Lock order: order → lines (id asc) → vendor. The triggers
  that maintain received quantity lock the line themselves, so even raw SQL can't
  over-receive.
- One short transaction per command, with no network calls. Writes are batched. Pool size,
  transaction `timeout` and `maxWait` are set explicitly.
- Pool exhaustion or timeout → `503 SERVICE_UNAVAILABLE`. `40001`/`40P01` are retried up to
  3 times with jitter, then `503 CONCURRENCY_RETRY_EXHAUSTED`.
- **Client optimistic concurrency.** Orders carry an integer `version`, incremented on
  every change to the order or its lines and returned as `ETag: "<version>"`.
  - Edit, submit, withdraw, delete, approve, reject and cancel require
    `If-Match: "<version>"`.
  - Missing header → `400 VALIDATION_FAILED`, field code `VERSION_REQUIRED`. Mismatch →
    `409 VERSION_CONFLICT`.
  - We use 400/409 rather than RFC 9110's `428`/`412` deliberately, so the API has no
    extra statuses. Clients branch on `code`.
  - Users carry a `version` too. The admin user update requires `If-Match` with the same
    rules (ADR-0016).
  - Receipts don't need `If-Match` and don't increment `version`. They are guarded by the
    line lock, the database constraint and `Idempotency-Key`. Requiring a version there
    would make concurrent receipts on different lines conflict needlessly.
- `Idempotency-Key` on creates of orders and receipts. Replaying a key returns the original
  result. A reused key with a different body → `409 IDEMPOTENCY_KEY_REUSED`. Keys are kept
  for 24 hours. PO numbers are allocated before the create transaction (ADR-0001),
  so a replay that reaches allocation can leave a gap.

## Tests (assert business outcomes)
50 parallel receipts on one line; edit vs submit (the final status matches the final
total); withdraw vs approve; two concurrent approve requests on the same step (a double
click, or two tabs; exactly one decision recorded); cancel vs receive; concurrent PO number
allocation; a simulated pool timeout → 503; missing `If-Match` on each listed command →
400 `VERSION_REQUIRED`; stale `If-Match` → 409; receipts accepted without `If-Match`.
