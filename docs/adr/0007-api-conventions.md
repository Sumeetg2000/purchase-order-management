# ADR-0007: API conventions: pagination, errors, status codes

- **Status:** Accepted · 2026-10-16 · amended 2026-10-20 (validation order, field rules
  and the full status and code registry moved here from the constitution; `NO_ROLE_ASSIGNED`,
  access-request codes; `DUPLICATE_APPROVER` removed)
- **Brief:** §5, §6 · Gaps G1, G4 · Lessons 1, 5, 6
- **Principles:** VI

## Decision
- **Offset pagination** on every collection: `page` (1-based, default 1) and `pageSize`
  (default 20, max 50). Invalid values → `400 VALIDATION_FAILED`. Envelope
  `{ items, page, pageSize, total }`. Every list has a stable sort ending in `id`, backed by
  a matching index.
  - Why: simplicity and page-number navigation. If deep pages get slow (measured at page
    100 in `docs/perf/`), a keyset or hybrid mode can be added, and the envelope can gain
    `nextCursor` without breaking existing clients.
- **Errors**: RFC 9457 problem+json with a stable `UPPER_SNAKE_CASE` `code` and field-level
  `details[{path, code}]`. There is one code registry.
- **Statuses**: no 422.
  - Missing references (vendor id, line id) → `400 VALIDATION_FAILED` with field codes
    `VENDOR_NOT_FOUND` or `LINE_NOT_FOUND`.
  - Business-rule and state conflicts → `409`.
  - Identity-based refusals on an order → `403`.
- Malformed JSON → 400. Non-UUID path ids → 400. DB and ORM errors are mapped in one module
  by SQLSTATE, constraint or trigger name, and Prisma code (P2002, P2003, P2025, …). Code
  never matches on message text, and a lint rule or test guards this.

### Validation order (before any business logic)
1. Malformed JSON → `400`.
2. Strict schemas for path, query and body. Unknown fields are rejected, and path ids must
   be UUIDs.
3. Reference resolution (vendor id, line ids).

Field rules:
- `quantity`: an integer, 1–1,000,000
- `unit_price`: a decimal, 0 to 999,999,999.9999, with at most 4 places
- `description`: 1–500 characters
- an order has 1–500 lines, and the same line id may not appear twice
- withdraw, reject and cancel `reason`: plain text, 1–500 characters
- receipt `note`: plain text, 0–500 characters
- user `name`: 1–100 characters; `phone`: E.164 after normalisation (ADR-0016)
- access-request `message` and dismiss `note`: plain text, 1–500 and 0–500 characters
- every free-text field is stored and rendered as text, never HTML

Check precedence is in ADR-0004.

### Status and code registry
One registry module holds every code. Every endpoint documents its codes in the OpenAPI.
- `400 VALIDATION_FAILED`, with field codes:
  - `VENDOR_NOT_FOUND`, `LINE_NOT_FOUND`, `DUPLICATE_LINE_ID`, `READ_ONLY_FIELD`
  - `VERSION_REQUIRED`
  - `INVALID_PHONE`, `INVALID_ROLE_SET`
  - `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG`, `PASSWORD_TOO_COMMON`, `INCORRECT_PASSWORD`
- Other `400` codes: `SIGNUP_DOMAIN_NOT_ALLOWED`, and `INVALID_TOKEN` (an invalid, expired,
  used or superseded one-time token, all indistinguishable).
- `401`:
  - `UNAUTHENTICATED`
  - `INVALID_CREDENTIALS`: one response for an unknown email, a wrong password, a missing
    password hash, and an unverified, deactivated or locked account
  - `SESSION_EXPIRED`: idle or absolute limit reached
  - `SESSION_REVOKED`
- `403`:
  - `FORBIDDEN`, `NO_ROLE_ASSIGNED`
  - `NOT_ORDER_OWNER`, `SELF_APPROVAL`
  - `CSRF_REJECTED`: a missing or wrong CSRF token, or a disallowed `Origin`
- `404 NOT_FOUND`.
- `409`:
  - `ORDER_LOCKED`, `INVALID_STATE_TRANSITION`, `VERSION_CONFLICT`
  - `ORDER_NOT_RECEIVABLE`, `ORDER_FULLY_RECEIVED`, `RECEIPT_EXCEEDS_OUTSTANDING`
  - `VENDOR_INACTIVE`, `DUPLICATE_VENDOR_NAME`
  - `IDEMPOTENCY_KEY_REUSED`
  - `ADMIN_NOT_MODIFIABLE`, `SELF_MODIFICATION`, `USER_UNVERIFIED`
  - `ACCESS_REQUEST_NOT_OPEN`
- `429 RATE_LIMITED`, with `Retry-After`.
- `500 INTERNAL_ERROR`, with no internal details.
- `503 SERVICE_UNAVAILABLE`, `CONCURRENCY_RETRY_EXHAUSTED`.
- The problem body carries `code`, `title`, `status`, `detail`, `correlationId` and an
  optional `details`.

## Alternatives
Cursor-only pagination (more scalable, but no page numbers); the `{error:{…}}` format
(equivalent, but problem+json is a standard).

## Tests
Page boundaries, defaults, max, invalid values, sort stability with equal timestamps;
malformed JSON → 400; bad UUID → 400; unknown errors → 500 with no leak; every documented
code appears in the OpenAPI.
