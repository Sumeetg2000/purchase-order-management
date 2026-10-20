<!--
Sync Impact Report
==================
Version change: 2.0.0 → 3.0.0
Bump rationale: MAJOR (structure change). The constitution now holds only MUST-level
principles. Numbers and mechanisms moved to the ADRs, so tuning a value no longer needs an
amendment. Rule: "we believe something different" is a principle; "we picked a different
number or mechanism" is an ADR.

Also redefined (owner decisions, 2026-10-20):
  II/III  Single-tier seeded approval; DUPLICATE_APPROVER removed; approval levels and
          owner transfer not adopted (ADR-0002, ADR-0004).
  III     Signup creates a no-role account; 403 NO_ROLE_ASSIGNED; in-app access requests
          (ADR-0004, ADR-0016).
  II      PO numbers by Indian financial year, PO-{FY}-{seq} (ADR-0001).
  IX      30-day absolute session lifetime; 8-year audit retention; 90-day purge of
          session and security-log data (ADR-0016, ADR-0017, ADR-0020).
  XII     Order-splitting control and receipt corrections not adopted; MFA/SSO deferred
          (ADR-0019).
  XIII    Confirmation-dialog rule and shared ConfirmDialog (ADR-0018).
  Final review: approval policy changed only via operator CLI (ADR-0002); phone purged 90
          days after deactivation (ADR-0016, ADR-0020); brief added as docs/BRIEF.md and
          referenced by [BRIEF §x] and the traceability check (ADR-0013).

Moved out: state table → ADR-0001; authorization matrix and check precedence → ADR-0004;
  error registry, validation order and field rules → ADR-0007; database roles, request-body
  rule, attack suite → ADR-0003; auth numbers → ADR-0017; stack, startup, security
  baseline, observability, retention → ADR-0020 (new); out-of-scope list → ADR-0019.
Removed rules: DUPLICATE_APPROVER; "self-signup grants BUYER".

Templates reviewed (not modified): plan, spec, tasks, checklist templates. They need no
change: the Constitution Check reads principles I–XIII.
Follow-up TODOs: remaining [DEFAULT]/[TARGET] markers in the ADRs await owner review.
-->

# Vendor & Purchase Order Management Constitution

This constitution governs a production-grade procurement system: vendors, purchase orders,
approvals, goods receipt and outstanding-orders reporting. No rule may be weakened
because the system is a prototype.

**Principles here, mechanisms in ADRs.** Each principle states what MUST be true and links
the ADR that records how and with which numbers. Changing a principle is an amendment.
Changing an ADR value (a lifetime, a limit, a target, an endpoint) is an ADR update,
reviewed in the PR, and needs no amendment unless it weakens a principle.

The brief is `docs/BRIEF.md`. Markers: **[BRIEF §x]** binding requirement in that
section of `docs/BRIEF.md` · **[ADR-NNNN]** recorded decision ·
**[NEEDS SIGN-OFF]** would change the brief's actors, permissions or explicit rules, so it
MUST NOT be built until the owner approves it. Inside ADRs, **[DEFAULT]** marks industry
practice adopted where the brief is silent, and **[TARGET]** marks an assumed number. Both
await owner confirmation.

## Core Principles

### I. Derived-Value Integrity Is Enforced by the Database (NON-NEGOTIABLE)

The order total and each line's received and outstanding quantities are derived. **No code
path, including a direct API call or raw SQL run as the application's database role, may
leave them inconsistent with their source data.** [BRIEF §1, §3.3, §3.6, §4, §6]
[ADR-0003, ADR-0015]

Invariants (they MUST hold after every committed transaction):
- **INV-1** `line_total = quantity × unit_price`, exactly.
- **INV-2** `order.total = Σ line_total` across the order's lines.
- **INV-3** `received_quantity = Σ receipt.quantity` across the line's receipts.
- **INV-4** `0 ≤ received_quantity ≤ quantity`, so outstanding is never negative.
- **INV-5** Every order has at least one line.
- **INV-6** `open_line_count = count(lines where received_quantity < quantity)`.

Rules:
- The guarantee MUST live in PostgreSQL: generated columns, constraints, triggers and
  privileges. Application checks only produce clear errors.
- The application role MUST be least-privilege. It can't write derived columns, can't
  disable triggers, and can't update or delete receipts or audit entries.
