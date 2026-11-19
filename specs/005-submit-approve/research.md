# Research: Slice 4 — Submission, routing, approval, rejection and withdrawal

**Date**: 2026-11-17 · **Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md)

Owner directions for this plan (2026-11-17), numbered as used below:
1. approval steps: table shape, one row per tier step, immutable once decided; what the
   database itself refuses
2. routing compared exactly in SQL; the policy version bound at submit
3. the vendor snapshot taken at submit, and the columns locked once submitted
4. auto-approval as the `SYSTEM` actor, in the submit's transaction
5. one lock order for every order command, the owner's user row last; no path locks a
   user and then an order; the races tested
6. the approval queue and nav count: indexes and plans at ADR-0012's dataset, oldest
   submission first, never the caller's own orders
7. every new error code and ADR-0004 matrix cell listed for sign-off (R9)

Every number and list below is a named constant in `packages/contracts/src/orders.ts` or
`approvals.ts`; where SQL holds a copy, `order-constants.test.ts` pins it (CLAUDE.md).

---

## R1 Approval policy: versioned rows, written only by the operator CLI

**Decision**
- `approval_policies (version integer PK, effective_at timestamptz, created_at)` and
  `approval_policy_tiers (policy_version → approval_policies, tier smallint, threshold
  numeric(22,4), PK (policy_version, tier))`. Tiers are numbered 1…n with strictly
  increasing thresholds, each `> 0` and within the order total's type. The **current
  policy is the highest version**; there is no "active" flag to keep in step.
- Rows are **immutable**: `po_app` has `SELECT` only. A `BEFORE UPDATE OR DELETE` trigger
  refuses every change for any role (`PO017 APPROVAL_POLICY_IMMUTABLE`), so a
  privileged mistake is loud too.
