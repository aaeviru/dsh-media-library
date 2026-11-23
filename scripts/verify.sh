#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> [1/5] Checking git whitespace / formatting hygiene & static lint rules..."
git diff --check
node --experimental-strip-types --input-type=module -e '
  import fs from "node:fs";
  import { APP_VERSION } from "./src/version.ts";
  const rootPkg = JSON.parse(fs.readFileSync("./package.json", "utf8")).version;
  const bundlePkg = JSON.parse(fs.readFileSync("./bundle/package.json", "utf8")).version;
  if (rootPkg !== bundlePkg || rootPkg !== APP_VERSION) {
    console.error(`Version parity check failed: package.json=${rootPkg}, bundle/package.json=${bundlePkg}, src/version.ts=${APP_VERSION}`);
    process.exit(1);
  }
  console.log(`Version parity check passed (${APP_VERSION}).`);
'
node --experimental-strip-types ./scripts/lint-rules.ts

echo "==> [2/5] Building plugin bundle and verifying typecheck & external imports..."
./scripts/build-bundle.sh
if [[ -n "${DSH_HARNESS_DIR:-}" ]]; then
  HARNESS_DIR="${DSH_HARNESS_DIR}"
elif [[ -d "/home/aaevi/projects/project/deepseek-harness" ]]; then
  HARNESS_DIR="/home/aaevi/projects/project/deepseek-harness"
else
  HARNESS_DIR="/home/aaevi/projects/deepseek-harness"
fi
echo "==> Typechecking test sources (tsconfig.test.json, --noEmit)..."
"$HARNESS_DIR/node_modules/.bin/tsc" -p tsconfig.test.json --noEmit

echo "==> [3/5] Running unit, SQLite fixture, search, and 10k/100k benchmark tests..."
node --experimental-strip-types --test \
  tests/inventory/tagstudio-inventory.test.ts \
  tests/host/*.test.ts \
  tests/db/*.test.ts \
  tests/import/tagstudio-importer.test.ts \
  tests/search/*.test.ts \
  tests/mutations/*.test.ts \
  tests/ingestion/*.test.ts \
  tests/performers/*.test.ts

echo "==> [4/5] Verifying .tgz package creation (portable relative default ./dist)..."
PACKED_TGZ="$(./scripts/pack.sh ./dist | tail -n 1)"
echo "    Created package: $PACKED_TGZ"

echo "==> [5/5] Verifying 3-layer DSH Web cold-install & Playwright E2E in WSL..."
./scripts/verify-web.sh "$PACKED_TGZ"

echo "==> All automated verification checks passed."
