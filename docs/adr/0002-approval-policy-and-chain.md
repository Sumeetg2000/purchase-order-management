# ADR-0002: Approval threshold, data-driven chain and the seeded policy

- **Status:** Accepted · 2026-10-16 · amended 2026-10-20 (single-tier seed,
  `DUPLICATE_APPROVER` removed, approval levels not adopted: **owner decision 2026-10-20**;
  policy changes through the operator CLI)
- **Brief:** §3.4, §8 · Gaps G9, G19, G23, Q3c, Q8
- **Principles:** II, III, IV

## Context
Orders above a threshold need approval. Below it, the brief lets us choose. §8 asks that a
second, higher tier be handled by a variable-length chain without special-casing.

The company currently has **one Approver**, and it wants one approval step above
₹1,00,000. Nothing in the system enforces how many users hold the Approver role.

## Decision
- **Tiers are versioned, audited policy data** (`APPROVAL_POLICY_CHANGED`). Each tier has a
  threshold. "Above" means strictly greater than, compared on the exact total.
- **Seeded policy: one tier.** Above ₹1,00,000 needs one approval step. At or below
  auto-approves on submit (`PO_AUTO_APPROVED`, actor `SYSTEM`, with the policy version). The
  earlier ₹10,00,000 tier is removed from the seed.
- **The chain stays data-driven**: one step per tier the total exceeds, in ascending
  order. Code never special-cases the number of tiers. Adding a tier is a policy data
  change, never a change to routing code. Today's CLI sets one tier, and it gains repeated
  `--tier` flags when a second tier is wanted. This keeps §8 met.
- Each submission records the policy version it used. A policy change never affects an
  order already submitted.
- **Changing the policy: operator CLI only**, run on the server and never exposed over
  HTTP (same CLI, advisory lock and exit-code rules as the admin commands in ADR-0016):
  - `docker compose exec api npm run admin -- policy:set --tier1 <amount>`
    - `<amount>` is a decimal string, at most 4 decimal places, greater than 0. Anything
      else → error, non-zero exit, nothing changes.
    - It creates a **new policy version**, effective immediately for new submissions only.
      Orders already submitted keep the version they recorded.
    - Setting the current value is a no-op: message, no new version, exit zero.
    - Audited as `APPROVAL_POLICY_CHANGED` with `actorType` `OPERATOR`, before → after, and
      `osUser` and `host`.
  - `policy:show` prints the current version: its number, tiers and when it took effect.
  - The data model keeps the multi-tier shape. The CLI can accept repeated `--tier` flags
    later, but today it sets one tier.
  - `GET /api/approval-policy` stays read-only. There is no HTTP write path.
- **Separation of duties**: `SELF_APPROVAL` (`403`) stays. Nobody approves, rejects or
  cancels an order they own.
  - `DUPLICATE_APPROVER` is **removed** everywhere: the rule, the error code, the matrix and
    the tests.
  - With a single tier it could never apply. If a second tier is ever added to the seed,
    decide then whether the same approver may decide successive steps. Until then, nothing
    stops it.
- **No approval levels.** Any Approver may decide any step (owner decision, 2026-10-20).
  The earlier "approval authority: needs sign-off" item is closed as not adopted.
- Approvals bind to the order version (`409 VERSION_CONFLICT` on stale).
- Approval is blocked when the vendor is inactive (`409 VENDOR_INACTIVE`). Reject is still
  allowed.
- Withdraw voids every step of the current round. Resubmission builds a fresh chain.
- **Read endpoint**: `GET /api/approval-policy` returns the current version's tiers. It's
  read-only and available to Buyer, Approver and Admin. The frontend's submit dialog uses
  it to say what is *expected* to happen (ADR-0018). The
  server's routing decision is what counts.

### Operational consequences of one Approver
- If the Approver is unavailable, orders above ₹1,00,000 wait. Delegation is deferred
  (ADR-0019).
- If the Approver also holds BUYER, **their own orders above ₹1,00,000 can never be
  approved** (`SELF_APPROVAL`).
  - **Recommendation: the single Approver holds the APPROVER role only, not
    BUYER + APPROVER.**
  - Otherwise a second user must hold APPROVER, or the Approver must never raise orders
    above the threshold.
  - The admin role dialog warns when assigning Buyer + Approver to the only Approver.

## Alternatives
- **Two seeded tiers with a different approver per step** (the earlier draft): fits a
  larger organisation, not this one. It stays possible as policy data, with a fresh
  decision about successive steps.
- **Approval levels** (senior approvers for higher amounts): not adopted.
- A "lighter check" below threshold (a buyer's second confirmation): adds friction without
  a control.
- Hard-coded `if tier2` branches: violates §8.

## Tests
- Production seed boundaries: ₹1,00,000.00 → auto-approved; ₹1,00,000.0001 and
  ₹1,00,000.01 → one step.
- The production seed has exactly one tier.
- **Fixtures, not the seed**:
  - a two-tier policy fixture produces a two-step chain (T6 then T7)
  - a three-tier chain is created by inserting a policy row only, with no code change
  - chain length 0 is covered by an amount at or below the threshold
- A policy change mid-flight doesn't change a submitted order's chain.
- `SELF_APPROVAL` for a dual-role user on approve, reject and cancel.
- Two concurrent approve requests on the same step (a double click, or two tabs). Business
  outcome: exactly one decision is recorded.
- Approve with an inactive vendor → 409. Reject is allowed.
- No code path or registry entry mentions `DUPLICATE_APPROVER` (registry test).
- `GET /api/approval-policy` per role (no-role → 403).
- Policy CLI:
  - `policy:set` creates a new version, and the next submission uses it
  - an order submitted before the change keeps its recorded version and chain
  - invalid amounts (`0`, negative, 5 decimal places, not a number) → error, non-zero
    exit, no new version
  - setting the current value is a no-op
  - the change is audited with `actorType` `OPERATOR`, before → after, `osUser` and `host`
  - `policy:show` prints the current version
  - no HTTP route writes the policy (route-table check)
