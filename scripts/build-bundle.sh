#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
if [[ -n "${DSH_HARNESS_DIR:-}" ]]; then
  HARNESS_DIR="${DSH_HARNESS_DIR}"
elif [[ -d "/home/aaevi/projects/project/deepseek-harness" ]]; then
  HARNESS_DIR="/home/aaevi/projects/project/deepseek-harness"
else
  HARNESS_DIR="/home/aaevi/projects/deepseek-harness"
fi

if [[ ! -d "$HARNESS_DIR/packages/client" ]]; then
  echo "Error: deepseek-harness not found at $HARNESS_DIR (set DSH_HARNESS_DIR to override)" >&2
  exit 1
fi

setup_local_node_modules() {
  local nm="$REPO_ROOT/node_modules"
  mkdir -p "$nm/@deepseek-ai" "$nm/@types"

  ln -sfn "$HARNESS_DIR/vendor/cordis" "$nm/@deepseek-ai/cordis"
  ln -sfn "$HARNESS_DIR/vendor/schemastery" "$nm/@deepseek-ai/schemastery"
  ln -sfn "$HARNESS_DIR/packages/client/locale" "$nm/@deepseek-ai/dsh-client-locale"
  ln -sfn "$HARNESS_DIR/packages/client/ui-layout" "$nm/@deepseek-ai/dsh-client-ui-layout"
  ln -sfn "$HARNESS_DIR/packages/client/ui-plugin-manager" "$nm/@deepseek-ai/dsh-client-ui-plugin-manager"
  ln -sfn "$HARNESS_DIR/packages/client/ui-renderer" "$nm/@deepseek-ai/dsh-client-ui-renderer"
  ln -sfn "$HARNESS_DIR/packages/client/ui-sidebar" "$nm/@deepseek-ai/dsh-client-ui-sidebar"
  ln -sfn "$HARNESS_DIR/packages/client/ui-primitives" "$nm/@deepseek-ai/dsh-client-ui-primitives"
  ln -sfn "$HARNESS_DIR/packages/client/ui-slots" "$nm/@deepseek-ai/dsh-client-ui-slots"
  ln -sfn "$HARNESS_DIR/packages/api/remotes" "$nm/@deepseek-ai/dsh-api-remotes"
  ln -sfn "$HARNESS_DIR/packages/typert/protocol" "$nm/@deepseek-ai/dsh-typert-protocol"
  ln -sfn "$HARNESS_DIR/packages/util/native-command" "$nm/@deepseek-ai/dsh-native-command"
  ln -sfn "$REPO_ROOT" "$nm/@deepseek-ai/dsh-experimental-media-library"

  local pnpm_dir="$HARNESS_DIR/node_modules/.pnpm"

  local zod_pkg
  zod_pkg="$(find "$pnpm_dir" -maxdepth 4 -path '*/node_modules/zod' -type d | head -n 1)"
  [[ -n "$zod_pkg" ]] && ln -sfn "$zod_pkg" "$nm/zod"

  local react_pkg
  react_pkg="$(find "$pnpm_dir" -maxdepth 4 -path '*/node_modules/react' -type d | head -n 1)"
  [[ -n "$react_pkg" ]] && ln -sfn "$react_pkg" "$nm/react"

  local react_dom_pkg
  react_dom_pkg="$(find "$pnpm_dir" -maxdepth 4 -path '*/node_modules/react-dom' -type d | head -n 1)"
  [[ -n "$react_dom_pkg" ]] && ln -sfn "$react_dom_pkg" "$nm/react-dom"

  local tsdown_pkg
  tsdown_pkg="$(find "$pnpm_dir" -maxdepth 4 -path '*/node_modules/tsdown' -type d | head -n 1)"
  [[ -n "$tsdown_pkg" ]] && ln -sfn "$tsdown_pkg" "$nm/tsdown"

  local types_node
  types_node="$(find "$pnpm_dir" -maxdepth 5 -path '*/node_modules/@types/node' -type d | head -n 1)"
  [[ -n "$types_node" ]] && ln -sfn "$types_node" "$nm/@types/node"

  local types_react
  types_react="$(find "$pnpm_dir" -maxdepth 5 -path '*/node_modules/@types/react' -type d | head -n 1)"
  [[ -n "$types_react" ]] && ln -sfn "$types_react" "$nm/@types/react"

  local types_react_dom
  types_react_dom="$(find "$pnpm_dir" -maxdepth 5 -path '*/node_modules/@types/react-dom' -type d | head -n 1)"
  [[ -n "$types_react_dom" ]] && ln -sfn "$types_react_dom" "$nm/@types/react-dom"
}

echo "==> Linking read-only harness dependencies into local node_modules..."
setup_local_node_modules

cd "$REPO_ROOT"
rm -rf "$REPO_ROOT/lib" "$REPO_ROOT/tsconfig.host.tsbuildinfo" "$REPO_ROOT/tsconfig.client.tsbuildinfo"

echo "==> Generating Typert metadata (lib/typert.*)..."
node --experimental-strip-types "$REPO_ROOT/scripts/generate-typert.ts"

echo "==> Typechecking and emitting declarations (tsc -b)..."
"$HARNESS_DIR/node_modules/.bin/tsc" -b .

echo "==> Bundling Host and Client outputs (tsdown)..."
"$HARNESS_DIR/node_modules/.bin/tsdown"
rm -f "$REPO_ROOT/lib/typert.host.src.js"

echo "==> Syncing lib/ and locale/ into bundle/..."
rm -rf "$REPO_ROOT/bundle/lib" "$REPO_ROOT/bundle/locale"
mkdir -p "$REPO_ROOT/bundle/lib" "$REPO_ROOT/bundle/locale"
cp -R "$REPO_ROOT/lib/." "$REPO_ROOT/bundle/lib/"
cp -R "$REPO_ROOT/locale/." "$REPO_ROOT/bundle/locale/"
cp "$REPO_ROOT/cordis.patch.yml" "$REPO_ROOT/bundle/cordis.patch.yml"

echo "==> Auditing bundle/lib/index.js and bundle/lib/typert.host.js external imports..."
node -e '
  const fs = require("node:fs");
  for (const file of ["bundle/lib/index.js", "bundle/lib/typert.host.js"]) {
    const code = fs.readFileSync(file, "utf8");
    const importRegex = /(?:import|export)\s+(?:[^"\x27]*?\s+from\s+)?["\x27]([^"\x27]+)["\x27]/g;
    const allowed = new Set(["@deepseek-ai/cordis"]);
    const disallowed = [];
    let match;
    while ((match = importRegex.exec(code)) !== null) {
      const spec = match[1];
      if (!spec.startsWith("node:") && !allowed.has(spec)) {
        disallowed.push(spec);
      }
    }
    if (disallowed.length > 0) {
      console.error("Disallowed external imports in " + file + ":", disallowed);
      process.exit(1);
    }
  }
  console.log("Host bundle import audit passed (only @deepseek-ai/cordis and node:* in index.js and typert.host.js).");
'
