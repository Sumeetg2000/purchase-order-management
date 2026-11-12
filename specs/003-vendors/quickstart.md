# Quickstart: Slice 2 — Vendors

Validation run for the slice; record results in `quickstart-results.md`.

## Prerequisites

- Node 24, Docker. `cp .env.example .env` with `SEED_DEMO_DATA=true`.
- `docker compose up` (production-like) or `npm run dev`.
- Demo users and password: see `specs/002-accounts-user-management/quickstart.md`.

## Automated

```bash
set -o pipefail; npm test 2>&1 | tail -40          # vendors, matrix, contract
npm run test:plans                                 # 2M-row plan tests (backend/contracts PRs, main, nightly)
npm run plans:vendors                              # rewrites docs/query-plans/vendors/*.txt
git diff --exit-code docs/query-plans/vendors       # EXPLAIN (COSTS OFF) shape: fails only on a real plan change
npm run e2e:local                                  # isolated po-e2e stack, all browsers
```

## Manual scenarios (map to spec user stories)

1. **US1** As Buyer A, add "Acme Supplies", NET 30, no phone → appears in the list. As
   Buyer B, search "acm" → found. Add "  ACME   supplies" → error with a link to Acme.
2. **US1** Try PARTIAL_ADVANCE with 100 % → field error on the percentage; ADVANCE with
   `netDays` via the API → `400 UNKNOWN_FIELD`; `contactPhone: ""` → `400 TOO_SHORT`.
3. **US2** Open the same vendor's edit form in two browsers; save in one, then the other →
   "changed by someone else" with Reload. Clear the phone → detail shows no phone, history
   shows `contactPhone` before → `null`.
4. **US3** Deactivate via the dialog → gone from the default list, present under `INACTIVE`;
   reactivate → back, no dialog. Deactivate twice via the API with the old ETag → `409
   VERSION_CONFLICT`; with the new one → `409 INVALID_STATE_TRANSITION`.
5. **US4** As the Approver: list and detail work, no write controls; `POST /api/vendors`
   → `403 FORBIDDEN`. As a no-role user → `403 NO_ROLE_ASSIGNED`. Anonymous → `401`.
6. **US5** As a Buyer or Admin, open History → four entries newest first with actor
   names; as the Approver → no History tab and `GET …/history` → `403`.

Expected: every step as stated; reconciliation query returns zero rows after the suite.
