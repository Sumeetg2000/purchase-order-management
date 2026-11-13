# Research: Slice 3 — Draft orders and the integrity suite

Choices the ADRs leave open, and the owner's directions of 2026-11-12, each as decision,
rationale and alternatives. ADR updates made with this plan (2026-11-12): ADR-0001 (PO
number allocation inside the create), ADR-0003 (recompute count per statement), ADR-0006
(lock order, no replay gap), ADR-0007 (order fields, filters, order-write body limit, new
codes), ADR-0010 (the decimal library), ADR-0020 (the dependencies). ADR-0004 (the three cells of R11) after the
owner's sign-off on 2026-11-12, which also approved R2's trade-off, R3's recompute count
and R7's PO-number sort.

## R1 Decimal library: `big.js` (owner direction 1)

- **Decision**: `big.js@7.0.1` (MIT, no dependencies, about 6 KB minified, published
  2025-04) with `@types/big.js@7.0.0`, in `packages/contracts`, so the API and the web app
  share one money module (`packages/contracts/src/money.ts`):
  - `Money` is a branded string type matching `^\d{1,18}\.\d{4}$` (always 4 places);
    `UnitPrice` matches `^\d{1,9}(\.\d{1,4})?$` on input and is normalised to 4 places.
  - `lineTotal(quantity, unitPrice)`, `sum(totals)` and `formatInr(money)` are the only
    arithmetic and formatting. They use `Big` and return strings via `toFixed(4)`; `Big`
    never leaves the module.
  - `Big.strict = true`, so a JavaScript `number` passed to `Big` throws, and
    `Big.DP`/`Big.RM` are never relied on: we only add and multiply, which are exact in
    `big.js` whatever the precision setting.
  - Reading from PostgreSQL: `NUMERIC` columns are selected as text
    (`total::text`) in repositories, so Prisma's `Decimal` never appears in our code; a
    lint rule bans importing `Prisma.Decimal` and `decimal.js` outside generated code.
  - The ban on `number` for money (NFR-DATA-01): the contracts' Zod schemas give every
    money field the `Money` brand, and a contract test walks the generated OpenAPI and
    asserts every money property is `type: string` with the pattern.
- **Rationale**: the largest total is 500 × 1,000,000 × 999,999,999.9999 =
  499,999,999,999,950,000.0000, and a total can carry up to 22 significant digits
  (18 before the point, 4 after: `NUMERIC(22,4)`). `big.js` adds and multiplies
  exactly with no precision cap. `decimal.js` (already in the lockfile through Prisma)
  rounds every result to `precision` significant digits, default 20, so the largest
  total would round silently unless every caller remembers a global setting. A one-module
  wrapper keeps the rule in one place.
- **Alternatives**: `decimal.js` (precision cap; larger bundle, about 32 KB); `bignumber.js`
  (exact but larger, and its configurable `DECIMAL_PLACES` applies to division only, so no
  gain); integer cents in `bigint` (exact, but every value needs a ×10⁴ scale at each edge,
  and `JSON` has no `bigint`); PostgreSQL-only arithmetic (the editor needs live line totals
  in the browser).

## R2 PO numbers allocated inside the create transaction (owner direction 2; amends ADR-0001)

- **Decision**: `po_number_counters (fy text PRIMARY KEY, last_value bigint)`. The create
  transaction allocates **as its last write before the audit entry**:
  1. lock the vendor (`requireActiveVendor`, `FOR SHARE`), insert the order with
     `po_number NULL`, insert its lines (one statement)
  2. `INSERT INTO po_number_counters (fy, last_value) VALUES (po_financial_year(now()), 1)
     ON CONFLICT (fy) DO UPDATE SET last_value = po_number_counters.last_value + 1
     RETURNING fy, last_value`
  3. `UPDATE purchase_orders SET po_number = format('PO-%s-%s', fy, lpad(seq, greatest(6,
     length(seq)), '0'))`: at least 6 digits, never cut (plain `lpad(seq, 6)` turns
     1000000 into 100000, a duplicate; caught by `po-number.test.ts`)
  4. insert `PO_CREATED`, commit
  A deferred constraint trigger refuses a commit with any `po_number` still `NULL`, and the
  immutability trigger allows exactly one change, `NULL` → a value, in the creating
  transaction. `po_financial_year(timestamptz)` returns `'2026-27'` for 1 April 2026 00:00
  IST to 31 March 2027 23:59:59.999999 IST; tests call it with injected timestamps at both
  boundaries, and a counter test seeds two FYs.
