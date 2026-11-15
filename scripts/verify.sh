#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> [1/2] Checking git whitespace / formatting..."
git diff --check

echo "==> [2/2] Running automated unit & SQLite fixture tests..."
node --test tests/inventory/*.test.ts

echo "==> verify.sh: PASS"
