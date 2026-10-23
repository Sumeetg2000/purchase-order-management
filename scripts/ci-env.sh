#!/usr/bin/env bash
# Writes .env from .env.example, replacing every change-me-… placeholder with a random
# throwaway value, so CI (including pull requests from forks) needs no secrets.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -e .env && "${1:-}" != "--force" ]]; then
  echo "ci-env: .env already exists; pass --force to overwrite it" >&2
  exit 1
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" =~ ^([A-Z0-9_]+)=change-me- ]]; then
    printf '%s=%s\n' "${BASH_REMATCH[1]}" "$(openssl rand -hex 24)" >>"$tmp"
  else
    printf '%s\n' "$line" >>"$tmp"
  fi
done <.env.example

chmod 600 "$tmp"
mv "$tmp" .env
trap - EXIT
echo "ci-env: wrote .env with random secrets"
