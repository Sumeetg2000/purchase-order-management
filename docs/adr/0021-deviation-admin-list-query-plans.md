# ADR-0021: Deviation: admin-list query plans deferred to slice 7

- **Status:** Accepted (deviation) · 2026-11-03 (POC scope, owner decision)
- **Brief:** §6 ("filter and paginate without loading everything")
- **Principles:** VII

## Principle and rule
Principle VII: "Every list and report MUST have a committed query plan, page and `COUNT`,
at the recorded dataset sizes." ADR-0012 records 10,000 users for the admin user list.

## Scope
Slice 1's two admin lists: `GET /api/admin/users` and `GET /api/admin/access-requests`.
Nothing else: every other list keeps the rule in the slice that adds it.

## Decision
Slice 1 ships the lists with `LIMIT`ed SQL, filters in SQL and the indexes of ADR-0016,
but without the 10,000-user seed or the committed `EXPLAIN (ANALYZE, BUFFERS)` output.
Slice 7 ("outstanding report, load tests and query plans") builds the plan tooling and
commits the plans for these two lists with the others, including SC-008 (first page under
200 ms at 10,000 users).

## Reason
For a proof of concept, a dedicated user seed and plan tooling for two admin lists cost
more in slice 1 than they prove; the user table stays small until then, and slice 7
builds the same tooling for the order lists anyway.

## Rejected alternative
Building the seed and plan tooling now (the original slice 1 plan, research R13): the
same work, done twice in different shapes.

## Revisit condition
Closed when slice 7 commits the page and `COUNT` plans for both lists at the ADR-0012
user dataset, with a test that fails on a sequential scan. Slice 7 may not merge with
this deviation open.