- **What it buys**: a rolled-back or refused create rolls its counter increment back with
  it, so **only deleted drafts leave gaps** (each explained by `PO_DRAFT_DELETED`). An
  idempotent replay returns the stored result without allocating (R5), so it leaves none
  either.
- **Trade-off, approved by the owner on 2026-11-12** (ADR-0001): the counter row of the current FY is
  locked from step 2 to commit, so concurrent creates queue there. Allocating last keeps
  the hold to two small statements, one audit insert and the commit (a WAL flush),
  independent of the line count: the 500 line inserts and their triggers happen before
  the lock. With `synchronous_commit = on`, the commit dominates: about 1–5 ms on local
  SSD, so the ceiling is roughly 200–1,000 creates a second, far above ADR-0012's 50
  virtual users. The load job measures it, and the concurrency suite checks 50 parallel
  creates get 50 consecutive numbers. If the ceiling ever binds, the fallback is
  ADR-0001's earlier design (allocate before the transaction, accept gaps).
- **Alternatives**: allocating before the transaction (ADR-0001 until now: no queueing,
  but rolled-back creates and replays leave gaps; replaced by owner direction); allocating
  first inside the transaction (holds the row through 500 line inserts); a sequence per FY
  (non-transactional, so gaps on rollback; DDL per year); `MAX(seq) + 1` (races without a
  lock).

## R3 Derived values: generated line totals, statement-level triggers (owner direction 3)

- **Decision**:
  - `order_lines.line_total NUMERIC(22,4) GENERATED ALWAYS AS (quantity * unit_price)
    STORED` (INV-1 by construction).
  - `purchase_orders.total NUMERIC(22,4)` and `open_line_count integer` are stored, and
    maintained by three `AFTER … FOR EACH STATEMENT` triggers on `order_lines` (insert,
    update, delete), each `REFERENCING` its transition table(s). PostgreSQL refuses
    transition tables on a trigger with more than one event, so it's three triggers
    calling one function, `recompute_orders(order_ids uuid[])`.
  - Each trigger collects the distinct `order_id`s of its transition table(s), exits early
    when the set is empty or (update) when no `quantity`, `unit_price`, `received_quantity`
    or `order_id` changed, and recomputes each affected order **once**: one `UPDATE
    purchase_orders SET total = s.total, open_line_count = s.open FROM (SELECT order_id,
    sum(line_total), count(*) FILTER (WHERE received_quantity < quantity) … GROUP BY
    order_id) s`. Orders that no longer exist (a cascade from a draft delete) are skipped.
  - `recompute_orders` is `SECURITY DEFINER`, owned by `po_owner`, `search_path` pinned,
    `EXECUTE` revoked from `PUBLIC`. It sets the transaction-local flag
    `po.recompute = <txid>` around its `UPDATE` and clears it after.
  - Overwrite guard: `BEFORE UPDATE … FOR EACH ROW` on `purchase_orders` raises SQLSTATE
    `PO005` (`DERIVED_VALUE_READ_ONLY`) when `total` or `open_line_count` changes and the
    flag isn't the current txid. Status, vendor, version and timestamp updates pass
    untouched. The app role also has no column `UPDATE` on `total` or `open_line_count`,
    so it's refused earlier with `42501`.
- **Recompute count (FR-021, clarified)**: once per line **statement**, never per line.
  An edit issues at most three line statements (insert, then update, then delete), so it
  recomputes one to three times whatever its line count: a 500-line edit that only
  changes lines recomputes **once**, and one that also adds and removes lines, three
  times (approved by the owner, 2026-11-12: at most once per line statement, ≤ 3 per
  edit, never per line). A status-only, vendor-only or timestamp-only order update recomputes nothing.
  The trigger-count test reads a per-transaction counter the function increments
  (`po.recompute_count`, transaction-local, read in the same transaction).
- **Rationale**: the guarantee lives in PostgreSQL (Principle I) and holds for raw SQL;
  set-based work once per statement (Principle VII); no app-written derived column.
