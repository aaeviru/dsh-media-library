#!/usr/bin/env bash
# Pack the built plugin bundle into a commit-stamped .tgz archive:
#   ./scripts/pack.sh                                         -> ./dist/dsh-media-library-<version>-<short-sha>.tgz
#   ./scripts/pack.sh ../dsh-media-library-local-data/artifacts -> ../dsh-media-library-local-data/artifacts/dsh-media-library-<version>-<short-sha>.tgz
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
BUNDLE_DIR="$REPO_ROOT/bundle"
OUT_ARG="${1:-./dist}"

if [[ ! -f "$BUNDLE_DIR/lib/index.js" || ! -f "$BUNDLE_DIR/lib/client.js" ]]; then
  echo "Error: bundle/lib is missing build outputs. Run ./scripts/build-bundle.sh first." >&2
  exit 1
fi

mkdir -p "$OUT_ARG"
OUT_ABS="$(cd -- "$OUT_ARG" && pwd)"

VERSION="$(node -p "require('$BUNDLE_DIR/package.json').version")"
ROOT_VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
SRC_VERSION="$(node --experimental-strip-types --input-type=module -e "import { APP_VERSION } from '$REPO_ROOT/src/version.ts'; console.log(APP_VERSION)")"
if [[ "$VERSION" != "$ROOT_VERSION" || "$VERSION" != "$SRC_VERSION" ]]; then
  echo "Error: version mismatch across package.json ($ROOT_VERSION), bundle/package.json ($VERSION), and src/version.ts ($SRC_VERSION)" >&2
  exit 1
fi
SHORT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
TARGET_TGZ="$OUT_ABS/dsh-media-library-${VERSION}-${SHORT_SHA}.tgz"

cd "$BUNDLE_DIR"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-${TMPDIR:-/tmp}/dsh-media-npm-cache}"
RAW_TGZ_NAME="$(npm pack --quiet --pack-destination "$OUT_ABS" | tail -n 1)"
mv -f "$OUT_ABS/$RAW_TGZ_NAME" "$TARGET_TGZ"
echo "$TARGET_TGZ"
