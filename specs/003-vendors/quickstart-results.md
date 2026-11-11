# Quickstart results: Slice 2 — Vendors

Run 2026-11-11 against a clean stack: a throwaway env file from `.env.example` with random
secrets (`scripts/ci-env.sh`, `SEED_DEMO_DATA=true`, `SIGNUP_ALLOWED_DOMAINS=example.local`),
`docker compose up -d --build --wait` as an isolated compose project (`po-qs`, image tag
`qs`, ports 28080 and 28025, removed with its volumes afterwards and the env file deleted),
so the default stack was never touched. Steps 1–6 were driven over HTTP through `web`
(`/api`), Mailpit's API and `docker compose exec api` (operator CLI for the Admin). The
browser-only parts are covered by `frontend/e2e/vendors.spec.ts` (4 passed the same day).

**Result: 36 checks, 0 failed.** `api`, `db`, `mailpit` and `web` healthy; `maintenance`
running. Setup: Admin set-password from the `admin:create` link → 204; no-role user signup
→ 202, verify from the Mailpit link → 204, login → 200.

| Step | Checked | Result |
|---|---|---|
| Demo seed | `status=ALL` → 200 with the five demo vendors: Acme Supplies NET 30, Bright Office Goods ADVANCE, Coastal Logistics PARTIAL_ADVANCE (40 %, 45 days), Delta Packaging NET 60 with no phone, Evergreen Stationers INACTIVE (the only inactive one); default list → 200, 4 vendors, no Evergreen | Pass |
| 1. US1 add, search, duplicate | Buyer A creates "Quickstart Supplies", NET 30, no phone → 201, `ETag: "1"`, `Location`, `contactPhone` null, email lower-cased; in Buyer A's list; Buyer B `q=quick` → 200, the one vendor; `q=acm` → 200, Acme Supplies; "  QUICKSTART   supplies" → `409 DUPLICATE_VENDOR_NAME` with `existingVendor` = Quickstart Supplies; "  ACME   supplies" → `409 DUPLICATE_VENDOR_NAME` with `existingVendor` = Acme Supplies. Link in the form: `vendors.spec.ts` | Pass |
| 2. US1 validation | PARTIAL_ADVANCE 100 % → `400 VALIDATION_FAILED`, `body.paymentTerms.advancePercent` `OUT_OF_RANGE`; ADVANCE with `netDays` → `400 VALIDATION_FAILED`, `body.paymentTerms.netDays` `UNKNOWN_FIELD`; `contactPhone: ""` → `400 VALIDATION_FAILED`, `body.contactPhone` `TOO_SHORT` | Pass |
| 3. US2 stale edit, clear phone | both Buyers read v1 of "Quickstart Phone Co"; A clears the phone → 200, `ETag: "2"`; B saves with v1 → `409 VERSION_CONFLICT`; detail → `contactPhone` null; history `VENDOR_UPDATED` `contactPhone` `+1 (555) 010-2000` → `null`. "Changed by someone else" with Reload: `vendors.spec.ts` | Pass |
| 4. US3 deactivate, reactivate | deactivate with `"2"` → 200, INACTIVE, `deactivatedAt` set, `ETag: "3"`; gone from the default list, present under `status=INACTIVE`; again with `"2"` → `409 VERSION_CONFLICT`; with `"3"` → `409 INVALID_STATE_TRANSITION`; reactivate (Buyer B) with `"3"` → 200, ACTIVE, `deactivatedAt` null, back in the default list. Dialog on deactivate, none on reactivate: `vendors.spec.ts` | Pass |
| 5. US4 access | Approver list and detail → 200; Approver `POST /api/vendors` → `403 FORBIDDEN`, `PUT` and deactivate → `403 FORBIDDEN`; no-role user → `403 NO_ROLE_ASSIGNED`; anonymous → `401 UNAUTHENTICATED`. No write controls for the Approver: `vendors.spec.ts` | Pass |
| 6. US5 history | Buyer and Admin `GET …/history` → 200, four entries newest first: `VENDOR_REACTIVATED` (Demo Buyer Two), `VENDOR_DEACTIVATED`, `VENDOR_UPDATED`, `VENDOR_CREATED` (Demo Buyer One), every actor named; Approver → `403 FORBIDDEN`. No History tab for the Approver: `vendors.spec.ts` | Pass |
| 7. Automated checks | `npm test`: contracts 74, backend 792, frontend 294, scripts 94, all passed; lint, typecheck, format, ID ban clean; `npm run test:plans`: 4 passed; `npm run plans:vendors` twice: identical; `npm run e2e:local`: 33 passed, 1 skipped; `npm run check:traceability`: ok | Pass |

Notes:
- The demo seed already holds "Acme Supplies", so step 1 created "Quickstart Supplies" and
  used its prefix (`quick`) for the search and duplicate checks; the quickstart's own
  "acm" search and "  ACME   supplies" duplicate were also run against the seeded Acme.
- Step 1's vendor has no phone, so steps 3, 4 and 6 used a second vendor created with one
  ("Quickstart Phone Co"), which gives exactly the four history entries step 6 expects.
- Step 2: the quickstart says only "field error on the percentage"; the code observed is
  `OUT_OF_RANGE`.
- Observed beyond the quickstart: `PUT` without `If-Match` → `400 VALIDATION_FAILED`; an
  Admin can list vendors (200) but `POST /api/vendors` → `403 FORBIDDEN`; `pageSize` above
  50 → `400 VALIDATION_FAILED`.
- Reconciliation: not run against this stack (the `psql` call used the wrong role and the
  stack was then torn down). In this slice `backend/src/db/reconciliation.sql` is
  `… WHERE false` with no invariants until slice 3, so it returns zero rows by construction;
  the migrations test runs it in `npm test`.
