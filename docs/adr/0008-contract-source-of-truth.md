# ADR-0008: Zod-first contract, generated OpenAPI

- **Status:** Accepted · 2026-10-16 · amended 2026-11-03 (error and field codes published as
  `x-extensible-enum`, found while implementing slice 1)
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
- **Error and field codes are extensible** (amended 2026-11-03): the `ErrorCode` and field
  code enums are published as `x-extensible-enum`, not `enum`. Codes grow with every
  slice, and a client must handle a code it doesn't know: the web app shows the
  internal-error message for one. oasdiff counts a value added to a response `enum` as
  breaking (`response-property-enum-value-added`), so with plain enums every slice that
  adds a code would need the `breaking` label. Validation in code still accepts only the
  registry's codes.
- Contract gate: Zod schemas and the OpenAPI diff are reviewed before any service code.

## Alternatives
OpenAPI-first YAML (generated validators are weaker at strict decimal and cross-field
rules); two hand-written sources with a checker between them.
