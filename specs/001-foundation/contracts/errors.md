# Error Code Registry — Slice 0

The registry lives in `packages/contracts/src/errors.ts`. ADR-0007 holds the full planned list.
Each slice adds the codes it uses, never earlier. Tests fail if code throws an unregistered
code, or if a registered code is missing from the generated OpenAPI `ErrorCode` enum.

| Code | Status | When (slice 0) | Field details |
|---|---|---|---|
| `VALIDATION_FAILED` | 400 | schema failure on path, query, header or body; malformed JSON; wrong content type | yes |
| `CSRF_REJECTED` | 403 | an API request carries an `Origin` other than `APP_ORIGIN`. ADR-0007 defines this code to cover a disallowed `Origin`; slice 1 adds the token check under the same code | no |
| `NOT_FOUND` | 404 | unknown route, or a method not defined on a known path | no |
| `PAYLOAD_TOO_LARGE` | 413 | body over 1 MB, refused before parsing | no |
| `INTERNAL_ERROR` | 500 | anything unexpected; the body never contains internal detail | no |
| `SERVICE_UNAVAILABLE` | 503 | pool exhausted, transaction timeout, readiness failing | no |
| `CONCURRENCY_RETRY_EXHAUSTED` | 503 | `40001`/`40P01` still failing after 3 retries | no |

Field codes used in slice 0 (inside `details[]` of `VALIDATION_FAILED`):

| Field code | Meaning |
|---|---|
| `MALFORMED_JSON` | the body isn't valid JSON (`path: "body"`) |
| `UNSUPPORTED_MEDIA_TYPE` | a body was sent without `application/json` (`path: "header.content-type"`) |
| `REQUIRED` | a required field is missing |
| `UNKNOWN_FIELD` | a field not in the schema (strict schemas) |
| `INVALID_FORMAT` | wrong type or format (e.g. not a UUID) |
| `TOO_SHORT`, `TOO_LONG`, `OUT_OF_RANGE` | length or range limits |

Database-level errors raised by triggers (`ACTOR_CONTEXT_REQUIRED` with SQLSTATE `PO001`,
`ACTOR_CONTEXT_MISMATCH` with `PO002`, mapped by SQLSTATE)
never reach a client as such. The central mapper turns them into `INTERNAL_ERROR` and logs
them, because they mean a code path forgot its actor context, which is a bug.

ADR-0007 update in this slice: add `413 PAYLOAD_TOO_LARGE` and the field codes
`MALFORMED_JSON` and `UNSUPPORTED_MEDIA_TYPE`.
