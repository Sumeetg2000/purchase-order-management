#!/usr/bin/env bash
# Order-write body limits through the nginx edge (slice 3 research R8), against a running
# stack with the demo data: the largest valid order, sent raw and fully escaped, is created
# (201) through /api/orders; a body one byte over ORDER_BODY_LIMIT_BYTES, and one byte over
# BODY_LIMIT_BYTES on another /api/ route, are refused by the edge (413). Called by
# scripts/smoke.sh; runs alone against any stack: BASE=http://127.0.0.1:PORT ORIGIN=… .
set -euo pipefail

BASE="${BASE:?set BASE, e.g. http://127.0.0.1:8080}"
ORIGIN="${ORIGIN:?set ORIGIN to the stack APP_ORIGIN}"
ORDER_LIMIT=$((4 * 1024 * 1024))
DEFAULT_LIMIT=$((1024 * 1024))
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT

failures=0
ok() { printf '  ok    %s\n' "$1"; }
bad() {
  printf '  FAIL  %s\n' "$1" >&2
  failures=$((failures + 1))
}

# A demo Buyer's session: the cookies from the login answer's Set-Cookie headers (read as
# headers, so a Secure cookie works over this plain-HTTP check too).
curl -s -o /dev/null -D "$dir/login.headers" --max-time 10 \
  -H 'Content-Type: application/json' -H "Origin: $ORIGIN" \
  --data '{"email":"buyer1@example.com","password":"po demo passphrase"}' \
  "$BASE/api/auth/login"
cookie() { sed -n "s/^[Ss]et-[Cc]ookie: $1=\\([^;]*\\).*/\\1/p" "$dir/login.headers" | tail -1; }
access="$(cookie po_access)"
csrf="$(cookie po_csrf)"
if [[ -z "$access" || -z "$csrf" ]]; then
  bad "a demo Buyer logs in (is SEED_DEMO_DATA on?)"
  exit 1
fi
auth=(-H "Origin: $ORIGIN" -H "Cookie: po_access=$access; po_csrf=$csrf" -H "X-CSRF-Token: $csrf")

vendor="$(curl -s --max-time 10 "${auth[@]}" "$BASE/api/vendors?q=Acme" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).items[0]?.id??""))')"
[[ -n "$vendor" ]] || { bad "the demo vendor Acme Supplies is listed"; exit 1; }

# The largest valid order: 500 lines of 500 emoji, raw UTF-8 and every emoji escaped.
VENDOR="$vendor" OUT="$dir" node -e '
  const fs = require("node:fs");
  const lines = Array.from({ length: 500 }, () => ({
    description: "\u{1F600}".repeat(500), quantity: 1000000, unitPrice: "999999999.9999" }));
  const raw = JSON.stringify({ vendorId: process.env.VENDOR, lines });
  fs.writeFileSync(process.env.OUT + "/raw.json", raw);
  fs.writeFileSync(process.env.OUT + "/escaped.json", raw.replaceAll("\u{1F600}", "\\ud83d\\ude00"));'
head -c $((ORDER_LIMIT + 1)) /dev/zero | tr '\0' ' ' >"$dir/over-order.json"
head -c $((DEFAULT_LIMIT + 1)) /dev/zero | tr '\0' ' ' >"$dir/over-default.json"

post() {
  local path="$1" file="$2" key
  key="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
  curl -s -o "$dir/answer.json" -w '%{http_code}' --max-time 60 "${auth[@]}" \
    -H 'Content-Type: application/json' -H "Idempotency-Key: $key" \
    --data-binary "@$file" "$BASE$path"
}

for form in raw escaped; do
  status="$(post /api/orders "$dir/$form.json")"
  if [[ "$status" == 201 ]] && grep -q '"total":"499999999999950000.0000"' "$dir/answer.json"; then
    ok "the largest valid order, ${form}, through the edge is 201"
  else
    bad "the largest valid order, ${form}, through the edge is 201 (got $status)"
  fi
done
status="$(post /api/orders "$dir/over-order.json")"
if [[ "$status" == 413 ]] && grep -q '"code":"PAYLOAD_TOO_LARGE"' "$dir/answer.json"; then
  ok "ORDER_BODY_LIMIT_BYTES + 1 on /api/orders is the edge's 413"
else
  bad "ORDER_BODY_LIMIT_BYTES + 1 on /api/orders is the edge's 413 (got $status)"
fi
status="$(post /api/vendors "$dir/over-default.json")"
if [[ "$status" == 413 ]] && grep -q '"code":"PAYLOAD_TOO_LARGE"' "$dir/answer.json"; then
  ok "BODY_LIMIT_BYTES + 1 on /api/vendors is the edge's 413"
else
  bad "BODY_LIMIT_BYTES + 1 on /api/vendors is the edge's 413 (got $status)"
fi
exit $((failures > 0))
