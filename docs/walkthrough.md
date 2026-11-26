# Walkthrough

A guide for someone new to this system: what it does, who uses it, how an order moves
from draft to received, where each guarantee is enforced, and the answers to the brief's
§7 questions (`docs/BRIEF.md`), each pointing at the code, tests and committed query
plans behind it. Every path named here is checked to exist (`npm run check:walkthrough`).

## What it is

A vendor and purchase-order system for one company: a shared vendor list, purchase
orders with derived totals, threshold-based approval, goods received per line, and a
report of what is still outstanding by vendor and age. The core concern is that derived
values (an order's total, a line's received and outstanding quantities, an order's count
of open lines) can never drift from what they are derived from, on any code path.

It runs with `docker compose up` and a documented `.env` (`.env.example`): PostgreSQL, the
API (Node, TypeScript, Express, Prisma), the React app behind nginx on one origin, and
Mailpit locally. The binding documents are the constitution
(`.specify/memory/constitution.md`), the ADRs (`docs/adr/README.md`) and the traceability
matrix (`docs/traceability.md`), which maps every brief clause to a passing test.

## Who uses it

- **Buyer**: maintains the shared vendor list, raises orders, submits them, withdraws a
  pending one to edit it, and records the goods received on their own approved orders.
- **Approver**: approves or rejects orders above the threshold that they don't own, and
  cancels an approved order with a reason (never their own: separation of duties).
- **Procurement Admin**: reads every order and the outstanding report; manages users and
  roles. Admins can't change orders.
- A new sign-up has **no role** until an Admin grants one.

Who may do what to which order is one matrix (`docs/adr/0004-ownership-visibility-and-sod.md`),
tested cell by cell (`backend/tests/integration/authorization-matrix.test.ts`).

## An order's life

1. **Draft**: the Buyer raises it (`POST /api/orders`) with 1–500 lines. Its total is
   computed by the database, never sent by the client.
2. **Submit**: the total decides the route. At or below ₹1,00,000 it is approved at once
   as an audited `SYSTEM` decision; above, one approval step per tier it exceeds, from
   versioned policy data (`backend/src/approvals/service.ts`).
3. **Approve, reject or withdraw**: an Approver decides against the version they saw
   (`If-Match`); the owner may withdraw a pending order to edit and resubmit it.
4. **Receive**: the owner records deliveries per line, partly and over several receipts;
   a receipt is append-only (`backend/src/receipts/service.ts`).
5. **Cancel**: an Approver may cancel an approved order that isn't fully received.

The state table is `docs/adr/0001-order-lifecycle-and-numbering.md`; the database refuses
any other status change. Every step leaves an audit entry in the same transaction.

## Where each guarantee lives

| Guarantee | Database | Service and API | Tests |
|---|---|---|---|
| Total = Σ lines; line total = quantity × price | generated column and statement triggers (`backend/prisma/migrations/0013_orders/migration.sql`) | totals are never accepted from a client | `backend/tests/integrity/attack-suite.test.ts` |
| Received = Σ receipts, never above ordered | receipt trigger and CHECK (`backend/prisma/migrations/0016_receipts/migration.sql`) | `409 RECEIPT_EXCEEDS_OUTSTANDING` naming each line | `backend/tests/integrity/receipt-attacks.test.ts` |
| Open-line count matches the lines | maintained by the same triggers, guarded | read by the report | `backend/tests/integrity/reconciliation.test.ts` |
| Approved orders are locked | triggers refuse line and header changes unless draft | `409 ORDER_LOCKED` | `backend/tests/integration/orders-lock.test.ts` |
| Nothing drifts, on any path | `backend/src/db/reconciliation.sql` returns zero rows | — | runs after every suite, seed and attack |
| Simultaneous requests | row locks in one order (`docs/adr/0006-concurrency-and-transactions.md`) | one short transaction per command | `backend/tests/concurrency/receipts.test.ts` |

## §7.1 An approved order cannot be edited. Where is that enforced?

In three places, so no path gets through:

1. **The service** locks the order row, reads its status and refuses an edit of anything
   but a draft with `409 ORDER_LOCKED`, which names the order's state
   (`backend/src/orders/service.ts`).
2. **The database** is the guarantee: triggers refuse any insert, update or delete of an
   order's lines, and any change to its vendor or header fields, unless the order is a
   draft, even for raw SQL run as the application's own role
   (`backend/prisma/migrations/0013_orders/migration.sql`, extended for approvals and
   cancels in `backend/prisma/migrations/0014_approvals/migration.sql` and
   `backend/prisma/migrations/0015_cancel/migration.sql`).
3. **Tests** prove both: the API returns the specific error for every edit path on an
   approved, rejected or cancelled order (`backend/tests/integration/orders-lock.test.ts`),
   and the attack suite tries the same edits in raw SQL and is refused
   (`backend/tests/integrity/attack-suite.test.ts`).

## §7.2 Show me a partial goods receipt. How is the outstanding quantity calculated?

A receipt is a document: one `goods_receipts` row (the date it arrived, who recorded it)
and one `goods_receipt_lines` row per line it covers, inserted in one statement
(`backend/src/receipts/repository.ts`). A statement-level trigger then adds each receipt
line's quantity to its order line's stored `received_quantity`, and keeps the order's
`open_line_count` (lines not yet fully received); a CHECK keeps `received_quantity` at or
below the ordered quantity (`backend/prisma/migrations/0016_receipts/migration.sql`).

**Outstanding = ordered − received**, per line, from those stored values. The order stays
`APPROVED`; whether it is partly or fully received is derived, never stored.

