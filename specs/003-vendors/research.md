# Research: Slice 2 — Vendors

Choices the ADRs leave open, each as decision, rationale and alternatives. ADR updates
made with this plan (2026-11-06): ADR-0005 (contact person, list default, clash member,
deactivate/reactivate), ADR-0006 (vendor `version`), ADR-0007 (clash member shape, one
"no value" form, vendor field rules), ADR-0016 (vendor contact details in audit; with the
spec).

## R1 Access levels by role set

- **Decision**: add one access level, `role`, with a `roles` list on the operation:
  `{ access: 'role', roles: [BUYER] }`. No role → `403 NO_ROLE_ASSIGNED`; a role outside
  the list → `403 FORBIDDEN`, both before validation (ADR-0004 precedence). Vendor reads
  use all three roles, writes `[BUYER]`, history `[BUYER, ADMIN]`.
- **Rationale**: the matrix rows are role sets, and slices 3–7 need more of them
  (approver queue, order create). One level plus a typed list beats a level per
  combination. The generated authorization-matrix test reads `roles` from the route table.
- **Alternatives**: `buyer`, `any-role`, `buyer-or-admin` levels (grows combinatorially);
  checks inside services (breaks "deny by default before validation").

## R2 Normalised name in the database

- **Decision**: `name_key text COLLATE "C" GENERATED ALWAYS AS
  (lower(regexp_replace(btrim(normalize(name, NFC)), '\s+', ' ', 'g'))) STORED`, with
  `UNIQUE (name_key)`. The contracts package exports `normaliseVendorName()` doing the
  same for the `q` prefix filter; an integration test pins it to the SQL expression over a
  fixture list (case, tabs, NBSP, combining accents).
- **Rationale**: uniqueness enforced by PostgreSQL, so concurrent creates can't both win
  (Principle I style). All four functions are `IMMUTABLE` in PostgreSQL 17 (checked on
  `postgres:17.11`). The `"C"` collation lets one btree serve both `ORDER BY name_key`
  and `LIKE 'prefix%'`.
