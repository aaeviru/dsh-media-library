#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> [1/4] Checking git whitespace / formatting hygiene..."
git diff --check

echo "==> [2/4] Building plugin bundle and verifying typecheck & external imports..."
./scripts/build-bundle.sh

echo "==> [3/4] Running unit and integration tests..."
node --experimental-strip-types --test \
  tests/inventory/tagstudio-inventory.test.ts \
  tests/host/unc-spike.test.ts

echo "==> [4/4] Verifying .tgz package creation..."
./scripts/pack.sh "$REPO_ROOT/dist"

echo "==> All automated verification checks passed."
