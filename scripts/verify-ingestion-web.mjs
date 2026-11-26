import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Real cold-installed Host/Remote/UI; only the external rename boundary is held by the test preload. */
export async function verifyIngestionWeb(page) {
  const work = process.env.VERIFY_WORK;
  const staging = path.join(work, 'staging');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'issue30-slow.mp4'), 'non-production video fixture');
  fs.writeFileSync(path.join(staging, 'issue30-other.mp4'), 'another fixture');
  fs.writeFileSync(path.join(staging, 'issue39-switch.mp4'), 'switch fixture');
  await page.click('[data-testid="toggle-ingestion-panel-btn"]');
  await page.click('[data-testid="ingestion-scan-btn"]');

  // Issue #39 B1 & B2: select an unmanifested file (key `f:<tempPath>`), switch away while
  // the Host creates its manifest with unsorted tags (new before existing), then switch back
  // and verify selection stays active and `ingestion-tags-input` matches the sorted pill order.
  await page.getByTestId('ingestion-file-issue39-switch.mp4').click();
  await page.getByTestId('ingestion-detail').waitFor();

  // Issue #49 B1 & B2: verify side-by-side Master-Detail layout on 1440x900 desktop viewport
  // and verify TagPicker autocomplete/create appends tags into ingestion-tags-input without duplicates.
  const listBox = await page.getByTestId('ingestion-manifest-list').boundingBox();
  const detailBox = await page.getByTestId('ingestion-detail').boundingBox();
  assert.ok(
    listBox && detailBox && detailBox.x >= listBox.x + listBox.width - 4,
    `Expected side-by-side Master-Detail layout on 1440px viewport, got list=${JSON.stringify(listBox)} detail=${JSON.stringify(detailBox)}`,
  );
  await page.getByTestId('ingestion-tag-picker-input').click();
  await page.getByTestId('ingestion-tag-picker-input').fill('Stage3PickedTag');
  await page.getByTestId('ingestion-tag-picker-dropdown').waitFor();
  await page.keyboard.press('Enter');
  assert.equal(await page.getByTestId('ingestion-tags-input').inputValue(), 'Stage3PickedTag');
  await page.waitForFunction(
    () => {
      const pills = Array.from(document.querySelectorAll('[data-testid="ingestion-tag-preview"] > span'));
      const pill = pills.find((el) => el.getAttribute('data-tag-name') === 'Stage3PickedTag');
      return pill?.getAttribute('data-match-state') === 'new';
    },
    undefined,
    { timeout: 5000 },
  );

  // Issue #71 B1 & B2: verify immediate existing-tag badge on TagPicker selection (while previewTagNames
  // is explicitly held) and authoritative existing / alias / new badges + ordering for manually entered
  // case/whitespace variants.
  const db71 = new DatabaseSync(path.join(process.env.DSH_HOME, 'media-library/library.sqlite3'));
  let pickerExistingTag;
  let manualExistingTag;
  const issue71AliasStored = 'Issue71 Alias Probe';
  const issue71AliasNorm = issue71AliasStored.trim().replace(/\s+/g, ' ').toLowerCase();
  const issue71AliasTyped = 'issue71   ALIAS   probe';
  try {
    const activeTags = db71
      .prepare('SELECT id, name FROM tags WHERE archived_at IS NULL ORDER BY id ASC LIMIT 2')
      .all();
    assert.ok(activeTags.length >= 1, 'Expected at least 1 active tag in library.sqlite3 for Issue #71 verification');
    pickerExistingTag = activeTags[0];
    manualExistingTag = activeTags[1] ?? activeTags[0];
    db71
      .prepare('INSERT OR IGNORE INTO tag_aliases (tag_id, alias, normalized_alias) VALUES (?, ?, ?)')
      .run(pickerExistingTag.id, issue71AliasStored, issue71AliasNorm);
  } finally {
    db71.close();
  }

  // B1: Hold previewTagNames until we have verified the immediate existing badge on TagPicker selection.
  let releaseB1Preview;
  const b1PreviewHeld = new Promise((resolve) => {
    releaseB1Preview = resolve;
  });
  let markB1PreviewIntercepted;
  const b1PreviewIntercepted = new Promise((resolve) => {
    markB1PreviewIntercepted = resolve;
  });
  let b1PreviewResponded = false;
  const b1ContinuePromises = [];
  const b1PreviewRoute = async (route) => {
    markB1PreviewIntercepted();
    const done = (async () => {
      await b1PreviewHeld;
      await route.continue();
      b1PreviewResponded = true;
    })();
    b1ContinuePromises.push(done);
    await done;
  };
  await page.route('**/api/mediaLibrary/previewTagNames', b1PreviewRoute);
  try {
    await page.getByTestId('ingestion-tags-input').fill('');
    await page.getByTestId('ingestion-tag-picker-input').click();
    await page.getByTestId('ingestion-tag-picker-input').fill(pickerExistingTag.name);
    const existingOption = page.getByTestId(`ingestion-tag-picker-option-${pickerExistingTag.id}`);
    await existingOption.waitFor({ timeout: 5000 });
    await existingOption.click();

    await page.waitForFunction(
      (targetName) => {
        const pills = Array.from(document.querySelectorAll('[data-testid="ingestion-tag-preview"] > span'));
        return pills.some((el) => el.getAttribute('data-tag-name') === targetName);
      },
      pickerExistingTag.name,
      { timeout: 5000 },
    );
    assert.equal(b1PreviewResponded, false, 'previewTagNames must still be held during immediate B1 assertion');
    const immediateB1Pill = await page.evaluate((targetName) => {
      const pills = Array.from(document.querySelectorAll('[data-testid="ingestion-tag-preview"] > span'));
      const pill = pills.find((el) => el.getAttribute('data-tag-name') === targetName);
      if (!pill) return null;
      return {
        matchState: pill.getAttribute('data-match-state'),
        text: pill.textContent ?? '',
      };
    }, pickerExistingTag.name);
    assert.ok(immediateB1Pill, `Expected immediate pill for picked existing tag "${pickerExistingTag.name}"`);
    assert.equal(
      immediateB1Pill.matchState,
      'name',
      `Expected immediate 'name' badge while previewTagNames is held, got ${JSON.stringify(immediateB1Pill)}`,
    );
    assert.match(immediateB1Pill.text, /(Existing|已有)/, `Expected Existing/已有 badge text, got: ${immediateB1Pill.text}`);
    assert.doesNotMatch(immediateB1Pill.text, /\+\s*(New|新建)/, `Picked existing tag must never display + New/+ 新建: ${immediateB1Pill.text}`);

    // Confirm the client actually fires previewTagNames to the intercepted route while the badge stays 'name'.
    await Promise.race([
      b1PreviewIntercepted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for held previewTagNames request')), 5000)),
    ]);
    assert.equal(b1PreviewResponded, false, 'previewTagNames must remain held until explicitly released');
    const stillHeldB1State = await page.evaluate((targetName) => {
      const pills = Array.from(document.querySelectorAll('[data-testid="ingestion-tag-preview"] > span'));
      return pills.find((el) => el.getAttribute('data-tag-name') === targetName)?.getAttribute('data-match-state') ?? null;
    }, pickerExistingTag.name);
    assert.equal(stillHeldB1State, 'name', 'Expected picked tag badge to remain name while previewTagNames is held');
  } finally {
    releaseB1Preview();
    await Promise.allSettled(b1ContinuePromises);
    await page.unroute('**/api/mediaLibrary/previewTagNames', b1PreviewRoute);
  }

  // B2: Clear draft (resetting caches) and manually enter unsorted new + case/whitespace alias + case/whitespace existing tag.
  const manualTagVariant = (() => {
    const toggled =
      manualExistingTag.name.toUpperCase() !== manualExistingTag.name
        ? manualExistingTag.name.toUpperCase()
        : manualExistingTag.name.toLowerCase();
    return toggled.replace(/\s+/g, '   ');
  })();
  await page.getByTestId('ingestion-tags-input').fill('');
  await page
    .getByTestId('ingestion-tags-input')
    .fill(`Stage3TrulyNew71,   ${issue71AliasTyped}  ,  ${manualTagVariant}  `);
  await page.waitForFunction(
    () => {
      const pills = Array.from(document.querySelectorAll('[data-testid="ingestion-tag-preview"] > span'));
      if (pills.length !== 3) return false;
      return pills.every((el) => {
        const st = el.getAttribute('data-match-state');
        return st === 'name' || st === 'alias' || st === 'new';
      });
    },
    undefined,
    { timeout: 5000 },
  );
  const manualB2Pills = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="ingestion-tag-preview"] > span')).map((el) => ({
      tagName: el.getAttribute('data-tag-name'),
      matchState: el.getAttribute('data-match-state'),
      text: el.textContent ?? '',
    })),
  );
  assert.deepEqual(
    manualB2Pills.map((p) => ({ tagName: p.tagName, matchState: p.matchState })),
    [
      { tagName: manualTagVariant.trim(), matchState: 'name' },
      { tagName: issue71AliasTyped, matchState: 'alias' },
      { tagName: 'Stage3TrulyNew71', matchState: 'new' },
    ],
    `Expected manually entered tags to resolve and sort name -> alias -> new, got: ${JSON.stringify(manualB2Pills)}`,
  );
  assert.match(manualB2Pills[0].text, /(Existing|已有)/);
  assert.match(manualB2Pills[1].text, /(Alias|别名)→/);
  assert.ok(
    manualB2Pills[1].text.includes(pickerExistingTag.name),
    `Expected alias pill to display canonical name "${pickerExistingTag.name}", got: ${manualB2Pills[1].text}`,
  );
  assert.match(manualB2Pills[2].text, /\+\s*(New|新建)/);

  // Clean up Issue #71 probe alias and clear draft so Issue #39 serverFallback test below runs on clean state.
  const db71Cleanup = new DatabaseSync(path.join(process.env.DSH_HOME, 'media-library/library.sqlite3'));
  try {
    db71Cleanup.prepare('DELETE FROM tag_aliases WHERE normalized_alias = ?').run(issue71AliasNorm);
  } finally {
    db71Cleanup.close();
  }
  await page.getByTestId('ingestion-tags-input').fill('');
  console.log('Issue #71 cold-install E2E: B1 immediate TagPicker existing badge (held RPC) & B2 manual case/whitespace existing/alias/new badges + ordering: PASS');
  await page.getByTestId('toggle-ingestion-panel-btn').click();
  const db39 = new DatabaseSync(path.join(process.env.DSH_HOME, 'media-library/library.sqlite3'));
  try {
    const existingTag = db39.prepare('SELECT id, name FROM tags WHERE archived_at IS NULL ORDER BY id ASC LIMIT 1').get();
    const switchTemp = path.join(staging, 'issue39-switch.mp4');
    const nowIso = new Date().toISOString();
    db39.prepare(`
      INSERT INTO ingestion_manifests (
        source_id, temp_path, target_root_id, target_relative_path, filename,
        title, catalog_number, media_date, tags_json, metadata_source,
        checksum_sha256, file_size, state, review_decision, created_at, updated_at
      ) VALUES (?, ?, 'nas-main', 'ingested/issue39-switch.mp4', 'issue39-switch.mp4',
        'Issue 39 Survived Switch', 'ISSUE-39', '2026-11-20', ?, 'https://fc2cmadb.com/test',
        '', 14, 'planned', 'pending', ?, ?)
    `).run(
      'staging:ingested/issue39-switch.mp4:14',
      switchTemp,
      JSON.stringify([{ name: 'BrandNewTag39' }, { name: existingTag.name }]),
      nowIso,
      nowIso,
    );
    await page.getByTestId('toggle-ingestion-panel-btn').click();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="ingestion-title-input"]')?.value === 'Issue 39 Survived Switch'
    );
    const expectedTags = `${existingTag.name}, BrandNewTag39`;
    await page.waitForFunction(
      (expected) => document.querySelector('[data-testid="ingestion-tags-input"]')?.value === expected,
      expectedTags,
      { timeout: 5000 },
    );
    const inputVal = await page.getByTestId('ingestion-tags-input').inputValue();
    assert.equal(
      inputVal,
      expectedTags,
      `Expected ingestion-tags-input to sort existing tag before new tag, got: ${inputVal}`,
    );

    // Issue #45 B1, B2 & B4:
    // 1. Insert a stale unindexed manifest whose file does not exist in stagingDir, and an unindexed manifest
    //    for `issue30-other.mp4` that points to an outdated temp_path (`\\old-share\temp\issue30-other.mp4`) with `state = 'failed'`.
    // 2. Click Scan and verify:
    //    - The stale manifest is deleted from SQLite.
    //    - `issue30-other.mp4` rebinds to its current staging tempPath, clears `failed` -> `planned`, and keeps its title when selected!
    db39.prepare(`
      INSERT INTO ingestion_manifests (
        source_id, temp_path, target_root_id, target_relative_path, filename,
        title, catalog_number, media_date, tags_json, metadata_source,
        checksum_sha256, file_size, state, review_decision, last_error, created_at, updated_at
      ) VALUES
        ('staging:ingested/stale-removed.mp4:99', '\\\\old-share\\temp\\stale-removed.mp4', 'nas-main', 'ingested/stale-removed.mp4', 'stale-removed.mp4',
         'Stale Manifest Should Be Cleaned', 'STALE-45', '2026-11-20', '[]', NULL, '', 99, 'planned', 'pending', NULL, ?, ?),
        ('staging:old-subdir/issue30-other.mp4:15', '\\\\old-share\\temp\\issue30-other.mp4', 'nas-main', 'old-subdir/issue30-other.mp4', 'issue30-other.mp4',
         'Rebound From Old Share', 'ISSUE-45', '2026-11-21', '[]', 'https://fc2cmadb.com/articles/45', '', 15, 'failed', 'pending', 'Cross-device copy is disabled.', ?, ?)
    `).run(nowIso, nowIso, nowIso, nowIso);
  } finally {
    db39.close();
  }
  console.log('Issue #39 cold-install E2E: selection survives f:<tempPath> -> m:<id> across panel switch and tag input matches sorted pill order: PASS');

  await page.click('[data-testid="ingestion-scan-btn"]');
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="ingestion-message"]')?.textContent?.includes('Scanned')
  );
  const db45 = new DatabaseSync(path.join(process.env.DSH_HOME, 'media-library/library.sqlite3'));
  let reboundManifestId = null;
  try {
    const staleRow = db45.prepare("SELECT id FROM ingestion_manifests WHERE filename = 'stale-removed.mp4'").get();
    assert.equal(staleRow, undefined, 'Expected stale unindexed manifest to be cleaned up on Scan');
    const reboundRow = db45.prepare("SELECT id, temp_path, state, last_error, title FROM ingestion_manifests WHERE filename = 'issue30-other.mp4'").get();
    assert.ok(reboundRow, 'Expected unindexed manifest for issue30-other.mp4 to be preserved and rebound');
    assert.equal(reboundRow.temp_path, path.join(staging, 'issue30-other.mp4'));
    assert.equal(reboundRow.state, 'planned');
    assert.equal(reboundRow.last_error, null);
    reboundManifestId = Number(reboundRow.id);
  } finally {
    db45.close();
  }
  await page.getByTestId(`ingestion-row-${reboundManifestId}`).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="ingestion-title-input"]')?.value === 'Rebound From Old Share'
  );
  console.log('Issue #45 cold-install E2E: filename-bound manifest rebinding across stagingDir change and stale manifest cleanup on Scan: PASS');

  await page.getByTestId('ingestion-file-issue30-slow.mp4').click();
  // Issue #69 B5: live preview updates target path YYYY/MM as media_date draft changes; keep date for commit check
  await page.getByTestId('ingestion-date-input').fill('2024-08-15');
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="ingestion-target-preview"]')?.textContent?.trim() ===
      'ingested/2024/08/issue30-slow.mp4'
  );
  console.log('Issue #69 cold-install E2E: B5 live YYYY/MM target path preview updates with media_date draft: PASS');
  await page.getByTestId('ingestion-title-input').fill('Issue 30 controlled rename');
  const requested = page.waitForRequest('**/api/mediaLibrary/commitIngestion');
  await page.getByTestId('ingestion-commit-btn').click();
  const commitRequest = await requested;
  await page.getByTestId('ingestion-busy').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="ingestion-busy"]')?.textContent.includes('#'));
  assert.equal(fs.existsSync(path.join(work, 'rename-entered')), true);
  assert.equal(fs.existsSync(path.join(work, 'rename-release')), false);
  assert.equal(await page.getByTestId('ingestion-title-input').isDisabled(), true);
  assert.equal(await page.getByTestId('ingestion-date-input').isDisabled(), true);
  assert.equal(await page.getByTestId('ingestion-tags-input').isDisabled(), true);
  assert.equal(await page.getByTestId('ingestion-fetch-btn').isDisabled(), true);
  assert.equal(await page.getByTestId('ingestion-reconcile-btn').isDisabled(), true);

  // Replay a real encoded request through the same authenticated Remote route, without a test RPC.
  const busyResponse = await page.request.post(commitRequest.url(), {
    data: commitRequest.postDataJSON(), headers: commitRequest.headers(),
  });
  const busyPayload = await busyResponse.json();
  assert.match(JSON.stringify(busyPayload), /IN_PROGRESS/);
  assert.match(JSON.stringify(busyPayload), /activeTask/);

  // Other entries can still be prepared and reviewed while execution is serialized.
  await page.getByTestId(`ingestion-row-${reboundManifestId}`).click();
  assert.equal(await page.getByTestId('ingestion-title-input').isDisabled(), false);
  await page.getByTestId('ingestion-title-input').fill('Prepared during rename');
  await page.getByTestId('ingestion-approve-btn').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="ingestion-message"]')?.textContent.includes('Approve'));
  assert.equal(await page.getByTestId('ingestion-commit-btn').isDisabled(), true);

  // Unmount and remount, then abort the initiating HTTP connection with a full page reload.
  await page.getByTestId('toggle-ingestion-panel-btn').click();
  await page.getByTestId('toggle-ingestion-panel-btn').click();
  await page.getByTestId('ingestion-busy').waitFor();
  await page.reload({ waitUntil: 'load' });
  // DSH onboarding is scoped to the new page connection and can reopen on reload.
  await page.waitForTimeout(2000);
  for (let step = 0; step < 4; step++) {
    const dismiss = page.getByRole('button', { name: /Continue|Got it|Close|Skip|Later|继续|我知道了|关闭/i }).first();
    if (await dismiss.isVisible().catch(() => false)) {
      await dismiss.click({ force: true });
      await page.waitForTimeout(500);
    }
  }
  await page.locator('button[aria-label="Media Library"], button[aria-label="媒体库"]').first().click();
  await page.getByTestId('toggle-ingestion-panel-btn').click();
  await page.getByTestId('ingestion-busy').waitFor();
  await page.getByTestId('ingestion-waiting-warning').waitFor({ timeout: 40000 });
  assert.equal(fs.existsSync(path.join(staging, 'issue30-slow.mp4')), true);
  assert.equal(await page.getByTestId('ingestion-reconcile-btn').isDisabled(), true);
  fs.writeFileSync(path.join(work, 'rename-release'), 'release');
  await page.waitForFunction(() => document.querySelector('[data-testid="ingestion-message"]')?.textContent.includes('Ingested media'), undefined, { timeout: 10000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="ingestion-busy"]'));
  assert.equal(fs.existsSync(path.join(staging, 'issue30-slow.mp4')), false);
  assert.equal(fs.existsSync(path.join(staging, 'issue30-other.mp4')), true, 'rejected work was never queued');
  assert.equal(fs.existsSync(path.join(work, '\\\\NAS\\MediaTest\\ingested\\2024\\08\\issue30-slow.mp4')), true);

  await page.getByTestId('toggle-ingestion-panel-btn').click();
  console.log('Issue #30 cold-install E2E: actual task, busy feedback, frozen inputs, other-item review, navigation/reload, 30s warning, disconnected-operation completion: PASS (controlled local rename; no Windows/SMB claim)');
}
