# ADR-0013: Traceability, test naming and walkthrough answers

- **Status:** Accepted · 2026-10-16 · amended 2026-10-20 (data-integrity map, brief-clause
  check and coverage target moved here from the constitution) · amended 2026-10-23 (row
  status rules for the CI check)
- **Brief:** all; §7 · Gaps G8, G21 · Lesson 10
- **Principles:** X, XI

## Decision
- Requirement IDs (`FR-<AREA>-NN`, `NFR-<AREA>-NN`) appear in `it`/`describe` names only.
  IDs on a describe apply to its tests.
- IDs are banned in production source, comments and commit subjects, and allowed in PR
  descriptions. A lint check (`\bT\d{3}\b`, `\bN?FR-[A-Z]+-\d+\b`, plus an allowlist; tier
  names like T1/T2 are not flagged) and commitlint enforce this.
- The CI check reads the runner's JSON report. Only passing tests satisfy a requirement.
  Unknown IDs in test names fail. A requirement → tests listing is uploaded as an artifact.
- The §7 walkthrough questions trace to `docs/walkthrough.md` answers, not tests.
- `docs/data-integrity.md` answers "where is this enforced?" for each invariant.
- CI fails if a section of `docs/BRIEF.md` (§1–§8) has no row in `docs/traceability.md`.
- **Row status drives the test check**, so it works from the first slice:
  - `Todo` (not started) and `Spec` (specified in a slice): not checked for tests.
  - `Tested` (tests written, failing): at least one test must carry the ID.
  - `Done`: at least one passing test must carry the ID.
  - A row delivered across several slices stays below `Done` until its last part lands.
    A slice is done when every row it delivers fully is `Done`.
- `docs/BRIEF.md` is kept unchanged. A change to it is a scope change, reviewed like an
  amendment.
- Coverage of the domain and service layer is at least 90% of lines and branches.
