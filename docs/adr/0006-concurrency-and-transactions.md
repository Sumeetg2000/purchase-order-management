# ADR-0006: Concurrency and transaction strategy

- **Status:** Accepted · 2026-10-16 · amended 2026-10-20 (details moved here from the
  constitution) · amended 2026-11-06 (vendors carry a `version`; slice 2) · amended
  2026-11-12 (the PO counter row is locked last; replays leave no gap; slice 3) ·
  amended 2026-11-17 (approve reads the owner's user row `FOR SHARE`; slice 4) · amended
  2026-11-17 (one lock order per order command; no user-then-order lock; slice 4 plan,
  research R6)
- **Brief:** §8 · Gaps G2, G6 · Lessons 2, 8
- **Principles:** V

## Decision
- Lock, then read, then decide (`SELECT … FOR UPDATE`), or one conditional statement. Never
  decide on an unlocked read. Lock order: order → lines (id asc) → vendor → the order
  owner's user row (`FOR SHARE`, approve only, ADR-0001) → PO number counter row (a
  create only, as its last write, ADR-0001). The triggers
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
  - Vendors carry a `version` too (amended 2026-11-06). Edit, deactivate and reactivate
    require `If-Match` with the same rules. A vendor create takes no `Idempotency-Key`:
    the unique normalised name already makes a retry answer `409 DUPLICATE_VENDOR_NAME`
    naming the vendor the first attempt created (ADR-0005).
  - Receipts don't need `If-Match` and don't increment `version`. They are guarded by the
    line lock, the database constraint and `Idempotency-Key`. Requiring a version there
    would make concurrent receipts on different lines conflict needlessly.
- `Idempotency-Key` on creates of orders and receipts. Replaying a key returns the original
  result. A reused key with a different body → `409 IDEMPOTENCY_KEY_REUSED`. Keys are kept
  for 24 hours. The key, the order and its PO number commit or roll back in one
  transaction, so a replay never allocates and leaves no gap (ADR-0001, amended
  2026-11-12).

### Lock order per order command (amended 2026-11-17, slice 4 plan)
| Command | Locks, in order |
|---|---|
| edit | order `FOR UPDATE` → lines (id asc) `FOR UPDATE` → vendor `FOR SHARE` |
| delete | order `FOR UPDATE` → lines (id asc) `FOR UPDATE` |
| create | idempotency key → vendor `FOR SHARE` → PO number counter (last) |
| submit | order `FOR UPDATE` → vendor `FOR SHARE` → the policy advisory lock, shared (lines are frozen by the order lock: every line change locks its order first) |
| `set_approval_policy` (operator CLI) | the policy advisory lock, exclusive: a submit and a policy change never interleave, so a round records the version its routing read (amended 2026-11-17, slice 4 implementation) |
| approve | order `FOR UPDATE` → current round's steps (step asc) `FOR UPDATE` → vendor `FOR SHARE` → the owner's and the acting Approver's `users` rows `FOR SHARE`, in id order (always two different rows) |
| reject | order `FOR UPDATE` → current round's steps (step asc) `FOR UPDATE` → the owner's and the acting Approver's `users` rows `FOR SHARE`, in id order |
| withdraw | order `FOR UPDATE` → current round's steps (step asc) `FOR UPDATE` |

- **No code path may lock a `users` row and then an order, line, round, step or
  vendor.** Order commands take `users` rows only last (approve's and reject's owner and
  Approver rows, in id order, then the `FOR KEY SHARE` of the step's `decided_by` foreign
  key on a row already held). Approve refuses an owner who can't act
  (`ORDER_OWNER_INACTIVE`); approve and reject refuse an Approver deactivated (`401
  ACCOUNT_DEACTIVATED`) or without APPROVER (`403 FORBIDDEN`) since the request began
  (ADR-0004, 2026-11-17). User-management commands lock
  only user and session rows and never touch order data. With `users` always last on one
  side and alone on the other, no lock cycle can form between the two families.

## Tests (assert business outcomes)
50 parallel receipts on one line; edit vs submit (the final status matches the final
total); withdraw vs approve; approve vs the owner's deactivation or BUYER removal (approved
before the change, or `409 ORDER_OWNER_INACTIVE` after it); approve and reject vs the
acting Approver's own deactivation or APPROVER removal (decided before the change, or
`401 ACCOUNT_DEACTIVATED` / `403 FORBIDDEN` after it, never decided after it); approve vs reject; withdraw vs
reject; submit vs vendor deactivation; submit vs a policy change (the chain matches the
version recorded); an approve and an admin deactivation of the owner, started in either
order, and an approve and an admin deactivation or role change of the acting Approver,
started in either order, finish without deadlock; two concurrent approve requests on the same step (a double
click, or two tabs; exactly one decision recorded); cancel vs receive; concurrent PO number
allocation; a simulated pool timeout → 503; missing `If-Match` on each listed command →
400 `VERSION_REQUIRED`; stale `If-Match` → 409; receipts accepted without `If-Match`.
