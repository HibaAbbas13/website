#!/usr/bin/env bash
# Deploy the storefront to the `monetra-web` Vercel project.
#
# Always use this rather than calling `vercel` directly. Vercel infers the
# project from the *current working directory*: running it from `public/` or
# `public/assets/` silently creates a brand-new project named after that folder
# and deploys the wrong subtree there. That has happened twice, and it also
# leaves stray `.vercel/` links behind that make the next deploy wrong too.
#
# This script cd's to its own location and refuses to run if the link has
# drifted to a different project.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

EXPECTED_PROJECT="monetra-web"
LINK=".vercel/project.json"

if [[ -f "$LINK" ]]; then
  actual=$(python3 -c "import json;print(json.load(open('$LINK'))['projectName'])")
  if [[ "$actual" != "$EXPECTED_PROJECT" ]]; then
    echo "Refusing to deploy: $LINK points at '$actual', expected '$EXPECTED_PROJECT'." >&2
    echo "Fix with: rm -rf .vercel && npx vercel link --project $EXPECTED_PROJECT" >&2
    exit 1
  fi
else
  echo "No Vercel link found. Run: npx vercel link --project $EXPECTED_PROJECT" >&2
  exit 1
fi

# Stray links inside the output directory would be picked up by a stray `cd`.
for stray in public/.vercel public/assets/.vercel; do
  [[ -e "$stray" ]] && { echo "Removing stray link: $stray"; rm -rf "$stray"; }
done

echo "Deploying $(pwd) → $EXPECTED_PROJECT"
npx vercel --prod --yes

echo
echo "Smoke test:"
for path in / /admin /s/toy; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://monetra-web-psi.vercel.app${path}")
  printf "  %-10s %s\n" "$path" "$code"
done
