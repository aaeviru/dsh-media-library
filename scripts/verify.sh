#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> [1/5] Checking git whitespace / formatting hygiene..."
git diff --check

echo "==> [2/5] Building plugin bundle and verifying typecheck & external imports..."
./scripts/build-bundle.sh

echo "==> [3/5] Running unit and integration tests..."
node --experimental-strip-types --test \
  tests/inventory/tagstudio-inventory.test.ts \
  tests/host/unc-spike.test.ts \
  tests/db/schema-and-backup.test.ts \
  tests/import/tagstudio-importer.test.ts

echo "==> [4/5] Verifying .tgz package creation (portable relative default ./dist)..."
PACKED_TGZ="$(./scripts/pack.sh ./dist | tail -n 1)"
echo "    Created package: $PACKED_TGZ"

echo "==> [5/5] Verifying 3-layer DSH Web cold-install & Playwright E2E in WSL..."
./scripts/verify-web.sh "$PACKED_TGZ"

echo "==> All automated verification checks passed."
