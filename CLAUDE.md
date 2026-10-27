# CLAUDE.md

## Project
A production-grade Vendor & Purchase Order Management system: a shared vendor list, purchase
orders with derived totals, threshold-based approval, per-line goods receipt, and an
outstanding-orders report by vendor and age. Stack: Node + TypeScript, Express, Prisma and
PostgreSQL for the API, a React frontend, docker compose. The core concern is derived-value
integrity: totals and outstanding quantities must never drift, on any code path.

## Binding documents (read before changing anything)
- [Constitution](.specify/memory/constitution.md): the principles. It overrides everything,
  this file included.
- [ADRs](docs/adr/README.md): every mechanism, number and decision.
- [Brief](docs/BRIEF.md): the requirements. Never edited: a change is a scope change.
- [Traceability](docs/traceability.md): brief clause → requirement ID → tests.

If a task conflicts with these, stop and ask. Don't work around them.

## Slices
Build in the constitution's slice order, one slice at a time: 0 Foundation; 1 Accounts and
user management; 2 Vendors; 3 Draft orders and the integrity suite; 4 Submission and
routing; 5 Lock, withdraw, reject, cancel; 6 Goods receipt and concurrency; 7 Outstanding
report, load tests and query plans. Use one branch per slice, `NNN-slice-name`, created by
`/speckit-specify` (NNN is the spec number, so slice 0 is `001-…`). Merge to `main` only
when the slice is done.

## Per-slice loop (gates: the constitution's "Development Workflow and Quality Gates")
1. `/speckit-specify`, then `/speckit-clarify` until no question is open
2. `/speckit-plan`: Zod schemas and the OpenAPI diff are reviewed before any service code
3. `/speckit-tasks`, then `/speckit-analyze`
4. `/speckit-implement`: tests first, seen failing against real PostgreSQL, then code
   until green. Never weaken, skip or delete a test to pass.
5. `/code-review` and `/security-review`, then CI green
6. Update `docs/traceability.md`: every row the slice touches has a passing test
7. Merge

## Commands (Node 24, see `.nvmrc`; `.npmrc` refuses other versions)
- Start (production-like, the only required setup): `cp .env.example .env && docker compose up`
- Dev loop (API reload + Vite HMR, same origin): `npm run dev`
- Test (needs only Docker): `npm test`
- Lint and typecheck: `npm run lint`, `npm run typecheck`

## Layering (backend; lint enforces the route rule)
`backend/src/<area>/routes.ts` → `service.ts` → `repository.ts`. Routes map inputs and
outputs and call services, never Prisma. Services own the business rules and take the
transaction (`AuditedTransaction`) from `withTransaction`. Only repositories run queries.

## Conventions
- Conventional Commits. Requirement IDs go in test names only, never in code, comments or
  commit subjects (ADR-0013).
- In a commit body, keep a "Failing run:" or "Verified:" line under 100 characters: a
  "Word:" paragraph is a footer, and commitlint (commit-msg hook) refuses longer ones.
- A new decision or a changed number is recorded as an ADR update, not an edit to the
  constitution (see its Governance section).
- A value used in more than one place, or one that carries business meaning (a lifetime,
  a retention period, a role, a timeout), is a named constant, defined once and imported.
  When the same value must also live in SQL, nginx or compose, a test pins that copy to
  the constant. Codes are string-literal union types derived from one const list (like
  `ErrorCode` from the registry), never plain `string`.
