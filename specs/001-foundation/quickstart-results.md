# Quickstart results (T115, SC-001, SC-008)

Run on 2026-10-27 from a clean clone of `001-foundation` at `1b3d2b9`, on Linux with
snap-packaged Docker (Compose v5.1.2) and Node 24.22.1.

## Timings

| Measure | Target | Result |
|---|---|---|
| Clean start, `docker compose up -d --build` until `web` is healthy | < 10 min | 74 s on this machine with a warm build cache (61 s first attempt + 13 s after the override below). CI's cold build, "Start the stack" in run [40505663166](https://github.com/Sumeetg2000/purchase-order-management/actions/runs/40505663166): 64 s |
| CI wall time on the pull request | < 15 min | 2 min 42 s, run [40505663166](https://github.com/Sumeetg2000/purchase-order-management/actions/runs/40505663166), every job green |

## Steps

| Step | Result |
|---|---|
| 1. Start the stack | The first `up` failed: `migrate` exited 255 with `exec …: operation not permitted`, the snap-Docker case in Troubleshooting. With its `docker-compose.override.yml`, every service started: migrate exited 0; db, api, web and mailpit were healthy; maintenance was running. `healthz`, `readyz`, the app shell, Mailpit (200), `/metrics` → 404 at the edge and the internal metrics all matched. With db stopped, `readyz` was 503 `SERVICE_UNAVAILABLE` and `healthz` 200. |
| 2. First admin | One set-password link on the first run. After `--force-recreate migrate`, the new run's output had **0** links, which is correct (nothing is created or printed again); the quickstart said "still 1" and is fixed. `admin:create` printed a link and exited 0; the repeat exited 2 with `EMAIL_IN_USE`. |
| 3. Errors and correlation | POST `/api/healthz` → 404 `NOT_FOUND` with a correlationId; `X-Request-Id: demo-req-0001` echoed in the header, body and the API log; a foreign `Origin` → 403 `CSRF_REJECTED`. |
| 4. Configuration refusals | migrate exited 1 naming `SEED_DEMO_DATA`. `docker compose run --rm api` exited 1 without reaching the API, because it starts migrate first, which refuses the production settings. The quickstart now uses `--no-deps`, with which the API exits 1 naming `SMTP_HOST` (and the change-me `DATABASE_URL`). |
| 5. Developer inner loop | `npm run dev` (T111): readiness ready through the Vite proxy; production headers plus the dev nonce; no CSP violations in headless Chromium; the API restarted on a source change; Ctrl-C left db and Mailpit running. |
| 6. Automated checks | lint, typecheck, check:ids, `npm test` (backend 344 + contracts 18 + frontend 53 + scripts 72), contract drift, build + bundle budget, `npm run e2e` (6 passed against the clone's stack) and check:traceability all passed. |
| 7. Audit guarantees | `npm test -w backend -- audit`: 52 tests passed. |
| 8. Mail and purge | `-- mail`: 27 passed; `-- purge`: 12 passed. `docker compose logs maintenance` showed the first run with per-table counts and "purge run complete". |

## Not done here

Branch protection on `main` (T117) is a manual GitHub settings step; it is recorded here
when done.
