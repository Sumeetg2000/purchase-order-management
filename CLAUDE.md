# CLAUDE.md

## Project
A production-grade Vendor & Purchase Order Management system. It covers a shared vendor
list, purchase orders with derived totals, threshold-based approval, per-line goods
receipt, and an outstanding-orders report by vendor and age. The stack is Node +
TypeScript, Express, Prisma and PostgreSQL for the API, a React frontend, and docker
compose. The core concern is derived-value integrity: totals and outstanding quantities
must never drift, on any code path.

## Binding documents (read before changing anything)
- [Constitution](.specify/memory/constitution.md): the principles. It overrides
  everything, including this file.
- [ADRs](docs/adr/README.md): every mechanism, number and decision.
- [Brief](docs/BRIEF.md): the requirements. It's never edited, because a change is a scope
  change.
- [Traceability](docs/traceability.md): brief clause → requirement ID → tests.

If a task conflicts with these, stop and ask. Don't work around them.

## Slices
Build in the constitution's slice order, one slice at a time:
0. Foundation
1. Accounts and user management
2. Vendors
3. Draft orders and the integrity suite
4. Submission and routing
5. Lock, withdraw, reject, cancel
6. Goods receipt and concurrency
7. Outstanding report, load tests and query plans

Use one branch per slice, `NNN-slice-name`, created by `/speckit-specify`. NNN is the spec
number, so slice 0 is `001-…`. Merge to `main` only when the slice is done.

## Per-slice loop
1. `/speckit-specify`, then `/speckit-clarify` until no question is open
2. `/speckit-plan`: Zod schemas and the OpenAPI diff are reviewed before any service code
3. `/speckit-tasks`, then `/speckit-analyze`
4. `/speckit-implement`: tests first, seen failing against real PostgreSQL, then code
   until green. Never weaken, skip or delete a test to pass.
5. `/code-review` and `/security-review`
6. CI green
7. Update `docs/traceability.md`: every row the slice touches has a passing test
8. Merge

Details of each gate: see the constitution's "Development Workflow and Quality Gates".

## Commands
Placeholders. Fill these in during slice 0.
- Start: `docker compose up` (local profile via `.env`, copied from `.env.example`)
- Test: `TODO`
- Lint: `TODO`
- Typecheck: `TODO`

## Conventions
- Conventional Commits. Requirement IDs go in test names only, never in code, comments or
  commit subjects (ADR-0013).
- A new decision or a changed number is recorded as an ADR update, not an edit to the
  constitution (see its Governance section).