- **Writes go through one function**, `set_approval_policy(thresholds numeric[])`,
  `SECURITY DEFINER`, `EXECUTE` granted to `po_app`. It refuses unless the transaction's
  actor context is `OPERATOR` (`PO017`), validates the tiers (count ≥ 1, each > 0, at
  most 4 decimal places, strictly increasing), returns the existing version unchanged
  when the tiers equal the current ones (the CLI's no-op), and otherwise inserts the next
  version and its tiers. The API never runs as `OPERATOR` (only the CLI's
  `withTransaction` sets it), so no HTTP path can write the policy, and the route-table
  test asserts no route does.
- Migration `0014_approvals` seeds version 1 with one tier, `100000.0000`
  (`APPROVAL_POLICY_SEED_TIERS`). It is migration data, like the transition rows, so it
  writes no audit entry (implementation, 2026-11-17: an entry in every database broke
  every test that reads the audit log, and no actor changed a policy); its version row
  records when it took effect, and every later `policy:set` is audited.
- **What the `OPERATOR` check protects against** (analysis, 2026-11-17): every API
  code path, since only the CLI's `withTransaction` sets `OPERATOR`. It is not a defence
  against a compromised `po_app` role: anyone running raw SQL as `po_app` can set the
  transaction's actor context to `OPERATOR` and call the function, and can equally set a
  USER context to forge a step decision under another user's id (D5 checks the decider
  against the context, not against a session). Those are code-path checks, not a
  boundary against the application's own role. A dedicated CLI database role, holding
  `EXECUTE` on `set_approval_policy` while `po_app` holds none, is the hardening option,
  recorded for slice 7 (ADR-0020's least-privilege review).
- CLI: `policy:set --tier1 <amount>` and `policy:show` in `backend/src/cli/commands/`,
  same exit-code and advisory-lock rules as the admin commands. `--tier1` only today
  (ADR-0002); the function already takes an array, so repeated `--tier` flags are a CLI
  change only.
  `policy:set` takes `APPROVAL_POLICY_LOCK` exclusively with the admin lock's timeout
  (`ONE_SHOT.adminLockTimeoutMs`) before reading the current policy (implementation,
  2026-11-19): a submit in progress shares the lock, so the command waits for it and,
  past the timeout, exits 3 `UNAVAILABLE` with nothing changed. It uses the CLI's
  existing database connection (`DATABASE_URL`, `po_app`) and actor context; no new role
  or setting. The audit entry's `entityId` is the new version number.
- `GET /approval-policy` (Buyer, Approver, Admin) returns `{ version, effectiveAt,
  tiers: [{ tier, threshold }] }` from the highest version.

**Rationale**: immutable versions make "the policy an order was routed by" a foreign key,
not a copy that could drift. The function plus the actor check is the database half of
"changed only by the operator CLI".

**Alternatives**: an `active` flag (two writes to keep consistent); `INSERT` granted to
`po_app` (the API process could write the policy); a separate CLI database role (a new
secret and compose change for one command).

---

## R2 Approval rounds and steps: shape, immutability, what the database refuses (direction 1)

**Decision: two tables.**
- `approval_rounds`: **one row per submission** of an order.
  `(order_id, round)` PK; `policy_version`; `total` (the order's total at submit);
  `vendor_snapshot` (R4); `submitted_by`, `submitted_at`; `outcome` (`NULL` while open,
  then one of `AUTO_APPROVED`, `APPROVED`, `REJECTED`, `WITHDRAWN`); `closed_at`;
  `withdraw_reason`. A `CHECK` ties `outcome` and `closed_at` together, and requires
  `withdraw_reason` exactly when `outcome = 'WITHDRAWN'`.
- `approval_steps`: **one row per tier step** of a round.
  `(order_id, round, step)` PK, FK to its round; `tier`, `threshold` (copied from the
  policy tier: what this step was for); `state` `OPEN | APPROVED | REJECTED | VOIDED`;
  `decided_by`, `decided_at`, `decided_version`, `reason`, `voided_at`. A `CHECK` fixes the
  shape per state: `OPEN` has no decision and no void; `APPROVED` has a decision, no
  reason; `REJECTED` has a decision and a reason; `VOIDED` has `voided_at` and keeps any
  earlier approval (ADR-0001: "decided steps keep their record").
- An auto-approved submission is a round with `outcome = AUTO_APPROVED` and **no steps**.
- Rounds are kept forever (only the order's current round decides it), and cascade only
  with a deleted draft (its audit record stays, as slice 3).

**What the database refuses** (custom SQLSTATEs, each an `INTERNAL_ERROR` if reached
through the API, because the service should have refused first):

| # | Refusal | How | Code |
|---|---|---|---|
| D1 | `APPROVED` with an open step, or any status that disagrees with its round | deferred constraint trigger `order_approval_consistent` at commit (below) | `PO014` |
| D2 | A decision on a step that isn't the current one: another round, a later step while an earlier one is open, or an order that isn't `PENDING_APPROVAL` | `BEFORE UPDATE` row trigger on `approval_steps`, reading the order (already locked by the command) | `PO012` |
| D3 | A status change outside `order_status_transitions` | slice 3's trigger, now with five rows (R4) | `PO009` |
| D4 | Any change to a step or round once its round is closed; any column change other than the allowed state moves; deleting a step or round while its order exists | row triggers on both tables | `PO012`, `PO013` |
| D5 | A step decided by the order's owner, or by anyone but the transaction's acting user | the D2 trigger: `decided_by = app.actor_user_id`, `actor_type = USER`, `decided_by <> owner_id` | `PO016` |
| D6 | An auto-approval recorded by anyone but `SYSTEM` | `approval_rounds` trigger: `outcome = AUTO_APPROVED` only with `app.actor_type = SYSTEM` | `PO013` |
| D7 | Steps or rounds inserted except for the order's next submission | insert triggers: order `DRAFT` and locked, `round = coalesce(current_round, 0) + 1`, steps `OPEN` | `PO012`, `PO013` |
| D8 | Vendor, submission columns or round pointer changed outside a transition | `purchase_orders` trigger (R4) | `PO015` |

Allowed step moves: `OPEN → APPROVED`, `OPEN → REJECTED` (both: D2 and D5 hold,
`decided_at = now()`, `decided_version` = the order's version at that moment);
`OPEN → VOIDED` and `APPROVED → VOIDED` (withdraw; also `OPEN → VOIDED` for the steps after
a rejected one). Nothing else, and nothing once the round is closed.

**D1, the commit-time check** `order_approval_consistent(order_id)`, fired by deferred
constraint triggers on `purchase_orders` (update), `approval_rounds` and
`approval_steps` (insert, update). A row-level constraint trigger fires at commit once per
changed row, so a command checks its order at most 2 + tier-count times (the order row,
the round, one row per step), after the command's statements, in whatever order they
ran. Each run reads one order, its rounds and steps by primary key; the cost is bounded
by the tier count, not by lines:
- the **expected chain** of the current round is recomputed from data: the tiers of the
  round's `policy_version` whose `threshold < round.total`, ascending; the round's steps
  must match it exactly (count, step numbers, tiers, thresholds). This is R3's routing,
  re-derived by the database, so a hand-built chain can't skip a tier;
- `round.total = order.total` and `order.submitted_at = round.submitted_at` while the order
  isn't a draft;
- per status: `DRAFT` → no round, or the current round `WITHDRAWN`, with every step
  `VOIDED`, and `submitted_at`, `approved_at` null; `PENDING_APPROVAL` → round open, at
  least one step, states `APPROVED* OPEN+`; `APPROVED` → `AUTO_APPROVED` with an empty
  expected chain, or `APPROVED` with every step `APPROVED`, and `approved_at =
  round.closed_at`; `REJECTED` → round `REJECTED`, states `APPROVED* REJECTED VOIDED*`;
- every earlier round is `WITHDRAWN` with all its steps `VOIDED`.
`CANCELLED` stays unreachable (no transition into it until slice 5, which extends this
function).

**Rationale**: the brief's state machine and §8 routing are integrity rules, so Principle
II puts them in the database, as Principle I does for totals. One commit-time function
states every rule in one place and is indifferent to statement order; the row triggers
give the immediate, specific refusals (D2, D4–D8).

**Alternatives**: steps only, with round data on the order (loses the withdraw reason and
earlier snapshots, and makes "auto-approved" a flag instead of a record); a JSON chain on
the order (unindexable, and immutability per step impossible); state rules only in the
service (Principle II forbids).

---

## R3 Routing: exact comparison in SQL, the policy version bound at submit (direction 2)

**Decision**
- Submit runs, under the order lock (R6):
  1. `INSERT INTO approval_rounds … SELECT` the next round number, the **highest policy
     version** (read once, in this statement), the order's `total`, the vendor snapshot
     (R4), the caller, `now()`;
  2. `INSERT INTO approval_steps … SELECT row_number() OVER (ORDER BY tier), tier,
     threshold FROM approval_policy_tiers WHERE policy_version = $v AND threshold <
     $total`, where `$v` and `$total` are the round's own columns (a sub-select on the row
     just inserted, not values sent from the app);
  3. one `UPDATE purchase_orders` to `PENDING_APPROVAL` when step 2 inserted rows,
     otherwise (under `SYSTEM`, R5) the round's outcome `AUTO_APPROVED` and the order to
     `APPROVED`.
- The comparison is `numeric(22,4) < numeric(22,4)` in PostgreSQL: exact, no float, no
  rounding. "Above" is strictly greater (ADR-0002). Seed boundaries tested:
  `100000.0000` → auto; `100000.0001` and `100000.0100` → one step.
- **Binding**: the round stores `policy_version` (FK). A later `policy:set` inserts a new
  version and never touches existing rounds, so a submitted order keeps its chain; a
  withdraw and resubmit routes under the then-current version. Policy rows are immutable,
  but a submit takes the policy advisory lock in shared mode before opening its round,
  and `set_approval_policy` takes it exclusively (implementation, 2026-11-17). Under READ
  COMMITTED the round insert and its guard read the highest version in two snapshots; a
  policy change committing between them made the guard refuse a valid submit. With the
  lock, one waits for the other, and the version read is the one recorded and re-checked
  at commit (D1).

**Rationale**: routing in the same statement that reads the data means the app can't
round, misread or race it, and D1 re-derives it at commit anyway.

**Alternatives**: compare in TypeScript with `big.js` (correct, but a second copy of the
rule, and D1 would still need SQL); store only the step count (loses which tiers).

---

## R4 Submission columns, vendor snapshot and what is locked once submitted (direction 3)

**Decision**
- **Vendor snapshot**: the round's `vendor_snapshot jsonb`, from slice 2's
  `requireActiveVendor` (`VendorOrderSnapshot`: id, name, contact name, email and phone,
  payment terms), taken in the submit transaction under the vendor's `FOR SHARE` lock. A
  `CHECK` requires the object and its keys; reads parse it with the contracts' Zod
  schema. Each submission has its own snapshot, so a withdraw → edit → resubmit history
  keeps every one.
- **New `purchase_orders` columns**: `current_round smallint` (null until the first
  submit), `submitted_at` (the current round's, for the queue index, R7; null on a
  draft), `approved_at` (set on → `APPROVED`; ADR-0015 measures age from it).
- **Reads**: a non-draft order shows the current round's snapshot; a draft (including a
  withdrawn one) the live vendor, as slice 3.
- **Locked once submitted** (database, D8 and slice 3's triggers):

  | Column or data | Rule |
  |---|---|
  | lines (all columns but `received_quantity`) | slice 3's `PO006`, unchanged |
  | `vendor_id` | changes only while the order is `DRAFT` before and after (`PO015`) |
  | `current_round`, `submitted_at`, `approved_at` | change only in the same `UPDATE` as a status change, to the values D1 checks (`PO015`, then `PO014`) |
  | `total`, `open_line_count` | derived; can't change because lines can't (slice 3) |
  | `po_number`, `owner_id`, `created_at` | immutable always (slice 3, `PO008`) |
  | `status` | only along `order_status_transitions` (`PO009`) |
  | the round (`policy_version`, `total`, `vendor_snapshot`, `submitted_*`) | immutable from insert (D4) |
  | delete | only while `DRAFT` (slice 3, `PO010`) |

- `order_status_transitions` gains: `DRAFT → APPROVED` (T4), `DRAFT → PENDING_APPROVAL`
  (T5), `PENDING_APPROVAL → APPROVED` (T7), `PENDING_APPROVAL → REJECTED` (T8),
  `PENDING_APPROVAL → DRAFT` (T9). T6 isn't a status change. `APPROVED → CANCELLED` is
  slice 5's.
- `po_app` gains `UPDATE (status, current_round, submitted_at, approved_at)` on
  `purchase_orders`; still nothing on derived columns, owner or timestamps.

**Rationale**: the snapshot belongs to the submission, not the order, because an order can
be submitted more than once. The three order columns exist only for indexes and the
report; D1 keeps them equal to their round.

**Alternatives**: snapshot columns on the order, overwritten each submit (loses earlier
snapshots); typed snapshot columns (eight columns for a document that is only ever read
whole; the `CHECK` and Zod parse give the shape).

---

## R5 Auto-approval as the `SYSTEM` actor, inside the submit (direction 4)

**Decision**
- `withTransaction` sets the actor context once per transaction (slice 0). A new helper,
  `asSystem(tx, fn)` in `db/transaction.ts`, available only on an `AuditedTransaction`,
  re-sets the transaction-local context to `SYSTEM` (same `actor_txid` and request id),
  runs `fn`, and restores the caller's context in a `finally`.
- Submit writes, in one transaction: as the owner, the round and `PO_SUBMITTED`; then, when
  no step was created, inside `asSystem`: the round's `outcome = AUTO_APPROVED`, the order
  → `APPROVED` with `approved_at`, and `PO_AUTO_APPROVED` (threshold, policy version,
  round). The audit fill trigger takes the actor from the context, so the entry is
  `SYSTEM` with no user fields, by the existing `CHECK`.
- D6 makes the database refuse an `AUTO_APPROVED` outcome written under any other context.
- One transaction: a failure anywhere rolls back the submit and the auto-approval
  together; there is never a submitted-but-unrouted order.

**Alternatives**: a `SECURITY DEFINER` function doing the auto-approval (moves service
logic into SQL for no extra guarantee beyond D6); a second transaction (a crash between
them would strand an order in a state the table doesn't allow).

---

## R6 Lock order for every order command; no user-then-order lock (direction 5)

**Decision**, recorded in ADR-0006 (amended 2026-11-17):

| Command | Locks, in this order | Then decides |
|---|---|---|
| edit (slice 3) | order `FOR UPDATE` → lines (id asc) `FOR UPDATE` → vendor `FOR SHARE` | |
| delete (slice 3) | order `FOR UPDATE` → lines (id asc) `FOR UPDATE` | |
| submit | order `FOR UPDATE` → vendor `FOR SHARE` → policy advisory lock (shared) | routing (R3) |
| approve | order `FOR UPDATE` → current round's steps (step asc) `FOR UPDATE` → vendor `FOR SHARE` → owner's and Approver's `users` rows `FOR SHARE`, in id order | step decision |
| reject | order `FOR UPDATE` → current round's steps (step asc) `FOR UPDATE` → owner's and Approver's `users` rows `FOR SHARE`, in id order | |
| withdraw | order `FOR UPDATE` → current round's steps (step asc) `FOR UPDATE` | |

- Submit locks no lines: every line change takes its order's lock first (slice 3's line
  triggers), so holding the order `FOR UPDATE` freezes the total.
- **`users` rows are always last**, and only approve and reject take them: the owner's
  and the acting Approver's, always two different rows (`SELF_APPROVAL` otherwise), in id
  order (owner decision, 2026-11-17). The FK on `approval_steps.decided_by` then takes
  `FOR KEY SHARE` on the Approver's row, already held.
- **The acting Approver is re-checked under that lock** (owner decision, 2026-11-17):
  deactivated since the request began → `401 ACCOUNT_DEACTIVATED`; APPROVER removed →
  `403 FORBIDDEN`; the same codes the request-level check gives. Locks are all taken
  first; the checks then run in R8's order, the Approver's re-check first.
- **Rule (ADR-0006): no code path may lock a `users` row and then an order, line, round,
  step or vendor.** User-management commands (admin update, deactivation, password,
  sessions, tokens) lock only user and session rows and never touch order data. So the
  only shared row between the two families is `users`, always taken last by order
  commands, and no cycle can form. Slice 6's open-order counts read orders without
  locking. A test asserts both families' lock sets (R6 tests below); a reviewer checks the
  rule on every new command.
- **Owner check under lock**: approve reads the owner's `status` and `roles` with `FOR
  SHARE`. An admin deactivation or role change (`FOR UPDATE` on that row) either commits
  first, so approve sees it and refuses `ORDER_OWNER_INACTIVE`, or waits until approve
  commits, so the order was approved before the change. Never approved after it.

**Races tested** (`backend/tests/concurrency/approvals.test.ts`, barriers, business
outcomes asserted):
1. approve vs reject on the same step: exactly one decision; the order is `APPROVED` or
   `REJECTED` to match; the loser gets `409 VERSION_CONFLICT` (same version) or
   `INVALID_STATE_TRANSITION`.
2. approve vs withdraw: one wins; `APPROVED` with no voided step, or `DRAFT` with every
   step `VOIDED` and no approval.
3. edit vs submit on a draft: one wins; the final status is the routing of the final total
   (an edit that crosses the threshold, then submit, routes by the new total).
4. approve vs the owner's deactivation, and approve vs removal of the owner's BUYER role:
   approved before the change, or `409 ORDER_OWNER_INACTIVE` after; never approved after.
5. double approve on the same step (two tabs): one decision recorded.
5a. approve and reject vs the acting Approver's own deactivation, and vs removal of their
    APPROVER role: decided before the change, or `401 ACCOUNT_DEACTIVATED` / `403
    FORBIDDEN` after it; never decided after it.
6. approve vs vendor deactivation; submit vs vendor deactivation: approved/submitted
   before, or `409 VENDOR_INACTIVE` after.
7. submit vs `policy:set`: the order records whichever version its statement read, and
   its chain matches that version (D1 passes).
8. withdraw vs reject: one wins (`DRAFT` or `REJECTED`).
Plus a lock-order test: an approve holding both `users` rows `FOR SHARE` and an admin
deactivation or role change of the owner, and of the acting Approver, each complete
without deadlock in both start orders.

**Alternatives**: `SERIALIZABLE` (retries instead of a clear lock order; ADR-0006 already
chose lock-then-read); a conditional `UPDATE … WHERE status = … AND version = …` per
command (fine for one row, but approve must read four tables consistently).

---

## R7 Approval queue and nav count: indexes, sort, plans (direction 6)

**Decision**
- Scope in SQL: `status = 'PENDING_APPROVAL' AND owner_id <> $caller`. Sort **oldest
  submission first**: `submitted_at ASC, id ASC`. Filters: `vendorId`; `poNumber` prefix,
  which, as slice 3's lists, sorts by PO number descending and walks the index
  backwards.
- **Partial indexes** (only pending orders, a few thousand rows however many orders
  exist):

  | Index | Serves |
  |---|---|
  | `(submitted_at, id) INCLUDE (owner_id) WHERE status = 'PENDING_APPROVAL'` | queue, no filter; its `COUNT`; the nav count |
  | `(vendor_id, submitted_at, id) INCLUDE (owner_id) WHERE status = 'PENDING_APPROVAL'` | queue + vendor |
  | `(po_number) INCLUDE (owner_id) WHERE status = 'PENDING_APPROVAL'` | queue + PO prefix |

  `owner_id` is included so the exclusion is checked in the index (index-only scans).
- Query shape: slice 3's deferred join (keys from the index, cut at `LIMIT … OFFSET` as
  literals, then join back for the page), rows and `total` in one statement. Per page row:
  the current round's snapshot name and current open step (PK lookups) and `ownerCanAct`
  (`users` by PK: `status = 'ACTIVE' AND 'BUYER' = ANY(roles)`).
- **Nav count** = the queue's `total` with `pageSize=1`, so it has the queue's exact scope
  (never the caller's own orders; ADR-0004, 2026-11-17).
- **Dataset** (ADR-0012 amended 2026-11-17): the 100k-order fixture gets a status mix,
  fixed by series number: 5,000 `DRAFT`, **3,000 `PENDING_APPROVAL`** (all in the one
  Approver's queue, ADR-0012's worst case), 2,000 `REJECTED`, 90,000 `APPROVED` (slices 5–6
  split these further). Rounds and steps seeded to match, and the reconciliation plus
  `order_approval_consistent` checked over all orders before planning. One of the top-10
  Buyers is given `{BUYER, APPROVER}` in a second fixture user, so the exclusion is
  planned with own pending orders present.
- `orders.plan.test.ts` adds: queue page 1 and page 100 (3,000 / 20 = 150 pages, so
  page 100 exists), each filter, the dual-role queue, and each `COUNT`;
  same assertions as slice 3 (no `Seq Scan` on `purchase_orders`, `approval_rounds`,
  `approval_steps`; no sort over more than page + offset rows). The order-list plans are
  re-committed, since the Approver scope (`status <> 'DRAFT'`) now has 95,000 rows.
  `npm run plans:orders` writes `docs/query-plans/orders/approval-queue-*.txt`.
- **Order lists with real non-draft data** (amended 2026-11-18, owner decision). The
  status mix exposed slice 3's list plans: its Approver scope was four status branches on
  `(status, created_at)` with every filter applied on the rows, planned when every order
  was a draft. At 95 % non-draft orders, 24 list and count plans read or sorted past the
  page (a vendor filter discarded 3,000 rows for a page of 20; a short PO prefix sorted
  90,000 rows at page 100; counts read the drafts). Fixed in migration 0014:
  - **A.** Non-draft partial indexes, the list's own predicate `status <> 'DRAFT'`:
    `(created_at DESC, id DESC)`, `(vendor_id, created_at DESC, id DESC)`, `(po_number)`.
    The Approver scope is one branch on them.
  - **B.** A Buyer+Approver's list is their own drafts plus every non-draft order, their
    own included: two branches that never overlap, so neither filters out the caller's
    rows.
  - **C.** `(vendor_id, status, created_at DESC, id DESC)` for a status and a vendor
    together (Admin, Approver).
  - **D.** `(owner_id, vendor_id, status, created_at DESC, id DESC)`: a Buyer's status and
    vendor together sorted 500 rows at page 1 without it, so by the owner's rule it got an
    index, not an exception. With it no deep page sorts past its bound: no exception is
    recorded.
  - A Buyer+Approver's own drafts by PO prefix sorted 500 rows at page 1 too: a partial
    `(owner_id, po_number) WHERE status = 'DRAFT'`, by the same rule (implementation,
    listed for the owner).
  Every order plan now walks an index to the page; none has a sequential scan, the three
  Admin counts slice 3 accepted included.
- **Timings** (`orders.timing.test.ts`): submit of a 500-line order p95 ≤ 500 ms; a
  single approval p95 ≤ 150 ms; queue page 1 p95 ≤ 150 ms (ADR-0012).

**Alternatives**: a full index `(status, submitted_at)` (covers more rows than needed;
the partial index stays small as approved orders accumulate); a queue table maintained by
triggers (another derived value to guard).

---

## R8 Error codes, messages and order of checks

**New registry entries** (`packages/contracts/src/errors.ts`, added tests first):

| Code | Status | Source | Problem `detail` |
|---|---|---|---|
| `ORDER_PENDING_APPROVAL` | 409 | ADR-0001, 2026-11-17 (new) | "This order is waiting for approval. Withdraw it to make changes." |
| `ORDER_OWNER_INACTIVE` | 409 | ADR-0001, 2026-11-17 (new) | "The buyer who raised this order can no longer act on it. Reject it, or approve once their access is restored." |
| `ORDER_LOCKED` | 409 | ADR-0001 (first reachable now) | by `orderState.status`: `APPROVED` "This order is approved and locked."; `REJECTED` "This order was rejected and is closed. Raise a new order instead." (`ORDER_LOCKED_MESSAGES`, a map keyed by status; slice 5 adds `CANCELLED`) |
| `NOT_ORDER_OWNER` | 403 | ADR-0004 (first reachable now) | "Only the buyer who raised this order can do that." |
| `SELF_APPROVAL` | 403 | ADR-0004 (first reachable now) | "You can't approve or reject an order you raised." |

No new field codes: reasons use slice 3's `REQUIRED`, `TOO_LONG`, `INVALID_FORMAT`.
`DUPLICATE_APPROVER` stays absent (registry test).

**Database errors** (`db/errors.ts`, all `INTERNAL_ERROR`): `PO012
APPROVAL_STEP_REFUSED`, `PO013 APPROVAL_ROUND_REFUSED`, `PO014
ORDER_APPROVAL_INCONSISTENT`, `PO015 ORDER_SUBMISSION_FIELD_LOCKED`, `PO016
SELF_DECISION_REFUSED`, `PO017 APPROVAL_POLICY_IMMUTABLE`.

**Order of checks** (ADR-0004 precedence; same for each command):
1. `401` → CSRF → `403 NO_ROLE_ASSIGNED` → `403 FORBIDDEN` (route role: submit and
   withdraw BUYER, approve and reject APPROVER; an Admin gets the read-only message).
2. `400`: `If-Match`; body (submit, approve: none or `{}`; reject, withdraw: `reason`).
3. In the transaction, after the locks of R6: approve and reject re-check the acting
   Approver (`401 ACCOUNT_DEACTIVATED`, `403 FORBIDDEN`) → `404` (missing or not readable) → order-level
   `403` (`NOT_ORDER_OWNER` for submit/withdraw/edit/delete by a non-owner who can read
   it; `SELF_APPROVAL` for approve/reject by the owner) → `409` state
   (`ORDER_PENDING_APPROVAL` / `ORDER_LOCKED` for edit and delete; `INVALID_STATE_TRANSITION`
   for submit, withdraw, approve, reject from the wrong state) → `409 VERSION_CONFLICT` →
   `409 VENDOR_INACTIVE` (submit, approve) → `409 ORDER_OWNER_INACTIVE` (approve).

State before version, as slice 3: a stale tab on an approved order learns that it is
locked, not that it is stale.

---

## R9 Authorization: cells for sign-off (direction 7)

**Already in ADR-0004, now exercised** (no change): read and timeline of non-draft orders
(Approver ✓); approve or reject (Approver ✓, owner `SELF_APPROVAL`); pending-approvals
count (Approver ✓, others 403; never their own orders, 2026-11-17); read policy (all
roles ✓, no role `NO_ROLE_ASSIGNED`).

**Signed off by the owner on 2026-11-17 and written into ADR-0004**, with two additions:
role-specific `FORBIDDEN` messages ("Approvers can review orders but not change them."
for a pure Approver on edit, submit, withdraw, delete; "Only Approvers can approve or
reject orders." for a pure Buyer on approve, reject; one shared constant each, API
`detail` and web message), and the acting Approver re-checked under lock (R6). The cells
as signed off:
- **S1 Approval queue (list)**, a new row beside the count row: Owner/Other Buyer
  `403 FORBIDDEN` (route); Approver ✓ (pending orders of others); Buyer+Approver ✓ (others'
  pending only); Admin `403 FORBIDDEN`; no role `403 NO_ROLE_ASSIGNED`; anonymous `401`.
- **S2 "Edit, submit, withdraw, delete" for an Approver**: the matrix says
  `403 NOT_ORDER_OWNER (if readable)`, but ADR-0004's own precedence puts the route's role
  check first, and slice 3 already tests a pure Approver's edit as `403 FORBIDDEN`. Proposed
  wording: pure Approver `403 FORBIDDEN` (route, before validation); Buyer+Approver on
  another buyer's readable order `403 NOT_ORDER_OWNER`; on another buyer's draft `404`.
- **S3 "Approve or reject" for a Buyer**: the matrix's "Other Buyer 404" and "Owner
  Buyer `SELF_APPROVAL` (if also Approver)" leave a pure Buyer undefined. Proposed: pure
  Buyer (owner or not) `403 FORBIDDEN` (route); Buyer+Approver owner `403 SELF_APPROVAL`;
  Buyer+Approver on another buyer's draft `404`.
- **S4 Admin on submit, withdraw, approve, reject**: `403 FORBIDDEN` at route level with
  "Admins can view orders but not change them." (extends the 2026-11-12 cell, which named
  create, edit, delete, submit and withdraw, to approve and reject).
- **S5 `ownerCanAct` on order reads and queue rows**: a boolean, shown to everyone who can
  read the order (owner, Approver, Admin). It tells an Approver that a colleague is
  deactivated or no longer a Buyer, but not which. Needed for the marker the owner
  decided on.
- **S6 Decider's name on order reads**: the approval chain shows each step's decider by
  name to everyone who can read the order (the owner Buyer sees which Approver decided).
  The audit timeline already shows it to the same readers; listed for confirmation.
- **S7 Withdrawn orders**: after a withdraw the order is a draft again, so an Approver
  (even one who approved an earlier step) gets `404` on it and its timeline until it is
  resubmitted. That is the existing draft cell; listed for confirmation.

The spec's US2 scenario 3 is corrected to match S2 (it said "an Approver").

---

## R10 Order reads and lists

- `order` gains `submittedAt`, `approvedAt`, `ownerCanAct`, `vendorSnapshot` (non-draft;
  drafts keep slice 3's live `vendor`), and `approval`: the current round, or null if
  never submitted: `{ round, policyVersion, outcome, submittedAt, closedAt,
  withdrawReason, steps: [{ step, tier, threshold, state, decidedBy: { id, name } | null,
  decidedAt, reason }] }`. A withdrawn draft shows its withdrawn round, so the owner sees
  why it came back.
- List items show the snapshot vendor name for non-draft orders (page rows only).
- Still one statement per read (slice 3's R10), with the round and steps as JSON
  sub-selects.

## R11 Web app

- Order detail: Submit (draft owner), Withdraw (pending owner), Approve and Reject
  (Approver, not the owner) as `ConfirmDialog`s (ADR-0018 text); the chain panel (state,
  decider, time, reason); the snapshot vendor; the "Owner can no longer act on this order"
  marker replacing Approve with Reject; read-only for every non-draft order.
- `/approvals`: the queue (PO number, buyer, vendor, total, step, submitted, marker),
  oldest first, filters in the URL; Approvers only.
- Nav: pending-approvals count for Approvers, from `GET /approvals?pageSize=1`, refreshed
  every 60 s, on focus and after submit, approve, reject or withdraw.
- Messages: the five registry entries; `ORDER_LOCKED` picks its sentence from
  `orderState.status`; a pending order's editor save shows `ORDER_PENDING_APPROVAL` with a
  "Withdraw" shortcut for the owner.
- The editor is never offered for a non-draft order; a stale editor tab gets the specific
  `409` and "Reload order".

## R12 Audit payloads and demo seed

- ADR-0016's catalogue (amended 2026-11-17) adds `round` to every approval event, and the
  vendor snapshot to `PO_SUBMITTED` (so the timeline shows what was sent for approval even
  after a withdraw). `PO_WITHDRAWN` lists each voided step with any earlier decision.
- Demo seed: per demo Buyer, one order in each reachable state (draft, pending,
  auto-approved, step-approved, rejected, a withdrawn draft), made through the services so
  the audit and rounds are real; reconciliation and `order_approval_consistent` after
  seeding.