- **Alternatives**: row-level triggers (500 runs for a 500-line edit; ADR-0003 lesson 7);
  a deferred recompute at commit (exactly one per transaction, but the edit's own
  response would read a stale total, and constraint triggers are row-level only); one
  `MERGE` (still fires each action's statement trigger, so no fewer recomputes); views
  (calculate-on-read, rejected in ADR-0003 for the report).

## R4 Database rules beyond the totals

- **At least one line (INV-5)**: deferred constraint triggers (`AFTER INSERT ON
  purchase_orders`, `AFTER DELETE ON order_lines`, both `DEFERRABLE INITIALLY DEFERRED`,
  row-level as constraint triggers must be) check at commit that the order, if it still
  exists, has a line. Deferred, so a create (order before lines) and an edit that replaces
  every line both pass, and a raw-SQL "delete the last line" fails at commit with `PO007`.
- **Drafts only**: an `AFTER … FOR EACH STATEMENT` check in each line trigger (it already
  has the affected order ids) raises `PO006` if any affected order isn't `DRAFT`. `BEFORE
  DELETE ON purchase_orders` raises `PO010` unless `DRAFT`.
- **Status**: `BEFORE UPDATE OF status` raises `PO009` for any change not in
  `order_status_transitions (from_status, to_status)`, which is empty in this slice;
  slice 4 inserts the submit rows. No code path changes status in this slice.
- **PO number**: `PO008` on any change except `NULL` → value (R2); the app role has no
  column `UPDATE` on `po_number` except through that one statement, so the grant is
  `UPDATE (po_number)` plus the trigger, not a broader grant.
- **Line position**: `UNIQUE (order_id, position) DEFERRABLE INITIALLY DEFERRED`, so an
  edit that reorders lines can renumber in one statement.
- All trigger SQLSTATEs map to `INTERNAL_ERROR` in `db/errors.ts`: the service checks
  everything first, so reaching a trigger means a bug (as PO001–PO004).

## R5 Idempotency keys for creates

- **Decision**: `idempotency_keys (user_id, operation, key uuid, request_hash bytea,
  status smallint, response jsonb, created_at)`, primary key `(user_id, operation, key)`.
  The create transaction starts with `INSERT … ON CONFLICT DO NOTHING RETURNING`:
  - inserted → proceed; on success, the row is updated with the response in the same
    transaction (so a rolled-back create leaves no key)
  - conflict → read the row: different `request_hash` (SHA-256 of the canonical JSON
    body) → `409 IDEMPOTENCY_KEY_REUSED`; same → return the stored status and body with no
    other write
  - a concurrent request with the same key waits on the first one's uncommitted insert
    (the unique index), then replays its result
  `Idempotency-Key` is **required** on `POST /orders` (spec assumption): missing → `400`,
  field code `REQUIRED` at path `["headers","idempotency-key"]`; not a UUID →
  `INVALID_FORMAT`. Keys are scoped to the user, so two users can't collide. The
  `maintenance` purge deletes rows older than 24 hours (`IDEMPOTENCY_KEY_TTL_HOURS`,
  pinned to the SQL by a test).
- **Rationale**: one transaction, so the key, the order and the counter commit or roll
  back together; no gap on replay (R2).
- **Alternatives**: a key table written after commit (a crash between leaves a duplicate
  window); an in-memory cache (lost on restart, wrong with two API instances).

## R6 Line identity on edit (ADR-0009)

- **Decision**: `PATCH /orders/:id` with `{ vendorId, lines: [{ id?, description,
  quantity, unitPrice }] }`. After locking the order (`FOR UPDATE`) and its lines (`FOR
  UPDATE`, id order), the service diffs the set in memory and issues, in order: one
  multi-row `INSERT` (new lines), one `UPDATE … FROM (VALUES …)` (changed lines only, by
  id; unchanged lines are not touched), one `DELETE … WHERE id = ANY(…)`. Positions are
  the array index; a moved line counts as changed. Then one `UPDATE purchase_orders SET
  vendor_id, version = version + 1 WHERE id = $id AND version = $expected` (zero rows
  can't happen after the lock, but keeps the check in one statement). A body equal to the
  stored order writes nothing: no version bump, no audit entry.
- Foreign or unknown line id → `400 LINE_NOT_FOUND` at `lines[i].id`; the same id twice
  → `400 DUPLICATE_LINE_ID` at the second; both checked against the locked lines, after
  schema validation.

## R7 Order list indexes and filters (owner direction 4)

Scopes (in SQL): a Buyer reads `owner_id = me`; an Admin reads everything; an Approver
reads `status <> 'DRAFT'` (empty in this slice); a Buyer+Approver reads the union
(R11, approved). Sort: `created_at DESC, id DESC`, except with the PO-number filter
(below). Filters (FR-016, combinable):
`status`, `vendorId`, `poNumber` (case-insensitive prefix, upper-cased before matching),
`createdFrom`/`createdTo` (inclusive IST dates, converted to `[from 00:00 IST, to + 1 day
00:00 IST)`).

- **Indexes** (`created_at DESC, id DESC` as the tail of each, so the page walks the
  index in sort order and stops at `LIMIT`):
  | Index | Serves |
  |---|---|
  | `(owner_id, created_at DESC, id DESC)` | Buyer, no filter; Buyer + date range |
  | `(owner_id, status, created_at DESC, id DESC)` | Buyer + status (± date) |
  | `(owner_id, vendor_id, created_at DESC, id DESC)` | Buyer + vendor (± date); the vendor dialog's draft count |
  | `(created_at DESC, id DESC)` | Admin, no filter; Admin + date range |
  | `(status, created_at DESC, id DESC)` | Admin + status; Approver (`status <> 'DRAFT'` as a range pair, later slices) |
  | `(vendor_id, created_at DESC, id DESC)` | Admin + vendor; also the vendor FK |
  | `UNIQUE (po_number COLLATE "C")` | uniqueness; Admin + PO prefix (range `>= $p AND < $p || chr(1114111)`), walked backwards |
  | `(owner_id, po_number)` | Buyer + PO prefix, walked backwards |
  Combined filters use the leading filter's index and filter the rest on the order rows,
  within one owner's or one vendor's orders.
- **The PO-prefix sort (owner decision, 2026-11-12)**: with the `poNumber` filter, the
  list is sorted by **PO number descending**, so the prefix range is walked backwards on
  the index and stops at page + offset rows, whatever the prefix length. No minimum
  length. The plan test covers a realistic prefix (`PO-2026-27-0012`) and the short one
  (`PO-2026-27-`) for the Buyer and Admin scopes, both committed, both bounded.
  - Text order equals number order while a financial year stays below 1,000,000 orders
    (6-digit sequences). Past that, 7-digit numbers sort among the 6-digit ones in text
    order. ADR-0012's production dataset is 100k orders in total, so this is recorded in
    ADR-0007 with a revisit condition, not engineered around now.
  - Alternatives: creation order with a top-N sort of all matches (reads every match for
    a short prefix); a minimum prefix length (rejected by the owner).
- **Counts**: `COUNT(*)` with the same predicate, served by the same index
  (index-only where the visibility map allows).
- **What the plan tests found, and the query now does** (2026-11-13, `orders.plan.test.ts`):
  - *Deferred join*: the page picks only its sort keys (`created_at, id`, or `po_number`)
    by an index-only scan, cut at `LIMIT … OFFSET`, then joins back for the page's rows.
    Selecting whole rows, PostgreSQL chose a bitmap scan and a sort of every match at deep
    pages (the busiest Buyer's 2,500 orders).
  - *A cut per branch*: a scope of several branches (Buyer+Approver, Approver) unions
    branches each `ORDER BY … LIMIT offset+limit` on its own index; uncut, PostgreSQL
    appended the union and sorted every order of the caller's instead of merging.
  - *Page bounds as literals*: `LIMIT` and `OFFSET` are checked integers written into the
    SQL, so a generic plan sees the page size (as parameters, it read the whole table to
    join back).
  - *Rows and total in one statement*: `SELECT (count) AS total, (json_agg over the page)
    AS items`, one snapshot, like `getOrder`.
  - *Counts* read only the rows they count: a count of nearly every order may read the
    table itself, which reads only matches too.
  - *Combined filters* (status and vendor) stop at page 1 but, at a deep page, sort the
    leading filter's matches (one vendor's or one Buyer's orders): no index holds both
    columns. Every single filter and every scope stops at the page at page 100.
- **Line count per row**: one `SELECT order_id, count(*) … WHERE order_id = ANY($page_ids)
  GROUP BY order_id` per page, on `(order_id, position)`. Not stored: another derived
  value to guard and reconcile for a display number.
- **Plan tests** (as slice 2's R11): `backend/tests/plans/orders-fixture.ts` seeds, as
  the superuser with row triggers off and then `ANALYZE` at full sample:
  - 2,000 vendors (top 20 ≈ 30 % of orders), 300 buyers (top 10 ≈ 25 %), one Admin
  - **100,000 orders and about 1,000,000 lines** (1 % of orders with 200–500 lines, the
    rest 1–15), all `DRAFT` (the only state that exists), totals and open-line counts
    computed by the seed's `INSERT … SELECT` and checked by the reconciliation query
    before planning
  - about 2M audit entries, 300k of them order entries
  `orders.plan.test.ts` asserts, for every list scope × each single filter, both prefix
  lengths, two combined filters, page 1 and page 100, and each `COUNT`: no `Seq Scan` on
  `purchase_orders`, `order_lines` or `audit_entries`, no sort over more than page +
  offset rows, no index scan discarding more than that. `npm run
  plans:orders` writes `EXPLAIN (COSTS OFF)` shapes to `docs/query-plans/orders/`; the
  `plans` workflow checks drift, as for vendors.
- **Timeline**: `listEntityHistory('ORDER', id)` from slice 2 on
  `audit_entries_entity_idx`; plan committed for the busiest order (500 lines, 50
  entries) and a page-1/count pair.

## R8 Order-write body limit (owner direction 5)

- **Decision**: **4 MiB** (`ORDER_BODY_LIMIT_BYTES = 4 * 1024 * 1024`) for `POST /orders`
  and `PATCH /orders/:id`; every other route keeps `BODY_LIMIT_BYTES` (1 MiB). nginx gets
  a `location ~ ^/api/orders(/[^/]+)?$` with `client_max_body_size 4m`, and `/api/`
  drops from `2m` to `1m`, so each nginx limit **equals** the API limit for its routes; a
  test reads `deploy/nginx/default.conf` and pins both values to the constants.
- **Sizing, from the max-order test** (`order-body-limit.test.ts`): 500 lines, each
  `{"id":"<uuid>","description":"<500 × U+1F600>","quantity":1000000,
  "unitPrice":"999999999.9999"}` plus the vendor id:
  - sent as raw UTF-8 (what `JSON.stringify` and the web app send): 4 bytes a character,
    about 2,110 bytes a line, **about 1.06 MB**: already over 1 MiB
  - sent with every character escaped as a surrogate pair (`😀`, valid JSON a
    client may emit): 12 bytes a character, **about 3.06 MB**
  4 MiB fits both, with room for pretty-printed whitespace. The test sends both forms
  through the API and through nginx in the compose smoke stack (201 each), and a body one
  byte over 4 MiB (413 `PAYLOAD_TOO_LARGE` from each layer).
- **Parsed only after authentication** (owner direction, 2026-11-12): the parser is
  per route, not global. The chain stays slice 0's `authenticate` (401 → CSRF → `403
  NO_ROLE_ASSIGNED` → `403 FORBIDDEN`), then the operation's body limit by
  `Content-Length` (413), then parsing. The limit becomes a field of the operation
  contract (`bodyLimitBytes`, default `BODY_LIMIT_BYTES`), so the two order writes declare
  `ORDER_BODY_LIMIT_BYTES` and nothing else changes. A request refused before its body is
  parsed (401, 403, 413) is answered with `Connection: close` and the body is not drained:
  today's refusal path calls `req.resume()`, which reads and discards it.
  - Test (`order-body-limit.test.ts`): a raw `http.request` sends `POST /api/orders` with
    `Content-Length: 4194304` and the first 1 KiB only, with no session (and again with a
    session but no CSRF token, and as an Admin); the `401` (`403`, `403`) arrives while
    the client is still holding the rest, with `Connection: close`, and the socket closes
    without the server having read more than the first chunk (asserted by the bytes the
    server's socket reports read).
- **Rationale**: a valid order must never fail on how its client encodes JSON; the larger
  limit applies only to two authenticated, CSRF-protected Buyer routes, so the public
  routes keep 1 MiB. nginx matching the API (owner direction) means an oversized body is
  refused at the edge without a correlation id, which is acceptable for a 413.
- **Alternatives**: 2 MiB (fits raw UTF-8 only; an escaping client fails on a valid
  order); 4 MiB everywhere (larger surface on unauthenticated routes).

## R9 Description and other field rules (owner clarification, 2026-11-12)

- **Description**: trimmed, then: 1–500 Unicode code points (`[...s].length`, not
  `s.length`, which counts UTF-16 units); no control characters (`/\p{Cc}/u`, which
  includes `\t`, `\n`, `\r`); well-formed Unicode (`s.isWellFormed()`), so a lone
  surrogate from an escaped JSON string is refused with `400 INVALID_FORMAT` instead of
  failing in PostgreSQL. Database: `CHECK (description = btrim(description) AND
  char_length(description) BETWEEN 1 AND 500 AND description !~ '[[:cntrl:]]')`
  (`char_length` counts code points in UTF-8), each value pinned to its constant by a
  test.
- **Quantity**: JSON integer 1–1,000,000. **Unit price**: a decimal **string**
  (`"12.5"`, `"0"`), 0–999,999,999.9999, at most 4 places, no exponent, no sign; a JSON
  number is refused (`INVALID_FORMAT`), so no float ever parses a price.
- **Delete reason**: optional; plain text, 1–500 code points, well-formed; line breaks
  allowed (a reason can be a short paragraph), every other control character refused;
  `null` or absent for none; `""` → `TOO_SHORT`.

## R10 Order reads and responses

- `GET /orders/:id`: `{ id, poNumber, status, vendor: { id, name, status }, owner: { id,
  name }, total, lineCount, lines: [{ id, description, quantity, unitPrice, lineTotal }],
  version, createdAt, updatedAt }`, `ETag`. Lines in position order; `position` itself
  isn't exposed (array order is the order).
- List item: `{ id, poNumber, status, vendor: { id, name }, owner: { id, name }, total,
  lineCount, createdAt }`.
- Timeline item: slice 2's history item shape (`occurredAt, actor, actingRole, action,
  details`).
- Response money fields are `Money` strings with 4 places (`"0.3000"`).

## R11 Authorization: what this slice touches in ADR-0004 (owner direction 6)

Cells this slice exercises that are **already in the matrix** (tested, no change): create
(Buyer ✓, Approver 403, Admin 403, no role 403 `NO_ROLE_ASSIGNED`); read draft (owner ✓,
other Buyer 404, Approver 404, Admin ✓); edit and delete (owner ✓, other Buyer 404,
Admin 403); lists (own / readable / all); timeline (own / readable / all).

**Cells the matrix didn't define, approved by the owner on 2026-11-12 and written into
ADR-0004**:
1. **Timeline of a deleted draft**: Admin ✓ by order id; former owner 404; everyone else
   404. (Spec clarification C, 2026-11-12; the matrix row "Order audit timeline: own
   orders" doesn't say whether a deleted draft is still "own".)
2. **Order list for a Buyer+Approver**: the union of their own orders (any state) and
   every non-draft order, in one list. ADR-0004 notes slice 4 revisits it with the
   approval queue.
3. **Admin create, edit and delete**: `403 FORBIDDEN` at route level, before validation,
   never `NOT_ORDER_OWNER`, with the message "Admins can view orders but not change
   them." (`ORDER_ADMIN_READ_ONLY_MESSAGE` in the contracts): the API puts it in the
   problem's `detail` when the caller holds ADMIN and not BUYER, and the web app shows the
   same constant for `FORBIDDEN` on an order write when the signed-in user is an Admin.
   Clients still branch on `code` only.

**No new cell for the vendor dialog's draft count**: the dialog calls the existing order
list with `vendorId` and `status=DRAFT`, `pageSize=1`, and reads `total`; a Buyer's list
scope is their own orders, so the count is exactly "the caller's drafts using this
vendor", with no new endpoint or permission.

## R12 Web app

- Routes: `/orders` (list, filters in the URL), `/orders/new`, `/orders/:id` (detail +
  timeline tab), `/orders/:id/edit`. Buyers see "New order"; Admins see the list and
  detail read-only; Approvers see an empty list with an explanation until slice 4.
- Editor: TanStack Virtual (chosen in ADR-0018, first installed now:
  `@tanstack/react-virtual@3.14.23`, released 2026-10-26) for the line table; one
  form state; row-level Zod validation from the contracts; live line totals and total via
  `money.ts` (R1), never `number`.
- `DeleteDraftDialog` on the shared `ConfirmDialog` with the clarified wording; the
  vendor deactivate dialog gains the draft count (R11).
- An `Idempotency-Key` per create attempt, reused on retry (ADR-0018).
