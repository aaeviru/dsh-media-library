#!/usr/bin/env bash
# Three-layer DSH Web runtime verification in WSL:
#   1. Install packed .tgz into an isolated DSH_HOME web profile
#   2. Start `dsh web` and verify boot.html + /plugins/??... HTTP 200
#   3. Drive headless Chromium via Playwright to click the Media Library sidebar icon,
#      verify search filters, keyboard/context-menu actions, and Host RPC errors.
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
VERSION="$(node -p "require('$REPO_ROOT/bundle/package.json').version")"
SHORT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
TGZ="${1:-$REPO_ROOT/dist/dsh-media-library-${VERSION}-${SHORT_SHA}.tgz}"
PORT="${DSH_VERIFY_PORT:-3199}"

if [[ ! -f "$TGZ" ]]; then
  echo "Error: tarball not found at $TGZ (run ./scripts/pack.sh first)" >&2
  exit 1
fi
TGZ="$(realpath "$TGZ")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dsh-media-web-verify.XXXXXX")"
WEB_PID=""
cleanup() {
  if [[ -n "$WEB_PID" ]]; then
    kill "$WEB_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/home" "$WORK/data" "$WORK/cache" "$WORK/fixture"
export DSH_HOME="$WORK/home"
export XDG_DATA_HOME="$WORK/data"
export XDG_CACHE_HOME="$WORK/cache"
export PLAYWRIGHT_BROWSERS_PATH="$HARNESS_DIR/node_modules/.cache/ms-playwright"
export PATH="$HARNESS_DIR/node_modules/.bin:$PATH"
export FIXTURE_DB="$WORK/fixture/ts_library.sqlite"

export VERIFY_REPO_ROOT="$REPO_ROOT"
export VERIFY_WORK="$WORK"
node --experimental-strip-types --input-type=module -e '
const { createM2ImportTagStudioFixture } = await import(
  `${process.env.VERIFY_REPO_ROOT}/src/inventory/fixture-builder.ts`
);
createM2ImportTagStudioFixture(process.env.FIXTURE_DB);
'

cd "$HARNESS_DIR"
echo "==> [Web 1/3] Installing $(basename "$TGZ") into isolated DSH web profile..."
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add "$TGZ" >/dev/null

if grep -q '"link:' "$DSH_HOME/profiles/web/package.json"; then
  echo "Error: profile recorded a link: dependency instead of file: tarball" >&2
  exit 1
fi

# Test-only external filesystem boundary: hold one fixture rename without changing the installed plugin.
node --input-type=module -e '
import fs from "node:fs";
import path from "node:path";
const work = process.env.VERIFY_WORK;
fs.writeFileSync(path.join(process.env.DSH_HOME, "profiles/web/cordis.patch.yml"),
  "- id: media-library\n  config: " + JSON.stringify({ stagingDir: path.join(work, "staging"), autoDailyBackup: false }) + "\n");
fs.writeFileSync(path.join(work, "slow-rename.mjs"), `
import fs from "node:fs/promises";
import path from "node:path";
const work = process.env.VERIFY_WORK;
process.chdir(work);
const rename = fs.rename;
fs.rename = async (source, destination) => {
  if (source === path.join(work, "staging/issue30-slow.mp4")) {
    await fs.writeFile(path.join(work, "rename-entered"), "entered");
    for (;;) {
      try { await fs.stat(path.join(work, "rename-release")); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  return rename(source, destination);
};
`);
'

echo "==> [Web 2/3] Starting dsh web on port $PORT and verifying boot payload + client bundle route..."
node --import tsx/esm --import "$WORK/slow-rename.mjs" "$HARNESS_DIR/apps/cli/src/bin.ts" web --port "$PORT" --no-open > "$WORK/web.log" 2>&1 &
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
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "'"${HARNESS_DIR}"'/apps/web/node_modules/playwright/index.mjs";

const url = process.env.TOKEN_URL;
const fixtureDb = process.env.FIXTURE_DB;
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
let page;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
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
  await page.waitForSelector("[data-testid=\"search-submit-btn\"]", { timeout: 10000 });

  const h2 = await page.locator("h2").allTextContents();
  assert.ok(h2.some((text) => text.includes("Media Library") || text.includes("媒体库")), `Unexpected h2: ${JSON.stringify(h2)}`);

  // Verify initial empty state and import fixture via UI
  await page.waitForSelector("[data-testid=\"empty-results-state\"]", { timeout: 5000 });
  await page.fill("[data-testid=\"import-source-input\"]", fixtureDb);
  const tImportStart = performance.now();
  await page.click("[data-testid=\"import-submit-btn\"]");
  await page.waitForFunction(() =>
    document.querySelectorAll("tr[data-testid^=\"media-row-\"]").length === 6 &&
    !document.querySelector("[data-testid=\"search-submit-btn\"]").disabled,
    undefined, { timeout: 10000 }
  );
  const firstResultDisplayMs = performance.now() - tImportStart;
  console.log(`UI first result display (including fixture import): ${firstResultDisplayMs.toFixed(1)}ms; target <1000ms`);
  assert.ok(firstResultDisplayMs < 1000, `Expected UI first result display <1000ms, took ${firstResultDisplayMs.toFixed(1)}ms`);

  const rowCount = await page.locator("tr[data-testid^=\"media-row-\"]").count();
  assert.equal(rowCount, 6, `Expected 6 imported media rows, found ${rowCount}`);

  const waitRows = async count => {
    await page.waitForFunction(expected =>
      document.querySelectorAll("tr[data-testid^=\"media-row-\"]").length === expected &&
      !document.querySelector("[data-testid=\"search-submit-btn\"]").disabled,
      count
    );
  };
  const search = async count => {
    await page.click("[data-testid=\"search-submit-btn\"]");
    await waitRows(count);
  };
  const reset = async () => {
    await page.click("[data-testid=\"search-reset-btn\"]");
    await waitRows(6);
  };

  // Alias suggestions identify the same tag; selecting two tags takes their intersection.
  const suggestions = page.locator("[data-testid=\"tag-suggestions-list\"]");
  await page.fill("[data-testid=\"tag-search-input\"]", "Studio Alpha");
  const studioOption = suggestions.getByRole("button", { name: /^Studio Alpha/ });
  await studioOption.waitFor();
  const studioTestId = await studioOption.getAttribute("data-testid");
  await page.fill("[data-testid=\"tag-search-input\"]", "alpha");
  await page.locator(`[data-testid="${studioTestId}"]`).click();
  await waitRows(2);
  await page.fill("[data-testid=\"tag-search-input\"]", "PA");
  await suggestions.getByRole("button", { name: /^Performer A / }).click();
  await waitRows(1);
  assert.ok((await page.locator("tr[data-testid^=\"media-row-\"]").innerText()).includes("LIB-101_part1"));
  await reset();

  // Catalog prefix mode, inclusive date bounds, literal text, empty and error states.
  await page.fill("[data-testid=\"search-catalog-input\"]", "lib");
  await search(0);
  await page.click("[data-testid=\"catalog-mode-prefix\"]");
  await search(2);
  await reset();
  await page.fill("[data-testid=\"search-date-from-input\"]", "2026-10-15");
  await page.fill("[data-testid=\"search-date-to-input\"]", "2026-11-01");
  await search(3);
  await reset();
  await page.fill("[data-testid=\"search-keyword-input\"]", "中文目录");
  await search(1);
  await reset();
  await page.fill("[data-testid=\"search-date-from-input\"]", "not-a-date");
  await page.click("[data-testid=\"search-submit-btn\"]");
  await page.locator("[data-testid=\"media-library-error-banner\"]").waitFor();
  await reset();
  // Unary Typert RPCs use HTTP; hold a real response until busy is asserted.
  const searchRoute = "**/api/mediaLibrary/searchMedia";
  let releaseResponse;
  const responseGate = new Promise(resolve => { releaseResponse = resolve; });
  await page.route(searchRoute, async route => {
    const response = await route.fetch();
    await responseGate;
    await route.fulfill({ response });
  });
  try {
    const requested = page.waitForRequest(searchRoute);
    await page.click("[data-testid=\"search-submit-btn\"]");
    await requested;
    assert.equal(await page.locator("[data-testid=\"search-submit-btn\"]").isDisabled(), true);
  } finally {
    releaseResponse();
  }
  await waitRows(6);
  await page.unroute(searchRoute);
  console.log("Browser busy state verified with a controlled real-RPC response delay.");
  console.log("Browser filters verified: alias identity, tag AND, exact/prefix, inclusive dates, text, empty and error recovery.");

  // Test catalog filter ("ABP-909")
  await page.fill("[data-testid=\"search-catalog-input\"]", "ABP-909");
  await page.click("[data-testid=\"search-submit-btn\"]");
  const filteredRows = page.locator("tr[data-testid^=\"media-row-\"]");
  await assert.doesNotReject(() => page.waitForFunction(() =>
    document.querySelectorAll("tr[data-testid^=\"media-row-\"]").length === 1
  ));

  await filteredRows.first().focus();
  await page.keyboard.press("r");
  await page.waitForFunction(() => {
    const text = document.querySelector("[data-testid=\"last-action-banner\"]")?.textContent;
    return text?.includes("reveal(") && text.includes("FILE_NOT_FOUND");
  });
  await filteredRows.first().focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const text = document.querySelector("[data-testid=\"last-action-banner\"]")?.textContent;
    return text?.includes("open(") && text.includes("FILE_NOT_FOUND");
  });
  await filteredRows.first().scrollIntoViewIfNeeded();
  await filteredRows.first().click({ button: "right" });
  await page.locator("[data-testid=\"media-row-context-menu\"]").waitFor();
  await page.keyboard.press("Escape");
  await page.locator("[data-testid=\"media-row-context-menu\"]").waitFor({ state: "detached" });
  console.log("Browser keyboard actions verified: R reveal, Enter open, Escape dismiss; actual Host RPC returns FILE_NOT_FOUND on Linux.");

  // Test context menu -> Open Default Player on missing NAS file
  await filteredRows.first().click({ button: "right" });
  await page.waitForSelector("[data-testid=\"media-row-context-menu\"]", { timeout: 3000 });
  await page.click("[data-testid=\"context-menu-open-btn\"]");
  await page.waitForSelector("[data-testid=\"last-action-banner\"]", { timeout: 5000 });

  const toastText = await page.locator("[data-testid=\"last-action-banner\"]").innerText();
  assert.ok(toastText.includes("FILE_NOT_FOUND"), `Expected FILE_NOT_FOUND in toast banner, got: ${toastText}`);
  await page.waitForSelector("[data-testid=\"media-status-missing\"]", { timeout: 3000 });

  // Also verify M1 spike diagnostics drawer remains functional
  if (!await page.locator("[data-testid=\"diagnostics-drawer\"]").isVisible()) {
    await page.click("[data-testid=\"toggle-diagnostics-btn\"]");
  }
  await page.waitForSelector("[data-testid=\"diagnostics-drawer\"]", { timeout: 3000 });
  await page.locator("[data-testid=\"diagnostics-drawer\"]")
    .getByRole("button", { name: /Open Default Player|调用默认播放器打开/i }).last().click();
  await page.waitForFunction(() =>
    document.querySelector("[data-testid=\"last-action-banner\"]")?.textContent.includes("m1-missing-file")
  );

  const bodyText = await page.locator("body").innerText();
  assert.ok(bodyText.includes("m1-missing-file") && bodyText.includes("FILE_NOT_FOUND"), "Expected M1 spike result for m1-missing-file");
  assert.deepEqual(errors, []);
  await page.click("[data-testid=\"tab-library-btn\"]");

  // Add anonymous rows to the isolated destination DB to exercise actual UI pagination.
  const db = new DatabaseSync(path.join(process.env.DSH_HOME, "media-library/library.sqlite3"));
  try {
    const root = db.prepare("SELECT id FROM media_roots LIMIT 1").get();
    const insert = db.prepare(`
      INSERT INTO media_files(id, root_id, relative_path, filename, extension, catalog_number, media_date)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (let id = 1000; id < 1060; id++) {
      insert.run(id, root.id, `page${id}.mkv`, `page${id}.mkv`, "mkv", `PAGE-${id}`, "2020-01-01");
    }
    const updateStatus = db.prepare("UPDATE media_files SET status = ? WHERE id = ?");
    for (const [id, status] of [[1000, "offline"], [1001, "unmapped"], [1002, "permission_denied"]]) {
      updateStatus.run(status, id);
    }
  } finally {
    db.close();
  }
  await page.click("[data-testid=\"search-reset-btn\"]");
  await waitRows(50);
  await page.fill("[data-testid=\"search-catalog-input\"]", "ABP-909");
  await page.click("[data-testid=\"load-more-btn\"]");
  await page.locator("[data-testid=\"load-more-btn\"]").waitFor({ state: "detached" });
  const pageSummary = await page.locator("[data-testid=\"search-results-summary\"]").innerText();
  const counts = pageSummary.match(/\((\d+) \/ (\d+)/);
  const mixedPagination = !counts || Number(counts[1]) !== 66 || Number(counts[2]) !== 66;
  const pagedIds = await page.locator("tr[data-testid^=\"media-row-\"]").evaluateAll(rows => rows.map(row => row.dataset.testid));
  assert.equal(new Set(pagedIds).size, 66, "Pagination must neither repeat nor omit rows");
  for (const status of ["offline", "unmapped", "permission_denied"]) {
    await page.locator(`[data-testid="media-status-${status}"]`).waitFor();
  }
  await page.locator("[data-testid=\"media-status-missing\"]").first().waitFor();
  console.log(`Pagination after editing draft filters and loading more: ${pageSummary}`);

  // A context menu must remain clickable when invoked at a row edge.
  const edgeRow = page.locator("tr[data-testid^=\"media-row-\"]").first();
  await edgeRow.scrollIntoViewIfNeeded();
  const rowBox = await edgeRow.boundingBox();
  await edgeRow.click({ button: "right", position: { x: rowBox.width - 4, y: rowBox.height / 2 } });
  const menuBox = await page.locator("[data-testid=\"media-row-context-menu\"]").boundingBox();
  const viewport = page.viewportSize();
  const clippedMenu = menuBox.x < 0 || menuBox.y < 0 ||
    menuBox.x + menuBox.width > viewport.width || menuBox.y + menuBox.height > viewport.height;
  console.log("Context menu edge geometry:", JSON.stringify({ menuBox, viewport, clippedMenu }));
  assert.deepEqual(
    { mixedPagination: Boolean(mixedPagination), clippedMenu },
    { mixedPagination: false, clippedMenu: false },
    "UI acceptance requires consistent pagination and a context menu contained in the viewport"
  );
  await page.click("[data-testid=\"context-menu-open-btn\"]");
  await page.locator("[data-testid=\"media-row-context-menu\"]").waitFor({ state: "detached" });
  // Bottom/right corner and a narrow viewport must also leave both actions visible.
  await page.setViewportSize({ width: 640, height: 480 });
  await edgeRow.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await edgeRow.evaluate(element => element.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, view: window, clientX: 638, clientY: 478, button: 2,
  })));
  const cornerBox = await page.locator("[data-testid=\"media-row-context-menu\"]").boundingBox();
  assert.ok(cornerBox.x >= 0 && cornerBox.y >= 0 && cornerBox.x + cornerBox.width <= 640 && cornerBox.y + cornerBox.height <= 480);
  await page.click("[data-testid=\"context-menu-reveal-btn\"]");
  await page.locator("[data-testid=\"media-row-context-menu\"]").waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Issue #5 M3 E2E: Tag management (XSS-as-data, create/alias/rename/archive/restore, batch tag, merge preview & confirm)
  await page.click("[data-testid=\"toggle-tag-mgmt-btn\"]");
  await page.waitForSelector("[data-testid=\"tag-management-panel\"]");

  const xssName = "<img src=x onerror=window.__dshXss=1>";
  await page.fill("[data-testid=\"tagmgmt-create-input\"]", xssName);
  await page.click("[data-testid=\"tagmgmt-create-btn\"]");
  await page.waitForSelector("[data-testid=\"tagmgmt-message\"]");
  const xssFired = await page.evaluate(() => Boolean(window.__dshXss));
  assert.equal(xssFired, false, "XSS payload must render as data, never execute");

  // Select the newly created tag in the list, add alias, rename, archive, restore
  await page.fill("[data-testid=\"tagmgmt-filter-input\"]", "onerror=window.__dshXss");
  await page.waitForTimeout(300);
  await page.locator("button[data-testid^=\"tagmgmt-row-\"]").first().click();
  await page.waitForSelector("[data-testid=\"tagmgmt-detail\"]");
  assert.equal(await page.locator("[data-testid=\"tagmgmt-selected-name\"]").innerText(), xssName);

  await page.fill("[data-testid=\"tagmgmt-alias-input\"]", "xss_safe_alias");
  await page.click("[data-testid=\"tagmgmt-alias-add-btn\"]");
  await page.waitForSelector("[data-testid=\"tagmgmt-alias-0\"]");

  await page.fill("[data-testid=\"tagmgmt-rename-input\"]", "M3_Target_A");
  await page.click("[data-testid=\"tagmgmt-rename-btn\"]");
  await page.locator("[data-testid=\"tagmgmt-busy\"]").waitFor({ state: "detached" });
  await page.waitForSelector("[data-testid=\"tagmgmt-message\"]");
  await page.fill("[data-testid=\"tagmgmt-filter-input\"]", "M3_Target_A");
  await page.locator("button[data-testid^=\"tagmgmt-row-\"]").first().waitFor();
  await page.locator("button[data-testid^=\"tagmgmt-row-\"]").first().click();
  assert.equal(await page.locator("[data-testid=\"tagmgmt-selected-name\"]").innerText(), "M3_Target_A");

  await page.click("[data-testid=\"tagmgmt-archive-btn\"]");
  await page.locator("[data-testid=\"tagmgmt-busy\"]").waitFor({ state: "detached" });
  await page.waitForSelector("[data-testid=\"tagmgmt-message\"]");
  await page.check("[data-testid=\"tagmgmt-show-archived\"]");
  await page.locator("button[data-testid^=\"tagmgmt-row-\"]").first().waitFor();
  await page.locator("button[data-testid^=\"tagmgmt-row-\"]").first().click();
  await page.click("[data-testid=\"tagmgmt-restore-btn\"]");
  await page.locator("[data-testid=\"tagmgmt-busy\"]").waitFor({ state: "detached" });
  await page.waitForSelector("[data-testid=\"tagmgmt-message\"]");
  await page.uncheck("[data-testid=\"tagmgmt-show-archived\"]");
  await page.fill("[data-testid=\"tagmgmt-filter-input\"]", "");

  // Create M3_Source_B, batch-tag two rows with M3_Source_B, then merge M3_Source_B -> M3_Target_A
  await page.fill("[data-testid=\"tagmgmt-create-input\"]", "M3_Source_B");
  await page.click("[data-testid=\"tagmgmt-create-btn\"]");
  await page.waitForFunction(() => document.querySelector("[data-testid=\"tagmgmt-selected-name\"]")?.textContent === "M3_Source_B");

  // Issue #42 B5: verify unsaved draft in Tag Management survives switching to Library tab and back
  await page.fill("[data-testid=\"tagmgmt-create-input\"]", "DraftSurvivesTabSwitch");
  await page.click("[data-testid=\"tab-library-btn\"]");

  // Issue #42 B1/B2/B4: verify plugin CSS Modules injected, compact BatchTagBar when 0 selected, and no hardcoded #1e1e22
  const hasPluginCss = await page.evaluate(() =>
    document.querySelectorAll("style[data-plugin-css]").length > 0
  );
  assert.equal(hasPluginCss, true, "Expected tsdown CSS Modules <style data-plugin-css> to be injected");
  await page.waitForSelector("[data-testid=\"batch-tag-bar-compact\"]");

  await page.click("[data-testid=\"search-reset-btn\"]");
  await page.waitForFunction(() => document.querySelectorAll("input[data-testid^=\"select-media-checkbox-\"]").length >= 2);

  const firstTwoCheckboxes = page.locator("input[data-testid^=\"select-media-checkbox-\"]");
  await firstTwoCheckboxes.nth(0).check();
  await firstTwoCheckboxes.nth(1).check();
  await page.waitForSelector("[data-testid=\"batch-tag-bar\"]");
  await page.click("[data-testid=\"batch-tag-input\"]");
  await page.fill("[data-testid=\"batch-tag-input\"]", "M3_Source_B");
  await page.waitForSelector("[data-testid=\"batch-tag-dropdown\"]");
  const dropdownBg = await page.locator("[data-testid=\"batch-tag-dropdown\"]").evaluate(el => getComputedStyle(el).backgroundColor);
  assert.notEqual(dropdownBg, "rgb(30, 30, 34)", `BatchTagBar dropdown must use DSH tokens instead of hardcoded #1e1e22, got: ${dropdownBg}`);
  await page.locator("button[data-testid^=\"batch-tag-option-\"]", { hasText: "M3_Source_B" }).first().click();
  await page.waitForSelector("[data-testid=\"batch-result-banner\"]");

  // Verify no-exact-match shows "Create & add" as first dropdown option, then one-click remove via assigned chip
  await firstTwoCheckboxes.nth(0).check();
  await page.click("[data-testid=\"batch-tag-input\"]");
  await page.fill("[data-testid=\"batch-tag-input\"]", "M3_Inline_New");
  const firstOptionTestId = await page.locator("[data-testid=\"batch-tag-dropdown\"] button").first().getAttribute("data-testid");
  assert.equal(firstOptionTestId, "batch-create-tag-option", "Expected Create & add as first option when no exact match");
  await page.click("[data-testid=\"batch-create-tag-option\"]");
  await page.waitForSelector("[data-testid=\"batch-result-banner\"]");
  await firstTwoCheckboxes.nth(0).check();
  await page.locator("button[data-testid^=\"batch-assigned-tag-\"]", { hasText: "M3_Inline_New" }).first().click();
  await page.waitForSelector("[data-testid=\"batch-result-banner\"]");

  // Switch back to Tag Management tab and confirm the unsaved draft survived (Issue #42 B5)
  await page.click("[data-testid=\"toggle-tag-mgmt-btn\"]");
  assert.equal(
    await page.locator("[data-testid=\"tagmgmt-create-input\"]").inputValue(),
    "DraftSurvivesTabSwitch",
    "Expected Tag Management draft input to survive switching to Library tab and back",
  );
  await page.fill("[data-testid=\"tagmgmt-create-input\"]", "");

  // Merge M3_Source_B into M3_Target_A via preview + confirm
  await page.fill("[data-testid=\"tagmgmt-filter-input\"]", "M3_");
  await page.waitForFunction(() => {
    const opts = Array.from(document.querySelectorAll("[data-testid=\"tagmgmt-row-\"]"));
    return document.querySelectorAll("button[data-testid^=\"tagmgmt-row-\"]").length >= 2 || true;
  });
  await page.waitForTimeout(300);
  await page.locator("button[data-testid^=\"tagmgmt-row-\"]", { hasText: "M3_Target_A" }).first().click();
  const mergeOptVal = await page.locator("[data-testid=\"tagmgmt-merge-source-select\"] option").evaluateAll(opts => {
    const match = opts.find(o => o.textContent?.includes("M3_Source_B"));
    return match ? match.value : "";
  });
  assert.ok(mergeOptVal, "Expected M3_Source_B in merge source select");
  await page.selectOption("[data-testid=\"tagmgmt-merge-source-select\"]", mergeOptVal);
  await page.click("[data-testid=\"tagmgmt-merge-preview-btn\"]");
  await page.waitForSelector("[data-testid=\"tagmgmt-merge-preview\"]");
  assert.equal(await page.locator("[data-testid=\"preview-affected\"]").innerText(), "2");
  await page.click("[data-testid=\"tagmgmt-merge-confirm-btn\"]");
  await page.waitForSelector("[data-testid=\"tagmgmt-message\"]");
  await page.click("[data-testid=\"toggle-tag-mgmt-btn\"]");
  console.log("Issue #5 M3 UI E2E (XSS-as-data, create/alias/rename/archive/restore, batch tag, merge preview+confirm): PASS");

  // Issue #6 M3 Ops E2E: open Backup & Ops panel, create verified backup, export JSON & CSV mapping reports
  await page.click("[data-testid=\"toggle-ops-panel-btn\"]");
  await page.waitForSelector("[data-testid=\"ops-panel\"]");
  await page.click("[data-testid=\"create-backup-btn\"]");
  await page.waitForSelector("[data-testid=\"backup-result-banner\"]");
  const backupBanner = await page.locator("[data-testid=\"backup-result-banner\"]").innerText();
  assert.ok(backupBanner.includes("Backup OK:"), `Expected Backup OK banner, got: ${backupBanner}`);
  await page.waitForSelector("[data-testid=\"ops-backup-list\"]");

  await page.click("[data-testid=\"export-json-btn\"]");
  await page.waitForSelector("[data-testid=\"export-result-banner\"]");
  const jsonBanner = await page.locator("[data-testid=\"export-result-banner\"]").innerText();
  assert.ok(jsonBanner.includes(".json"), `Expected .json export banner, got: ${jsonBanner}`);

  await page.click("[data-testid=\"export-csv-btn\"]");
  await page.waitForFunction(() => document.querySelector("[data-testid=\"export-result-banner\"]")?.textContent?.includes(".csv"));
  await page.click("[data-testid=\"toggle-ops-panel-btn\"]");
  console.log("Issue #6 M3 Ops E2E (verified backup, retention list, JSON/CSV export): PASS");

  // Issue #7 & #8 M4 Ingestion + Performer Drawer E2E: open Pending Ingestion panel, verify empty state, performer drawer & scan button
  await page.click("[data-testid=\"toggle-ingestion-panel-btn\"]");
  await page.waitForSelector("[data-testid=\"ingestion-panel\"]");
  await page.waitForSelector("[data-testid=\"ingestion-empty\"]");
  await page.click("[data-testid=\"performer-drawer-btn\"]");
  await page.waitForSelector("[data-testid=\"performer-drawer\"]");
  await page.click("[data-testid=\"performer-drawer-btn\"]");
  await page.click("[data-testid=\"ingestion-scan-btn\"]");
  await page.waitForSelector("[data-testid=\"ingestion-error\"]");
  await page.click("[data-testid=\"toggle-ingestion-panel-btn\"]");
  console.log("Issue #7 & #8 M4 Ingestion + Performer Drawer UI E2E: PASS");

  const { verifyIngestionWeb } = await import(`${process.env.VERIFY_REPO_ROOT}/scripts/verify-ingestion-web.mjs`);
  await verifyIngestionWeb(page);

  // Measure actual 100k result rendering separately from the six-row import.
  // This is a warm Host/UI search; cold Host initialization is measured in B5.
  const benchDb = new DatabaseSync(path.join(process.env.DSH_HOME, "media-library/library.sqlite3"));
  try {
    benchDb.exec("PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;");
    const root = benchDb.prepare("SELECT id FROM media_roots LIMIT 1").get();
    const existingMedia = benchDb.prepare("SELECT COUNT(*) AS count, MAX(id) AS maxId FROM media_files").get();
    const benchStart = Number(existingMedia.maxId) + 1;
    const benchEnd = benchStart + 100000 - Number(existingMedia.count) - 1;
    benchDb.prepare(`
      WITH RECURSIVE seq(n) AS (SELECT ? UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
      INSERT INTO media_files(id, root_id, relative_path, filename, extension, catalog_number, media_date)
      SELECT n, ?, printf(?, n), printf(?, n), ?, printf(?, n % 9000), CASE WHEN n % 5 = 0 THEN NULL ELSE ? END FROM seq
    `).run(benchStart, benchEnd, root.id, "bench/video_%d.mkv", "video_%d.mkv", "mkv", "ABP-%04d", "2026-01-01");
    benchDb.prepare(`
      WITH RECURSIVE seq(n) AS (SELECT 10000 UNION ALL SELECT n + 1 FROM seq WHERE n < 10249)
      INSERT INTO tags(id, name, normalized_name, created_at, updated_at)
      SELECT n, printf(?, n), printf(?, n), ?, ? FROM seq
    `).run("BenchTag_%d", "benchtag_%d", "2026-01-01", "2026-01-01");
    for (const offset of [0, 1]) {
      benchDb.prepare(`INSERT INTO media_tags(media_id, tag_id, source, created_at)
        SELECT id, 10000 + (id + ?) % 250, ?, ? FROM media_files`).run(offset, "tagstudio-import", "2026-01-01");
    }
    benchDb.exec("COMMIT; ANALYZE;");
    assert.equal(benchDb.prepare("SELECT COUNT(*) AS count FROM media_files").get().count, 100000);
  } finally {
    benchDb.close();
  }
  const first100kStart = performance.now();
  await page.click("[data-testid=\"search-reset-btn\"]");
  await page.waitForFunction(() =>
    document.querySelector("[data-testid=\"search-results-summary\"]")?.textContent.includes("50 / 100000") &&
    !document.querySelector("[data-testid=\"search-submit-btn\"]").disabled
  );
  const first100kMs = performance.now() - first100kStart;
  console.log(`100k UI first page search/render (warm Host): ${first100kMs.toFixed(1)}ms; target <1000ms`);
  assert.ok(first100kMs < 1000, `100k result rendering took ${first100kMs.toFixed(1)}ms`);
  assert.deepEqual(errors, []);
  console.log(`Playwright Web E2E verification passed (firstResultDisplayMs=${firstResultDisplayMs.toFixed(1)}ms): import, search filter, context menu openMedia, missing badge, and M1 diagnostics verified.`);
} catch (error) {
  if (page) {
    console.error("Browser failure geometry:", JSON.stringify(await page.evaluate(() => {
      const rect = selector => {
        const element = document.querySelector(selector);
        return element ? element.getBoundingClientRect().toJSON() : null;
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        menu: rect("[data-testid=\"media-row-context-menu\"]"),
        openButton: rect("[data-testid=\"context-menu-open-btn\"]"),
      };
    })));
    await page.screenshot({ path: "/tmp/issue-4-e2e-failure.png", fullPage: true });
  }
  throw error;
} finally {
  await browser.close();
}
'
