#!/usr/bin/env bash
# Fails on a breaking change to the committed OpenAPI document compared with a base
# revision, unless the pull request is labelled `breaking` and its description explains
# why on a "Breaking change: …" line (ADR-0008, research R12).
#
# Usage: scripts/contract-breaking.sh <base-revision>
# Environment: BREAKING_LABEL ("true" when the PR has the label), PR_BODY (its description).
set -euo pipefail

cd "$(dirname "$0")/.."

base="${1:?usage: contract-breaking.sh <base-revision>}"
doc=packages/contracts/openapi/openapi.json
oasdiff_image=tufin/oasdiff:v1.33.0

if ! git cat-file -e "$base:$doc" 2>/dev/null; then
  echo "contract-breaking: $base has no $doc yet, so there is nothing to compare"
  exit 0
fi

# Under the git-ignored reports/ rather than /tmp, which a snap-packaged Docker can't see.
mkdir -p reports
specs="$(cd "$(mktemp -d reports/oasdiff.XXXXXX)" && pwd)"
trap 'rm -rf "$specs"' EXIT
git show "$base:$doc" >"$specs/base.json"
cp "$doc" "$specs/head.json"
chmod -R a+rX "$specs"

set +e
docker run --rm --user "$(id -u):$(id -g)" -v "$specs:/specs:ro" "$oasdiff_image" \
  breaking /specs/base.json /specs/head.json --fail-on ERR --format text
status=$?
set -e

case "$status" in
  0)
    echo "contract-breaking: no breaking change against $base"
    exit 0
    ;;
  1) ;;
  *)
    echo "contract-breaking: oasdiff failed to run (exit $status)" >&2
    exit "$status"
    ;;
esac

if [[ "${BREAKING_LABEL:-false}" == "true" ]] &&
  grep -qiE '^[[:space:]]*breaking change:[[:space:]]*[^[:space:]]' <<<"${PR_BODY:-}"; then
  echo "contract-breaking: breaking change accepted: the PR is labelled 'breaking' and explains why"
  exit 0
fi

echo "contract-breaking: breaking change against $base. If it is intended, label the PR" \
  "'breaking' and add a 'Breaking change: <why>' line to its description (ADR-0008)." >&2
exit 1
