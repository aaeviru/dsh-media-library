import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { Config } from '../../src/config.ts';
import { migrateDatabase } from '../../src/db/schema.ts';
import {
  commitIngestionManifest,
  computeIngestionTargetRelativePath,
  defaultIngestionFileOps,
  ensureManifestForStagingFile,
  getIngestionManifestById,
  normalizeTargetSubdir,
  parseIsoYearMonth,
  reconcileIngestionManifests,
  reviewIngestionManifest,
  scanStagingDirectory,
  type IngestionFileOps,
} from '../../src/ingestion/index.ts';
import { MediaLibrarySpikeService } from '../../src/spike-service.ts';
import type { MediaRootConfig } from '../../src/types.ts';
import { APP_VERSION } from '../../src/version.ts';

const UNC_ROOT = '\\\\NAS\\MediaShare';

function createTempEnv(prefix: string) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const nasRoot = path.join(tmpDir, 'nas-share');
  const stagingDir = path.join(nasRoot, 'temp');
  const dbPath = path.join(tmpDir, 'local-db', 'library.sqlite3');
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const mapUnc = (p: string) =>
    p.startsWith(UNC_ROOT) ? path.join(nasRoot, p.slice(UNC_ROOT.length).replaceAll('\\', '/')) : p;
  const fileOps: IngestionFileOps = {
    exists: (p) => defaultIngestionFileOps.exists(mapUnc(p)),
    statSize: (p) => defaultIngestionFileOps.statSize(mapUnc(p)),
    sha256: (p) => defaultIngestionFileOps.sha256(mapUnc(p)),
    readRange: (p, off, len) => defaultIngestionFileOps.readRange(mapUnc(p), off, len),
    ensureDir: (p) => defaultIngestionFileOps.ensureDir(mapUnc(p)),
    rename: (a, b) => defaultIngestionFileOps.rename(mapUnc(a), mapUnc(b)),
    copyFile: (a, b) => defaultIngestionFileOps.copyFile(mapUnc(a), mapUnc(b)),
    removeFile: (p) => defaultIngestionFileOps.removeFile(mapUnc(p)),
  };
  const roots: readonly MediaRootConfig[] = [
    {
      rootId: 'nas-main',
      label: 'NAS',
      canonicalUncRoot: UNC_ROOT,
      enabled: true,
    },
  ];
  return { tmpDir, nasRoot, stagingDir, dbPath, roots, fileOps };
}

