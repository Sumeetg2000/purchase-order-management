# Errors: Slice 3 — Draft orders

## Registry additions (`packages/contracts/src/errors.ts`)

| Code | Status | When | Message (web app) |
|---|---|---|---|
| `IDEMPOTENCY_KEY_REUSED` | 409 | A create replays a key with a different body | "This request was already used for a different order. Start a new order." |

## Field codes added

| Field code | Where |
|---|---|
| `LINE_NOT_FOUND` | `lines[i].id` names a line not on this order |
| `DUPLICATE_LINE_ID` | `lines[i].id` repeats an earlier line's id |
| `READ_ONLY_FIELD` | a derived or system-assigned key in a body (`ORDER_READ_ONLY_FIELDS`) |

Existing codes used: `VENDOR_NOT_FOUND` (field), `VENDOR_INACTIVE`, `VERSION_CONFLICT`,
`VERSION_REQUIRED` (field), `NOT_FOUND`, `FORBIDDEN`, `NO_ROLE_ASSIGNED`,
`PAYLOAD_TOO_LARGE`, `REQUIRED`, `INVALID_FORMAT`, `TOO_SHORT`, `TOO_LONG`,
`OUT_OF_RANGE`, `UNKNOWN_FIELD`.

## Order of checks (ADR-0004 precedence, ADR-0007 validation order)

1. `401` → CSRF → `403 NO_ROLE_ASSIGNED` → `403 FORBIDDEN` (route role list; for an
   Admin on an order write, `detail` = `ORDER_ADMIN_READ_ONLY_MESSAGE`). Nothing of the
   body has been read yet; these refusals close the connection.
2. body size by `Content-Length` (`413`, 4 MiB on order writes) → malformed JSON → schema (`READ_ONLY_FIELD`
   before `UNKNOWN_FIELD`), headers (`Idempotency-Key`, `If-Match`) → `400`
3. transaction: idempotency key (replay or `409 IDEMPOTENCY_KEY_REUSED`) → lock order →
   `404` if not readable → order-level `403` (none reachable for drafts) → `409
   VERSION_CONFLICT` → line ids (`400 LINE_NOT_FOUND`, `DUPLICATE_LINE_ID`) → vendor
   (`400 VENDOR_NOT_FOUND`, `409 VENDOR_INACTIVE`)

Line-id and vendor reference checks need the locked rows, so they run inside the
transaction but before any write (ADR-0007 step 3, "reference resolution").

## Database errors (`backend/src/db/errors.ts`)

| SQLSTATE | Name | Maps to |
|---|---|---|
| `PO005` | `DERIVED_VALUE_READ_ONLY` | `INTERNAL_ERROR` |
| `PO006` | `ORDER_LINES_LOCKED` | `INTERNAL_ERROR` |
| `PO007` | `ORDER_WITHOUT_LINES` | `INTERNAL_ERROR` |
| `PO008` | `ORDER_FIELD_IMMUTABLE` | `INTERNAL_ERROR` |
| `PO009` | `ORDER_STATUS_TRANSITION_REFUSED` | `INTERNAL_ERROR` |
| `PO010` | `ORDER_DELETE_REFUSED` | `INTERNAL_ERROR` |
| `PO011` | `PO_NUMBER_UNASSIGNED` | `INTERNAL_ERROR` |

Each means the service let through something it should have refused, so it is logged as
a bug. The integrity suite asserts the SQLSTATE directly on raw SQL.
