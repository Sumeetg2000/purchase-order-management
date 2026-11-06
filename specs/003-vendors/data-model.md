# Data model: Slice 2 — Vendors

Migration `0011_vendors` (one migration). Every number below is a named constant in
`packages/contracts/src/vendors.ts`; a test pins each SQL copy to it (research R13).

## Table `vendors`

| Column | Type | Rule |
|---|---|---|
| `id` | `uuid` PK | `DEFAULT gen_random_uuid()`; never written by the app |
| `name` | `text NOT NULL` | trimmed by the API; `CHECK (char_length(name) BETWEEN 1 AND 200)` |
| `name_key` | `text COLLATE "C"` generated, stored | `lower(btrim(regexp_replace(normalize(name, NFC), '[<WS>]+', ' ', 'g')))`, where `<WS>` is JavaScript's `\s` set spelled out (PostgreSQL's `\s` misses the no-break space); `CONSTRAINT vendors_name_key_key UNIQUE (name_key)` |
| `contact_name` | `text NOT NULL` | `CHECK (char_length BETWEEN 1 AND 200)` |
| `contact_email` | `text NOT NULL` | `CHECK (contact_email = lower(contact_email) AND char_length <= 254)`; not unique |
| `contact_phone` | `text NULL` | `NULL` = no phone; `CHECK (contact_phone ~ '^[0-9 +()-]{1,30}$' AND contact_phone ~ '[0-9]')`, so `''` is refused |
| `payment_term_type` | `text NOT NULL` | `CHECK IN ('NET', 'ADVANCE', 'PARTIAL_ADVANCE')` |
| `net_days` | `smallint NULL` | see terms check |
| `advance_percent` | `smallint NULL` | see terms check |
| `status` | `text NOT NULL DEFAULT 'ACTIVE'` | `CHECK IN ('ACTIVE', 'INACTIVE')` |
| `deactivated_at` | `timestamptz NULL` | `CHECK ((status = 'INACTIVE') = (deactivated_at IS NOT NULL))` |
| `version` | `integer NOT NULL DEFAULT 1` | `CHECK (version >= 1)` |
| `created_at`, `updated_at` | `timestamptz NOT NULL DEFAULT now()` | `updated_at` by the existing `set_updated_at()` trigger |

Terms check `vendors_payment_terms_valid` (wrapped in `coalesce(…, false)`, so a missing
number is refused rather than passing as `NULL`):
- `NET`: `net_days BETWEEN 0 AND 180 AND advance_percent IS NULL`
- `ADVANCE`: `net_days IS NULL AND advance_percent IS NULL`
- `PARTIAL_ADVANCE`: `advance_percent BETWEEN 1 AND 99 AND net_days BETWEEN 0 AND 180`

Indexes:
- `vendors_name_key_key` (unique, from the constraint): the `ALL` filter's sort and prefix.
- `vendors_status_name_key_idx (status, name_key, id)`: the default `ACTIVE` list, the
  `INACTIVE` filter, prefix within a status, and their counts.

Triggers and privileges:
- `require_actor_context` (existing function) `BEFORE INSERT OR UPDATE OR DELETE OR
  TRUNCATE … FOR EACH STATEMENT`: no vendor change without an actor.
- `vendors_set_updated_at` `BEFORE UPDATE … FOR EACH ROW`.
- `po_app`: `SELECT`, `INSERT (name, contact_name, contact_email, contact_phone,
  payment_term_type, net_days, advance_percent)`, `UPDATE (name, contact_name,
  contact_email, contact_phone, payment_term_type, net_days, advance_percent, status,
  deactivated_at, version)`. No `DELETE` or `TRUNCATE`: vendors are never deleted.
  `po_maintenance`: nothing.

State transitions (`status`): `ACTIVE → INACTIVE` (deactivate), `INACTIVE → ACTIVE`
(reactivate). Any other request → `409 INVALID_STATE_TRANSITION`. Edits allowed in both.

## Index on `audit_entries`

`audit_entries_entity_idx (entity_type, entity_id, occurred_at DESC, id DESC)`: vendor
history now, order timelines (slice 3) and the Admin log's entity filter later.

## Audit events (`backend/src/audit/events.ts`)

`entityType: 'vendor'`, `entityId`: the vendor id. `VendorSnapshot` = `{ name,
contactName, contactEmail, contactPhone, paymentTerms, status }` (full contact details,
ADR-0016 amended 2026-11-06).

| Action | Details |
|---|---|
| `VENDOR_CREATED` | `{ before: null, after: VendorSnapshot }` |
| `VENDOR_UPDATED` | `{ before: VendorSnapshot, after: VendorSnapshot }`; every accepted edit writes one and moves the version, even a save with no change |
| `VENDOR_DEACTIVATED` | `{ before: VendorSnapshot, after: VendorSnapshot }` |
| `VENDOR_REACTIVATED` | `{ before: VendorSnapshot, after: VendorSnapshot }` |

The acting role is `BUYER` (a Buyer who is also an Approver acts as Buyer here).

## Snapshot for orders (FR-012)

`VendorSnapshot` without `status`, plus `id`: the value `requireActiveVendor` returns and
the order stores on submit (slice 4). Payment terms keep the API's union shape.

## Demo seed

With `SEED_DEMO_DATA=true` (never in production): five vendors, at least one per payment
term type, one inactive, one without a phone; created as `SYSTEM`.
