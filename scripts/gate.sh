#!/usr/bin/env bash
# The local gate, run before every commit and push (owner, 2026-11-26): each check in
# turn, stopping at the first that fails, with that check's exit status. Each check's full
# output goes to $GATE_LOG_DIR/gate-<name>.log (reports/ by default); a passing check prints its summary lines, a
# failing one the end of its log. No check's exit status is ever piped or wrapped away.
#
# Usage: scripts/gate.sh            every check, gitleaks last
#        GATE_SKIP_E2E=1 scripts/gate.sh   without the local e2e stack (never before a push)
set -euo pipefail

cd "$(dirname "$0")/.."
LOG_DIR=${GATE_LOG_DIR:-reports}
mkdir -p "$LOG_DIR"

# The same gitleaks image as lefthook.yml and CI, pinned by digest
# (scripts/tests/image-pins.test.mjs).
GITLEAKS_IMAGE=ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f

# Lines worth printing from a passing check: test totals and the tools' own verdicts.
SUMMARY='check-walkthrough|Test Files |Tests  |^# (pass|fail) |^ℹ (pass|fail) |check-requirement-ids|passed \(|no leaks found|leaks found'

run() {
  local name=$1
  shift
  local log="${LOG_DIR}/gate-${name}.log"
  printf '== gate: %s\n' "$name"
  local status=0
  "$@" >"$log" 2>&1 || status=$?
  if ((status != 0)); then
    tail -n 60 "$log"
    printf 'gate: %s FAILED with status %d (full log: %s)\n' "$name" "$status" "$log" >&2
    exit "$status"
  fi
  grep -E "$SUMMARY" "$log" || true
}

gitleaks() {
  git fetch -q origin main
  docker run --rm -v "$PWD:/repo" -w /repo "$GITLEAKS_IMAGE" \
    git /repo --config /repo/.gitleaks.toml --redact --log-opts="origin/main..HEAD"
}

run ids npm run -s check:ids
run lint npm run -s lint
run format npm run -s format:check
run typecheck npm run -s typecheck
run walkthrough npm run -s check:walkthrough
run test npm test
if [[ "${GATE_SKIP_E2E:-0}" != 1 ]]; then
  run e2e npm run e2e:local
fi
run gitleaks gitleaks
printf 'gate: all checks passed\n'
