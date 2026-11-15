#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
BUNDLE_DIR="$REPO_ROOT/bundle"
OUT_DIR="${1:-$REPO_ROOT/dist}"

if [[ ! -f "$BUNDLE_DIR/lib/index.js" || ! -f "$BUNDLE_DIR/lib/client.js" ]]; then
  echo "Error: bundle/lib is missing build outputs. Run ./scripts/build-bundle.sh first." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cd "$BUNDLE_DIR"
npm pack --pack-destination "$OUT_DIR"