describe('Auto YYYY/MM Ingestion Target Folder (Issue #69 B1..B5)', () => {
  it('B1 & B2: Config defaults ingestionAutoDateSubdir=true and pure path helper handles valid, invalid, empty dates & empty subdir', () => {
    const parsedConfig = Config({});
    assert.equal(parsedConfig.ingestionAutoDateSubdir.get(), true);

    const fixedNow = new Date(2026, 10, 27, 23, 59, 0); // local 2026-11-27

    assert.deepEqual(parseIsoYearMonth('2024-08-15'), { year: '2024', month: '08' });
    assert.deepEqual(parseIsoYearMonth('0099-01-15'), { year: '0099', month: '01' });
    assert.equal(parseIsoYearMonth('2025-02-30'), null);
    assert.equal(parseIsoYearMonth('2025-13-01'), null);
    assert.equal(parseIsoYearMonth('2024/08/15'), null);
    assert.equal(parseIsoYearMonth(''), null);
    assert.equal(parseIsoYearMonth(null), null);

    // Auto enabled + valid media_date + non-empty subdir
    assert.equal(
      computeIngestionTargetRelativePath({
        filename: 'FC2-PPV-1234567.mp4',
        targetSubdir: 'ingested',
        autoDateSubdir: true,
        mediaDate: '2024-08-15',
        now: fixedNow,
      }),
      'ingested/2024/08/FC2-PPV-1234567.mp4',
    );

    // Auto enabled + missing/invalid media_date -> fallback to now YYYY/MM
    assert.equal(
      computeIngestionTargetRelativePath({
        filename: 'FC2-PPV-1234567.mp4',
        targetSubdir: 'ingested',
        autoDateSubdir: true,
        mediaDate: 'not-a-date',
        now: fixedNow,
      }),
      'ingested/2026/11/FC2-PPV-1234567.mp4',
    );

    // Auto enabled + empty targetSubdir -> YYYY/MM/<filename>
    assert.equal(
      computeIngestionTargetRelativePath({
        filename: 'FC2-PPV-1234567.mp4',
        targetSubdir: '',
        autoDateSubdir: true,
        mediaDate: '2023-02-28',
        now: fixedNow,
      }),
      '2023/02/FC2-PPV-1234567.mp4',
    );

    // Auto disabled -> flat legacy behavior (including segment trailing space parity with normalizeTargetSubdir)
    assert.equal(
      computeIngestionTargetRelativePath({
        filename: 'FC2-PPV-1234567.mp4',
        targetSubdir: 'ingested',
        autoDateSubdir: false,
        mediaDate: '2024-08-15',
        now: fixedNow,
      }),
      'ingested/FC2-PPV-1234567.mp4',
    );
    assert.equal(
      computeIngestionTargetRelativePath({
        filename: 'video.mp4',
        targetSubdir: normalizeTargetSubdir('incoming /'),
        autoDateSubdir: false,
        now: fixedNow,
      }),
      'incoming /video.mp4',
    );
  });

  it('B1/B2/B3/B4: hot-reloads volatile toggle via SpikeService, solidifies on review/commit, and auto-creates YYYY/MM dir', async () => {
    const env = createTempEnv('dsh-i69-service-');
    try {
      let autoDateEnabled = true;
      const fixedNow = new Date(2026, 10, 27, 12, 0, 0); // 2026-11-27
      const fileA = path.join(env.stagingDir, 'ABP-123.mp4');
      const fileB = path.join(env.stagingDir, 'ABP-456.mp4');
      fs.writeFileSync(fileA, 'payload-a');
      fs.writeFileSync(fileB, 'payload-b');

      const service = new MediaLibrarySpikeService({
        dbPath: env.dbPath,
        roots: env.roots,
        configuredStagingDir: () => env.stagingDir,
        configuredTargetSubdir: () => 'ingested',
        configuredAutoDateSubdir: () => autoDateEnabled,
        ingestionFileOps: env.fileOps,
        autoDailyBackup: false,
        now: () => fixedNow,
      });

      const scan1 = await service.scanStagingFiles();
      assert.equal(scan1.ok, true);
      assert.equal(scan1.autoDateSubdir, true);
      assert.equal(scan1.files[0]!.targetRelativePath, 'ingested/2026/11/ABP-123.mp4');

      // Review with explicit mediaDate -> updates target_relative_path to 2024/05
      const rev1 = await service.reviewIngestion({
        relativePath: 'ABP-123.mp4',
        decision: 'approved',
        mediaDate: '2024-05-19',
      });
      assert.equal(rev1.ok, true);
      assert.equal(rev1.manifest?.targetRelativePath, 'ingested/2024/05/ABP-123.mp4');

      // Commit -> creates ingested/2024/05 directory and moves file there
      const commit1 = await service.commitIngestion({ manifestId: rev1.manifest!.id });
      assert.equal(commit1.ok, true);
      assert.equal(commit1.manifest?.targetRelativePath, 'ingested/2024/05/ABP-123.mp4');
      assert.equal(fs.existsSync(path.join(env.nasRoot, 'ingested', '2024', '05', 'ABP-123.mp4')), true);

      // Flip volatile toggle off -> hot takes effect for next scan/review/commit (flat layout)
      autoDateEnabled = false;
      const scan2 = await service.scanStagingFiles();
      assert.equal(scan2.ok, true);
      assert.equal(scan2.autoDateSubdir, false);
      assert.equal(scan2.files.find((f) => f.filename === 'ABP-456.mp4')?.targetRelativePath, 'ingested/ABP-456.mp4');

      const rev2 = await service.reviewIngestion({
        relativePath: 'ABP-456.mp4',
        decision: 'approved',
        mediaDate: '2024-05-19',
      });
      assert.equal(rev2.ok, true);
      assert.equal(rev2.manifest?.targetRelativePath, 'ingested/ABP-456.mp4');

      const commit2 = await service.commitIngestion({ manifestId: rev2.manifest!.id });
      assert.equal(commit2.ok, true);
      assert.equal(fs.existsSync(path.join(env.nasRoot, 'ingested', 'ABP-456.mp4')), true);
    } finally {
      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    }
  });

  it('B3 Freeze Invariant: target_relative_path stays frozen across month rollover once manifest enters moving/failed', async () => {
    const env = createTempEnv('dsh-i69-freeze-');
    try {
      const stagedFile = path.join(env.stagingDir, 'NO-DATE-999.mp4');
      fs.writeFileSync(stagedFile, 'payload-freeze-check');

      const db = new DatabaseSync(env.dbPath);
      try {
        await migrateDatabase(db, { dbPath: env.dbPath, appVersion: APP_VERSION });

        // Month 1: 2026-11-30 23:59
        const novEnd = new Date(2026, 10, 30, 23, 59, 0);
        const manifest = await ensureManifestForStagingFile(db, {
          relativePath: 'NO-DATE-999.mp4',
          stagingDir: env.stagingDir,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          autoDateSubdir: true,
          roots: env.roots,
          fileOps: env.fileOps,
          now: () => novEnd,
        });
        assert.equal(manifest.targetRelativePath, 'ingested/2026/11/NO-DATE-999.mp4');

        const reviewed = reviewIngestionManifest(
          db,
          { manifestId: manifest.id, decision: 'approved', mediaDate: '' },
          () => novEnd,
          { targetSubdir: 'ingested', autoDateSubdir: true, roots: env.roots },
        );
        assert.equal(reviewed.ok, true);
        assert.equal(reviewed.manifest?.targetRelativePath, 'ingested/2026/11/NO-DATE-999.mp4');

        // Simulate crash during moving: file already moved to 2026/11, manifest left in 'moving'
        const novDest = path.join(env.nasRoot, 'ingested', '2026', '11', 'NO-DATE-999.mp4');
        fs.mkdirSync(path.dirname(novDest), { recursive: true });
        fs.renameSync(stagedFile, novDest);
        db.prepare(`UPDATE ingestion_manifests SET state = 'moving' WHERE id = ?`).run(manifest.id);

        // Month 2: 2026-12-01 00:05 — rescan & reconcile MUST NOT drift to 2026/12!
        const decStart = new Date(2026, 11, 1, 0, 5, 0);
        const rescan = await scanStagingDirectory(db, {
          stagingDir: env.stagingDir,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          autoDateSubdir: true,
          roots: env.roots,
          fileOps: env.fileOps,
          now: () => decStart,
        });
        assert.equal(rescan.ok, true);
        const afterScan = getIngestionManifestById(db, manifest.id);
        assert.equal(afterScan?.targetRelativePath, 'ingested/2026/11/NO-DATE-999.mp4');

        const rec = await reconcileIngestionManifests(db, {
          roots: env.roots,
          stagingDir: env.stagingDir,
          fileOps: env.fileOps,
          now: () => decStart,
        });
        assert.equal(rec.ok, true);
        assert.equal(rec.movedNotIndexedFixed, 1);
        const indexed = getIngestionManifestById(db, manifest.id);
        assert.equal(indexed?.state, 'indexed');
        assert.equal(indexed?.targetRelativePath, 'ingested/2026/11/NO-DATE-999.mp4');
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    }
  });

  it('P1/P2 Regressions: failed retry re-approval preserves frozen destination, review without roots skips recompute, and spikeStatus tracks live toggle', async () => {
    const env = createTempEnv('dsh-i69-reg-');
    try {
      const stagedFile = path.join(env.stagingDir, 'RETRY-777.mp4');
      fs.writeFileSync(stagedFile, 'payload-retry');

      const db = new DatabaseSync(env.dbPath);
      try {
        await migrateDatabase(db, { dbPath: env.dbPath, appVersion: APP_VERSION });

        // November: create & approve, then mark 'failed' (simulating interrupted copy/index)
        const novEnd = new Date(2026, 10, 30, 23, 59, 0);
        const m = await ensureManifestForStagingFile(db, {
          relativePath: 'RETRY-777.mp4',
          stagingDir: env.stagingDir,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          autoDateSubdir: true,
          roots: env.roots,
          fileOps: env.fileOps,
          now: () => novEnd,
        });
        assert.equal(m.targetRelativePath, 'ingested/2026/11/RETRY-777.mp4');

        // Review WITHOUT roots must NOT overwrite target_relative_path with unvalidated input
        const unvalidatedRev = reviewIngestionManifest(
          db,
          { manifestId: m.id, decision: 'approved', mediaDate: '' },
          () => novEnd,
          { targetSubdir: 'C:/evil', autoDateSubdir: true },
        );
        assert.equal(unvalidatedRev.ok, true);
        assert.equal(unvalidatedRev.manifest?.targetRelativePath, 'ingested/2026/11/RETRY-777.mp4');

        // Transition to 'failed' with November destination frozen
        db.prepare(`UPDATE ingestion_manifests SET state = 'failed', last_error = 'network blip' WHERE id = ?`).run(m.id);

        // December: user clicks Move & Index (which re-approves then commits) — MUST stay in 2026/11!
        const decStart = new Date(2026, 11, 1, 0, 5, 0);
        const reapproved = reviewIngestionManifest(
          db,
          { manifestId: m.id, decision: 'approved', mediaDate: '' },
          () => decStart,
          { targetSubdir: 'ingested', autoDateSubdir: true, roots: env.roots },
        );
        assert.equal(reapproved.ok, true);
        assert.equal(reapproved.manifest?.state, 'failed');
        assert.equal(reapproved.manifest?.targetRelativePath, 'ingested/2026/11/RETRY-777.mp4');

        const retried = await commitIngestionManifest(db, {
          manifestId: m.id,
          stagingDir: env.stagingDir,
          targetSubdir: 'ingested',
          autoDateSubdir: true,
          roots: env.roots,
          fileOps: env.fileOps,
          now: () => decStart,
        });
        assert.equal(retried.ok, true);
        assert.equal(retried.manifest?.targetRelativePath, 'ingested/2026/11/RETRY-777.mp4');
        assert.equal(fs.existsSync(path.join(env.nasRoot, 'ingested', '2026', '11', 'RETRY-777.mp4')), true);
      } finally {
        db.close();
      }

      // Live volatile toggle reflected immediately via getSpikeStatus()
      let autoDate = true;
      const service = new MediaLibrarySpikeService({
        dbPath: env.dbPath,
        roots: env.roots,
        configuredTargetSubdir: () => 'ingested',
        configuredAutoDateSubdir: () => autoDate,
        autoDailyBackup: false,
      });
      assert.equal(service.getSpikeStatus().ingestionAutoDateSubdir, true);
      autoDate = false;
      assert.equal(service.getSpikeStatus().ingestionAutoDateSubdir, false);
    } finally {
      fs.rmSync(env.tmpDir, { recursive: true, force: true });
    }
  });
});
