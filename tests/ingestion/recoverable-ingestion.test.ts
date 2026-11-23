import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_MIGRATIONS, migrateDatabase } from '../../src/db/schema.ts';
import {
  commitIngestionManifest,
  defaultIngestionFileOps,
  ensureManifestForStagingFile,
  fetchMetadataForManifest,
  finishIngestionTask,
  listIngestionTasks,
  markInterruptedIngestionTasks,
  MetadataFetcher,
  parseCmadbHtml,
  parseFc2Code,
  parsePpvdbHtml,
  previewStagingPlan,
  reconcileIngestionManifests,
  reviewIngestionManifest,
  scanStagingDirectory,
  startIngestionTask,
  type IngestionFileOps,
} from '../../src/ingestion/index.ts';
import { MediaLibrarySpikeService } from '../../src/spike-service.ts';
import type { MediaRootConfig } from '../../src/types.ts';

function setupEnv(tmpDir: string) {
  const nasRoot = path.join(tmpDir, 'nas-root');
  const tempDir = path.join(nasRoot, 'temp');
  const targetDir = path.join(nasRoot, 'ingested');
  fs.mkdirSync(tempDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'library.sqlite3');
  const uncRoot = '\\\\NAS\\MediaTest';
  const roots: MediaRootConfig[] = [
    { rootId: 'nas-main', label: 'NAS Main', canonicalUncRoot: uncRoot, enabled: true },
  ];
  const mapPath = (p: string): string => {
    if (p.toLowerCase().startsWith(uncRoot.toLowerCase())) {
      const rel = p.slice(uncRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
      return rel ? path.join(nasRoot, rel) : nasRoot;
    }
    return p;
  };
  const fileOps: IngestionFileOps = {
    exists: (p) => defaultIngestionFileOps.exists(mapPath(p)),
    statSize: (p) => defaultIngestionFileOps.statSize(mapPath(p)),
    sha256: (p) => defaultIngestionFileOps.sha256(mapPath(p)),
    readRange: (p, offset, length) => defaultIngestionFileOps.readRange(mapPath(p), offset, length),
    ensureDir: (d) => defaultIngestionFileOps.ensureDir(mapPath(d)),
    rename: (src, dest) => defaultIngestionFileOps.rename(mapPath(src), mapPath(dest)),
    copyFile: (src, dest) => defaultIngestionFileOps.copyFile(mapPath(src), mapPath(dest)),
    removeFile: (p) => defaultIngestionFileOps.removeFile(mapPath(p)),
  };
  return { nasRoot, tempDir, targetDir, dbPath, roots, fileOps };
}

describe('Recoverable Media Ingestion & Metadata Fetcher (Issue #7 B1..B5)', () => {
  it('B1 & B2: schema v4 creates ingestion_manifests and pure async scan performs zero content reads or DB writes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ingest-b1-'));
    try {
      const { tempDir, dbPath, roots } = setupEnv(tmpDir);
      const sampleFile = path.join(tempDir, 'FC2-PPV-4545625.mp4');
      fs.writeFileSync(sampleFile, 'video-payload-1');

      const db = new DatabaseSync(dbPath);
      try {
        const mig = await migrateDatabase(db, { dbPath, appVersion: '0.6.0' });
        assert.equal(mig.currentVersion, 7);

        const dryRun = await previewStagingPlan({
          stagingDir: tempDir,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
        });
        assert.equal(dryRun.ok, true);
        assert.equal(dryRun.files.length, 1);
        assert.equal(dryRun.targetRelativePaths[0], 'ingested/FC2-PPV-4545625.mp4');

        const scan = await scanStagingDirectory(db, {
          stagingDir: tempDir,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
        });
        assert.equal(scan.ok, true);
        assert.equal(scan.files.length, 1);
        assert.equal(scan.files[0]!.manifestId, null);

        // Zero DB or file mutation after dry-run & scan.
        const count = Number((db.prepare('SELECT COUNT(*) AS c FROM ingestion_manifests').get() as { c: number }).c);
        assert.equal(count, 0);
        assert.equal(fs.existsSync(sampleFile), true);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('B3: parses FC2CMADB JSON & FC2PPVDB HTML fallback, retries transient HTTP, and respects auth walls', async () => {
    const code = parseFc2Code('sample FC2-PPV-4545625-1.mp4');
    assert.deepEqual(code, { videoId: '4545625', suffix: '1', code: 'FC2-PPV-4545625-1' });

    const cmadbHtml = `
      <html><body>
        <script data-page="app" type="application/json">
          {"props":{"article":{"video_id":"4545625","title":"Sample &amp; Title","writer":{"name":"CreatorA"},"tags":["Amateur",{"name":"1080p"}]}}}
        </script>
        <table class="table table-md p-1"><tbody>
          <tr><th>ID：</th><td>4545625</td></tr>
          <tr><th>販売者：</th><td><a href="https://fc2cmadb.com/writers/x">CreatorA</a></td></tr>
          <tr><th>女優：</th><td><a href="https://fc2cmadb.com/actresses/12502">ここあ</a></td></tr>
          <tr><th>販売日：</th><td>2026-11-13</td></tr>
          <tr><th>タグ：</th><td><a href="https://fc2cmadb.com/tags/a">ハメ撮り</a><a href="https://fc2cmadb.com/tags/b">中出し</a></td></tr>
        </tbody></table>
      </body></html>
    `;
    const okCmadb = parseCmadbHtml(cmadbHtml, '4545625', 'https://fc2cmadb.com/articles/4545625');
    assert.equal(okCmadb.category, 'ok');
    assert.equal(okCmadb.metadata?.title, 'Sample & Title');
    assert.deepEqual(okCmadb.metadata?.actresses, ['ここあ']);
    assert.equal(okCmadb.metadata?.mediaDate, '2026-11-13');
    assert.deepEqual(okCmadb.metadata?.candidateTags, ['ここあ', 'CreatorA', 'ハメ撮り', '中出し', 'Amateur', '1080p']);

    const inertiaOnlyHtml = `
      <html><body>
        <script data-page="app" type="application/json">
          {"props":{"actresses":[{"id":12502,"name":"ここあ"}],"article":{"video_id":"5006891","title":"Inertia Only","release_date":"2026-11-13","writer":{"name":"CreatorB"},"actress":{"name":"みなみ"},"tags":[{"name":"巨乳"}]}}}
        </script>
      </body></html>
    `;
    const okInertia = parseCmadbHtml(inertiaOnlyHtml, '5006891', 'https://fc2cmadb.com/articles/5006891');
    assert.equal(okInertia.category, 'ok');
    assert.deepEqual(okInertia.metadata?.actresses, ['みなみ', 'ここあ']);
    assert.deepEqual(okInertia.metadata?.candidateTags, ['みなみ', 'ここあ', 'CreatorB', '巨乳']);

    const loginHtml = '<html><body><form action="/login">メールアドレス</form></body></html>';
    assert.equal(parseCmadbHtml(loginHtml, '4545625', 'https://fc2cmadb.com/articles/4545625').category, 'auth_or_blocked');
    assert.equal(parsePpvdbHtml(loginHtml, '4545625', 'https://fc2ppvdb.com/articles/4545625').category, 'auth_or_blocked');

    const ppvdbHtml = '<html><head><meta property="og:title" content="FC2-PPV-4545625 Fallback Video Title - FC2PPVDB"></head></html>';
    const okPpvdb = parsePpvdbHtml(ppvdbHtml, '4545625', 'https://fc2ppvdb.com/articles/4545625');
    assert.equal(okPpvdb.category, 'ok');
    assert.equal(okPpvdb.metadata?.title, 'Fallback Video Title');

    let calls = 0;
    const fetcher = new MetadataFetcher({
      retries: 2,
      retryDelayMs: 0,
      requestDelayMs: 0,
      fetchImpl: async (url) => {
        calls += 1;
        if (url.includes('fc2cmadb.com')) {
          return { status: 404, ok: false, text: async () => 'Not Found' };
        }
        if (calls === 2) {
          return { status: 503, ok: false, text: async () => 'Retry' };
        }
        return { status: 200, ok: true, text: async () => ppvdbHtml };
      },
    });
    const res = await fetcher.lookup('4545625');
    assert.equal(res.metadata?.provider, 'FC2PPVDB');
    assert.equal(res.metadata?.title, 'Fallback Video Title');

    // Follow-up actress resolution from article.comments when cmadbCookie is present.
    const seenCookies: Array<string | undefined> = [];
    const cookieFetcher = new MetadataFetcher({
      cmadbCookie: 'fc2cmadb-session=test-token',
      retries: 1,
      requestDelayMs: 0,
      fetchImpl: async (url, init) => {
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        seenCookies.push(hdrs.Cookie);
        if (url.endsWith('/articles/5006891')) {
          return {
            status: 200,
            ok: true,
            text: async () => `
              <html><body><script data-page="app" type="application/json">
                {"props":{"article":{"video_id":5006891,"title":"Test 5006891","release_date":"2026-11-13","writer":{"name":"CreatorC"},"tags":[{"name":"巨乳"}],"comments":[{"body":"https://fc2cmadb.com/actresses/12502"}]}}}
              </script></body></html>
            `,
          };
        }
        if (url.endsWith('/actresses/12502')) {
          return {
            status: 200,
            ok: true,
            text: async () => `
              <html><body><script data-page="app" type="application/json">
                {"props":{"actress":{"id":12502,"name":"ここあ"}}}
              </script></body></html>
            `,
          };
        }
        return { status: 404, ok: false, text: async () => 'Not Found' };
      },
    });
    const cookieRes = await cookieFetcher.lookup('5006891');
    assert.equal(cookieRes.category, 'ok');
    assert.deepEqual(cookieRes.metadata?.actresses, ['ここあ']);
    assert.deepEqual(cookieRes.metadata?.candidateTags, ['ここあ', 'CreatorC', '巨乳']);
    assert.deepEqual(seenCookies, ['fc2cmadb-session=test-token', 'fc2cmadb-session=test-token']);

    // Inertia v2 deferredProps (X-Inertia-Partial-Data: actresses) resolution works even without cookie.
    const partialHeadersSeen: Array<Record<string, string>> = [];
    const deferredFetcher = new MetadataFetcher({
      retries: 1,
      requestDelayMs: 0,
      fetchImpl: async (url, init) => {
        const hdrs = (init?.headers ?? {}) as Record<string, string>;
        if (url.endsWith('/articles/5003320') && hdrs['X-Inertia'] === 'true') {
          partialHeadersSeen.push(hdrs);
          return {
            status: 200,
            ok: true,
            text: async () =>
              JSON.stringify({
                component: 'Articles/Show',
                props: { actresses: [{ id: 12502, name: 'ここあ' }] },
              }),
          };
        }
        if (url.endsWith('/articles/5003320')) {
          return {
            status: 200,
            ok: true,
            text: async () => `
              <html><body><script data-page="app" type="application/json">
                {"component":"Articles/Show","version":"v123","deferredProps":{"default":["actresses"]},"props":{"auth":{"user":null},"article":{"video_id":5003320,"title":"Deferred 5003320","release_date":"2026-11-06","writer":{"name":"CreatorD"},"tags":[{"name":"巨乳"}],"comments":[]}}}
              </script></body></html>
            `,
          };
        }
        return { status: 404, ok: false, text: async () => 'Not Found' };
      },
    });
    const deferredRes = await deferredFetcher.lookup('5003320');
    assert.equal(deferredRes.category, 'ok');
    assert.deepEqual(deferredRes.metadata?.actresses, ['ここあ']);
    assert.deepEqual(deferredRes.metadata?.candidateTags, ['ここあ', 'CreatorD', '巨乳']);
    assert.equal(partialHeadersSeen.length, 1);
    assert.equal(partialHeadersSeen[0]?.['X-Inertia-Version'], 'v123');
    assert.equal(partialHeadersSeen[0]?.['X-Inertia-Partial-Component'], 'Articles/Show');
    assert.equal(partialHeadersSeen[0]?.['X-Inertia-Partial-Data'], 'actresses');
  });

  it('B4 & B5: lazy manifest on action, same-share rename + EXDEV copy fallback, idempotent replay, and 3 crash-point reconciles', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ingest-b5-'));
    try {
      const { tempDir, targetDir, dbPath, roots, fileOps } = setupEnv(tmpDir);
      const fileA = path.join(tempDir, 'FC2-PPV-4545625.mp4');
      const fileB = path.join(tempDir, 'FC2-PPV-9999999.mkv');
      const fileC = path.join(tempDir, 'FC2-PPV-1111111.mp4');
      fs.writeFileSync(fileA, 'payload-A');
      fs.writeFileSync(fileB, 'payload-B');
      fs.writeFileSync(fileC, 'payload-C');

      const db = new DatabaseSync(dbPath);
      try {
        await migrateDatabase(db, { dbPath, appVersion: '0.5.0' });

        // Manifest is created lazily only when user acts on fileA.
        const mA = await ensureManifestForStagingFile(db, {
          tempPath: fileA,
          stagingDir: tempDir,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
          fileOps,
        });
        const mB = await ensureManifestForStagingFile(db, {
          tempPath: fileB,
          stagingDir: tempDir,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
          fileOps,
        });
        const mC = await ensureManifestForStagingFile(db, {
          tempPath: fileC,
          stagingDir: tempDir,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
          fileOps,
        });

        // B4: Commit before review must fail with REVIEW_REQUIRED.
        const unreviewed = await commitIngestionManifest(db, { manifestId: mA.id, stagingDir: tempDir, roots, fileOps });
        assert.equal(unreviewed.ok, false);
        assert.equal(unreviewed.code, 'REVIEW_REQUIRED');

        // Fetch metadata with mocked fetcher, then review & approve mA.
        const cmadbHtml = `<script data-page="app" type="application/json">{"props":{"article":{"video_id":"4545625","title":"Kept Original Name","writer":{"name":"StudioX"}}}}</script>`;
        const fetcher = new MetadataFetcher({
          requestDelayMs: 0,
          fetchImpl: async () => ({ status: 200, ok: true, text: async () => cmadbHtml }),
        });
        const fetched = await fetchMetadataForManifest(db, mA.id, fetcher);
        assert.equal(fetched.ok, true);

        const reviewedA = reviewIngestionManifest(db, {
          manifestId: mA.id,
          decision: 'approved',
          newTagNames: ['StudioX', 'ReviewedTag'],
        });
        assert.equal(reviewedA.ok, true);
        assert.equal(reviewedA.manifest?.state, 'reviewed');

        // Same-share instant rename for mA:
        const commitA = await commitIngestionManifest(db, { manifestId: mA.id, stagingDir: tempDir, roots, fileOps });
        assert.equal(commitA.ok, true);
        assert.equal(fs.existsSync(path.join(targetDir, 'FC2-PPV-4545625.mp4')), true);
        assert.equal(fs.existsSync(fileA), false);

        // Idempotent replay of completed manifest does NOT duplicate media or tags.
        const replayA = await commitIngestionManifest(db, { manifestId: mA.id, stagingDir: tempDir, roots, fileOps });
        assert.equal(replayA.ok, true);
        assert.equal(replayA.idempotentReplay, true);
        assert.equal(replayA.mediaId, commitA.mediaId);
        assert.equal(Number((db.prepare('SELECT COUNT(*) AS c FROM media_files').get() as { c: number }).c), 1);

        // Crash point 1 (EXDEV fallback -> copied-not-deleted):
        reviewIngestionManifest(db, { manifestId: mC.id, decision: 'approved', newTagNames: ['ExdevTag'] });
        const exdevFailUnlinkOps: IngestionFileOps = {
          ...fileOps,
          rename: () => {
            const err = new Error('EXDEV: cross-device link') as NodeJS.ErrnoException;
            err.code = 'EXDEV';
            throw err;
          },
          removeFile: () => {
            throw new Error('EPERM: simulated unlink crash');
          },
        };
        const commitC = await commitIngestionManifest(db, { manifestId: mC.id, stagingDir: tempDir, roots, allowCrossDeviceCopy: true, fileOps: exdevFailUnlinkOps });
        assert.equal(commitC.ok, true);
        assert.match(commitC.warning ?? '', /copied-not-deleted/);
        assert.equal(fs.existsSync(fileC), true);

        const rec1 = await reconcileIngestionManifests(db, { stagingDir: tempDir, roots, fileOps });
        assert.equal(rec1.copiedNotDeletedFixed, 1);
        assert.equal(fs.existsSync(fileC), false);

        // Crash point 2: moved-not-indexed (file moved manually while manifest is stuck in `moving`).
        reviewIngestionManifest(db, { manifestId: mB.id, decision: 'approved', newTagNames: ['RecoveredTag'] });
        db.prepare(`UPDATE ingestion_manifests SET state = 'moving' WHERE id = ?`).run(mB.id);
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(fileB, path.join(targetDir, 'FC2-PPV-9999999.mkv'));

        const rec2 = await reconcileIngestionManifests(db, { stagingDir: tempDir, roots, fileOps });
        assert.equal(rec2.movedNotIndexedFixed, 1);
        assert.equal(fs.existsSync(fileB), false);
        assert.equal(Number((db.prepare('SELECT COUNT(*) AS c FROM media_files').get() as { c: number }).c), 3);

        // Crash point 3: indexed-but-missing (destination file disappears after indexing).
        fs.rmSync(path.join(targetDir, 'FC2-PPV-9999999.mkv'));
        const rec3 = await reconcileIngestionManifests(db, { stagingDir: tempDir, roots, fileOps });
        assert.equal(rec3.indexedButMissingMarked, 1);
        const statusRow = db.prepare('SELECT status FROM media_files WHERE filename = ?').get('FC2-PPV-9999999.mkv') as { status: string };
        assert.equal(statusRow.status, 'missing');
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('service fails fast on placeholder uncRoot and respects READ_ONLY_DEGRADED during ingestion writes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ingest-deg-'));
    try {
      const { tempDir, dbPath, roots } = setupEnv(tmpDir);
      const placeholderService = new MediaLibrarySpikeService({
        baseDir: tmpDir,
        dbPath,
        autoDailyBackup: false,
      });
      const placeholderScan = await placeholderService.scanStagingFiles();
      assert.equal(placeholderScan.ok, false);
      assert.match(placeholderScan.error ?? '', /configure your real NAS/i);

      const db = new DatabaseSync(dbPath);
      await migrateDatabase(db, { dbPath, appVersion: '0.5.0' });
      db.prepare('INSERT INTO schema_versions (version, applied_at, app_version, description) VALUES (99, ?, ?, ?)').run(
        new Date().toISOString(),
        '9.9.9',
        'Future',
      );
      db.close();

      const service = new MediaLibrarySpikeService({
        baseDir: tmpDir,
        dbPath,
        roots,
        configuredStagingDir: tempDir,
        autoDailyBackup: false,
      });

      const scan = await service.scanStagingFiles();
      assert.equal(scan.ok, false);
      assert.match(scan.error ?? '', /READ_ONLY_DEGRADED/);

      const commit = await service.commitIngestion({ manifestId: 1 });
      assert.equal(commit.ok, false);
      assert.equal(commit.code, 'READ_ONLY_DEGRADED');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('upgrades an existing v4 database (without ingestion_tasks) to v5', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ingest-v4-to-v5-'));
    try {
      const { dbPath, roots } = setupEnv(tmpDir);
      const db = new DatabaseSync(dbPath);
      try {
        const v4Only = DEFAULT_MIGRATIONS.filter((m) => m.version <= 4);
        const resV4 = await migrateDatabase(db, {
          dbPath,
          appVersion: '0.5.0',
          migrations: v4Only,
        });
        assert.equal(resV4.currentVersion, 4);
        const beforeTable = db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ingestion_tasks'`)
          .get();
        assert.equal(beforeTable, undefined);
      } finally {
        db.close();
      }

      // Opening MediaLibrarySpikeService in 0.5.2 upgrades v4 -> v5 and creates ingestion_tasks.
      const service = new MediaLibrarySpikeService({
        baseDir: tmpDir,
        dbPath,
        roots,
        autoDailyBackup: false,
      });
      const tasks = await service.listIngestionTasks();
      assert.deepEqual(tasks, []);

      const dbAfter = new DatabaseSync(dbPath);
      try {
        const afterTable = dbAfter
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ingestion_tasks'`)
          .get() as { name: string } | undefined;
        assert.equal(afterTable?.name, 'ingestion_tasks');
        const versionRow = dbAfter
          .prepare(`SELECT MAX(version) AS v FROM schema_versions`)
          .get() as { v: number };
        assert.equal(versionRow.v, 7);
      } finally {
        dbAfter.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('ingestion_tasks enforces per-item concurrency locks and marks interrupted tasks on startup', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ingest-tasks-'));
    try {
      const { dbPath, roots } = setupEnv(tmpDir);
      const db = new DatabaseSync(dbPath);
      try {
        await migrateDatabase(db, { dbPath, appVersion: '0.5.0' });
        const lock1 = startIngestionTask(db, 'manifest:42', 'commit', 'Moving...');
        assert.equal(lock1.acquired, true);
        const lock2 = startIngestionTask(db, 'manifest:42', 'commit', 'Duplicate');
        assert.equal(lock2.acquired, false);
        if (!lock1.acquired) return;

        // Finish task1 -> lock can be acquired again; leave a running task to test startup recovery.
        finishIngestionTask(db, lock1.taskId, 'succeeded', 'Done');
        const lock3 = startIngestionTask(db, 'manifest:42', 'fetch', 'Fetching...');
        assert.equal(lock3.acquired, true);
      } finally {
        db.close();
      }

      // Opening a fresh service marks any leftover running tasks as interrupted.
      const service = new MediaLibrarySpikeService({
        baseDir: tmpDir,
        dbPath,
        roots,
        autoDailyBackup: false,
      });
      const tasks = await service.listIngestionTasks();
      assert.equal(tasks.length, 2);
      assert.equal(tasks[0]!.status, 'interrupted');
      assert.equal(tasks[1]!.status, 'succeeded');

      // Direct helper check too.
      const db2 = new DatabaseSync(dbPath);
      try {
        assert.equal(markInterruptedIngestionTasks(db2), 0);
        assert.equal(listIngestionTasks(db2).length, 2);
      } finally {
        db2.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('matches existing tags via tag_aliases on fetch and commit without creating duplicates (Q1)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ingest-alias-'));
    try {
      const { tempDir, dbPath, roots, fileOps } = setupEnv(tmpDir);
      const sampleFile = path.join(tempDir, 'FC2-PPV-5006891.mp4');
      fs.writeFileSync(sampleFile, 'video-alias-test');

      const db = new DatabaseSync(dbPath);
      try {
        await migrateDatabase(db, { dbPath, appVersion: '0.5.4' });
        const nowIso = '2026-11-17T00:00:00.000Z';
        db.prepare(
          `INSERT INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
           VALUES ('nas-main', 'NAS', ?, 1, ?)`,
        ).run(roots[0]!.canonicalUncRoot, nowIso);
        const tagIns = db
          .prepare(
            `INSERT INTO tags (name, normalized_name, kind, created_at, updated_at, revision)
             VALUES ('中出', '中出', 'custom', ?, ?, 1)`,
          )
          .run(nowIso, nowIso);
        const canonicalTagId = Number(tagIns.lastInsertRowid);
        db.prepare(
          `INSERT INTO tag_aliases (tag_id, alias, normalized_alias)
           VALUES (?, '中出し', '中出し')`,
        ).run(canonicalTagId);

        const fetcher = new MetadataFetcher({
          requestDelayMs: 0,
          fetchImpl: async () => ({
            status: 200,
            ok: true,
            text: async () => `
              <html><body><script data-page="app" type="application/json">
                {"props":{"article":{"video_id":5006891,"title":"Alias Merge Test","release_date":"2026-11-13","tags":[{"name":"中出し"},{"name":"ここあ"}]}}}
              </script></body></html>
            `,
          }),
        });

        const ensured = await ensureManifestForStagingFile(db, {
          tempPath: sampleFile,
          stagingDir: tempDir,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
          fileOps,
        });
        assert.ok(ensured.id);

        const fetched = await fetchMetadataForManifest(db, ensured.id, fetcher);
        assert.equal(fetched.ok, true);
        assert.ok(fetched.manifest);
        const matched = fetched.manifest.tags.find((t) => t.tagId === canonicalTagId);
        assert.equal(matched?.name, '中出');

        const reviewed = reviewIngestionManifest(db, {
          manifestId: fetched.manifest.id,
          decision: 'approved',
          newTagNames: ['中出し', 'ここあ'],
        });
        assert.equal(reviewed.ok, true);

        const committed = await commitIngestionManifest(db, {
          manifestId: fetched.manifest.id,
          stagingDir: tempDir,
          roots,
          fileOps,
        });
        assert.equal(committed.ok, true);
        assert.ok(committed.mediaId);

        const linkedTags = db
          .prepare(
            `SELECT t.id, t.name
             FROM media_tags mt
             JOIN tags t ON t.id = mt.tag_id
             WHERE mt.media_id = ?
             ORDER BY t.id ASC`,
          )
          .all(committed.mediaId) as Array<{ id: number; name: string }>;
        assert.deepEqual(
          linkedTags.map((r) => r.name),
          ['中出', 'ここあ'],
        );
        const dupRow = db.prepare(`SELECT id FROM tags WHERE normalized_name = '中出し'`).get();
        assert.equal(dupRow, undefined);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('openStagingFile plays video strictly inside stagingDir and rejects traversal/non-video paths', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ingest-play-'));
    try {
      const stagingDir = path.join(tmpDir, 'temp');
      fs.mkdirSync(stagingDir, { recursive: true });
      const sampleVideo = path.join(stagingDir, 'FC2-PPV-5006891.mp4');
      fs.writeFileSync(sampleVideo, 'video-bytes');

      const openedPaths: string[] = [];
      const service = new MediaLibrarySpikeService({
        baseDir: tmpDir,
        configuredUncRoot: '\\\\TestNAS\\Media',
        configuredStagingDir: stagingDir,
        autoDailyBackup: false,
        fileProbe: async (p) => (fs.existsSync(p) ? { ok: true } : { ok: false, code: 'FILE_NOT_FOUND' }),
        opener: {
          async openPath(p) {
            openedPaths.push(p);
          },
          async revealPath() {},
        },
      });

      const okRes = await service.openStagingFile({ relativePath: 'FC2-PPV-5006891.mp4' });
      assert.equal(okRes.ok, true);
      assert.deepEqual(openedPaths, [path.resolve(sampleVideo)]);

      const traversal = await service.openStagingFile({ relativePath: '../secret.mp4' });
      assert.equal(traversal.ok, false);
      if (!traversal.ok) assert.equal(traversal.code, 'PATH_TRAVERSAL_REJECTED');

      const uncAttempt = await service.openStagingFile({ relativePath: '\\\\OtherNAS\\Share\\a.mp4' });
      assert.equal(uncAttempt.ok, false);
      if (!uncAttempt.ok) assert.equal(uncAttempt.code, 'PATH_TRAVERSAL_REJECTED');

      const nonVideo = await service.openStagingFile({ relativePath: 'notes.txt' });
      assert.equal(nonVideo.ok, false);
      if (!nonVideo.ok) assert.equal(nonVideo.code, 'PATH_TRAVERSAL_REJECTED');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Issue #45 B1..B3: rebinds unindexed manifest by filename across stagingDir changes, cleans up stale manifests on scan while preserving frozen/recovery items, and deduplicates alias-matched tags on repeated fetches', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ingest-issue45-'));
    try {
      const homeStagingDir = path.join(tmpDir, 'home-temp');
      const privateStagingDir = path.join(tmpDir, 'private-temp');
      const targetDir = path.join(tmpDir, 'nas-root', 'FC2', '2026-09-4963189');
      fs.mkdirSync(homeStagingDir, { recursive: true });
      fs.mkdirSync(privateStagingDir, { recursive: true });
      const dbPath = path.join(tmpDir, 'library.sqlite3');
      const uncRoot = '\\\\iriyano\\Private';
      const roots: MediaRootConfig[] = [
        { rootId: 'nas-main', label: 'Private NAS', canonicalUncRoot: uncRoot, enabled: true },
      ];
      const mapPath = (p: string): string => {
        if (p.toLowerCase().startsWith(uncRoot.toLowerCase())) {
          const rel = p.slice(uncRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
          return rel ? path.join(tmpDir, 'nas-root', rel) : path.join(tmpDir, 'nas-root');
        }
        return p;
      };
      let simulateExdev = true;
      const fileOps: IngestionFileOps = {
        exists: (p) => defaultIngestionFileOps.exists(mapPath(p)),
        statSize: (p) => defaultIngestionFileOps.statSize(mapPath(p)),
        sha256: (p) => defaultIngestionFileOps.sha256(mapPath(p)),
        readRange: (p, offset, length) => defaultIngestionFileOps.readRange(mapPath(p), offset, length),
        ensureDir: (d) => defaultIngestionFileOps.ensureDir(mapPath(d)),
        rename: async (src, dest) => {
          if (simulateExdev) {
            throw Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' });
          }
          await defaultIngestionFileOps.rename(mapPath(src), mapPath(dest));
        },
        copyFile: (src, dest) => defaultIngestionFileOps.copyFile(mapPath(src), mapPath(dest)),
        removeFile: (p) => defaultIngestionFileOps.removeFile(mapPath(p)),
      };

      const filename12 = 'FC2-PPV-4999261 172cm高身長Fカップ美女.mp4';
      const oldTempFile = path.join(homeStagingDir, filename12);
      const staleFile = path.join(homeStagingDir, 'FC2-PPV-4000001-stale.mp4');
      const recoveryFile = path.join(homeStagingDir, 'FC2-PPV-4000002-recovered.mp4');
      const frozenFile = path.join(homeStagingDir, 'FC2-PPV-4000003-frozen.mp4');
      fs.writeFileSync(oldTempFile, 'video-4999261-payload');
      fs.writeFileSync(staleFile, 'stale-payload');
      fs.writeFileSync(recoveryFile, 'recovery-payload');
      fs.writeFileSync(frozenFile, 'frozen-payload');

      const db = new DatabaseSync(dbPath);
      try {
        await migrateDatabase(db, { dbPath, appVersion: '0.7.6' });
        const nowIso = '2026-11-21T00:00:00.000Z';
        db.prepare(
          `INSERT INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
           VALUES ('nas-main', 'Private NAS', ?, 1, ?)`,
        ).run(uncRoot, nowIso);

        // Seed tag #8 "无码" with alias "無修正"
        const tagIns = db
          .prepare(
            `INSERT INTO tags (name, normalized_name, kind, created_at, updated_at, revision)
             VALUES ('无码', '无码', 'custom', ?, ?, 1)`,
          )
          .run(nowIso, nowIso);
        const uncensoredTagId = Number(tagIns.lastInsertRowid);
        db.prepare(
          `INSERT INTO tag_aliases (tag_id, alias, normalized_alias)
           VALUES (?, '無修正', '無修正')`,
        ).run(uncensoredTagId);

        const targetSubdir = 'FC2/2026-09-4963189';
        const m12 = await ensureManifestForStagingFile(db, {
          tempPath: oldTempFile,
          stagingDir: homeStagingDir,
          targetRootId: 'nas-main',
          targetSubdir,
          roots,
          fileOps,
        });
        const mStale = await ensureManifestForStagingFile(db, {
          tempPath: staleFile,
          stagingDir: homeStagingDir,
          targetRootId: 'nas-main',
          targetSubdir,
          roots,
          fileOps,
        });
        const mRecovery = await ensureManifestForStagingFile(db, {
          tempPath: recoveryFile,
          stagingDir: homeStagingDir,
          targetRootId: 'nas-main',
          targetSubdir,
          roots,
          fileOps,
        });
        const mFrozen = await ensureManifestForStagingFile(db, {
          tempPath: frozenFile,
          stagingDir: homeStagingDir,
          targetRootId: 'nas-main',
          targetSubdir,
          roots,
          fileOps,
        });

        // Add a performer review queue item on mStale to verify cascade deletion on scan cleanup
        db.prepare(
          `INSERT INTO performer_review_queue (
             manifest_id, raw_name, normalized_name, reason, candidate_tag_ids_json, status, created_at, updated_at
           ) VALUES (?, 'Stale Actress', 'stale actress', 'unknown', '[]', 'pending', ?, ?)`,
        ).run(mStale.id, nowIso, nowIso);

        const fetcher = new MetadataFetcher({
          requestDelayMs: 0,
          fetchImpl: async () => ({
            status: 200,
            ok: true,
            text: async () => `
              <html><body><script data-page="app" type="application/json">
                {"props":{"article":{"video_id":4999261,"title":"172cm高身長Fカップ美女","release_date":"2026-11-11","writer":{"name":"ハメ師"},"tags":[{"name":"無修正"},{"name":"ハメ撮り"}]}}}
              </script></body></html>
            `,
          }),
        });

        // B3: Fetch metadata twice and verify alias-matched tag "無修正" -> {tagId: uncensoredTagId, name: "无码"} is never duplicated
        const fetch1 = await fetchMetadataForManifest(db, m12.id, fetcher);
        assert.equal(fetch1.ok, true);
        const fetch2 = await fetchMetadataForManifest(db, m12.id, fetcher);
        assert.equal(fetch2.ok, true);
        const matchingTags = (fetch2.manifest?.tags ?? []).filter((t) => t.tagId === uncensoredTagId || t.name === '无码');
        assert.equal(matchingTags.length, 1, `Expected exactly 1 "无码" tag after repeated fetch, got: ${JSON.stringify(fetch2.manifest?.tags)}`);

        // Approve m12 and fail commit with EXDEV (simulating \\iriyano\home\Temp -> \\iriyano\Private)
        reviewIngestionManifest(db, {
          manifestId: m12.id,
          decision: 'approved',
          tagIds: [uncensoredTagId],
          newTagNames: ['無修正', 'ハメ師', 'ハメ撮り'],
        });
        const failedCommit = await commitIngestionManifest(db, {
          manifestId: m12.id,
          stagingDir: homeStagingDir,
          roots,
          fileOps,
          allowCrossDeviceCopy: false,
        });
        assert.equal(failedCommit.ok, false);
        assert.equal(failedCommit.manifest?.state, 'failed');
        assert.match(failedCommit.manifest?.lastError ?? '', /Cross-device copy is disabled/);

        // Prepare mRecovery as a moved-not-indexed candidate (approved + moving + destination file exists, source missing)
        reviewIngestionManifest(db, { manifestId: mRecovery.id, decision: 'approved' });
        db.prepare(`UPDATE ingestion_manifests SET state = 'moving' WHERE id = ?`).run(mRecovery.id);
        fs.mkdirSync(targetDir, { recursive: true });
        fs.renameSync(recoveryFile, path.join(targetDir, 'FC2-PPV-4000002-recovered.mp4'));

        // Freeze mFrozen with a running task while its file is removed from staging
        const frozenLock = startIngestionTask(db, `manifest:${mFrozen.id}`, 'fetch', 'Running fetch...');
        assert.equal(frozenLock.acquired, true);
        fs.rmSync(frozenFile);
        fs.rmSync(staleFile);

        // User moves FC2-PPV-4999261 from homeStagingDir to privateStagingDir and switches stagingDir
        const newTempFile = path.join(privateStagingDir, filename12);
        fs.renameSync(oldTempFile, newTempFile);

        // B1 & B2: Scan privateStagingDir ->
        // 1) m12 is matched by filename, temp_path is rebound to newTempFile, state resets from 'failed' to 'reviewed', last_error cleared!
        // 2) mStale (and its performer_review_queue row) is deleted because its file is gone!
        // 3) mRecovery (moved-not-indexed) and mFrozen (running task) are preserved!
        const scan = await scanStagingDirectory(db, {
          stagingDir: privateStagingDir,
          targetRootId: 'nas-main',
          targetSubdir,
          roots,
          fileOps,
        });
        assert.equal(scan.ok, true);
        assert.equal(scan.files.length, 1);
        assert.equal(scan.files[0]!.manifestId, m12.id);
        assert.equal(scan.files[0]!.state, 'reviewed');
        assert.equal(scan.files[0]!.reviewDecision, 'approved');

        const rebound12 = scan.manifests.find((m) => m.id === m12.id);
        assert.ok(rebound12);
        assert.equal(rebound12.tempPath, newTempFile);
        assert.equal(rebound12.state, 'reviewed');
        assert.equal(rebound12.lastError, null);
        assert.equal(rebound12.title, '172cm高身長Fカップ美女');

        // Stale unindexed manifest and its performer queue row were cleaned up
        assert.equal(scan.manifests.find((m) => m.id === mStale.id), undefined);
        const orphanQueueCount = Number(
          (db.prepare('SELECT COUNT(*) AS c FROM performer_review_queue WHERE manifest_id = ?').get(mStale.id) as { c: number }).c,
        );
        assert.equal(orphanQueueCount, 0);

        // Recovery candidate and frozen manifest were preserved
        assert.ok(scan.manifests.find((m) => m.id === mRecovery.id));
        assert.ok(scan.manifests.find((m) => m.id === mFrozen.id));

        // Also test ensureManifestForStagingFile directly when temp_path changes before scan
        const altStagingDir = path.join(tmpDir, 'alt-temp');
        fs.mkdirSync(altStagingDir, { recursive: true });
        const altTempFile = path.join(altStagingDir, filename12);
        fs.renameSync(newTempFile, altTempFile);

        const ensuredRebound = await ensureManifestForStagingFile(db, {
          tempPath: altTempFile,
          stagingDir: altStagingDir,
          targetRootId: 'nas-main',
          targetSubdir,
          roots,
          fileOps,
        });
        assert.equal(ensuredRebound.id, m12.id);
        assert.equal(ensuredRebound.tempPath, altTempFile);

        // Now same-share commit succeeds without PATH_TRAVERSAL_REJECTED or EXDEV!
        simulateExdev = false;
        const committed = await commitIngestionManifest(db, {
          manifestId: m12.id,
          stagingDir: altStagingDir,
          roots,
          fileOps,
        });
        assert.equal(committed.ok, true);
        assert.equal(committed.manifest?.state, 'indexed');
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('Issue #31: reconciles >500 manifests via SQL-filtered keyset pagination without dropping older records or skipping pages on error', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ingest-issue31-'));
    try {
      const { tempDir, targetDir, dbPath, roots, fileOps } = setupEnv(tmpDir);
      fs.mkdirSync(targetDir, { recursive: true });
      const db = new DatabaseSync(dbPath);
      try {
        await migrateDatabase(db, { dbPath, appVersion: '0.7.10' });
        db.prepare(
          `INSERT INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
           VALUES ('nas-main', 'NAS Main', '\\\\NAS\\MediaTest', 1, '2026-11-20T00:00:00.000Z')`,
        ).run();

        const insertManifest = db.prepare(
          `INSERT INTO ingestion_manifests (
             source_id, temp_path, target_root_id, target_relative_path, filename, title,
             catalog_number, media_date, tags_json, metadata_source, checksum_sha256, file_size,
             state, review_decision, last_error, indexed_media_id, created_at, updated_at
           ) VALUES (?, ?, 'nas-main', ?, ?, ?, ?, NULL, '[]', 'manual', ?, ?, ?, 'approved', NULL, NULL, ?, ?)`,
        );

        // 1) Older interrupted manifest #1 (ID=1): moved-not-indexed (dest exists with matching size, temp gone).
        const payload1 = 'older-interrupted-payload-1';
        const dest1 = path.join(targetDir, 'OLD-001.mp4');
        fs.writeFileSync(dest1, payload1);
        const r1 = insertManifest.run(
          'src-old-1',
          path.join(tempDir, 'OLD-001.mp4'),
          'ingested/OLD-001.mp4',
          'OLD-001.mp4',
          'Older Interrupted 1',
          'OLD-001',
          'sha-old-1',
          Buffer.byteLength(payload1),
          'moving',
          '2026-11-01T00:00:00.000Z',
          '2026-11-01T00:00:00.000Z',
        );
        const oldOkId = Number(r1.lastInsertRowid);

        // 2) Older failing manifest #2 (ID=2): destination missing -> must record error without blocking later pages.
        const r2 = insertManifest.run(
          'src-old-fail-2',
          path.join(tempDir, 'OLD-FAIL-002.mp4'),
          'ingested/OLD-FAIL-002.mp4',
          'OLD-FAIL-002.mp4',
          'Older Failing 2',
          'OLD-002',
          'sha-old-2',
          128,
          'failed',
          '2026-11-01T00:01:00.000Z',
          '2026-11-01T00:01:00.000Z',
        );
        const oldFailId = Number(r2.lastInsertRowid);

        // 3) Insert 515 newer 'planned' manifests so IDs 1 & 2 fall beyond the old LIMIT 500 window.
        for (let i = 1; i <= 515; i++) {
          const name = `PLANNED-${String(i).padStart(4, '0')}.mp4`;
          const ts = `2026-11-15T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
          insertManifest.run(
            `src-planned-${i}`,
            path.join(tempDir, name),
            `ingested/${name}`,
            name,
            `Planned ${i}`,
            null,
            `sha-planned-${i}`,
            10,
            'planned',
            ts,
            ts,
          );
        }

        // 4) Later page manifest (>500): copied-not-deleted with identical dir/name/size/content (dedup rule preserved).
        const payloadLate = 'late-page-dedup-payload-518';
        const tempLate = path.join(tempDir, 'LATE-518.mp4');
        const destLate = path.join(targetDir, 'LATE-518.mp4');
        fs.writeFileSync(tempLate, payloadLate);
        fs.writeFileSync(destLate, payloadLate);
        const rLate = insertManifest.run(
          'src-late-518',
          tempLate,
          'ingested/LATE-518.mp4',
          'LATE-518.mp4',
          'Late Page Dedup 518',
          'LATE-518',
          'sha-late-518',
          Buffer.byteLength(payloadLate),
          'moving',
          '2026-11-20T00:00:00.000Z',
          '2026-11-20T00:00:00.000Z',
        );
        const lateId = Number(rLate.lastInsertRowid);

        // 5) Same-size but different-content pair: checkExistingTarget must fail and retain the staging copy.
        const tempMismatch = path.join(tempDir, 'LATE-519-MISMATCH.mp4');
        const destMismatch = path.join(targetDir, 'LATE-519-MISMATCH.mp4');
        const mismatchSrc = 'AAAA-same-size-payload-519';
        const mismatchDst = 'BBBB-same-size-payload-519';
        assert.equal(Buffer.byteLength(mismatchSrc), Buffer.byteLength(mismatchDst));
        fs.writeFileSync(tempMismatch, mismatchSrc);
        fs.writeFileSync(destMismatch, mismatchDst);
        const rMismatch = insertManifest.run(
          'src-late-519-mismatch',
          tempMismatch,
          'ingested/LATE-519-MISMATCH.mp4',
          'LATE-519-MISMATCH.mp4',
          'Late Page Size Match Content Mismatch 519',
          'LATE-519',
          'sha-late-519',
          Buffer.byteLength(mismatchSrc),
          'moving',
          '2026-11-20T00:01:00.000Z',
          '2026-11-20T00:01:00.000Z',
        );
        const mismatchId = Number(rMismatch.lastInsertRowid);

        const totalManifests = Number(
          (db.prepare('SELECT COUNT(*) AS c FROM ingestion_manifests').get() as { c: number }).c,
        );
        assert.ok(totalManifests > 500, `Expected >500 manifests, got ${totalManifests}`);

        // Use pageSize=2 so the 4 pending reconcile records span multiple pages across the >500 table.
        const res = await reconcileIngestionManifests(db, {
          roots,
          stagingDir: tempDir,
          fileOps,
          pageSize: 2,
        });

        assert.equal(res.ok, false);
        assert.equal(res.movedNotIndexedFixed, 2);
        assert.equal(res.errors.length, 2);
        assert.ok(res.errors.some((e) => new RegExp(`Manifest #${oldFailId}:`).test(e)));
        assert.ok(res.errors.some((e) => new RegExp(`Manifest #${mismatchId}:`).test(e)));

        // Older interrupted manifest #1 was indexed despite >500 newer manifests.
        const row1 = db.prepare('SELECT state, indexed_media_id FROM ingestion_manifests WHERE id = ?').get(oldOkId) as {
          state: string;
          indexed_media_id: number | null;
        };
        assert.equal(row1.state, 'indexed');
        assert.ok(row1.indexed_media_id !== null);

        // Later page manifest was ALSO processed after #2 failed, and its temp duplicate was removed.
        const rowLate = db.prepare('SELECT state, indexed_media_id FROM ingestion_manifests WHERE id = ?').get(lateId) as {
          state: string;
          indexed_media_id: number | null;
        };
        assert.equal(rowLate.state, 'indexed');
        assert.ok(rowLate.indexed_media_id !== null);
        assert.equal(fs.existsSync(tempLate), false);
        assert.equal(fs.existsSync(destLate), true);

        // Same-size different-content manifest was NOT indexed and its staging copy was retained.
        const rowMismatch = db.prepare('SELECT state, indexed_media_id FROM ingestion_manifests WHERE id = ?').get(mismatchId) as {
          state: string;
          indexed_media_id: number | null;
        };
        assert.equal(rowMismatch.state, 'moving');
        assert.equal(rowMismatch.indexed_media_id, null);
        assert.equal(fs.existsSync(tempMismatch), true);
        assert.equal(fs.existsSync(destMismatch), true);

        // Non-finite pageSize falls back cleanly to default instead of throwing a SQLite datatype mismatch.
        const nanRes = await reconcileIngestionManifests(db, {
          roots,
          stagingDir: tempDir,
          fileOps,
          pageSize: Number.NaN,
        });
        assert.equal(nanRes.errors.length, 2);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
