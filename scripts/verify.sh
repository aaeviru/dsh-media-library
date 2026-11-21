#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> [1/5] Checking git whitespace / formatting hygiene & client UI rules..."
git diff --check
node --input-type=module -e '
  import fs from "node:fs";
  import path from "node:path";
  const clientDir = "src/client";
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(tsx?|css)$/.test(ent.name)) files.push(full);
    }
  };
  walk(clientDir);
  const violations = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (/#[0-9a-fA-F]{3,8}\b/.test(line) || /\brgba?\s*\(/.test(line)) {
        violations.push(`${file}:${idx + 1} hardcoded color: ${line.trim()}`);
      }
      if (file.endsWith(".tsx") && /<select\b/.test(line) && !/^\s*(?:\/\*|\*|\/\/|\{\/\*)/.test(line)) {
        violations.push(`${file}:${idx + 1} forbidden native <select> (Issue #28 / #47 B3): ${line.trim()}`);
      }
    });
  }
  if (violations.length > 0) {
    console.error("Client UI hygiene gate failed:\n" + violations.join("\n"));
    process.exit(1);
  }
  console.log("Client UI hygiene gate passed (0 hardcoded colors, 0 new native <select>).");
'

echo "==> [2/5] Building plugin bundle and verifying typecheck & external imports..."
./scripts/build-bundle.sh

echo "==> [3/5] Running unit, SQLite fixture, search, and 10k/100k benchmark tests..."
node --experimental-strip-types --test \
  tests/inventory/tagstudio-inventory.test.ts \
  tests/host/unc-spike.test.ts \
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
