---

description: "Task list for Slice 3 — Draft orders and the integrity suite"
---

# Tasks: Slice 3 — Draft orders and the integrity suite

**Input**: Design documents from `specs/004-draft-orders/`

**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md), [research.md](research.md),
[data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Tests**: Required (Principle VIII). Every test task is **run and seen failing against
real PostgreSQL** (Testcontainers) before the task that makes it pass; its commit body
carries a "Failing run:" line under 100 characters. Requirement IDs go in test names only
(ADR-0013). Never weaken, skip or delete a test to pass.

**Order rule (owner direction, 2026-11-12)**: the migration, every trigger and the raw-SQL
half of the integrity attack suite (Phase 2 and Phase 3, US2; the trigger and attack tests are seen failing on the
migration's tables before its triggers are written) are done and green **before
any order service, repository or route code** (first in Phase 4, T031). The API- and
service-level attacks join the same suite file in the story that creates the path they
attack (US1, US3).

**Operations per story** (as slice 2): Foundational adds constants, schemas, codes, the
per-operation body limit and the generator support, but no order operation. Each story
adds its operations to `OPERATIONS` with their routes, and grows the OpenAPI operation
list, the body inventory and the authorization-matrix pins in the same commit: US1
`createOrder`, `getOrder`; US3 `editOrder`; US5 `listOrders`, `listOrderTimeline`; US4
`deleteOrder`.

**Organization**: Setup, Foundational, then US2 → US1 → US3 → US6 → US5 → US4 (plan
order), then Polish. Stories run in sequence; each ends with a checkpoint (green CI on the
slice's draft PR) and a short summary stop.

## Format: `- [ ] T### [P?] [US#?] Outcome — files — refs`

- **[P]**: parallel with the other [P] tasks of the same group (different files, no
  dependency on an incomplete task).
- **Refs**: spec FR/SC, research R#, and the `docs/traceability.md` row ID the tests carry.
- **Size**: one reviewable commit each, roughly under 300 changed lines.
- **Layering**: `routes.ts` → `service.ts` → `repository.ts`; routes never import Prisma,
  a repository or `db/transaction.ts`.
- **While working**: run only the affected tests; the full gate
  (`set -o pipefail; npm test 2>&1 | tail -40`) and `npm run e2e:local` before each push.
- `LEFTHOOK_EXCLUDE=eslint` only for test-first commits importing code not yet written.

---

## Phase 1: Setup

- [ ] T001 Dependencies at exact versions: `big.js@7.0.1` and `@types/big.js@7.0.0`
  (`packages/contracts`), `fast-check@4.10.2` (dev, `packages/contracts` and `backend`),
  `@tanstack/react-virtual@3.14.23` (`frontend`); `npm ci` clean; lint rule banning
  `Prisma.Decimal` and `decimal.js` imports outside generated code —
  `packages/contracts/package.json`, `backend/package.json`, `frontend/package.json`,
  `eslint.config.mjs` — R1, R12, ADR-0010, ADR-0020.

---

## Phase 2: Foundational (blocks every story)

### Schema: migration `0013_orders` and every trigger

- [X] T002 Migration tests, seen failing: tables and columns exactly as
  [data-model.md](data-model.md), each rule by name:
  - `po_number_counters`: `fy` "`CHECK (fy ~ '^\d{4}-\d{2}$')`", `last_value`
    "`CHECK (last_value >= 1)`"; `po_app` `SELECT, INSERT, UPDATE (last_value)` only
  - `purchase_orders`: `po_number text COLLATE "C"` "`CHECK (po_number ~
    '^PO-\d{4}-\d{2}-\d{6,}$')`" and `UNIQUE`; `status` "`CHECK (status IN
    ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','CANCELLED'))`" default `DRAFT`;
    `total numeric(22,4)` "`CHECK (total >= 0)`"; `open_line_count` "`CHECK
    (open_line_count >= 0)`"; `version` "`CHECK (version >= 1)`"; grants `SELECT`,
    `INSERT (owner_id, vendor_id)`, `UPDATE (vendor_id, version, po_number)`, `DELETE`;
    no privilege on `total`, `open_line_count`, `status`, `id`, timestamps
  - `order_lines`: `position` "`CHECK (position BETWEEN 0 AND 499)`", `UNIQUE (order_id,
    position) DEFERRABLE INITIALLY DEFERRED`; `description` "`CHECK (description =
    btrim(description) AND char_length(description) BETWEEN 1 AND 500 AND description !~
    '[[:cntrl:]]')`"; `quantity` "`CHECK (quantity BETWEEN 1 AND 1000000)`"; `unit_price
    numeric(13,4)` "`CHECK (unit_price >= 0)`"; `line_total` generated `quantity *
    unit_price` stored; `received_quantity` "`CHECK (received_quantity BETWEEN 0 AND
    quantity)`"; FK `ON DELETE CASCADE`; grants `SELECT`, `INSERT (order_id, position,
    description, quantity, unit_price)`, `UPDATE (position, description, quantity,
    unit_price)`, `DELETE`; none on `line_total`, `received_quantity`, `id`
  - `order_status_transitions` empty, `po_app` `SELECT` only
  - `idempotency_keys`: PK `(user_id, operation, key)`, `operation` "`CHECK (operation
    IN ('createOrder'))`", `request_hash` "`CHECK (octet_length(request_hash) = 32)`",
    index on `created_at`; `po_app` `SELECT, INSERT, UPDATE (status, response)`;
    `po_maintenance` `SELECT, DELETE`
  - the eight order indexes of data-model.md by name and column list
  - `po_financial_year(timestamptz)` is `STABLE`, returns `'2025-26'` for 31 March 2026
    23:59:59 IST and `'2026-27'` for 1 April 2026 00:00 IST; executable by `po_app` only
  - a statement on either table without actor context → `PO001`
  — `backend/tests/integration/order-schema.test.ts` — R2, R4, R5, R7, R9 (FR-PO-01,
  FR-PO-05).
- [X] T003 Migration `0013_orders`, part 1: the five tables, grants, the eight indexes,
  `po_financial_year`, `require_actor_context` and `set_updated_at`; **no derived-value
  or rule triggers yet** (they come test-first in US2, T025); Prisma models with derived
  columns read-only — `backend/prisma/migrations/0013_orders/migration.sql`,
  `backend/prisma/schema.prisma` — T002 green.
- [X] T004 Database error mapping: `PO005`–`PO011` named as in
  [errors.md](contracts/errors.md), each → `INTERNAL_ERROR`, logged as a bug —
  `backend/src/db/errors.ts`, `backend/tests/unit/db-errors.test.ts` (test first) — R4.
- [X] T005 Reconciliation query: INV-1, INV-2, INV-4, INV-5, INV-6 and `po_number IS
  NULL` as `UNION ALL` branches (one row per violation); tests, seen failing, that plant
  each violation as the superuser with triggers off and get exactly its row; the query
  runs as `po_app` — `backend/src/db/reconciliation.sql`,
  `backend/src/db/reconciliation.ts` (runner), `backend/tests/integrity/reconciliation.test.ts`
  — data-model (NFR-DATA-01).
- [X] T006 Reconciliation after every suite: the shared `afterEach` in
  `backend/tests/support/setup.ts` runs the reconciliation on each tracked database
  (where the order tables exist) before dropping it and fails on any row; a planted
  violation in a throwaway test proves it fires, then is removed —
  `backend/tests/support/setup.ts` — FR-014, SC-002 (NFR-DATA-01).

### Contracts

- [X] T007 [P] **Property-based money tests**, seen failing (`fast-check`, fixed seed
  logged, ≥ 1,000 runs each): `lineTotal(q, p)` equals a `BigInt` oracle on values
  scaled by 10⁴ for every `q` in 1–1,000,000 and `p` matching
  `UNIT_PRICE_INPUT_PATTERN`; `sum` is commutative and associative and equals the oracle
  for 1–500 line totals, including the extreme `500 × 1,000,000 × 999999999.9999` =
  `499999999999950000.0000`; every result matches `MONEY_PATTERN`; `toMoney` normalises
  to 4 places and is idempotent; `formatInr` uses en-IN grouping with 2–4 places and
  round-trips the digits; `Big.strict` makes a JS `number` throw; examples `0.1 × 1` ×3 =
  `0.3000`, `7 × 0.0125` = `0.0875` — `packages/contracts/tests/money.property.test.ts`
  — R1, FR-013 (FR-PO-07, NFR-DATA-01).
- [X] T008 [P] Schema tests, seen failing: `createOrderBody`/`editOrderBody` accept 1 and
  500 lines and refuse 0 and 501; description trimmed, whitespace-only → `TOO_SHORT`, a
  `\n`, `\t` or other `\p{Cc}` → `INVALID_FORMAT`, a lone surrogate → `INVALID_FORMAT`,
  500 × U+1F600 accepted and 501 → `TOO_LONG` (code points, not UTF-16 units); quantity
  0, −1, 1.5, 1,000,001 refused; unit price as a JSON number, with a sign, an exponent, 5
  decimals or `1000000000` refused, `"0"` accepted and normalised to `"0.0000"`; each
  `ORDER_READ_ONLY_FIELDS` key → `READ_ONLY_FIELD` (in the body and in a line), any other
  extra key → `UNKNOWN_FIELD`; `id` refused on create lines; `deleteOrderBody` reason
  optional, `null` ok, `""` → `TOO_SHORT`, line breaks allowed, other control chars
  refused, 501 → `TOO_LONG`; `orderListQuery` upper-cases `poNumber`, refuses
  `createdFrom > createdTo` with `OUT_OF_RANGE` at `createdTo`; vendors keep
  `UNKNOWN_FIELD` for every extra key — `packages/contracts/tests/order-schemas.test.ts`
  — R6, R9, FR-001, FR-008, FR-016 (NFR-VAL-01).
- [X] T009 [P] Contract tests, seen failing: registry has `IDEMPOTENCY_KEY_REUSED` (409)
  and field codes `LINE_NOT_FOUND`, `DUPLICATE_LINE_ID`, `READ_ONLY_FIELD`; an operation
  may declare `bodyLimitBytes` (default `BODY_LIMIT_BYTES`) and a required
  `Idempotency-Key` header, documented in the OpenAPI on a made-up operation; a walk of the
  generated OpenAPI asserts every money property is `type: string` with `MONEY_PATTERN`
  — `packages/contracts/tests/errors.test.ts`, `openapi.test.ts` — R1, R5, R8.
- [X] T010 Money module and constants: `money.ts` exactly as
  [contracts/api.md](contracts/api.md) (`Big` never exported); `orders.ts` constants
  (`ORDER_LINES_MIN = 1`, `ORDER_LINES_MAX = 500`, `LINE_DESCRIPTION_MAX = 500`,
  `LINE_QUANTITY_MAX = 1_000_000`, `UNIT_PRICE_MAX = '999999999.9999'`,
  `DELETE_REASON_MAX = 500`, `ORDER_STATUSES`, `PO_NUMBER_PATTERN`, `PO_NUMBER_TIME_ZONE
  = 'Asia/Kolkata'`, `ORDER_BODY_LIMIT_BYTES = 4 * 1024 * 1024`,
  `IDEMPOTENCY_KEY_TTL_HOURS = 24`, `ORDER_ADMIN_READ_ONLY_MESSAGE = 'Admins can view
  orders but not change them.'`, `ORDER_READ_ONLY_FIELDS`) —
  `packages/contracts/src/money.ts`, `packages/contracts/src/orders.ts`, `index.ts` — T007
  green.
- [X] T011 Schemas and the read-only guard: `schemas/read-only.ts` (`readOnlyGuarded`,
  runs before the strict-object check), `schemas/orders.ts` (bodies, `order`,
  `orderLine`, `orderListItem`, `orderListQuery`, `orderTimelineItem`) —
  `packages/contracts/src/schemas/read-only.ts`, `packages/contracts/src/schemas/orders.ts`
  — T008 green.
- [X] T012 Registry, field codes, `OperationContract.bodyLimitBytes`, the
  `Idempotency-Key` header support and the generator changes (no order operation yet) —
  `packages/contracts/src/errors.ts`, `operations.ts`, `openapi.ts` — T009 green;
  regenerate `openapi.json` (don't open it); breaking-change check green.
- [X] T013 [P] Constants ↔ SQL pin tests, seen failing then green against T003: every
  number and list in T010 equals its `CHECK`, column type or SQL literal
  (`ORDER_STATUSES`, line and description limits, quantity max, `UNIT_PRICE_MAX` =
  `numeric(13,4)` max, `PO_NUMBER_PATTERN`, `PO_NUMBER_TIME_ZONE` inside
  `po_financial_year`, `ORDER_LINES_MAX - 1` = position max); description rules agree
  between Zod and PostgreSQL on a shared table of samples (emoji, NBSP, `\t`, U+0085) —
  `backend/tests/integration/order-constants.test.ts` — R9, CLAUDE.md constants rule.

### Platform: per-operation body limit, parsed after authentication

- [X] T014 Body-parsing tests, seen failing, on made-up test-only operations (one at the
  default, one declaring 4 MiB): a body over the operation's limit by `Content-Length` →
  `413 PAYLOAD_TOO_LARGE`, under it parsed; the parser runs after `authenticate` → CSRF →
  `NO_ROLE_ASSIGNED` → `FORBIDDEN`; a request refused before parsing (401, 403 CSRF, 403
  role, 413) is answered with `Connection: close` and **its body is not read**: a raw
  `http.request` declaring `Content-Length: 4194304` and writing only the first 1 KiB
  gets the response while still holding the rest, and the server socket's `bytesRead`
  stays under 64 KiB; a **chunked** body (`Transfer-Encoding: chunked`, no
  `Content-Length`) over the operation's limit → `413 PAYLOAD_TOO_LARGE` and is never
  parsed (the handler and the JSON parser never see it, the socket closes) —
  `backend/tests/integration/body-limit.test.ts` — R8 (NFR-VAL-01).
- [X] T015 Per-route parser: `parseJson(limit)` built per operation from
  `bodyLimitBytes`, mounted after authorization; refusals before parsing set
  `Connection: close` and drop the `req.resume()` drain — `backend/src/http/
  middleware/parse-json.ts`, `backend/src/http/define-route.ts`
  — T014 green; the full gate stays green (slice 0–2 refusal tests).
- [X] T016 [P] nginx: `location ~ ^/api/orders(/[^/]+)?$` with `client_max_body_size 4m`
  (same proxy settings as `/api/`), `/api/` and the server default drop from `2m` to `1m`;
  a test, seen failing, parses `deploy/nginx/default.conf` and pins each limit to
  `ORDER_BODY_LIMIT_BYTES` and `BODY_LIMIT_BYTES` — `deploy/nginx/default.conf`,
  `backend/tests/unit/nginx-limits.test.ts` — R8, ADR-0020.

### Audit, idempotency, web plumbing

- [X] T017 [P] Audit events `PO_CREATED`, `PO_EDITED`, `PO_DRAFT_DELETED` (`entityType:
  'ORDER'`, `order_id` and `po_number` carried, `details` exactly as data-model.md with
  `Money` strings), with a unit test of each details schema —
  `backend/src/audit/events.ts`, `backend/tests/unit/audit-write.test.ts` — FR-020.
- [X] T018 [P] Idempotency repository tests, seen failing, then the repository:
  `claim(userId, operation, key, hash)` inserts or returns the stored row; `complete(…,
  status, response)` in the same transaction; a rolled-back claim leaves no row; a
  concurrent claim of the same key waits, then sees the stored result —
  `backend/tests/integration/idempotency.test.ts`, `backend/src/idempotency/repository.ts`
  — R5 (NFR-CON-01).
- [X] T019 [P] Purge: idempotency keys older than `IDEMPOTENCY_KEY_TTL_HOURS` deleted
  under `po_maintenance`; test first, with the injected clock —
  `backend/src/maintenance/purge.ts`, `backend/tests/integration/purge.test.ts` — R5.
- [X] T020 [P] Web: messages for `IDEMPOTENCY_KEY_REUSED` and the three field codes;
  `FORBIDDEN` on an order write shows `ORDER_ADMIN_READ_ONLY_MESSAGE` when the signed-in
  user is an Admin (`messageForOrderWrite`); tests first. The routes and the Shell entry
  moved to the stories that add their operations (T035 `/orders/new`, `/orders/:id`; T044
  `/orders/:id/edit`; T057 `/orders` and the nav entry, gated by `listOrders`) —
  `frontend/src/errors/messages.ts`,
  `frontend/tests/error-messages.test.ts` — R11, R12.

**Checkpoint**: schema (migration part 1, no rule triggers yet), reconciliation, contracts
and the body-limit machinery green; no order service, repository or route exists yet.

---

## Phase 3: User Story 2 — The total can never drift (P1) 🎯 first

**Goal**: no path, raw SQL included, can make a total disagree with its lines.

**Independent test**: run `backend/tests/integrity/`; every attack refused with its
specific outcome; reconciliation zero rows.

All tasks here are raw SQL against the migrated database; **no service code**. The
tests (T021–T024) run against part 1 of the migration and fail because the
triggers don't exist yet; T025 adds them to the same, still unreleased migration file
(reset the local dev database after it changes).

- [X] T021 [P] [US2] Trigger tests, seen failing, raw SQL as `po_app` with actor context unless
  stated, each asserting the SQLSTATE:
  - line insert, update (quantity, unit price) and delete each leave `total` = Σ
    `line_total` and `open_line_count` = lines with `received_quantity < quantity`, in the
    same transaction; a description- or position-only update leaves both unchanged and
    recomputes nothing
  - deleting an order's last line → `PO007` at commit; replacing every line in one
    transaction commits; an order inserted with no line → `PO007` at commit
  - an order committed with `po_number NULL` → `PO011`; `NULL` → value in the creating
    transaction passes; any later change of `po_number`, `owner_id` or `created_at` →
    `PO008`
  - a status change of a draft → `PO009`; a line change on, or a delete of, a non-draft
    order (status set by the superuser with triggers off) → `PO006` / `PO010`
  - as `po_owner`: `UPDATE purchase_orders SET total = …` and `SET open_line_count = …` →
    `PO005`; a status-, vendor-, version- or timestamp-only update passes
  — `backend/tests/integration/order-triggers.test.ts` — R3, R4 (FR-PO-03, FR-PO-04,
  FR-SM-02, FR-RPT-03).
- [X] T022 [P] [US2] Attack suite, database part, seen failing on part 1: as `po_app`,
  `UPDATE` of `total`, `open_line_count`, `line_total`, `received_quantity`, `status`,
  `id` → `42501` (these pass on part 1, the grants are there); `INSERT` with
  `total`/`line_total` → `42501`/`428C9`; as `po_owner`, `total` and `open_line_count`
  writes → `PO005`; line insert/update/delete without touching the order still moves the
  total; delete of the last line → `PO007`; `po_number` change → `PO008`; status change
  → `PO009`; `ALTER TABLE … DISABLE TRIGGER` refused to `po_app`; each case ends with the
  reconciliation at zero rows — `backend/tests/integrity/attack-suite.test.ts` — FR-009,
  FR-014, SC-003 (FR-PO-03, FR-PO-04).
- [X] T023 [P] [US2] Trigger-count tests, seen failing on part 1: in one transaction, a
  500-line update of only quantities → `po.recompute_count` = 1; insert + update +
  delete statements → 3; a vendor-only, version-only, status-attempt or timestamp-only
  order update → 0; a description-only line update → 0 —
  `backend/tests/integrity/trigger-count.test.ts` — FR-021 (NFR-PERF-03).
- [X] T024 [P] [US2] Exactness at the limits, property-based (`fast-check`, ≥ 200 runs),
  seen failing on part 1 (totals stay 0): random line sets (1–500 lines, fractional
  prices, limit values) inserted by raw SQL; PostgreSQL's `line_total` and `total` (read
  as text) equal `money.ts`'s `lineTotal` and `sum` exactly; the extreme 500-line order
  fits `numeric(22,4)` with no overflow —
  `backend/tests/integrity/money-agreement.property.test.ts` — US2 scenario 4, FR-013
  (NFR-DATA-01).
- [X] T025 [US2] Migration `0013_orders`, part 2: `recompute_orders(uuid[])` (`SECURITY
  DEFINER`, owned by `po_owner`, `search_path` pinned, `EXECUTE` revoked from `PUBLIC`,
  sets the transaction-local `po.recompute` flag and increments `po.recompute_count`),
  the three statement-level line triggers with transition tables (`PO006` check, early
  exit when no `quantity`/`unit_price`/`received_quantity`/`order_id` changed, cascaded
  orders skipped), the derived guard (`PO005`), immutability (`PO008`), status transition
  (`PO009`), draft-only delete (`PO010`), deferred `has_lines` (`PO007`) and
  `po_number_assigned` (`PO011`) constraint triggers —
  `backend/prisma/migrations/0013_orders/migration.sql` — T021, T022, T023, T024 green.
- [X] T026 [US2] PO number allocation statement and its tests, seen failing: the
  counter upsert + `UPDATE … SET po_number` as one module used by the service and the
  seeds; first number of a FY is `000001`; 31 March 23:59:59 IST vs 1 April 00:00 IST
  (injected timestamp) land in different years; a rolled-back allocation leaves no gap;
  two FYs seeded keep separate counters — `backend/src/orders/po-number.ts`,
  `backend/tests/integration/po-number.test.ts` — R2, FR-002 (FR-PO-05).

**Checkpoint**: integrity suite (database half) green; `npm test` reconciliation zero.

---

## Phase 4: User Story 1 — Raise a draft order (P1) 🎯 MVP

**Goal**: a Buyer creates an order and reads it back.

**Independent test**: create a 3-line order as a Buyer → `DRAFT`, PO number, exact totals,
one `PO_CREATED`.

- [X] T027 [P] [US1] Create tests, seen failing: success shape, `201`, `Location`,
  `ETag: "1"`, lines in the order sent, exact `0.3000` and `0.0875`; `GET
  /orders/not-a-uuid` → `400` (`INVALID_FORMAT` on the id), never `404` or `500`; vendor missing →
  `400 VENDOR_NOT_FOUND`, inactive → `409 VENDOR_INACTIVE`, nothing written; each field
  rule of T008 through the API → `400` naming every failing field; `READ_ONLY_FIELD` /
  `UNKNOWN_FIELD`; missing or non-UUID `Idempotency-Key` → `400` (`REQUIRED`,
  `INVALID_FORMAT`); replay same key + body → the original response and no second order
  or number; same key, other body → `409 IDEMPOTENCY_KEY_REUSED`; two users with the same
  key create two orders — `backend/tests/integration/orders-create.test.ts` — FR-001,
  FR-003, FR-006, FR-008 (FR-PO-01, FR-PO-02, FR-VEN-02, NFR-CON-01, NFR-VAL-01).
- [X] T028 [P] [US1] Audit tests, seen failing: one `PO_CREATED` per create with actor,
  `actingRole: BUYER`, name and email at the time, PO number, vendor, every line, total,
  request id; refused, replayed and rolled-back creates write none —
  `backend/tests/integration/orders-audit.test.ts` — FR-020, SC-007 (NFR-AUD-01).
- [X] T029 [P] [US1] **Max-order body-limit test hitting the API directly** (Supertest /
  raw `http` against the app, no proxy), seen failing: the largest valid order (500
  lines, each description 500 × U+1F600, quantity 1,000,000, unit price
  `999999999.9999`) sent as raw UTF-8 (~1.06 MB) → `201` with total
  `499999999999950000.0000`; the same order with every character escaped as `😀`
  (~3.06 MB) → `201`; a body of `ORDER_BODY_LIMIT_BYTES + 1` → `413 PAYLOAD_TOO_LARGE`;
  the same 4 MiB `POST /api/orders` with no session, with a session but no CSRF token,
  and as an Admin, writing only the first 1 KiB → `401`, `403 CSRF_REJECTED`, `403
  FORBIDDEN` (detail `ORDER_ADMIN_READ_ONLY_MESSAGE`) each with `Connection: close`
  before the rest is sent, server socket `bytesRead` under 64 KiB; the largest order
  plus padding sent **chunked** past 4 MiB → `413`, never parsed, no order written; any
  other route still refuses a body over 1 MiB — `backend/tests/integration/order-body-limit.test.ts` — R8
  (NFR-VAL-01).
- [X] T030 [P] [US1] Attack suite, API and service part (its own file, beside the database part), seen failing: `total`,
  `lineTotal`, `openLineCount`, `poNumber`, `receivedQuantity` in a create body →
  `400 READ_ONLY_FIELD`; a price as a JSON number → `400`; a service-level call
  (`createOrder` with a crafted input object carrying `total`) cannot set it; each ends
  with reconciliation at zero — `backend/tests/integrity/attack-suite-api.test.ts` — FR-014.
- [X] T031 [US1] Repository: insert order (`po_number NULL`), insert lines in one
  multi-row statement, read order with lines (NUMERIC as text, lines by position), vendor
  name/status join — `backend/src/orders/repository.ts`.
- [X] T032 [US1] Service `createOrder`: idempotency claim → lock vendor
  (`requireActiveVendor`) → insert order and lines → allocate PO number last
  (`po-number.ts`) → `PO_CREATED` → complete the key, one transaction; `getOrder` with
  the read scope of ADR-0004 (owner, Admin; others `404`) — `backend/src/orders/service.ts`.
- [X] T033 [US1] Operations `createOrder` (BUYER, `bodyLimitBytes:
  ORDER_BODY_LIMIT_BYTES`, `Idempotency-Key` required) and `getOrder` (all three roles):
  contract, routes, OpenAPI list, body inventory, matrix pins (create: Buyer ✓, Approver
  403, Admin 403 with `detail` = `ORDER_ADMIN_READ_ONLY_MESSAGE`, no role
  `NO_ROLE_ASSIGNED`, anonymous 401; read draft: owner ✓, other Buyer 404, Approver 404,
  Admin ✓) — `packages/contracts/src/operations.ts`, `backend/src/orders/routes.ts`,
  `backend/src/api.ts`, `packages/contracts/tests/body-inventory.test.ts`,
  `backend/tests/integration/authorization-matrix.test.ts` — T027–T030 green.
- [X] T034 [P] [US1] Web tests, seen failing: editor (create) renders, adds and removes
  lines, shows live line totals and total from `money.ts`, row-level errors inline, save
  disabled while invalid or pending, so a double click sends one request; the web app
  sends an `Idempotency-Key` on every create (asserted on the MSW request), one per
  attempt, reused on retry; loading, empty and error states;
  `VENDOR_INACTIVE` banner focuses the vendor picker; vendor picker lists active vendors
  only; axe clean — `frontend/tests/order-editor.test.tsx` — FR-023 (NFR-FE-03,
  NFR-FE-04, NFR-FE-06).
- [X] T035 [US1] Web: `OrderEditor` (TanStack Virtual line table, keyboard reachable,
  move up/down) for create, `OrderDetail` (header, lines, total in en-IN INR), queries,
  routes `/orders/new` and `/orders/:id` — `frontend/src/pages/orders/`,
  `frontend/src/app/router.tsx` — T034 green.

**Checkpoint**: a Buyer can raise and read a draft end to end.

---

## Phase 5: User Story 3 — Edit a draft (P1)

**Goal**: full-line-set edit with line identity, `If-Match`, field-level audit.

**Independent test**: the spec's 3-line edit (change, remove, add, move first).

- [X] T036 [P] [US3] Line-diff property tests, seen failing (`fast-check`): for any stored
  set and intended set, `diff` yields added/changed/removed such that applying it gives
  the intended set; unchanged lines never appear in `changed`; a moved line is changed
  (position only); an identical set yields nothing; ids not in the stored set →
  `LINE_NOT_FOUND` at `lines[i].id`, a repeat → `DUPLICATE_LINE_ID` at the second —
  `backend/tests/unit/line-diff.property.test.ts` — R6 (FR-PO-06).
- [X] T037 [US3] Pure line diff — `backend/src/orders/line-diff.ts` — T036 green.
- [X] T038 [P] [US3] Edit tests, seen failing: spec scenarios 1–5 (ids kept, array order
  = display order, version +1, `ETag`); `PATCH /orders/not-a-uuid` → `400`; stale
  `If-Match` → `409 VERSION_CONFLICT`,
  missing → `400 VERSION_REQUIRED`; foreign/duplicate line id; empty set; missing and
  inactive vendor; a draft whose vendor was deactivated may switch to an active one; a
  no-op save → version unchanged, no audit entry; `PO_EDITED` details per data-model.md
  (vendor before/after, lines added/removed/changed field by field, total before/after);
  at most one INSERT, one UPDATE and one DELETE statement (statement log); the largest
  valid order as an edit → `200` (appended to `order-body-limit.test.ts`) —
  `backend/tests/integration/orders-edit.test.ts`,
  `backend/tests/integration/order-body-limit.test.ts` — FR-004, FR-005, FR-020 (FR-PO-06,
  NFR-CON-03, NFR-AUD-01).
- [X] T039 [P] [US3] Concurrency tests (barrier): edit/edit same version → one `200`, one
  `409`; 50 concurrent creates → 50 distinct, consecutive numbers; reconciliation zero —
  `backend/tests/concurrency/orders.test.ts` — SC-004 (NFR-CON-03, FR-PO-05).
- [X] T040 [P] [US3] Attack suite, edit part (appended): `total`/`lineTotal` in an edit
  body or line → `400 READ_ONLY_FIELD`; an edit whose lines name another order's line id
  → `400 LINE_NOT_FOUND`, nothing changed — `backend/tests/integrity/attack-suite-api.test.ts`
  — FR-014.
- [X] T041 [US3] Repository (lock order `FOR UPDATE`, lock lines by id, the three line
  statements, version bump) and service `editOrder` (lock order → 404 if unreadable →
  version → line ids → vendor; diff; `PO_EDITED`) — `backend/src/orders/repository.ts`,
  `service.ts`.
- [X] T042 [US3] Operation `editOrder` (BUYER, `ifMatch`, `bodyLimitBytes:
  ORDER_BODY_LIMIT_BYTES`): contract, route, OpenAPI list, body inventory, matrix pins
  (owner ✓, other Buyer 404, Approver 403, Admin 403 with the message) —
  `packages/contracts/src/operations.ts`, `backend/src/orders/routes.ts`,
  `backend/tests/integration/authorization-matrix.test.ts` — T038–T040 green.
- [X] T043 [P] [US3] Web tests, seen failing: editor in edit mode loads the stored order,
  sends `If-Match`; no confirmation on save; "Discard your unsaved changes?" on in-app
  navigation and `beforeunload`; `409 VERSION_CONFLICT` banner "This order changed since
  you opened it." with "Reload order" — `frontend/tests/order-editor-edit.test.tsx` —
  FR-023 (NFR-FE-01, NFR-FE-09).
- [X] T044 [US3] Web: edit route, guard, conflict reload — `frontend/src/pages/orders/`
  — T043 green.

---

## Phase 6: User Story 6 — Visibility and role boundaries (P1)

**Goal**: every draft cell of ADR-0004 for the operations so far, including **the cells
the owner added on 2026-11-12**.

**Independent test**: the matrix rows for create, read, edit against six caller kinds.

- [X] T045 [US6] Matrix tests, seen failing where not yet covered: Buyer B → `404` on
  Buyer A's draft read and edit; Approver read → `404`, create → `403` before body
  validation (invalid body still 403); no role → `403 NO_ROLE_ASSIGNED` with an invalid
  body; anonymous → `401`; **Admin create and edit → `403 FORBIDDEN` with `detail` =
  "Admins can view orders but not change them." (`ORDER_ADMIN_READ_ONLY_MESSAGE`), never
  `NOT_ORDER_OWNER`, before validation (owner cell 3, 2026-11-12)**; a Buyer+Approver owner edits their draft as owner; a Buyer whose
  BUYER role is removed mid-edit → `403` (or `NO_ROLE_ASSIGNED`), orders kept —
  `backend/tests/integration/orders-access.test.ts`,
  `backend/tests/integration/authorization-matrix.test.ts` — FR-019, SC-006 (FR-OWN-01,
  NFR-AUTH-01, NFR-AUTH-02).
- [X] T046 [US6] Fixes from T045 (expected: the Admin `detail` set where the route-level
  `FORBIDDEN` is raised for an order write by an Admin; ADMIN is never combined with
  another role, ADR-0016) —
  `backend/src/orders/routes.ts` or the authorize hook it uses — T045 green.
- [X] T047 [P] [US6] Web tests, seen failing: Admin sees detail read-only (no Edit/Delete,
  no "New order"); an Admin `FORBIDDEN` on an order write shows the message; Approver
  sees the empty-state text "Orders appear here once buyers submit them." —
  `frontend/tests/orders-list.test.tsx` ("by role"), `order-editor-edit.test.tsx` — R11, R12 (NFR-FE-03).
- [X] T048 [US6] Web role gating — `frontend/src/pages/orders/` — T047 green.

---

## Phase 7: User Story 5 — Find and read orders (P1)

**Goal**: filtered, paginated lists in the database; the timeline; committed plans.

**Independent test**: two Buyers' orders seeded; scoping, filters, pagination, timeline.

- [X] T049 [P] [US5] List tests, seen failing: Buyer sees own only, Admin all, Approver
  none (no non-drafts exist; asserted on a non-draft set by the superuser with triggers
  off); **Buyer+Approver gets one list = own orders ∪ every non-draft order (owner cell
  2, 2026-11-12)**; sort `createdAt DESC, id DESC`; each filter alone and combined
  (status, vendor, PO prefix case-insensitive, created range inclusive in IST at both day
  edges); with `poNumber` sorted by PO number descending; `createdFrom > createdTo` →
  `400`; page past the end → empty `items`, right `total`; line count per row from one
  query; vendor dialog query (`vendorId`, `status=DRAFT`, `pageSize=1`) returns the
  caller's draft count only — `backend/tests/integration/orders-list.test.ts` — FR-015,
  FR-016, FR-024 (FR-OWN-01, NFR-PERF-01).
- [X] T050 [P] [US5] Timeline tests, seen failing: owner and Admin read it paginated,
  newest first, each item actor, capacity, time, details; other Buyer and Approver →
  `404`; an Admin asking for the timeline of a well-formed id that never existed → `404`
  (not an empty page); `GET /orders/not-a-uuid/timeline` → `400` — `backend/tests/integration/orders-timeline.test.ts` — FR-018 (NFR-AUD-03).
- [X] T051 [US5] Repository list/count with the scope and filter predicates of R7 (one
  page query, one `COUNT`, one line-count query); timeline via `listEntityHistory('ORDER',
  id)`; services `listOrders`, `listOrderTimeline` — `backend/src/orders/repository.ts`,
  `service.ts`.
- [X] T052 [US5] Operations `listOrders` and `listOrderTimeline` (all three roles):
  contract, routes, OpenAPI list, matrix pins (lists: own / readable / all; timeline:
  own / readable / all) — `packages/contracts/src/operations.ts`,
  `backend/src/orders/routes.ts`, `backend/tests/integration/authorization-matrix.test.ts`
  — T049, T050 green.
- [X] T053 [US5] **Plan fixture** at the ADR-0012 sizes, as the superuser with row
  triggers off, `INSERT … SELECT … FROM generate_series(…)` only: 2,000 vendors (top 20 ≈
  30 % of orders), 300 buyers (top 10 ≈ 25 %), one Admin, **100,000 orders and about
  1,000,000 lines** (1 % with 200–500 lines, the rest 1–15), totals and open-line counts
  set by the seed and **checked by the reconciliation query before planning**, about 2M
  audit entries (300k order entries); `VACUUM ANALYZE`; record seed time —
  `backend/tests/plans/orders-fixture.ts` — R7, FR-022.
- [X] T054 [US5] **Plan tests**, seen failing before the indexes are used as intended:
  for every list scope (Buyer busiest, Buyer+Approver, Admin) × each single filter, the
  PO prefix at `PO-2026-27-0012` and the short `PO-2026-27-`, two combined filters, page
  1 and page 100, each `COUNT`, the vendor dialog count, and the timeline (busiest order,
  page 1 + count): no `Seq Scan` on `purchase_orders`, `order_lines` or `audit_entries`,
  no `Sort` over more than page + offset rows, no index scan discarding more than that;
  asserted on `EXPLAIN (ANALYZE, FORMAT JSON)` held in memory, generic plans for the
  prefix filter — `backend/tests/plans/orders.plan.test.ts` — R7, FR-015, FR-022
  (NFR-PERF-01).
- [X] T055 [US5] **Committed plans**: `EXPLAIN (COSTS OFF)` writer, `plans:orders` script
  (with its `pre` hook as `plans:vendors`), plans committed; running it twice leaves
  `git diff --exit-code docs/query-plans/orders` clean; the `plans` workflow runs it and
  checks drift — `backend/scripts/plans-orders.ts`, `backend/package.json`,
  `docs/query-plans/orders/*.txt`, `.github/workflows/plans.yml` — T054 green.
- [X] T056 [P] [US5] Web tests, seen failing: `/orders` list with filters in the URL
  (status, vendor combo box, debounced PO prefix, date range), page numbers, "Sorted by
  PO number" note with a prefix, en-IN totals, loading/empty/error; the URL round-trips
  every filter and the page (reload and back/forward restore them); the PO-prefix search
  is debounced (one request after typing stops); detail Timeline tab —
  `frontend/tests/orders-list.test.tsx`, `frontend/tests/order-timeline.test.tsx` —
  FR-023 (NFR-FE-03, NFR-FE-04).
- [X] T057 [US5] Web: `OrdersList`, `OrderTimeline`, route `/orders` and the Shell's
  "Orders" entry (shown when `useCan('listOrders')`) — `frontend/src/pages/orders/`,
  `frontend/src/app/router.tsx`, `Shell.tsx` — T056 green.

---

## Phase 8: User Story 4 — Delete a draft (P2)

**Goal**: owner deletes a draft; audit survives; number never reused.

**Independent test**: delete via the dialog; `404` afterwards; Admin reads its timeline.

- [ ] T058 [P] [US4] Delete tests, seen failing: `DELETE /orders/not-a-uuid` → `400`;
  with and without a reason (no body, `{}`,
  `{"reason":null}`), order and lines gone, one `PO_DRAFT_DELETED` with PO number, full
  lines, total, reason; stale/missing `If-Match`; edit racing delete (barrier) → one wins,
  the other `409` or `404`; the next create gets a new number, never the deleted one;
  **deleted-draft timeline: Admin ✓ by order id, former owner `404`, other Buyer and
  Approver `404` (owner cell 1, 2026-11-12)**; Admin delete → `403` with the message —
  `backend/tests/integration/orders-delete.test.ts`,
  `backend/tests/concurrency/orders.test.ts` — FR-007, FR-018, FR-020 (FR-SM-02,
  FR-PO-05, NFR-AUD-03).
- [ ] T059 [US4] Repository delete (after lock, cascade), service `deleteOrder` (lock →
  404 → version → `PO_DRAFT_DELETED` → delete); timeline read scope for a deleted order
  (no order row: Admin only, everyone else `404`) — `backend/src/orders/repository.ts`,
  `service.ts`.
- [ ] T060 [US4] Operation `deleteOrder` (BUYER, `ifMatch`, optional body): contract,
  route, OpenAPI list, body inventory, matrix pins — `packages/contracts/src/
  operations.ts`, `backend/src/orders/routes.ts`,
  `backend/tests/integration/authorization-matrix.test.ts` — T058 green.
- [ ] T061 [P] [US4] Web tests, seen failing: `DeleteDraftDialog` title "Delete draft
  PO-…?", vendor, line count, total, both warning sentences, optional reason ≤ 500, safe
  choice focused, errors inside, `VERSION_CONFLICT` offers "Reload order", disabled while
  pending — `frontend/tests/delete-draft-dialog.test.tsx` — NFR-FE-09.
- [ ] T062 [US4] Web: `DeleteDraftDialog` on `ConfirmDialog` —
  `frontend/src/pages/orders/` — T061 green.

---

## Phase 9: Polish

- [X] T063 [P] Vendor deactivate dialog draft count: "N of your draft orders use this
  vendor" (omitted at 0, "Couldn't load your draft count" on error, never blocking); test
  first — `frontend/src/pages/vendors/DeactivateVendorDialog.tsx`,
  `frontend/tests/deactivate-vendor-dialog.test.tsx` — FR-024.
- [ ] T064 [P] Demo seed: three drafts per demo Buyer through the service (`0.1 × 1` ×3,
  20 lines, one against a vendor then deactivated); refused in production; reconciliation
  zero after seeding; test extended — `backend/src/migrate/seed-demo.ts`,
  `backend/tests/integration/seed-demo.test.ts` — FR-026.
- [ ] T065 [P] Compose smoke through nginx: the largest valid order (raw and escaped) →
  `201` and `ORDER_BODY_LIMIT_BYTES + 1` → `413`; a 1 MiB + 1 body on another `/api/`
  route → `413` — `scripts/smoke.sh` — R8.
- [ ] T066 [P] Editor benchmark: 500-line order, 4× CPU throttling: keystroke → paint p95
  ≤ 50 ms, add/remove ≤ 100 ms, loaded and interactive ≤ 1,000 ms; route chunk ≤ 150 KB
  gzip (bundle budget) — `frontend/e2e/order-editor-perf.spec.ts`,
  `scripts/check-bundle-budget.mjs` — SC-008, ADR-0012.
- [ ] T067 [P] Service timing check: create and replace a 500-line order p95 ≤ 500 ms,
  busiest buyer's first page p95 ≤ 150 ms on the plan fixture; record results in R7 —
  `backend/tests/plans/orders.timing.test.ts` — FR-022, SC-005.
- [ ] T068 E2E: raise a multi-line order with exact total; edit (change, add, remove);
  version conflict and reload; delete through the dialog; second Buyer can't see it;
  Admin reads it read-only; axe on each screen; delete dialog added to the Playwright
  dialog checks — `frontend/e2e/orders.spec.ts` — FR-025, NFR-FE-09. Run
  `npm run e2e:local`.
- [ ] T069 Traceability: FR-PO-01/02/03/04/05/06/07, FR-SM-02, NFR-DATA-01, FR-VEN-02
  (create/edit part), NFR-PERF-03 and FR-RPT-03 (line parts), NFR-AUD-01 (raise),
  NFR-AUD-03 (order part), NFR-FE-01/03/04/06/09 (parts), FR-OWN-01, FR-ACT-01, NFR-AUTH-01 and
  NFR-AUTH-02 (draft cells), NFR-VAL-01, NFR-CON-01, NFR-CON-03 and NFR-PERF-01 (order
  parts) updated with their passing tests; `npm run check:traceability` green —
  `docs/traceability.md`.
- [ ] T070 Quickstart run and results — `specs/004-draft-orders/quickstart-results.md`.
- [ ] T071 Slice-end review: `/code-review`, `/security-review` (permissions and body
  parsing changed), constitution pass; fix findings; full gate, lint, typecheck green.

---

## Owner requirements → tasks

| Requirement (2026-11-12) | Tasks |
|---|---|
| Migration + triggers + attack suite before any service code | T002–T006 (schema, reconciliation), T021–T024 (trigger tests, attack suite, trigger counts, PostgreSQL ↔ money), T025 (triggers), T026 (PO numbers); first service code T031 |
| Property-based money tests | T007 (money module), T024 (PostgreSQL ↔ `money.ts`), T036 (line diff) |
| Plan tests and committed plans for orders | T053 (fixture), T054 (plan tests), T055 (committed plans + drift check) |
| Max-order body-limit test hitting the API directly | T014 (machinery), T029 (create, raw + escaped, +1 byte, unread refusals), T038 (edit); T065 adds the nginx path |
| ADR-0004 cells added 2026-11-12 | cell 3 Admin 403 message: T029, T033, T045, T058; cell 2 Buyer+Approver list: T049, T054; cell 1 deleted-draft timeline: T058 |

## Dependencies and execution order

- Setup (T001) → Foundational (T002–T020) → US2 (T021–T026) → US1 → US3 → US6 → US5 →
  US4 → Polish.
- Within Foundational: T002 → T003 → T004, T005; T006 lands after T025 (before the
  triggers, every raw draft keeps `total = 0`, so the per-test reconciliation would flag it); T007–T009 → T010–T012;
  T013 after T003 and T010; T014 → T015; T016–T020 after T012.
- US2: T021–T024 (seen failing on part 1) → T025 (part 2) → T026. US1 needs T026's
  `po-number.ts`.
- US3 builds on US1's repository and service; T039's 50-create case needs T033.
- US6 covers the cells of the operations that exist (create, read, edit); US5 and US4 add
  their own cells with their operations.
- T053 → T054 → T055. T063 after T052. T067 after T053. T069–T071 last.

## Parallel examples

- Foundational: T007, T008, T009 together; then T013, T016, T017, T018, T019, T020.
- US2: T021, T022, T023, T024 together; then T025, then T026.
- US1: T027, T028, T029, T030, T034 together.
- US3: T036, T038, T039, T040, T043 together.
- Polish: T063, T064, T065, T066, T067 together.

## Implementation strategy

The integrity guarantee first (US2): the database alone keeps totals right before any
code writes an order. MVP is US1 (raise and read a draft). US3 completes correction, US6
proves the matrix, US5 adds lists and the committed plans, US4 deletes. Each story: tests
first, seen failing against real PostgreSQL, then code; a short summary stop after each
story.
