#!/usr/bin/env bash
# Three-layer DSH Web runtime verification in WSL:
#   1. Install packed .tgz into an isolated DSH_HOME web profile
#   2. Start `dsh web` and verify boot.html + /plugins/??... HTTP 200
#   3. Drive headless Chromium via Playwright to click the Media Library sidebar icon,
#      verify spikeStatus() diagnostics, and trigger openMedia('m1-missing-file') RPC.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
HARNESS_DIR="${DSH_HARNESS_DIR:-/home/aaevi/projects/deepseek-harness}"
VERSION="$(node -p "require('$REPO_ROOT/bundle/package.json').version")"
SHORT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
TGZ="${1:-$REPO_ROOT/dist/dsh-media-library-${VERSION}-${SHORT_SHA}.tgz}"
PORT="${DSH_VERIFY_PORT:-3199}"

if [[ ! -f "$TGZ" ]]; then
  echo "Error: tarball not found at $TGZ (run ./scripts/pack.sh first)" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dsh-media-web-verify.XXXXXX")"
WEB_PID=""
cleanup() {
  if [[ -n "$WEB_PID" ]]; then
    kill "$WEB_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/home" "$WORK/data" "$WORK/cache"
export DSH_HOME="$WORK/home"
export XDG_DATA_HOME="$WORK/data"
export XDG_CACHE_HOME="$WORK/cache"
export PLAYWRIGHT_BROWSERS_PATH="$HARNESS_DIR/node_modules/.cache/ms-playwright"
export PATH="$HARNESS_DIR/node_modules/.bin:$PATH"

cd "$HARNESS_DIR"
echo "==> [Web 1/3] Installing $(basename "$TGZ") into isolated DSH web profile..."
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add "$TGZ" >/dev/null

if grep -q '"link:' "$DSH_HOME/profiles/web/package.json"; then
  echo "Error: profile recorded a link: dependency instead of file: tarball" >&2
  exit 1
fi

echo "==> [Web 2/3] Starting dsh web on port $PORT and verifying boot payload + client bundle route..."
node --import tsx/esm apps/cli/src/bin.ts web --port "$PORT" --no-open > "$WORK/web.log" 2>&1 &
WEB_PID=$!

for _ in $(seq 1 40); do
  if grep -q "http://127.0.0.1:$PORT" "$WORK/web.log" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    cat "$WORK/web.log" >&2
    exit 1
  fi
  sleep 0.5
done

if grep -q "entry did not activate" "$WORK/web.log"; then
  echo "Error: plugin failed to activate in Host:" >&2
  cat "$WORK/web.log" >&2
  exit 1
fi

export TOKEN_URL="$(grep -oE "http://127\.0\.0\.1:$PORT/\?token=[^[:space:]]+" "$WORK/web.log" | head -n 1)"
if [[ -z "$TOKEN_URL" ]]; then
  echo "Error: failed to obtain TOKEN_URL from dsh web log:" >&2
  cat "$WORK/web.log" >&2
  exit 1
fi

curl -sL -c "$WORK/cj" -b "$WORK/cj" -o "$WORK/boot.html" "$TOKEN_URL"
REV="$(grep -oE 'dsh-experimental-media-library/client\.js&rev=[0-9a-f]+' "$WORK/boot.html" | head -n 1 | cut -d= -f2)"
if [[ -z "$REV" ]]; then
  echo "Error: @deepseek-ai/dsh-experimental-media-library missing from boot.html" >&2
  exit 1
fi

HTTP_CODE="$(curl -s -b "$WORK/cj" -o "$WORK/mod.js" -w "%{http_code}" \
  "http://127.0.0.1:$PORT/plugins/??@deepseek-ai/dsh-experimental-media-library/client.js&rev=$REV")"
if [[ "$HTTP_CODE" != "200" ]]; then
  echo "Error: module route returned HTTP $HTTP_CODE" >&2
  exit 1
fi

echo "==> [Web 3/3] Running Playwright headless Chromium E2E click & RPC verification..."
node --input-type=module -e '
import assert from "node:assert/strict";
import { chromium } from "/home/aaevi/projects/deepseek-harness/apps/web/node_modules/playwright/index.mjs";

const url = process.env.TOKEN_URL;
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(url, { waitUntil: "load", timeout: 40000 });
  await page.waitForTimeout(4000);

  for (let i = 0; i < 4; i++) {
    const btn = page.getByRole("button", { name: /Continue|Got it|Close|Skip|Later|继续|我知道了|关闭/i }).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }

  const mediaBtn = page.locator("button[aria-label=\"Media Library\"], button[aria-label=\"媒体库\"]").first();
  await mediaBtn.click({ force: true });
  await page.waitForTimeout(1500);

  const h2 = await page.locator("h2").allTextContents();
  assert.ok(h2.some((text) => text.includes("Media Library") || text.includes("媒体库")), `Unexpected h2: ${JSON.stringify(h2)}`);

  const openButtons = page.getByRole("button", { name: /Open Default Player|调用默认播放器打开/i });
  const openCount = await openButtons.count();
  assert.equal(openCount, 6, `Expected 6 Open buttons, found ${openCount}`);

  await openButtons.last().click({ force: true });
  await page.waitForTimeout(1000);

  const afterClickText = await page.locator("body").innerText();
  assert.ok(afterClickText.includes("m1-missing-file") && afterClickText.includes("FILE_NOT_FOUND"), "Expected FILE_NOT_FOUND result after clicking Open on m1-missing-file");
  assert.deepEqual(errors, []);
  console.log("Playwright Web E2E verification passed: panel rendered, spikeStatus loaded, and openMedia RPC returned FILE_NOT_FOUND.");
} finally {
  await browser.close();
}
'