- **Alternatives**: `citext` (doesn't collapse spaces, extension); an app-written key
  column with a `CHECK` (two writers of one rule); `text_pattern_ops` index (can't serve
  the sort).

## R3 Duplicate-name answer with `existingVendor`

- **Decision**: create runs `INSERT … ON CONFLICT (name_key) DO NOTHING RETURNING`; no
  row returned → `SELECT id, name … WHERE name_key = $key` in the same transaction →
  `409 DUPLICATE_VENDOR_NAME` with `existingVendor`. Edit checks for a clash
  (`name_key = $key AND id <> $id`) after locking the vendor; if a concurrent rename still
  wins, the `UPDATE` raises `23505` on `vendors_name_key_key`, the transaction rolls back,
  and the service reads the clashing vendor in a fresh read-only transaction and throws
  the same `409`.
- **Rationale**: `ON CONFLICT DO NOTHING` waits for an in-flight insert and doesn't abort
  the transaction, so the follow-up read sees the winner. A retried create (lost
  response) gets the vendor it already made. No savepoints through Prisma.
- **Alternatives**: a `CONSTRAINT_ERRORS` entry only (can't carry the existing vendor);
  an advisory lock per name (extra mechanism for a rare race).

## R4 Clash member in the problem contract (ADR-0007)

- **Decision**: registry entries gain an optional `clash` naming their member
  (`DUPLICATE_VENDOR_NAME: { status: 409, …, clash: 'existingVendor' }`). `problemSchema`
  gains `existingVendor: { id: uuid, name: string }` (strict), refined to appear only on a
  code whose `clash` is `existingVendor`. `AppError` gets an `existingVendor` option,
  refused at construction for any other code (like `reason`). The generator documents
  the member on that code.
- **Rationale**: one typed member per clash kind, reusable by later codes; the web app
  reads it without parsing text.
- **Alternatives**: put it in `detail` (text; forbidden for branching); a generic
  `existing: { type, id, label }` (loses typing per entity).

## R5 Payment terms

- **Decision**: API shape is a discriminated union on `type`, each variant a strict
  object: `{ type: 'NET', netDays }`, `{ type: 'ADVANCE' }`,
  `{ type: 'PARTIAL_ADVANCE', advancePercent, netDays }`. A field of another variant →
  `UNKNOWN_FIELD`; out of range → `OUT_OF_RANGE`; integers only. Storage: columns
  `payment_term_type`, `net_days smallint`, `advance_percent smallint` with one `CHECK`
  per type. Constants `PAYMENT_TERM_TYPES`, `NET_DAYS_MAX = 180`,
  `ADVANCE_PERCENT_MIN = 1`, `ADVANCE_PERCENT_MAX = 99`, pinned to the SQL `CHECK`s by a
  test (CLAUDE.md).
- **Rationale**: the order snapshot (slice 4) copies three columns; the database refuses
  an impossible combination on any path.
- **Alternatives**: one `jsonb` column (a `CHECK` on JSON is harder to read and query).

## R6 One form for "no phone" (ADR-0007)

- **Decision**: `contactPhone` is `string | null` in responses and `NULL` in storage.
  Create and edit (full replacement, R7) accept the field as optional and nullable:
  omitted or `null` → stored `NULL`. `""` (and whitespace only, after trimming) →
  `400 TOO_SHORT`, never stored. A `CHECK (contact_phone <> '')` backs it in the database.
- **Rationale**: one representation, so the snapshot, audit before → after and the UI
  never compare `""` with `null`.
- **Alternatives**: coerce `""` to `null` (hides client bugs; two inputs, one meaning).

## R7 Edit is a full replacement (`PUT`)

- **Decision**: `PUT /api/vendors/:id` with the whole editable vendor: `name`,
  `contactName`, `contactEmail`, `contactPhone?`, `paymentTerms`. Status changes are the
  separate `deactivate` and `reactivate` actions.
- **Rationale**: "leaving the field out clears it" is replacement semantics; the form
  always sends the whole vendor; payment terms change type as a unit.
- **Alternatives**: `PATCH` (omitted means "unchanged", contradicting R6's rule).

## R8 Versioning and state changes

- **Decision**: `version integer NOT NULL DEFAULT 1`, returned as `ETag`. Edit,
  deactivate and reactivate: `SELECT … FOR UPDATE` → `404` if missing → compare
  `If-Match` (`409 VERSION_CONFLICT`) → state or clash rule → `UPDATE … SET version =
  version + 1`. Deactivating an inactive vendor (or reactivating an active one) →
  `409 INVALID_STATE_TRANSITION`, after the version check. `CHECK ((status = 'INACTIVE')
  = (deactivated_at IS NOT NULL))`.
- **Rationale**: lock, then read, then decide (Principle V); the order of checks matches
  ADR-0004's (version before state).

## R9 Active check for the order slices (FR-011, FR-012)

- **Decision**: `vendors/service.ts` exports `requireActiveVendor(tx, vendorId, path)`:
  `SELECT … FOR SHARE`; missing → `400 VALIDATION_FAILED` with
  `{ path, code: 'VENDOR_NOT_FOUND' }`; inactive → `409 VENDOR_INACTIVE`; otherwise
  returns a `VendorSnapshot` (`id`, `name`, `contactName`, `contactEmail`,
  `contactPhone`, `paymentTerms`). Callers take it after locking the order and lines
  (ADR-0006 lock order). Tested directly in this slice with a test-only caller.
- **Rationale**: `FOR SHARE` lets submits run together while blocking a concurrent
  deactivation (which takes `FOR UPDATE`) until the order's transaction ends, so a
  submit can't pass the check against a vendor being deactivated.
- **Alternatives**: `FOR KEY SHARE` (doesn't block a status update); `FOR UPDATE`
  (serialises unrelated submits on a popular vendor).

## R10 Vendor history

- **Decision**: `GET /api/vendors/:id/history` reads `audit_entries` where
  `entity_type = 'vendor' AND entity_id = :id`, newest first (`occurred_at DESC, id
  DESC`), paginated. New index `audit_entries_entity_idx (entity_type, entity_id,
  occurred_at DESC, id DESC)`. Unknown vendor → `404`. Each event's details are
  `{ before: VendorSnapshot | null, after: VendorSnapshot }` plus `status` for
  deactivate/reactivate; created has `before: null`.
- **Rationale**: the order timelines (slice 3) and the Admin log filter by entity use
  the same index.

## R11 Committed query plans (Principle VII; ADR-0021 doesn't cover vendors)

- **Decision**: a plan test (`backend/tests/plans/vendors.plan.test.ts`) seeds, with a
  fixed seed, 2,000 vendors (ADR-0012 production; 10 % inactive) and 10,000 vendor audit
  entries among 200,000 other entries, runs `VACUUM ANALYZE`, then `EXPLAIN (ANALYZE,
  BUFFERS, FORMAT JSON)` for: list page and `COUNT` per status filter, with and without
  `q`; history page and `COUNT`. It asserts no `Seq Scan` on `vendors` or
  `audit_entries` for the page queries and no `Sort` node over more rows than the page
  plus offset. `npm run plans:vendors` writes the text plans to
  `docs/query-plans/vendors/`, committed. Slice 7 generalises the tooling.
- **Rationale**: ADR-0021 deferred only the two admin lists; every other list keeps the
  rule in its own slice.
- **Alternatives**: another deviation (no reason to give: the tooling is small here).

## R12 Frontend

- **Decision**: routes `/vendors`, `/vendors/new`, `/vendors/:id`, `/vendors/:id/edit`;
  filters and page in URL search params; one `VendorForm` for create and edit with the
  router's unsaved-changes blocker; `DeactivateVendorDialog` via the shared
  `ConfirmDialog`; reactivate inline; a history tab on the detail page for Buyers and
  Admins. A `409 DUPLICATE_VENDOR_NAME` shows "A vendor with this name already exists"
  with a link to `existingVendor`. `VERSION_CONFLICT` offers reload. Write controls render
  for Buyers only.
- **Rationale**: ADR-0018 screens and confirmation rule; no new dependency.

## R13 Constants and codes

- `VENDOR_NAME_MAX = 200`, `CONTACT_NAME_MAX = 200`, `EMAIL_MAX_LENGTH` and `emailAddressSchema` (reused from `email.ts`),
  `CONTACT_PHONE_MAX = 30`, `CONTACT_PHONE_PATTERN`, `VENDOR_STATUSES = ['ACTIVE',
  'INACTIVE']`, `VENDOR_STATUS_FILTERS = ['ACTIVE', 'INACTIVE', 'ALL']` (default
  `ACTIVE`), `PAYMENT_TERM_TYPES`, the R5 numbers; SQL copies pinned by a test.
- New error codes: `DUPLICATE_VENDOR_NAME`, `INVALID_STATE_TRANSITION`,
  `VENDOR_INACTIVE`. New field code: `VENDOR_NOT_FOUND`. System-assigned fields (`id`,
  `status`, `version`, timestamps, `nameKey`) are `UNKNOWN_FIELD`, as for `PATCH /me`;
  `READ_ONLY_FIELD` arrives with the order's derived fields (slice 3).
