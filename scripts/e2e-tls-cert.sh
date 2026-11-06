#!/usr/bin/env bash
# Makes the end-to-end TLS edge's certificate (deploy/e2e/compose.tls.yml): self-signed for
# localhost, valid for one day, written to the git-ignored .e2e-tls/ at run time. Never
# committed; each run replaces it.
set -euo pipefail

cd "$(dirname "$0")/.."

dir=.e2e-tls
rm -rf "$dir"
mkdir -p "$dir"
openssl req -x509 -nodes -days 1 \
  -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -subj /CN=localhost -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1' \
  -keyout "$dir/key.pem" -out "$dir/cert.pem" 2>/dev/null
# The edge's nginx reads the files as another user inside its container.
chmod 644 "$dir/key.pem" "$dir/cert.pem"
echo "e2e-tls-cert: wrote a one-day certificate for localhost to $dir/"