A partial receipt, end to end: order 100 units, receive 40 (40 received, 60 outstanding),
then 60 (100 and 0); each is a separate receipt with its own audit entry
(`backend/tests/integration/receipts-record.test.ts`). A receipt that would take any line
past what was ordered is refused whole, naming every line it would exceed
(`backend/tests/integration/receipts-multiline.test.ts`).

It holds under pressure: 50 simultaneous single-unit receipts on a line with 30 outstanding
record exactly 30 (or fewer, never more), because every receipt locks the order first
(`backend/tests/concurrency/receipts.test.ts`); random receipt sequences keep the
invariants (`backend/tests/integrity/receipt-invariants.property.test.ts`); and the
reconciliation query proves no stored value has drifted
(`backend/src/db/reconciliation.sql`).

## §7.3 How do you list outstanding orders by vendor and age? What does that query touch?

**Outstanding** = approved with at least one line not fully received:
`status = 'APPROVED' AND open_line_count > 0`, decided from the order row alone. **Age** is
whole calendar days in India time from the approval date to the report's as-of date, which
every response states; bands are 0–30, 31–60, 61–90 and over 90 days, each a range of
`approved_at` between India midnights (`docs/adr/0015-outstanding-report.md`).

Three partial indexes hold only approved orders that are still open, so they shrink as
orders complete (`backend/prisma/migrations/0017_outstanding_report/migration.sql`): by
approval date (the Admin's and Approvers' report), by vendor (the vendor filter and the
per-vendor summary) and by owner (a Buyer's own report).

The query (`backend/src/reports/repository.ts`) touches:
- **the partial index**, walked in approval order to the page's 20 rows and no further,
  with the age band as an index range; the total counts the same index entries alone
- **those 20 order rows**, plus their vendors and owners by primary key
- **each page row's lines**, by the order key, only to sum what is still outstanding
- **never receipts**: the stored `received_quantity` and `open_line_count` already carry
  them

The committed plans show it: over 90 days on the 100,000-order dataset
(`docs/query-plans/orders/report-admin-over-90-page-1.txt`), and on the brief's §8 load
test of 10,000 orders across 200 vendors (`docs/query-plans/load/outstanding-by-age.txt`).
Plan tests fail if any report plan reads receipts, scans orders or reads lines beyond the
page (`backend/tests/plans/orders.plan.test.ts`). At 100,000 orders the first page answers
in about 11 ms at p95 (target 200 ms; `backend/tests/plans/orders.timing.test.ts`); the load
run's own numbers are recorded in `docs/perf/load-run.md`.

The per-vendor summary groups the outstanding orders in the vendor index (no table
reads), then orders the vendors by their oldest approval. The web app shows both
(`frontend/src/pages/reports/OutstandingReport.tsx`,
`frontend/src/pages/reports/OutstandingVendors.tsx`); a row's lines come from the order's
own read when it is opened.

## Follow-up questions

### Why can a Buyer only receive goods on their own orders, when §2 just says "record goods received"?
§2 lists actions, not which orders they apply to. Scoping actions by ownership is standard
procurement practice. It also makes approver ≠ receiver hold by construction: receipts are
owner-only and nobody can approve their own order. Accepted trade-off: receipts wait if the
owner is unavailable. Reassignment is **not adopted**: if the owner leaves, the order is
cancelled and a new one raised. (`docs/adr/0004-ownership-visibility-and-sod.md`)

### What happens if lines change while an order is awaiting approval?
They can't: editing a pending order returns `409 ORDER_PENDING_APPROVAL`. The owner
withdraws (the round's open steps are voided, kept as history), edits and resubmits;
routing is recomputed from the new total with a fresh chain
(`backend/tests/integration/approvals-withdraw.test.ts`).

### Anyone at the company can sign up. Can they raise orders?
No. Signup requires an email domain in `SIGNUP_ALLOWED_DOMAINS` and a verified mailbox,
and the new account has **no role**. It can manage its own profile, password and sessions,
and send an in-app access request. Everything else returns `403 NO_ROLE_ASSIGNED` until an
Admin assigns Buyer and/or Approver. Responses don't reveal whether an account exists.
(`docs/adr/0017-authentication-and-sessions.md`)

### Can a buyer split a large order into small ones to avoid approval?
Yes, and that's a deliberate decision. Buyers legitimately split orders to get better vendor
offers per order value, so a blocking rule would punish normal buying. Every order is
audited with buyer, vendor and total; if splitting fraud is ever observed, detection would
be a report, not a blocking rule. (`docs/adr/0019-considered-and-deferred-features.md`)

### What happens if someone records the wrong receipt quantity?
It's permanent: receipts are append-only, with no reversal. If a receipt completes the
order, it can no longer be cancelled (`409 ORDER_FULLY_RECEIVED`). The mitigation is the
receipt dialog: per line, what is being received, what was received so far and what stays
outstanding, with a warning when a line becomes fully received
(`frontend/src/pages/orders/ReceiptDialog.tsx`).

### How many approval tiers are there? Doesn't §8 want two?
The seeded policy has one tier: above ₹1,00,000 needs one approval, and the company has one
Approver. The chain is built from versioned policy data, one step per tier the total
exceeds, with no special-casing of the count; tests load two- and three-tier policies and
prove the chain handles them (`backend/tests/integration/approvals-routing.test.ts`). A new
tier is a policy-data change through the operator CLI (`policy:set`), never a code change.

### Two receipts for the same line arrive at almost the same instant. What happens?
Both lock the order before reading anything, so they run one after the other: the second
sees the first's quantity, and is refused whole if it would exceed what was ordered. The
same lock order holds for every command, so no two of them deadlock
(`docs/adr/0006-concurrency-and-transactions.md`, `backend/tests/concurrency/receipts.test.ts`).
