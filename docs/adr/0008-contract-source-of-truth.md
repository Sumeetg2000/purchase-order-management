# ADR-0008: Zod-first contract, generated OpenAPI

- **Status:** Accepted · 2026-10-16
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
- Contract gate: Zod schemas and the OpenAPI diff are reviewed before any service code.

## Alternatives
OpenAPI-first YAML (generated validators are weaker at strict decimal and cross-field
rules); two hand-written sources with a checker between them.
