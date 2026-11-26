# Quickstart results: Slice 7 — Outstanding orders report, load tests and query plans

Run 2026-11-26 against a clean, isolated stack: the e2e compose project (`po-e2e`, a
throwaway env file from `scripts/ci-env.sh` with `SEED_DEMO_DATA=true`), removed with its
volumes afterwards. Scenarios 1–5 were driven over HTTP through the TLS edge as the demo
Buyers, the Demo Approver, an Admin made with the operator CLI and a verified no-role
sign-up; the driver is kept locally (`.local/quickstart/`, not committed). Scenarios 6–10
cite the slice's own runs.

**Result: 24 API checks, 24 passed, on the first run**, plus the recorded load run, the
plan suites and the gate below.

| # | Checked | Result |
|---|---|---|
| 1. Report contents | the Admin's report on the demo data: exactly each demo Buyer's partly received approved order (one open line, one unit outstanding), not the fully received or cancelled ones; `asOf` today's India date; age 0, band 0–30 | Pass |
| 2. Receipts move it | Demo Buyer One receives the last unit → `201`; the order leaves the Admin's report (2 → 1) and Buyer One's summary (1 → 0) | Pass |
| 3. Filters | by vendor, by band (0–30 keeps both, over 90 is empty), both; a vendor with nothing outstanding → `200`, empty; `ageBucket=SOON` and `vendorId=x` → `400 INVALID_FORMAT`; `colour=red` → `400 UNKNOWN_FIELD`, each naming the field | Pass |
| 4. Scope | each demo Buyer sees only their own; the Approver and the Admin see both; no role → `403 NO_ROLE_ASSIGNED`; anonymous → `401` | Pass |
| 5. Vendor summary | the Admin's: one row per vendor with anything outstanding, its counts per band adding up to its orders, oldest approval today; a Buyer's counts only their own | Pass |
| 6. Ages | the recorded load run spread ages over 0–180 days through the guarded age shift (`po-load` only) and planned the over-90 band on them; the band boundaries (30, 60, 90 days; 23:50 India time) are pinned by `backend/tests/integration/reports-outstanding.test.ts` with an injected clock | Pass |
| 7. Load test | `npm run load`, recorded in `docs/perf/load-run.md`: 10,000 orders, 200 vendors, 12,612 receipts in 2 min 36 s; 35,054 responses, no 5xx, no timeout; report and summary p95 9–17 ms (targets 200 and 300 ms); reconciliation 0 rows after the shift and at the end; all 31 unused indexes in the expected list, each with its reason | Pass |
| 8. Plans | `test:plans`: orders 9 (report and summary at 100,000 orders), timing 7 (report 11 ms, summary 22 ms), users plan 5 and timing 1 (admin lists at 10,000 users, accepted scans in ADR-0012); plans committed under `docs/query-plans/orders/`, `admin/` and `load/` | Pass |
| 9. Walkthrough | `npm run check:walkthrough`: 48 paths, all present | Pass |
| 10. Gate | `npm run gate` (commit 2bb409d): contracts 146, backend 1,285, web 516, scripts 128, e2e 51 (the 3 report tests among them), formatting, walkthrough, no leaks; `check:traceability` ok | Pass |

**SC-004** (every outstanding order for a vendor older than 60 days, under 30 seconds from
opening the report): two choices in the web app, as the e2e drives it (an age band and a
vendor link), each answered in milliseconds; recorded as observed, not timed.

**SC-008**: axe found nothing on the Orders view (with filters and lines open) or the By
vendor view (e2e, Chromium; component tests).

## Slice-end review

- `/security-review`: no finding. Checked: every report value bound as a parameter
  (`Prisma.raw` only on constants and checked page numbers; the as-of date from the
  server's clock); the report's scope (a Buyer's own orders always, whatever the vendor
  filter; Approver and Admin see only approved orders, which they can already read); rows
  carry owner and vendor names only, no email; the access-request rewrite returns the same
  columns behind the same admin-only route; the load tooling's secrets stay in the
  environment of a throwaway stack; the nightly job has read-only permissions, pinned
  actions and no secrets.
- `/code-review`: two important findings, both fixed, test first:
  - the report's cached pages weren't refreshed by order actions (a fully received or
    cancelled order could linger up to 30 s): its keys now sit under the order lists'
    key, which every save, receipt, approval and cancel refreshes
  - an approval stamped by the database a few seconds past India midnight, before the
    API's clock, read as age −1 (breaking the contract): the age is now clamped at 0
  - five nits fixed: roles and the India time zone from the contract's constants (web and
    load script), band labels built from `AGE_BUCKET_UPPER_DAYS`, "Your orders" said only
    once the user is known, the load plan's as-of date read from the API right before its
    EXPLAIN, and its header says the values are inlined (the generic plan is checked at
    100,000 orders)
- Constitution pass: derived values only read (INV-3, INV-6), never recomputed or stored
  anew; every report path tested first against real PostgreSQL; layering holds (`reports/`
  routes → service → repository); new decisions in ADR-0012, ADR-0013 and ADR-0015; the one
  open deviation (ADR-0021) closed, none left open.
