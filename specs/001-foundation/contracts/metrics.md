# Internal Metrics Contract — Slice 0

- **Endpoint**: `GET /metrics` on the API's second listener, `METRICS_PORT` (default
  `9464`). The main API port doesn't serve it.
- **Format**: Prometheus text exposition format.
- **Reachability**:
  - Compose declares the port with `expose` only, so it's reachable from other containers
    on the compose network and never published to the host.
  - nginx (`web`) has `location = /metrics { return 404; }` and proxies only `/api/`.
- **Series** (prefix `po_`):
  - `po_http_request_duration_seconds` (histogram), labels `method`, `route` (the
    registered pattern, never the raw path), `status_class` (`2xx` … `5xx`)
  - `po_http_requests_total` (counter), same labels
  - `po_http_errors_total` (counter), labels `route`, `code` (the registry code)
  - default process metrics (CPU, memory, event loop lag, GC)
- **Never in labels**: user ids, emails, raw paths, query strings or correlation ids. This
  keeps label counts bounded and personal data out.

## Tests

- Through `web`: `GET http://localhost:${WEB_PORT}/metrics` → `404`.
- No host-published port serves `/metrics`. The smoke script checks every published port.
- From inside the compose network (`docker compose exec web wget -qO- http://api:9464/metrics`)
  → `200`, containing `po_http_requests_total`.
- After a request that gets a `404`, `po_http_errors_total{code="NOT_FOUND"}` has increased.
