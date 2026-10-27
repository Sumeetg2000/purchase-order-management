# CI self-test record (T114, SC-004)

Run on 2026-10-27. The breaks branched from `001-foundation` at `c9d4371`, and the
coverage-floor break at `835a5ba`. The run on `c9d4371` was cancelled by the next push;
`835a5ba`, which adds only coverage settings, passed every job. Each break was a
throwaway draft PR to `main` from a `selftest/<check>` branch with one deliberate change.
Every PR was closed and its branch deleted after the run.
`gh pr list --state open --search "head:selftest/"` returns nothing.

`traceability` needs the test jobs' reports, so it is skipped whenever one of them fails.
That is expected and not counted as a second failure.

| Check | Break | Failed job (step) | Run |
|---|---|---|---|
| Style | blank lines in `backend/src/lib/uuid.ts` | static (format:check) | [40504435459](https://github.com/Sumeetg2000/purchase-order-management/actions/runs/40504435459) |
| Types | `const typeBreak: number = 'not a number'` in a unit test | static (typecheck) | [40504446235](https://github.com/Sumeetg2000/purchase-order-management/actions/runs/40504446235) |
| ID ban | a requirement ID in a source comment | static (Requirement-ID ban) | [40504459072](https://github.com/Sumeetg2000/purchase-order-management/actions/runs/40504459072) |
| Migration | migration `0007_selftest` with invalid SQL | api (backend tests) and e2e (Start the stack) | [40504472201](https://github.com/Sumeetg2000/purchase-order-management/actions/runs/40504472201) |
| Contract drift | `.describe()` on the health schema, document not regenerated | contract (contracts tests: `[NFR-API-01] generated OpenAPI document`) | [40504481955](https://github.com/Sumeetg2000/purchase-order-management/actions/runs/40504481955) |
| Traceability | a test citing an unknown ID | traceability | [40504493156](https://github.com/Sumeetg2000/purchase-order-management/actions/runs/40504493156) |
| Axe | `--color-text` lowered to #c8c8c8 (contrast) | e2e (End-to-end tests) | [40504506436](https://github.com/Sumeetg2000/purchase-order-management/actions/runs/40504506436) |
| Bundle | ~90k-number padding module imported by `main.tsx` | web (Bundle budget) | [40505814981](https://github.com/Sumeetg2000/purchase-order-management/actions/runs/40505814981) |
| Smoke | nginx's `location = /metrics { return 404; }` removed | e2e (Smoke test) | [40504534998](https://github.com/Sumeetg2000/purchase-order-management/actions/runs/40504534998) |
| Secrets | the AWS key fixture from gitleaks' `testdata/repos/nogit/main.go`, in a doc (not repeated here, or this file would fail the scan); confirmed locally with the pinned image first | secrets (gitleaks, pull request commits) | [40504546408](https://github.com/Sumeetg2000/purchase-order-management/actions/runs/40504546408) |
| Coverage floor (T118) | line floor raised to 95% (measured 90.31%) | api ("Coverage for lines (90.31%) does not meet global threshold (95%)") | [40504865037](https://github.com/Sumeetg2000/purchase-order-management/actions/runs/40504865037) |

Notes:
- **Migration** fails two jobs by design: `api` runs every migration from empty against
  Testcontainers, and `e2e` starts the stack, whose `migrate` service runs them too.
- **Bundle**: the first attempt also failed `static`, because the generated padding wasn't
  Prettier-formatted ([40504520710](https://github.com/Sumeetg2000/purchase-order-management/actions/runs/40504520710)). After formatting it, only `web` failed.
- **Breaking change without the label**: can't be exercised in CI yet. The check compares
  against the PR base, and `main` has no OpenAPI document until slice 0 merges, so it
  passes with "nothing to compare". It was run locally against `HEAD` with
  `checks.migrations` removed from the readiness response: exit 1
  (`response-required-property-removed`) without the label, and exit 0 with
  `BREAKING_LABEL=true` and a "Breaking change:" line. **Repeat this row as a CI
  self-test on the first PR after slice 0 merges.**
