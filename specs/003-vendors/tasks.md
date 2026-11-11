---

description: "Task list for Slice 2 — Vendors"
---

# Tasks: Slice 2 — Vendors

**Input**: Design documents from `specs/003-vendors/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Required (Principle VIII). Every test task is **run and seen failing against
real PostgreSQL** (Testcontainers) before the task that makes it pass; its commit body
carries a "Failing run:" line under 100 characters. Requirement IDs go in test names only
(ADR-0013).

**Operations per story** (owner decision, 2026-11-11): Foundational adds the registry
codes, `existingVendor`, the `role` access level and the generator's support for them, but
no vendor operation. Each story adds its operations to `OPERATIONS` together with their
routes (US1 `listVendors`, `getVendor`, `createVendor`; US2 `updateVendor`; US3
`deactivateVendor`, `reactivateVendor`; US5 `listVendorHistory`), and grows the OpenAPI
operation list, the body inventory and the authorization-matrix pins in the same commit,
as slice 1 did. An unserved operation would leave the matrix test red until US5.

**Organization**: Setup, Foundational, then US1–US5 in plan order, then Polish. Stories
run in sequence; each ends with a checkpoint (green CI on the slice's draft PR) and a
short summary stop.

## Format: `- [ ] T### [P?] [US#?] Outcome — files — refs`

- **[P]**: parallel with the other [P] tasks of the same group (different files, no
  dependency on an incomplete task).
- **Refs**: spec FR/SC, research R#, and the `docs/traceability.md` row ID the tests carry.
- **Size**: one reviewable commit each, roughly under 300 changed lines.
- **Layering**: `routes.ts` → `service.ts` → `repository.ts`; routes never import Prisma,
  a repository or `db/transaction.ts`.
- **While working**: run only the affected tests; the full gate before each push.

---

## Phase 1: Setup

- [X] T001 Add a separate Vitest project for plan tests (`backend/tests/plans/**`,
  excluded from the default `npm test`) and the `test:plans` script —
  `backend/vitest.config.ts`, `backend/package.json`, root `package.json` — R11.

---

## Phase 2: Foundational (blocks every story)

### Schema

- [X] T002 Migration tests, seen failing: `vendors` columns, `CHECK`s and grants exactly as
  [data-model.md](data-model.md): `name` "`CHECK (char_length(name) BETWEEN 1 AND 200)`",
  `name_key` generated and unwritable by `po_app`, `vendors_name_key_key` unique,
  `contact_email` "`= lower(contact_email) AND char_length <= 254`", `contact_phone`
  "`~ '^[0-9 +()-]{1,30}$' AND ~ '[0-9]'`" (so `''` refused), `vendors_payment_terms_valid`
  per type (NET `net_days` 0–180, ADVANCE both null, PARTIAL_ADVANCE `advance_percent`
  1–99 and `net_days` 0–180), status/`deactivated_at` check, `version >= 1`; `po_app` has
  no `DELETE`/`TRUNCATE`; statement without actor context → `PO001`;
  `audit_entries_entity_idx` exists — `backend/tests/integration/vendor-schema.test.ts` —
  FR-004, FR-005, R2, R5, R6 (FR-VEN-01).
- [X] T003 Migration `0011_vendors` (table, indexes `vendors_status_name_key_idx (status,
  name_key, id)` and `audit_entries_entity_idx (entity_type, entity_id, occurred_at DESC,
  id DESC)`, `require_actor_context` and `set_updated_at` triggers, column grants) and the
  Prisma `Vendor` model with `name_key` read-only — `backend/prisma/migrations/0011_vendors/
  migration.sql`, `backend/prisma/schema.prisma` — T002 green.

### Contracts