- Stored derived values MUST NOT be overwritten by anything except their recompute
  function. A privileged role gets a loud error, not a silent fix.
- Requests containing derived or system-assigned fields MUST be rejected, never ignored.
- Money MUST be exact decimals end to end, and never a JavaScript `number` [ADR-0010].
- A committed reconciliation query MUST return zero rows after every test suite, seed and
  attack attempt.

### II. Explicit Order State Machine

Orders move only through the transitions in the state table [ADR-0001], and the database
refuses every other change. [BRIEF §3.2, §3.4, §3.5]

- States: `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `CANCELLED`. The last two
  are final. Receipt progress is derived, never stored.
- Every order is created in `DRAFT`. On submit, its total decides the route: at or below
  the threshold it auto-approves as an audited `SYSTEM` decision, and above it waits for
  approval.
- Pending orders MUST NOT be edited. The owner withdraws, edits and resubmits, and routing
  is recomputed.
- Non-draft orders are locked: every edit path returns a specific `409`, and the database
  refuses raw-SQL edits.
- The approval chain MUST be data-driven: one step per tier exceeded, from versioned policy
  data, with no special-casing of the number of tiers [BRIEF §8] [ADR-0002].
- Approval decisions MUST bind to the order version they were made against.
- PO numbers MUST be unique, never reused and never editable [ADR-0001].

### III. Authorization Beyond Roles: Ownership and Separation of Duties

Every action is tied to a real, authenticated user, and there is no anonymous path except
the documented public account endpoints. Roles decide the kind of action. Ownership,
visibility and separation of duties decide whether it applies to a specific order.
[BRIEF §2, §6] [ADR-0004, ADR-0016, ADR-0017]

- Identity MUST come only from the verified token. Status and roles MUST be loaded on
  every request, so changes take effect immediately.
- Deny by default: every route declares its permission, or startup and CI fail.
- **Roles**: Buyers maintain shared vendors and act only on their own orders. Approvers
  read every non-draft order and decide approvals and cancellations on orders they don't
  own. The Procurement Admin is read-only for orders, and their only write power is user
  management (signed off 2026-10-20). A new account has **no role** until an Admin
  assigns one, and can use only its own profile, password, sessions and access request.
  Admin accounts come only from the server-side bootstrap or operator CLI.
- **Visibility**: a caller who can't read an order gets `404`. A caller who can read it
  but isn't its owner gets `403` for owner-only actions. Every list and report is scoped
  to what the caller can read.
- **Separation of duties**: nobody approves, rejects or cancels an order they own
  (`SELF_APPROVAL`). Receipts are owner-only, so an order's approver never records its
  receipts.
- The authorization matrix in ADR-0004 is binding. Every cell MUST be tested, for each
  order state and for unauthenticated callers. Changing a cell needs sign-off
  (Principle X).

### IV. Atomic, Append-Only Audit Trail

Every state change, approval decision, receipt, vendor change, policy change and user or
role change leaves a structured audit entry. That entry is what procurement asks for in a
dispute. [BRIEF §6] [ADR-0016]

- An entry MUST be written in the same transaction as its change. Triggers MUST refuse
  changes made without an actor context.
- Entries MUST be append-only and MUST outlive what they describe, including deleted
  drafts.
- Each entry MUST record who acted (a user, `SYSTEM` or `OPERATOR`), in what capacity, a
  snapshot of the actor's name and email, before/after details and the request id.
  Renaming a user never changes past entries.
- Audit is readable only within each role's visibility (ADR-0016). Personal data
  that's not needed, such as phone numbers, never enters an entry.
- Retention follows the law that applies (ADR-0016, ADR-0020).

### V. Concurrency Correctness and Transaction Strategy

The invariants and the state machine MUST hold under simultaneous requests. [BRIEF §8]
[ADR-0006]

- Lock, then read, then decide, or decide in one conditional statement. Deciding on an
  unlocked read is forbidden.
- Each command runs in one short transaction with no network calls inside it.
- Overload MUST surface as `503`, never `500` or a hang.
- Clients MUST prove which version they are changing, and retries of creates MUST be
  idempotent.
- Concurrency tests MUST assert business outcomes, not just internal consistency.

### VI. API Contract Discipline

The API is a versioned, generated contract that the frontend uses on equal terms with any
other client. [BRIEF §5, §6] [ADR-0007, ADR-0008]

- Zod schemas are the single source. The OpenAPI is generated and committed, and CI fails
  on drift or on an unapproved breaking change.
- Every error is part of the contract: a stable `code`, one registry, RFC 9457 format,
  and no `422`.
- Input MUST be validated strictly, with unknown fields rejected, before any business
  logic.
- Every collection MUST be paginated with a stable sort backed by an index.
- Code and tests branch on `code`, never on message text. Database errors are mapped in
  one place.

### VII. Data Access and Performance with Numeric Targets

Lists and reports are answered by the database with indexed, bounded queries, never by
loading rows into memory. [BRIEF §3.7, §6, §8] [ADR-0012, ADR-0015]

- Every list has a `LIMIT`, and its filters run in SQL. The number of queries per request
  MUST NOT grow with page size or line count.
- Every list and report MUST have a committed query plan, page and `COUNT`, at the
  recorded dataset sizes.
- Performance targets are numeric, recorded in ADR-0012, and checked by a load job.
- Derived-value maintenance MUST run once per statement, not once per row.

### VIII. Test-First Against Real PostgreSQL (NON-NEGOTIABLE)

- Invariant, concurrency and authorization tests are written first and seen failing.
- Anything touching persistence, transactions, constraints or triggers is tested against
  real PostgreSQL with production migrations. Mocking the database there is forbidden.
- Required suites: integrity attack (ending in reconciliation), property-based
  invariants, state machine (one test per transition), locked orders, approval routing
  (seed boundaries and multi-tier fixtures), concurrency, authorization matrix, contract,
  audit, pagination, line editing, trigger efficiency and query plans, accounts and
  sessions, and frontend components, dialogs and end-to-end flows.
- Tests are deterministic: barriers instead of sleeps, isolated database state, seeded
  randomness and injected clocks.

### IX. Production Operability and Security

[BRIEF §6] [ADR-0016, ADR-0017, ADR-0020]

- `docker compose up` with a documented `.env` MUST be the only setup step. Invalid
  config MUST stop the process.
- **Authentication**: no auth token is ever readable by JavaScript. Sessions rotate
  their refresh tokens, detect reuse, have an idle and an absolute lifetime, and can be
  revoked one at a time or all at once. Every state-changing request is protected
  against CSRF.
- **Accounts**: signup is restricted to the company's domains, needs a verified mailbox,
  and grants no role. Account endpoints MUST NOT reveal whether an account exists.
  Passwords use a memory-hard hash, and Admins never set or see them. Login is
  rate-limited, and accounts lock after repeated failures.
- Secrets, tokens and personal data MUST NOT appear in logs. The only exceptions are the
  one-time set-password links printed to an operator.
- Security events are logged separately from the business audit.
- Personal data is kept only as long as its purpose or the law requires. Purges run
  under a separate maintenance role, never the app role.
- The security baseline (headers, least privilege, dependency scanning, non-root
  containers) is in ADR-0020.

### X. Brief Is Binding; Silence Defaults to Industry Practice

- The brief's explicit statements are binding. Additions MAY add controls but MUST NOT
  contradict the brief.
- An addition that would change the brief's actors, permissions or explicit rules is
  **[NEEDS SIGN-OFF]** and isn't built until approved.
- Silence is never a reason to skip a concern. The default is established industry
  practice, recorded as an ADR with context, decision, alternatives and status.
- `docs/traceability.md` maps every clause of `docs/BRIEF.md` → requirement → passing
  test, and CI enforces it. The §7 questions trace to `docs/walkthrough.md`.

### XI. Code Clarity; Traceability Lives Outside Source

- TypeScript `strict`. No `any`, `@ts-ignore` or non-null assertion without a justified
  lint-disable.
- Layering: routes (HTTP, validation) → services (rules, authorization, transactions) →
  repositories. Domain code never imports Express.
- Names come from this constitution's domain language. Comments explain *why*.
- Requirement IDs appear in test names only, never in production source, comments or
  commit subjects. Lint and CI enforce this [ADR-0013].

### XII. Simplicity Within the Bar

- Choose the simplest design that satisfies all the other principles. Simplicity never
  justifies skipping a database guarantee, an audit entry, a test suite, pagination or a
  security control.
- Do not add features the brief doesn't ask for. Deepen what is there instead [BRIEF §8].
  What was considered and left out is recorded in ADR-0019.
- No speculative abstraction. A generic mechanism needs a concrete requirement, as §8
  justifies the data-driven approval chain.
- A new runtime service or dependency requires an ADR [ADR-0020].

### XIII. Production-Grade Frontend

The React app is held to the same bar as the API. It is a client of the public API with no
privileged path. Every rule is enforced server-side, and role-based routes are UX only.
[ADR-0018]

- The client and types are generated from the contract. Errors are handled by `code`.
- Money stays a decimal string, formatted for India.
- Every view has loading, empty and error states. Nothing can be submitted twice by
  accident.
- **Confirmation rule**: an action that can't be undone, ends something, or changes what
  another person can do MUST be confirmed in a dialog that names the action, states the
  consequence and focuses the safe choice. Reversible saves MUST NOT be confirmed. Unsaved
  edits MUST NOT be lost silently.
- WCAG 2.1 AA, a strict CSP and no raw HTML rendering.
- Bundle and interaction budgets are enforced in CI.

## Development Workflow and Quality Gates

Work proceeds in **vertical slices**. A slice passes every gate, in order, before the next
starts.

1. **Spec**: `/speckit-specify` gives requirement IDs, acceptance scenarios and brief
   traceability. `/speckit-clarify` runs until no question is open.
2. **Contract**: `/speckit-plan` gives the data model, invariant design and error codes.
   The Zod schemas and the OpenAPI diff are reviewed before any service code.
3. **Decisions**: an ADR is written or updated for every documented choice, production
   addition and deviation.
4. **Tests**: `/speckit-tasks` puts tests first, and they are seen failing against real
   PostgreSQL.
5. **Implementation**: `/speckit-implement` until green, without weakening, skipping or
   deleting a gate-4 test.
6. **Review**: `/speckit-analyze`, `/code-review`, `/security-review`, a constitution
   compliance pass, and a re-check of every open deviation's revisit condition.
7. **CI** (all green): lint, typecheck and the ID ban; every suite in Principle VIII;
   contract drift and the breaking-change check; migrations from empty, reconciliation
   and traceability; dependency scans; the compose smoke test and Playwright. The load
   test runs on `main` and nightly.

A slice is **done** only when every brief row it touches in `docs/traceability.md` has a
passing test. Slice order: (0) foundation: compose, nginx, auth, errors, audit, DB
roles, contracts, frontend shell, mail, bootstrap; (1) accounts and user management; (2)
vendors; (3) draft orders and the integrity suite; (4) submission and routing; (5) lock,
withdraw, reject, cancel; (6) goods receipt and concurrency; (7) outstanding report, load
tests and query plans.

Conventional Commits. `main` is always releasable.

## Governance

- This constitution overrides every other practice. When a spec, plan or task conflicts
  with it, the spec is fixed, not the principle. ADRs MUST NOT contradict it.
- **Amendments**: a PR that edits this file, with the reason, impact, migration plan for
  affected slices, an updated Sync Impact Report and an ADR where a decision changes. The
  owner approves it.
- **Principle or ADR?** If a change means "we believe something different", it is a
  principle and needs an amendment. If it means "we picked a different number or
  mechanism", it is an ADR update. An ADR change that would weaken a principle is an
  amendment.
- **Versioning**: MAJOR when a principle is removed or redefined, a guarantee is weakened,
  or the structure changes. MINOR when a principle or section is added or materially
  expanded. PATCH for wording.
- **Deviations** [ADR-0014]: recorded as a plan Complexity Tracking row linked to an
  `Accepted (deviation)` ADR with a revisit condition. They're listed in
  `docs/adr/README.md` and re-checked at every review gate. Principles I and VIII can never
  be deviated from.
- **Compliance**: every plan's Constitution Check, every review gate and every PR verify
  Principles I–XIII.
- `[DEFAULT]` and `[TARGET]` markers live in the ADRs and are confirmed there with the
  owner.
- Runtime guidance for agents lives in `CLAUDE.md` and MUST NOT contradict this document.

**Version**: 3.0.0 | **Ratified**: 2026-10-15 | **Last Amended**: 2026-10-20
