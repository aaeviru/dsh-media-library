import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/** Real cold-installed Host/Remote/UI; only the external rename boundary is held by the test preload. */
export async function verifyIngestionWeb(page) {
  const work = process.env.VERIFY_WORK;
  const staging = path.join(work, 'staging');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'issue30-slow.mp4'), 'non-production video fixture');
  fs.writeFileSync(path.join(staging, 'issue30-other.mp4'), 'another fixture');
  await page.click('[data-testid="toggle-ingestion-panel-btn"]');
  await page.click('[data-testid="ingestion-scan-btn"]');
  await page.getByTestId('ingestion-file-issue30-slow.mp4').click();
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
  await page.getByTestId('ingestion-file-issue30-other.mp4').click();
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
  assert.equal(fs.existsSync(path.join(work, '\\\\NAS\\MediaTest\\ingested\\issue30-slow.mp4')), true);

  await page.getByTestId('toggle-ingestion-panel-btn').click();
  console.log('Issue #30 cold-install E2E: actual task, busy feedback, frozen inputs, other-item review, navigation/reload, 30s warning, disconnected-operation completion: PASS (controlled local rename; no Windows/SMB claim)');
}