- [X] T004 [P] Contract tests, seen failing: `vendorBody` accepts each payment-term
  variant and refuses out-of-range, cross-variant fields (`UNKNOWN_FIELD`), non-integers;
  `contactPhone` omitted/`null` accepted, `""` → `TOO_SHORT`, letters → `INVALID_FORMAT`,
  31 chars → `TOO_LONG`; `contactEmail` lower-cased; system fields (`id`, `status`,
  `version`, `createdAt`, `updatedAt`, `nameKey`) → `UNKNOWN_FIELD`; list query default
  `status=ACTIVE` — `packages/contracts/tests/vendor-schemas.test.ts` — FR-002, FR-003,
  FR-008, R5, R6 (FR-VEN-01, NFR-VAL-01).
- [ ] T005 [P] Contract tests, seen failing: `existingVendor` allowed only on
  `DUPLICATE_VENDOR_NAME` (problem schema refine and `AppError` constructor); the OpenAPI
  documents it on the responses that can carry that code (`x-problem-members`), a role
  operation's `x-roles`, and `Location` on a 201, shown on made-up operations;
  `access: 'role'` requires a non-empty `roles` and vice versa. The vendor operations'
  OpenAPI entries and body-inventory rows arrive with their stories (see "Operations per
  story") —
  `packages/contracts/tests/errors.test.ts`, `openapi.test.ts`, `body-inventory.test.ts` —
  R1, R4, FR-015.
- [X] T006 Constants (`VENDOR_NAME_MAX = 200`, `CONTACT_NAME_MAX
  = 200`, `CONTACT_PHONE_MAX = 30`, `CONTACT_PHONE_PATTERN`, `NET_DAYS_MAX = 180`,
  `ADVANCE_PERCENT_MIN = 1`, `ADVANCE_PERCENT_MAX = 99`, `PAYMENT_TERM_TYPES`,
  `VENDOR_STATUSES = ['ACTIVE', 'INACTIVE']`, `VENDOR_STATUS_FILTERS = ['ACTIVE',
  'INACTIVE', 'ALL']` (`ALL` a filter value only), default `ACTIVE`) and the schemas of
  [contracts/api.md](contracts/api.md) — `packages/contracts/src/vendors.ts`,
  `packages/contracts/src/schemas/vendors.ts`, `index.ts` — T004 green.
- [ ] T007 Registry: `DUPLICATE_VENDOR_NAME` (409, `clash: 'existingVendor'`),
  `INVALID_STATE_TRANSITION` (409), `VENDOR_INACTIVE` (409, registry comment: "first
  route: order create, slice 3"), field code `VENDOR_NOT_FOUND`;
  `problemSchema.existingVendor`; `AppError` `existingVendor` option; `ACCESS_LEVELS`
  `'role'` + `roles` and the generator's support (no vendor operation yet, see
  "Operations per story") — `packages/contracts/src/
  errors.ts`, `schemas/problem.ts`, `app-error.ts`, `operations.ts`, `openapi.ts` — T005
  green; regenerate `openapi.json` (don't open it); breaking-change check green.
- [X] T008 [P] Constants ↔ SQL pin tests, seen failing then green against T003: every
  number and list in T006 equals its `CHECK` (and `AUDIT_ACTOR_TYPES` its audit `CHECK`);
  the one name rule, `vendor_name_key(text)` (SQL only, R2, owner decision 2026-11-11),
  is `IMMUTABLE`, executable by `po_app` only, and treats non-ASCII case (`ÉCOLE` /
  `école`), tabs, NBSP and combining accents as one name, by key and by a clash on
  `vendors_name_key_key` — `backend/tests/integration/vendor-constants.test.ts` — R2, R13.

### Platform

- [ ] T009 Authorize tests, seen failing: `role` level → no role `403 NO_ROLE_ASSIGNED`,
  role outside `roles` `403 FORBIDDEN` before body validation (an invalid body still gets
  403), anonymous `401` — `backend/tests/integration/authorize.test.ts` — R1 (FR-ACT-01).
- [ ] T010 `role` access level in `allowed()` and `ROLE_LEVELS` —
  `backend/src/http/middleware/authorize.ts` — T009 green.
- [ ] T011 [P] Audit events `VENDOR_CREATED`/`UPDATED`/`DEACTIVATED`/`REACTIVATED`
  (`entityType: 'vendor'`, `{ before: VendorSnapshot | null, after: VendorSnapshot }`) —
  `backend/src/audit/events.ts` — FR-013, data-model.
- [ ] T012 [P] Web: messages for the three codes and the field code
  ([contracts/errors.md](contracts/errors.md)); `Vendors` nav item for role holders; lazy
  routes `/vendors`, `/vendors/new`, `/vendors/:id`, `/vendors/:id/edit` with Buyer-only
  guards on new/edit — `frontend/src/errors/messages.ts`, `frontend/src/app/router.tsx`,
  `Shell.tsx` — FR-016.

**Checkpoint**: schema, contract and access level in place; nothing user-visible yet.

---

## Phase 3: US1 — Add a vendor and find it again (P1) 🎯 MVP

**Goal**: Buyers create vendors; every role lists and reads them.
**Independent test**: Buyer A creates "Acme Supplies" NET 30; Buyer B finds it by "acm"
under the default active filter.

### Tests (seen failing)

- [ ] T013 [P] [US1] Create: 201 with `ETag`, `Location`, `version 1`, status `ACTIVE`;
  stored name trimmed, email lower-cased, phone `null` when omitted; one `VENDOR_CREATED`
  entry with full snapshot; duplicate by case/spacing against active and inactive →
  `409 DUPLICATE_VENDOR_NAME` with `existingVendor { id, name }` and no audit entry; a
  retried identical create → same `409` naming the first — `backend/tests/integration/
  vendors-create.test.ts` — FR-001–FR-004, FR-013 (FR-VEN-01).
- [ ] T014 [P] [US1] Concurrent creates of one normalised name behind a barrier: exactly
  one 201, the other 409 naming the winner, never 500 — `backend/tests/integration/
  vendors-concurrency.test.ts` — R3, SC-002 (FR-VEN-01).
- [ ] T015 [P] [US1] List and read: default `ACTIVE`; `INACTIVE`, `ALL`; lowercase
  `active` → 400; `q` prefix
  case- and space-insensitive with `%`/`_` taken literally; sort `name_key, id`;
  pagination envelope and a page past the end; `GET /vendors/:id` 200 with `ETag`, unknown
  id 404, non-UUID 400 — `backend/tests/integration/vendors-list.test.ts` — FR-009.
- [ ] T016 [P] [US1] Web: list (states, filters in URL, pagination, payment-terms format)
  and create form (per-type fields, field errors by code, duplicate link to
  `existingVendor`, no double submit), axe clean — `frontend/src/pages/vendors/
  VendorsList.test.tsx`, `VendorForm.test.tsx` — FR-016, SC-007.

### Implementation

- [ ] T017 [US1] Repository: `insertVendor` (`INSERT … ON CONFLICT (name_key) DO NOTHING
  RETURNING`), `findVendorByNameKey`, `findVendor`, `listVendors` (`LIMIT`/`OFFSET`, filters
  in SQL, `name_key LIKE` the escaped `vendor_name_key($q)` plus `%`), `countVendors` — `backend/src/vendors/repository.ts` — R2, R3.
- [ ] T018 [US1] Pure `toVendor`/`toSnapshot` mapping (columns ↔ union `paymentTerms`) —
  `backend/src/vendors/snapshot.ts` — FR-012.
- [ ] T019 [US1] Service `createVendor` (audited, clash → `existingVendor`), `getVendor`,
  `listVendors` — `backend/src/vendors/service.ts` — T013–T015 green.
- [ ] T020 [US1] Operations and routes `listVendors`, `getVendor`, `createVendor` (contract,
  OpenAPI list, body inventory, matrix pins and rows; regenerate `openapi.json`); register
  the area —
  `backend/src/vendors/routes.ts`, `backend/src/http/routes/index.ts`.
- [ ] T021 [US1] Web: `queries.ts`, `payment-terms.ts` (format), `VendorsList`,
  `VendorForm` (create), `VendorDetail` (read) — `frontend/src/pages/vendors/` — T016 green.

**Checkpoint**: US1 demonstrable alone.

---

## Phase 4: US2 — Correct a vendor's details (P1)

**Goal**: full-replacement edit with optimistic concurrency.
**Independent test**: two Buyers edit one vendor; the stale save gets `409 VERSION_CONFLICT`.

- [ ] T022 [P] [US2] Edit tests, seen failing: `PUT` with current `If-Match` → 200,
  version +1, `VENDOR_UPDATED` before → after (contact email and phone included); missing
  `If-Match` → 400 `VERSION_REQUIRED`; stale → 409 `VERSION_CONFLICT`, nothing changed;
  phone cleared by `null` and by omission (stored `NULL`), `""` → 400; rename onto another
  vendor's normalised name → 409 with `existingVendor`; own-name case change allowed;
  inactive vendor editable; unknown id 404 — `backend/tests/integration/
  vendors-update.test.ts` — FR-006, R6, R7, R8 (FR-VEN-01).
- [ ] T023 [P] [US2] Concurrency, seen failing: two edits with the same version behind a
  barrier → one 200, one 409; two renames to one new name → one 200, one 409
  `DUPLICATE_VENDOR_NAME` with `existingVendor` (the `23505` fallback read, R3) —
  `backend/tests/integration/vendors-concurrency.test.ts` — SC-003.
- [ ] T024 [P] [US2] Web: edit form prefilled, sends `If-Match`, clearing phone sends
  `null`; unsaved-changes guard (router blocker and `beforeunload`); `VERSION_CONFLICT`
  reload after the guard; no confirmation on save — `frontend/src/pages/vendors/
  VendorForm.test.tsx` — FR-016, NFR-FE-09.
- [ ] T025 [US2] Repository `lockVendor` (`FOR UPDATE`), `findClash(nameKey, exceptId)`,
  `updateVendor` (`version = version + 1`) — `backend/src/vendors/repository.ts`.
- [ ] T026 [US2] Service `updateVendor`: lock → 404 → version → clash → update + audit;
  on `vendors_name_key_key` violation, read the clash in a new read transaction and throw
  `DUPLICATE_VENDOR_NAME` — `backend/src/vendors/service.ts` — T022, T023 green.
- [ ] T027 [US2] Operation and route `updateVendor` (contract, OpenAPI list, inventory,
  matrix pin) — `backend/src/vendors/routes.ts`.
- [ ] T028 [US2] Web: edit route and form mode, guard, conflict handling —
  `frontend/src/pages/vendors/` — T024 green.

**Checkpoint**: US1 + US2.

---

## Phase 5: US3 — Deactivate and reactivate a vendor (P1)

**Goal**: soft lifecycle and the active check the order slices use.
**Independent test**: deactivate → leaves default list, check reports inactive;
reactivate restores.

- [ ] T029 [P] [US3] Tests, seen failing: deactivate/reactivate with `If-Match` → 200,
  version +1, `deactivatedAt` set/cleared, one audit entry each; repeat → 409
  `INVALID_STATE_TRANSITION`, no entry, version unchanged; stale → 409 `VERSION_CONFLICT`
  (checked before state); no delete route exists and `po_app` `DELETE` fails —
  `backend/tests/integration/vendors-status.test.ts` — FR-005, FR-007 (FR-VEN-01).
- [ ] T030 [P] [US3] Active check tests, seen failing, via a test-only caller in a
  transaction: missing id → `VALIDATION_FAILED` with `{ path, code: 'VENDOR_NOT_FOUND' }`;
  inactive → `VENDOR_INACTIVE`; active → `VendorSnapshot` (`id`, name, contacts,
  `paymentTerms`); a deactivate started while a check holds `FOR SHARE` waits until that
  transaction ends (barrier); two checks don't block each other —
  `backend/tests/integration/vendor-active-check.test.ts` — FR-011, FR-012, R9
  (FR-VEN-02, FR-VEN-03 building blocks).
- [ ] T031 [P] [US3] Web: Deactivate dialog (title, consequence text, safe button
  focused, Escape closes, disabled while pending, server error inside); Reactivate with
  no dialog; axe — `frontend/src/pages/vendors/DeactivateVendorDialog.test.tsx`,
  `VendorDetail.test.tsx` — FR-016, NFR-FE-09.
- [ ] T032 [US3] Repository `setVendorStatus`, `lockVendorShared` (`FOR SHARE`) —
  `backend/src/vendors/repository.ts`.
- [ ] T033 [US3] Service `deactivateVendor`, `reactivateVendor`, exported
  `requireActiveVendor(tx, vendorId, path)` — `backend/src/vendors/service.ts` — T029,
  T030 green.
- [ ] T034 [US3] Operations and routes `deactivateVendor`, `reactivateVendor` (contract,
  OpenAPI list, inventory, matrix pins) —
  `backend/src/vendors/routes.ts`.
- [ ] T035 [US3] Web: dialog via `ConfirmDialog`, reactivate button, status badge —
  `frontend/src/pages/vendors/` — T031 green.

**Checkpoint**: US1–US3.

---

## Phase 6: US4 — Role boundaries on vendors (P1)

**Goal**: ADR-0004 vendor rows, every cell.
**Independent test**: the matrix rows pass for Buyer, other Buyer, Approver, Admin, no
role and anonymous.

- [ ] T036 [P] [US4] Matrix rows, seen failing for any gap: the seven vendor operations ×
  6 caller kinds (writes as Approver/Admin → 403 `FORBIDDEN` with an invalid body; no role
  → `NO_ROLE_ASSIGNED`; anonymous → 401; history as Approver → 403), generated from the
  route table — `backend/tests/integration/authorization-matrix.test.ts` — FR-010, SC-004
  (FR-ACT-01).
- [ ] T037 [P] [US4] Web: Approver and Admin see no write controls; Buyer-only routes show
  Forbidden; a role removed mid-edit → next save shows the 403 message —
  `frontend/src/pages/vendors/VendorsList.test.tsx`, `VendorDetail.test.tsx` — FR-016.
- [ ] T038 [US4] Fix whatever T036/T037 expose (expected: none beyond the route table) —
  `backend/src/vendors/routes.ts`, `frontend/src/pages/vendors/`.

---

## Phase 7: US5 — Vendor history (P2)

**Goal**: who changed what, for Buyers and Admins.
**Independent test**: create, edit, deactivate, reactivate → four entries newest first.

- [ ] T039 [P] [US5] Tests, seen failing: history paginated newest first (`occurredAt
  DESC, id DESC`, equal timestamps stable); actor name snapshot survives a later rename;
  refused changes leave none; unknown vendor 404; Approver 403 —
  `backend/tests/integration/vendor-history.test.ts` — FR-013, FR-014, SC-005
  (NFR-AUD-03).
- [ ] T040 [P] [US5] Web: History tab for Buyers and Admins (states, pagination, changed
  fields before → after); hidden for Approvers — `frontend/src/pages/vendors/
  VendorHistory.test.tsx` — FR-016.
- [ ] T041 [US5] Audit repository `listEntityHistory(entityType, entityId, page)` and
  `countEntityHistory` — `backend/src/audit/repository.ts`.
- [ ] T042 [US5] Service `listVendorHistory` (404 when the vendor doesn't exist), operation
  (contract, OpenAPI list, matrix pin) and route
  — `backend/src/vendors/service.ts`, `routes.ts` — T039 green.
- [ ] T043 [US5] Web: `VendorHistory` tab — `frontend/src/pages/vendors/` — T040 green.

---

## Phase 8: Polish

- [ ] T044 [P] Demo seed: five vendors (one per term type, one inactive, one without
  phone) as `SYSTEM`, refused in production; test extended —
  `backend/src/migrate/seed-demo.ts`, `backend/tests/integration/seed-demo.test.ts` —
  FR-018.
- [ ] T045 [P] Plan test, seen failing, at the ADR-0012 sizes: 2,000 vendors (10 %
  inactive) and about 2M audit entries (10,000 vendor entries), each table seeded by one
  `INSERT … SELECT … FROM generate_series(…)` statement with values derived from the series
  number (no ORM loops); `VACUUM ANALYZE`; list page per status filter with and without
  `q`, history page: no `Seq Scan` on `vendors`/`audit_entries`, no `Sort` over more than
  page + offset rows, asserted on `EXPLAIN (ANALYZE, FORMAT JSON)` held in memory only
  (never written to disk); counts captured. Record the seed and run time —
  `backend/tests/plans/vendors.plan.test.ts` — R11, SC-006.
- [ ] T046 Plan writer using `EXPLAIN (COSTS OFF)` (shape only: no costs, timings, rows
  or buffers), the `plans:vendors` script entry, and the committed plans; running it twice
  on the same data leaves `git diff --exit-code docs/query-plans/vendors` clean —
  `backend/scripts/plans-vendors.ts`, `backend/package.json`,
  `docs/query-plans/vendors/*.txt` — T045 green.
- [ ] T047 CI: a `plans` job running `npm run test:plans`, then `npm run plans:vendors`
  and `git diff --exit-code docs/query-plans/vendors`, on pull requests changing
  `backend/**` or `packages/contracts/**`, on every push to `main`, and in the nightly
  workflow; record the measured CI time in R11 (move it into the default run if under
  about 1 minute) —
  `.github/workflows/nightly.yml`, `.github/workflows/ci.yml`,
  `specs/003-vendors/research.md` — R11.
- [ ] T048 [P] E2E: two Buyers share a vendor; duplicate link; version conflict and
  reload; deactivate via dialog and reactivate (no dialog); Approver read-only; axe on each
  screen. Add the deactivate dialog to the Playwright dialog checks (content and
  consequence, safe button focused, Escape closes, disabled while pending so a double
  click sends one request) — `frontend/e2e/vendors.spec.ts` — FR-017, SC-007, NFR-FE-09.
  Run `npm run e2e:local`.
- [ ] T049 Traceability: FR-VEN-01 → Tested; FR-ACT-01 and NFR-AUD-03 note the vendor
  cells passing (rows stay partial until the order slices); NFR-FE-09 lists the
  deactivate-vendor dialog among its Playwright dialogs and stays Tested; FR-VEN-02/03 stay
  Todo — `docs/traceability.md`.
- [ ] T050 Quickstart run and results — `specs/003-vendors/quickstart-results.md`.
- [ ] T051 Slice-end review: `/code-review`, `/security-review`, constitution pass; fix
  findings; full gate `set -o pipefail; npm test 2>&1 | tail -40`, lint, typecheck green.

---

## Dependencies and execution order

- Setup (T001) → Foundational (T002–T012) → US1 → US2 → US3 → US4 → US5 → Polish.
- Within Foundational: T002 → T003; T004/T005 → T006/T007; T008 after T003 and T006;
  T009 → T010.
- US2–US5 build on US1's repository, service and routes; US4 needs every route; US5 needs
  the audit events written by US1–US3.
- T046 after T045; T047 after T046; T049–T051 last.

## Parallel examples

- Foundational: T004, T005 together; then T008, T011, T012 together.
- US1: T013, T014, T015, T016 together; then T017 and T018.
- US3: T029, T030, T031 together.
- Polish: T044, T045, T048 together.

## Implementation strategy

MVP is US1 (shared list with create and duplicate protection). Then US2 and US3 complete
FR-VEN-01 and the building blocks slice 3 needs; US4 proves the matrix; US5 adds history.
Each story: tests first, seen failing against real PostgreSQL, then code; a short summary
stop after each story.
