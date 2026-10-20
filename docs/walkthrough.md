# Walkthrough Answers

Draft answers to the brief's §7 questions and to questions a reviewer is likely to ask.
Each answer points at the code and tests that back it; fill in paths as slices land.

## §7.1 An approved order cannot be edited. Where is that enforced?
Three layers. (1) The service locks the order row and checks its status, returning
`409 ORDER_LOCKED` with the current status. (2) The guarantee is a database trigger that
refuses any line insert/update/delete, vendor or header change unless the order is `DRAFT`
— so even raw SQL as the app role can't edit it. (3) Tests cover the API path and the
raw-SQL path. (ADR-0001)

## §7.2 Show me a partial goods receipt. How is the outstanding quantity calculated?
Each receipt is an immutable event row against a line. A statement-level trigger keeps
`received_quantity = Σ receipts`, locking the line first; a CHECK enforces
`received ≤ ordered`. Outstanding is `quantity − received_quantity`. The reconciliation
query proves no stored value has drifted. (ADR-0003)

## §7.3 How do you list outstanding orders by vendor and age? What does that query touch?
Outstanding = `status = 'APPROVED' AND open_line_count > 0`, where `open_line_count` is a
trigger-maintained count of lines not yet fully received (INV-6, checked by the
reconciliation query). Age is measured from `approved_at`, and buckets are `approved_at`
ranges. The page query and its COUNT use the partial index `(vendor_id, approved_at)` with
that predicate (`(owner_id, approved_at)` for a Buyer's own report) and read only those
order rows, plus vendors for names. Lines are read only for the ≤ 50 orders on the page,
and receipts are never read. The index holds only open approved orders, so it shrinks as
orders complete. Committed plans: `docs/perf/`. (ADR-0015, ADR-0012)

## Why can a Buyer only receive goods on their own orders, when §2 just says "record goods received"?
§2 lists actions, not which orders they apply to. Scoping actions by ownership is standard
procurement practice. It also makes approver ≠ receiver hold by construction: receipts are
owner-only and nobody can approve their own order. Accepted trade-off: receipts wait if the
owner is unavailable. Reassignment is **not adopted**: if the owner leaves, the order is
cancelled and a new one raised. (ADR-0004)

## What happens if lines change while an order is awaiting approval?
They can't: editing a pending order returns `409 INVALID_STATE_TRANSITION`. The owner
withdraws (all approval steps of that round voided, kept as history), edits, and
resubmits; routing is recomputed from the new total with a fresh chain. (ADR-0001)

## Anyone at the company can sign up. Can they raise orders?
No. Signup requires an email domain in `SIGNUP_ALLOWED_DOMAINS` and a verified mailbox,
and the new account has **no role**. It can manage its own profile, password and
sessions, and send an in-app access request. Everything else returns
`403 NO_ROLE_ASSIGNED` until an administrator assigns Buyer and/or Approver. The right to
raise orders, which can auto-approve up to ₹1,00,000, is granted, never self-served.
Responses don't reveal whether an account exists. (ADR-0017, ADR-0016, ADR-0004)

## Can a buyer split a large order into small ones to avoid approval?
Yes, and that's a deliberate decision. Buyers legitimately split orders to get better
vendor offers per order value, so a blocking rule would punish normal buying. Every order
is audited with buyer, vendor and total. If splitting fraud is ever observed, detection
would be a report (orders per buyer and vendor within N days that together exceed the
threshold), not a blocking rule. (ADR-0019)

## What happens if someone records the wrong receipt quantity?
It's permanent: receipts are append-only, with no reversal. If it fully receives a line
and that completes the order, the order can no longer be cancelled
(`409 ORDER_FULLY_RECEIVED`). The mitigation is the receipt confirmation dialog. It
shows, per line, what is being received, what was received so far and what will be
outstanding after, and warns when a line becomes fully received. (ADR-0011, ADR-0018,
ADR-0019)

## How many approval tiers are there? Doesn't §8 want two?
The seeded policy has one tier: above ₹1,00,000 needs one approval. The company has one
Approver. The chain is still built from versioned policy data, one step per tier the total
exceeds, with no special-casing of the count. Tests load a two-tier and a three-tier policy
fixture and prove the chain handles them. Adding a tier in production is a policy-data
change made through the operator CLI (`policy:set`), never a change to routing code.
(ADR-0002)
