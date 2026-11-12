# ADR-0008: Zod-first contract, generated OpenAPI

- **Status:** Accepted · 2026-10-16 · amended 2026-11-03 (error and field codes published as
  `x-extensible-enum`, found while implementing slice 1) · amended 2026-11-12 (unread
  response fields removed, a breaking change taken under the one-client exception; every
  database-backed operation declares the database's 503 codes)
- **Brief:** §5 · Gap G12 · Lesson 1
- **Principles:** VI

## Decision
- Zod schemas in a shared `contracts` package are the single source. OpenAPI 3.1 is
  generated (zod-openapi) and committed, and CI fails on drift.
- Frontend types and client are generated from the committed OpenAPI (openapi-typescript).
- Every endpoint documents its error codes with status and the shared error schema.
- oasdiff compares against `main`. Breaking changes fail unless the PR is labelled breaking
  and explains why. That exception applies only while our frontend (regenerated in the same
  PR) is the only consumer. With any external client, use `/api/v2`.
- The check runs on pull requests only (amended 2026-11-12): main only changes through
  approved PRs and the PR run is the gate; a push run can't see the PR's label, so it would
  fail every approved breaking merge.
- **Error and field codes are extensible** (amended 2026-11-03): the `ErrorCode` and field
  code enums are published as `x-extensible-enum`, not `enum`. Codes grow with every
  slice, and a client must handle a code it doesn't know: the web app shows the
  internal-error message for one. oasdiff counts a value added to a response `enum` as
  breaking (`response-property-enum-value-added`), so with plain enums every slice that
  adds a code would need the `breaking` label. Validation in code still accepts only the
  registry's codes.
- **Unread response fields removed** (amended 2026-11-12, audit): `Me.status` (only an
  active user can read `/me`), `Vendor.createdAt` and `Vendor.updatedAt`, and the access
  request's `createdAt` and `decidedAt` (own and admin views). The admin view's
  `user.signedUpAt` is renamed `user.createdAt`, as `Me` names it. The vendor detail page
  now shows `deactivatedAt`. These are breaking changes, so the contract-breaking check
  reports them: expected, under the exception above, since our frontend is the only client
  and is regenerated in the same PR. The columns stay in the database (`decided_at` is
  still written on a dismissal).
- **Database failures are declared** (amended 2026-11-12, audit): every operation that
  reads or writes the database lists `SERVICE_UNAVAILABLE` and
  `CONCURRENCY_RETRY_EXHAUSTED` (ADR-0006) on its 503. Only liveness, which never reads it,
  and readiness, which declares its own `SERVICE_UNAVAILABLE`, opt out.
- Contract gate: Zod schemas and the OpenAPI diff are reviewed before any service code.

## Alternatives
OpenAPI-first YAML (generated validators are weaker at strict decimal and cross-field
rules); two hand-written sources with a checker between them.
