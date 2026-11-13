# Data model: Slice 3 — Draft orders

Migration `0013_orders` (one file, run as `po_owner`). Constants live in
`packages/contracts/src/orders.ts`; every SQL copy is pinned to its constant by
`backend/tests/integration/order-constants.test.ts` (CLAUDE.md).

## Table `po_number_counters` (research R2)

| Column | Type | Rule |
|---|---|---|
| `fy` | `text` PK | `CHECK (fy ~ '^\d{4}-\d{2}$')` |
| `last_value` | `bigint NOT NULL` | `CHECK (last_value >= 1)` |

Grants: `po_app` `SELECT, INSERT, UPDATE (last_value)`. Never deleted.

Function `po_financial_year(ts timestamptz) RETURNS text`: the April–March year of `ts`
in `Asia/Kolkata`, as `'2026-27'`. `STABLE` (time-zone data), `EXECUTE` to `po_app`.

## Table `purchase_orders`

| Column | Type | Rule |
|---|---|---|
| `id` | `uuid` PK | `DEFAULT gen_random_uuid()` |
| `po_number` | `text COLLATE "C"` | `UNIQUE`; `NULL` only inside the creating transaction (deferred check, R2); format `CHECK (po_number ~ '^PO-\d{4}-\d{2}-\d{6,}$')` |
| `owner_id` | `uuid NOT NULL` | FK `users(id)`; never changes (trigger) |
| `vendor_id` | `uuid NOT NULL` | FK `vendors(id)` |
| `status` | `text NOT NULL DEFAULT 'DRAFT'` | `CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','CANCELLED'))`; changes only per `order_status_transitions` (empty now) |
| `total` | `numeric(22,4) NOT NULL DEFAULT 0` | derived (INV-2); `CHECK (total >= 0)` |
| `open_line_count` | `integer NOT NULL DEFAULT 0` | derived (INV-6); `CHECK (open_line_count >= 0)` |
| `version` | `integer NOT NULL DEFAULT 1` | `CHECK (version >= 1)` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` | `set_updated_at()` trigger |

`approved_at` and the vendor snapshot columns arrive with slice 4.

Grants: `po_app` `SELECT`, `INSERT (owner_id, vendor_id)`, `UPDATE (vendor_id, version,
po_number)`, `DELETE`. No privilege on `total`, `open_line_count`, `status` (slice 4
grants `status`), `id`, timestamps.

## Table `order_lines`

| Column | Type | Rule |
|---|---|---|
| `id` | `uuid` PK | `DEFAULT gen_random_uuid()` |
| `order_id` | `uuid NOT NULL` | FK `purchase_orders(id) ON DELETE CASCADE` |
| `position` | `integer NOT NULL` | `CHECK (position BETWEEN 0 AND 499)`; `UNIQUE (order_id, position) DEFERRABLE INITIALLY DEFERRED` |
| `description` | `text NOT NULL` | `CHECK (description = btrim(description) AND char_length(description) BETWEEN 1 AND 500 AND description !~ '[[:cntrl:]]')` |
| `quantity` | `integer NOT NULL` | `CHECK (quantity BETWEEN 1 AND 1000000)` |
| `unit_price` | `numeric(13,4) NOT NULL` | `CHECK (unit_price >= 0)` (the type caps it at 999,999,999.9999) |
| `line_total` | `numeric(22,4)` | `GENERATED ALWAYS AS (quantity * unit_price) STORED` (INV-1) |
| `received_quantity` | `integer NOT NULL DEFAULT 0` | `CHECK (received_quantity BETWEEN 0 AND quantity)` (INV-4); written only by slice 6's receipt trigger |

Index: `(order_id, position)` (the unique constraint). Grants: `po_app` `SELECT`,
`INSERT (order_id, position, description, quantity, unit_price)`, `UPDATE (position,
description, quantity, unit_price)`, `DELETE`. No privilege on `line_total`,
`received_quantity`, `id`.

## Table `order_status_transitions`

`(from_status text, to_status text, PRIMARY KEY (from_status, to_status))`, empty in this
slice; `po_app` `SELECT` only. Slice 4 inserts T4/T5.

## Table `idempotency_keys` (research R5)

| Column | Type | Rule |
|---|---|---|
| `user_id` | `uuid NOT NULL` | FK `users(id)` |
| `operation` | `text NOT NULL` | `CHECK (operation IN ('createOrder'))`; slice 6 adds `recordReceipt` |
| `key` | `uuid NOT NULL` | |
| `request_hash` | `bytea NOT NULL` | SHA-256, `CHECK (octet_length(request_hash) = 32)` |
| `status` | `smallint` | `NULL` until the create succeeds in the same transaction |
| `response` | `jsonb` | as above |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | purged after 24 hours |

PK `(user_id, operation, key)`; index `(created_at)` for the purge. Grants: `po_app`
`SELECT, INSERT, UPDATE (status, response)`; `po_maintenance` `SELECT, DELETE`.

## Indexes on `purchase_orders` (research R7)

```text
purchase_orders_owner_created_idx         (owner_id, created_at DESC, id DESC)
purchase_orders_owner_status_created_idx  (owner_id, status, created_at DESC, id DESC)
purchase_orders_owner_vendor_created_idx  (owner_id, vendor_id, created_at DESC, id DESC)
purchase_orders_created_idx               (created_at DESC, id DESC)
purchase_orders_status_created_idx        (status, created_at DESC, id DESC)
purchase_orders_vendor_created_idx        (vendor_id, created_at DESC, id DESC)
purchase_orders_owner_po_number_idx       (owner_id, po_number)
purchase_orders_po_number_key             UNIQUE (po_number)   -- COLLATE "C" column
```

## Triggers and functions

| Name | On | Kind | Does |
|---|---|---|---|
| `require_actor_context` | `purchase_orders`, `order_lines` | before, statement | slice 0's actor check |
| `order_lines_recompute_ins/upd/del` | `order_lines` | after, statement, transition tables | refuse if any affected order isn't `DRAFT` (`PO006`); `recompute_orders(ids)` once (R3) |
| `recompute_orders(uuid[])` | — | `SECURITY DEFINER` | sets `po.recompute`, one set-based `UPDATE` of `total`, `open_line_count`; increments `po.recompute_count` |
| `purchase_orders_derived_guard` | `purchase_orders` | before update, row | `PO005 DERIVED_VALUE_READ_ONLY` without the flag |
| `purchase_orders_immutable` | `purchase_orders` | before update, row | `PO008` on `po_number` (except `NULL` → value), `owner_id`, `created_at` changes |
| `purchase_orders_status_transition` | `purchase_orders` | before update of `status`, row | `PO009` unless in `order_status_transitions` |
| `purchase_orders_delete_draft_only` | `purchase_orders` | before delete, row | `PO010` unless `DRAFT` |
| `purchase_orders_has_lines` | `purchase_orders` (insert), `order_lines` (delete) | constraint, deferred, row | `PO007` if the order exists with no line at commit (INV-5) |
| `purchase_orders_po_number_assigned` | `purchase_orders` (insert) | constraint, deferred, row | `PO011` if `po_number` is still `NULL` at commit |
| `purchase_orders_set_updated_at` | `purchase_orders` | before update, row | `set_updated_at()` |

New SQLSTATEs `PO005`–`PO011`, all `INTERNAL_ERROR` in `db/errors.ts` (a reached trigger
is a bug: the service checks first).

## Reconciliation query (`backend/src/db/reconciliation.sql`, run after every test on each test database and after every seed)

Test databases are dropped after each test, so the shared `afterEach` in
`backend/tests/support/setup.ts` runs the query on each tracked database before dropping
it and fails the test on any row (tasks T006).

Returns one row per violation, zero rows when consistent:
- INV-1: `line_total <> quantity * unit_price`
- INV-2: `total <> coalesce(Σ line_total, 0)`
- INV-4: `received_quantity < 0 OR received_quantity > quantity`
- INV-5: an order with no line
- INV-6: `open_line_count <> count(lines where received_quantity < quantity)`
- `po_number IS NULL`
INV-3 (receipts) joins in slice 6.

## Audit events (`backend/src/audit/events.ts`, ADR-0016)

| Action | Entity | `details` |
|---|---|---|
| `PO_CREATED` | `ORDER`, id | `vendor: { id, name }`, `lines: [{ id, description, quantity, unitPrice, lineTotal }]`, `total` |
| `PO_EDITED` | `ORDER`, id | `vendor: { before, after }` when changed; `lines: { added: [line], removed: [line], changed: [{ id, position?, description?, quantity?, unitPrice?, lineTotal? } as { before, after } per changed field] }`; `total: { before, after }` |
| `PO_DRAFT_DELETED` | `ORDER`, id | `poNumber`, `vendor`, `lines` (full), `total`, `reason` (or `null`) |

Every entry carries `order_id` and `po_number` columns, actor, `actingRole: BUYER`,
request id. Money in `details` is `Money` strings.

## Demo seed (`backend/src/migrate/seed-demo.ts`)

Per demo Buyer: three drafts (one with `0.1 × 1` three times, one with 20 lines, one
against a vendor that is then deactivated), through the service, so audit entries exist;
the reconciliation query runs after seeding.
