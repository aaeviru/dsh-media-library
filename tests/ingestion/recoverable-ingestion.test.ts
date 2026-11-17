import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { migrateDatabase } from '../../src/db/schema.ts';
import {
  commitIngestionManifest,
  defaultIngestionFileOps,
  ensureManifestForStagingFile,
  fetchMetadataForManifest,
  MetadataFetcher,
  parseCmadbHtml,
  parseFc2Code,
  parsePpvdbHtml,
  previewStagingPlan,
  reconcileIngestionManifests,
  reviewIngestionManifest,
  scanStagingDirectory,
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
        const mig = await migrateDatabase(db, { dbPath, appVersion: '0.5.0' });
        assert.equal(mig.currentVersion, 4);

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
      </body></html>
    `;
    const okCmadb = parseCmadbHtml(cmadbHtml, '4545625', 'https://fc2cmadb.com/articles/4545625');
    assert.equal(okCmadb.category, 'ok');
    assert.equal(okCmadb.metadata?.title, 'Sample & Title');
    assert.deepEqual(okCmadb.metadata?.candidateTags, ['CreatorA', 'Amateur', '1080p']);

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
        const mA = ensureManifestForStagingFile(db, {
          tempPath: fileA,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
          fileOps,
        });
        const mB = ensureManifestForStagingFile(db, {
          tempPath: fileB,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
          fileOps,
        });
        const mC = ensureManifestForStagingFile(db, {
          tempPath: fileC,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
          fileOps,
        });

        // B4: Commit before review must fail with REVIEW_REQUIRED.
        const unreviewed = commitIngestionManifest(db, { manifestId: mA.id, roots, fileOps });
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
        const commitA = commitIngestionManifest(db, { manifestId: mA.id, roots, fileOps });
        assert.equal(commitA.ok, true);
        assert.equal(fs.existsSync(path.join(targetDir, 'FC2-PPV-4545625.mp4')), true);
        assert.equal(fs.existsSync(fileA), false);

        // Idempotent replay of completed manifest does NOT duplicate media or tags.
        const replayA = commitIngestionManifest(db, { manifestId: mA.id, roots, fileOps });
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
        const commitC = commitIngestionManifest(db, { manifestId: mC.id, roots, fileOps: exdevFailUnlinkOps });
        assert.equal(commitC.ok, true);
        assert.match(commitC.warning ?? '', /copied-not-deleted/);
        assert.equal(fs.existsSync(fileC), true);

        const rec1 = reconcileIngestionManifests(db, { roots, fileOps });
        assert.equal(rec1.copiedNotDeletedFixed, 1);
        assert.equal(fs.existsSync(fileC), false);

        // Crash point 2: moved-not-indexed (file moved manually while manifest is stuck in `moving`).
        reviewIngestionManifest(db, { manifestId: mB.id, decision: 'approved', newTagNames: ['RecoveredTag'] });
        db.prepare(`UPDATE ingestion_manifests SET state = 'moving' WHERE id = ?`).run(mB.id);
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(fileB, path.join(targetDir, 'FC2-PPV-9999999.mkv'));

        const rec2 = reconcileIngestionManifests(db, { roots, fileOps });
        assert.equal(rec2.movedNotIndexedFixed, 1);
        assert.equal(fs.existsSync(fileB), false);
        assert.equal(Number((db.prepare('SELECT COUNT(*) AS c FROM media_files').get() as { c: number }).c), 3);

        // Crash point 3: indexed-but-missing (destination file disappears after indexing).
        fs.rmSync(path.join(targetDir, 'FC2-PPV-9999999.mkv'));
        const rec3 = reconcileIngestionManifests(db, { roots, fileOps });
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
});
