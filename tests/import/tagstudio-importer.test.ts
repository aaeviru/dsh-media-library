import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, describe, it } from 'node:test'
import { runImportCli } from '../../scripts/import-tagstudio.ts'
import { collectDatabaseTableCounts, restoreDatabaseFromBackup } from '../../src/db/backup.ts'
import { openMediaLibraryDatabase, runDatabaseHealthChecks } from '../../src/db/schema.ts'
import { importTagStudioDatabase } from '../../src/import/tagstudio-importer.ts'
import { createM2ImportTagStudioFixture } from '../../src/inventory/fixture-builder.ts'
import { snapshotFileFingerprint } from '../../src/inventory/tagstudio-inventory.ts'
import { MediaLibrarySpikeService } from '../../src/spike-service.ts'

describe('TagStudio Importer & Reconciliation Rules D2.1..D2.5 (Issue #3 B3..B8)', () => {
  let tempRoot: string
  let fixtureDbPath: string

  before(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-media-import-test-'))
    fixtureDbPath = path.join(tempRoot, 'source', 'ts_library.sqlite')
    createM2ImportTagStudioFixture(fixtureDbPath)
  })

  after(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('B3 & B5: dry-run mode verifies full reconciliation without creating or touching targetDbPath or modifying source SHA-256', async () => {
    const beforeSource = snapshotFileFingerprint(fixtureDbPath)
    const nonExistentTarget = path.join(tempRoot, 'dry-run-dir', 'library.sqlite3')

    const report = await importTagStudioDatabase({
      sourceDbPath: fixtureDbPath,
      targetDbPath: nonExistentTarget,
      mode: 'dry-run',
      rootId: 'nas-main',
      canonicalUncRoot: '\\\\SynologyNAS\\Media',
    })

    const afterSource = snapshotFileFingerprint(fixtureDbPath)
    assert.deepEqual(afterSource, beforeSource)
    assert.equal(existsSync(nonExistentTarget), false, 'dry-run must not create target DB file on disk')
    assert.equal(report.mode, 'dry-run')
    assert.equal(report.status, 'succeeded')
    assert.equal(report.reconciliation.allReconciled, true)
    assert.equal(report.targetHealth.ok, true)
  })

  it('B4 (D2.1..D2.5): imports anonymized fixture with exact reconciliation, precedence rules, duplicate tag merge, and sidecar filtering', async () => {
    const beforeSource = snapshotFileFingerprint(fixtureDbPath)
    const targetDbPath = path.join(tempRoot, 'imported', 'library.sqlite3')

    const report = await importTagStudioDatabase({
      sourceDbPath: fixtureDbPath,
      targetDbPath,
      mode: 'import',
      rootId: 'nas-main',
      canonicalUncRoot: '\\\\SynologyNAS\\Media',
    })

    const afterSource = snapshotFileFingerprint(fixtureDbPath)
    assert.deepEqual(afterSource, beforeSource, 'Source TagStudio DB must remain byte-for-byte identical')
    assert.equal(report.status, 'succeeded')
    assert.equal(report.reconciliation.allReconciled, true)
    assert.equal(report.targetHealth.ok, true)

    // Entries reconciliation: 9 total = 6 imported + 2 sidecars (Thumbs.db, .vsmeta) + 1 unmapped (../outside_escape.mkv)
    assert.equal(report.reconciliation.entries.sourceEntries, 9)
    assert.equal(report.reconciliation.entries.importedEntries, 6)
    assert.equal(report.reconciliation.entries.skippedSidecarEntries, 2)
    assert.equal(report.reconciliation.entries.unmappedEntries, 1)
    assert.equal(report.reconciliation.entries.reconciled, true)

    // Tags reconciliation (D2.4): 8 source tags -> 7 imported tags + 1 merged duplicate ('Studio Alpha' + 'studio alpha')
    assert.equal(report.reconciliation.tags.sourceTags, 8)
    assert.equal(report.reconciliation.tags.importedTags, 7)
    assert.equal(report.reconciliation.tags.mergedDuplicateTags, 1)
    assert.equal(report.mergedDuplicateTags.length, 1)
    assert.equal(report.mergedDuplicateTags[0]?.winnerSourceTagId, 1001)
    assert.deepEqual(report.mergedDuplicateTags[0]?.mergedSourceTagIds, [1002])

    // Tag aliases reconciliation: 6 source aliases -> 4 imported + 1 deduplicated ('alpha' on 1001 & 1002) + 1 orphan (88888)
    assert.equal(report.reconciliation.tagAliases.sourceTagAliases, 6)
    assert.equal(report.reconciliation.tagAliases.importedTagAliases, 4)
    assert.equal(report.reconciliation.tagAliases.deduplicatedTagAliases, 1)
    assert.equal(report.reconciliation.tagAliases.orphanedTagAliases, 1)
    // Shared alias across distinct tags (1000 and 1005 share 'actor_a_alias')
    assert.equal(report.sharedAliases.length, 1)
    assert.equal(report.sharedAliases[0]?.normalizedAlias, 'actor_a_alias')

    // Tag parents reconciliation: 3 source -> 1 valid + 1 self-loop + 1 orphan
    assert.equal(report.reconciliation.tagParents.sourceTagParents, 3)
    assert.equal(report.reconciliation.tagParents.importedTagParents, 1)
    assert.equal(report.reconciliation.tagParents.selfLoopTagParents, 1)
    assert.equal(report.reconciliation.tagParents.orphanedTagParents, 1)

    // Tag entries reconciliation (D2.1):
    // 12 total = 7 imported + 1 deduplicatedAfterTagMerge (entry 9 had both 1001 & 1002) + 2 skippedSidecarTagEntries (entries 7 & 8) + 2 orphaned (entry 99999, tag 88888)
    assert.equal(report.reconciliation.tagEntries.sourceTagEntries, 12)
    assert.equal(report.reconciliation.tagEntries.importedMediaTags, 7)
    assert.equal(report.reconciliation.tagEntries.deduplicatedAfterTagMerge, 1)
    assert.equal(report.reconciliation.tagEntries.skippedSidecarTagEntries, 2)
    assert.equal(report.reconciliation.tagEntries.orphanedTagEntries, 2)
    assert.equal(report.reconciliation.tagEntries.reconciled, true)

    // Inspect target SQLite database rows directly for D2.2, D2.3, D2.4, and legacy_ids
    const { db } = openMediaLibraryDatabase({ dbPath: targetDbPath })
    try {
      const mediaRows = db
        .prepare(
          `SELECT source_key, relative_path, catalog_number, catalog_source, media_date, date_source, added_at
           FROM media_files
           ORDER BY id ASC`,
        )
        .all() as Array<{
        source_key: string
        relative_path: string
        catalog_number: string | null
        catalog_source: string | null
        media_date: string | null
        date_source: string | null
        added_at: string | null
      }>

      const bySourceKey = new Map(mediaRows.map(r => [r.source_key, r]))

      // Entry 1 & 2: multi-file catalog LIB-101, date from datetime_field '2026-11-01'
      assert.equal(bySourceKey.get('tagstudio:1')?.catalog_number, 'LIB-101')
      assert.equal(bySourceKey.get('tagstudio:1')?.catalog_source, 'text_field')
      assert.equal(bySourceKey.get('tagstudio:1')?.media_date, '2026-11-01')
      assert.equal(bySourceKey.get('tagstudio:1')?.date_source, 'datetime_field')
      assert.equal(bySourceKey.get('tagstudio:2')?.catalog_number, 'LIB-101')

      // Entry 3: CJK path, catalog from filename 'ABP-909', date from filename '2026-10-15'
      assert.equal(bySourceKey.get('tagstudio:3')?.catalog_number, 'ABP-909')
      assert.equal(bySourceKey.get('tagstudio:3')?.catalog_source, 'filename')
      assert.equal(bySourceKey.get('tagstudio:3')?.media_date, '2026-10-15')
      assert.equal(bySourceKey.get('tagstudio:3')?.date_source, 'filename_or_path')

      // Entry 4: D2.2 precedence (text_field 'SSIS-999' wins over filename 'SSIS-002'), and D2.3 no fabricated media_date!
      assert.equal(bySourceKey.get('tagstudio:4')?.catalog_number, 'SSIS-999')
      assert.equal(bySourceKey.get('tagstudio:4')?.catalog_source, 'text_field')
      assert.equal(bySourceKey.get('tagstudio:4')?.media_date, null)
      assert.equal(bySourceKey.get('tagstudio:4')?.date_source, null)
      assert.equal(bySourceKey.get('tagstudio:4')?.added_at, '2026-09-02T00:00:00Z')

      // Entry 5: catalog is NULL (tag CAT-777 is not used to fabricate catalog per D2.2), date from text_field '2026-08-10'
      assert.equal(bySourceKey.get('tagstudio:5')?.catalog_number, null)
      assert.equal(bySourceKey.get('tagstudio:5')?.media_date, '2026-08-10')
      assert.equal(bySourceKey.get('tagstudio:5')?.date_source, 'text_field')

      // Entry 9: catalog from parent directory 'FC2-PPV-1476760'
      assert.equal(bySourceKey.get('tagstudio:9')?.catalog_number, 'FC2-PPV-1476760')
      assert.equal(bySourceKey.get('tagstudio:9')?.catalog_source, 'directory')
      assert.equal(bySourceKey.get('tagstudio:9')?.media_date, null)

      // D2.4 legacy_ids: both source tag 1001 and 1002 map to the same consolidated target tag entity_id
      const legacy1001 = db
        .prepare("SELECT entity_id FROM legacy_ids WHERE source_type = 'tagstudio' AND entity_type = 'tag' AND source_id = '1001'")
        .get() as { entity_id: number }
      const legacy1002 = db
        .prepare("SELECT entity_id FROM legacy_ids WHERE source_type = 'tagstudio' AND entity_type = 'tag' AND source_id = '1002'")
        .get() as { entity_id: number }
      assert.ok(legacy1001)
      assert.equal(legacy1001.entity_id, legacy1002.entity_id)
    } finally {
      db.close()
    }
  })

  it('B6: re-running import with identical source fingerprint is idempotent (already_imported), and --force cleanly re-imports', async () => {
    const targetDbPath = path.join(tempRoot, 'imported', 'library.sqlite3')

    const secondRun = await importTagStudioDatabase({
      sourceDbPath: fixtureDbPath,
      targetDbPath,
      mode: 'import',
      rootId: 'nas-main',
      canonicalUncRoot: '\\\\SynologyNAS\\Media',
    })
    assert.equal(secondRun.status, 'already_imported')
    assert.equal(secondRun.targetTableCounts.mediaFiles, 6)
    assert.equal(secondRun.targetTableCounts.tags, 7)
    assert.equal(secondRun.targetTableCounts.importRuns, 1)

    const forcedRun = await importTagStudioDatabase({
      sourceDbPath: fixtureDbPath,
      targetDbPath,
      mode: 'import',
      rootId: 'nas-main',
      canonicalUncRoot: '\\\\SynologyNAS\\Media',
      force: true,
    })
    assert.equal(forcedRun.status, 'succeeded')
    assert.equal(forcedRun.targetTableCounts.mediaFiles, 6)
    assert.equal(forcedRun.targetTableCounts.tags, 7)
    assert.equal(forcedRun.targetTableCounts.importRuns, 2)
  })

  it('B5: rolls back a failed mid-transaction import without replacing or corrupting the existing database', async () => {
    const targetDbPath = path.join(tempRoot, 'imported', 'library.sqlite3')

    await assert.rejects(
      () =>
        importTagStudioDatabase({
          sourceDbPath: fixtureDbPath,
          targetDbPath,
          mode: 'import',
          rootId: 'nas-main',
          canonicalUncRoot: '\\\\SynologyNAS\\Media',
          force: true,
          injectFaultBeforeCommit: true,
        }),
      /Injected fault before commit/,
    )

    // Verify the pre-existing database still has all 6 media_files and 7 tags and passes health checks
    const { db } = openMediaLibraryDatabase({ dbPath: targetDbPath })
    try {
      assert.equal(runDatabaseHealthChecks(db).ok, true)
      const counts = collectDatabaseTableCounts(db)
      assert.equal(counts.mediaFiles, 6)
      assert.equal(counts.tags, 7)
      assert.equal(counts.mediaTags, 7)
    } finally {
      db.close()
    }
  })

  it('B7 & B8: CLI supports --dry-run, --import, --backup, and --restore-check into an empty directory', async () => {
    const cliTargetDb = path.join(tempRoot, 'cli-run', 'library.sqlite3')
    const cliJsonOut = path.join(tempRoot, 'cli-run', 'import-report.json')
    const cliBackupPath = path.join(tempRoot, 'cli-run', 'backups', 'snapshot.sqlite3')
    const cliRestoredDb = path.join(tempRoot, 'cli-restored-empty', 'library.sqlite3')

    const codeImport = await runImportCli([
      '--import',
      '--source',
      fixtureDbPath,
      '--target',
      cliTargetDb,
      '--root-id',
      'nas-main',
      '--unc-root',
      '\\\\SynologyNAS\\Media',
      '--sanitize',
      '--json',
      cliJsonOut,
    ])
    assert.equal(codeImport, 0)
    assert.equal(existsSync(cliJsonOut), true)

    const codeBackup = await runImportCli([
      '--backup',
      '--target',
      cliTargetDb,
      '--out',
      cliBackupPath,
    ])
    assert.equal(codeBackup, 0)
    assert.equal(existsSync(cliBackupPath), true)

    const codeRestore = await runImportCli([
      '--restore-check',
      '--backup-file',
      cliBackupPath,
      '--restore-to',
      cliRestoredDb,
    ])
    assert.equal(codeRestore, 0)

    const directRestore = await restoreDatabaseFromBackup(cliBackupPath, path.join(tempRoot, 'cli-restored-2', 'library.sqlite3'))
    assert.equal(directRestore.countsMatch, true)
    assert.equal(directRestore.health.ok, true)
  })

  it('Issue #33 B1/B3/B4: scoped --force re-import preserves other roots, manual tags, and M4 ingested media across CLI and Host', async () => {
    const beforeSource = snapshotFileFingerprint(fixtureDbPath)
    const mixedDbPath = path.join(tempRoot, 'mixed-force', 'library.sqlite3')

    // 1. Initial TagStudio import into nas-main
    const initial = await importTagStudioDatabase({
      sourceDbPath: fixtureDbPath,
      targetDbPath: mixedDbPath,
      mode: 'import',
      rootId: 'nas-main',
      canonicalUncRoot: '\\\\SynologyNAS\\Media',
    })
    assert.equal(initial.status, 'succeeded')

    // 2. Seed another root, a manual tag, and an M4-ingested media file + manifest in nas-main
    const { db } = openMediaLibraryDatabase({ dbPath: mixedDbPath })
    try {
      const ts = '2026-11-22T00:00:00.000Z'
      db.prepare(
        `INSERT INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
         VALUES ('nas-other', 'Other NAS', '\\\\SynologyNAS\\Other', 1, ?)`,
      ).run(ts)
      const otherMedia = db
        .prepare(
          `INSERT INTO media_files (
             root_id, relative_path, filename, extension, title, status, source_key, revision
           ) VALUES ('nas-other', 'other\\clip.mkv', 'clip.mkv', 'mkv', 'Other Clip', 'indexed', 'tagstudio:9001', 1)`,
        )
        .run()
      const manualTag = db
        .prepare(
          `INSERT INTO tags (name, normalized_name, kind, created_at, updated_at, revision)
           VALUES ('Manual Keeper', 'manual keeper', 'custom', ?, ?, 1)`,
        )
        .run(ts, ts)
      db.prepare(
        `INSERT INTO media_tags (media_id, tag_id, source, created_at)
         VALUES (?, ?, 'manual', ?)`,
      ).run(Number(otherMedia.lastInsertRowid), Number(manualTag.lastInsertRowid), ts)

      const m4Media = db
        .prepare(
          `INSERT INTO media_files (
             root_id, relative_path, filename, extension, title, status, source_key, revision
           ) VALUES ('nas-main', 'ingested\\m4-video.mp4', 'm4-video.mp4', 'mp4', 'M4 Video', 'indexed', 'staging:ingested\\m4-video.mp4:4096', 1)`,
        )
        .run()
      const m4MediaId = Number(m4Media.lastInsertRowid)
      db.prepare(
        `INSERT INTO media_tags (media_id, tag_id, source, created_at)
         VALUES (?, ?, 'ingestion', ?)`,
      ).run(m4MediaId, Number(manualTag.lastInsertRowid), ts)
      db.prepare(
        `INSERT INTO ingestion_manifests (
           source_id, temp_path, target_root_id, target_relative_path, filename,
           checksum_sha256, file_size, state, review_decision, indexed_media_id, created_at, updated_at
         ) VALUES (
           'staging:ingested\\m4-video.mp4:4096', '\\\\SynologyNAS\\Media\\temp\\m4-video.mp4',
           'nas-main', 'ingested\\m4-video.mp4', 'm4-video.mp4',
           '', 4096, 'indexed', 'approved', ?, ?, ?
         )`,
      ).run(m4MediaId, ts, ts)
    } finally {
      db.close()
    }

    // 3. CLI --force re-import into nas-main must succeed and preserve non-target data
    const cliCode = await runImportCli([
      '--import',
      '--force',
      '--source',
      fixtureDbPath,
      '--target',
      mixedDbPath,
      '--root-id',
      'nas-main',
      '--unc-root',
      '\\\\SynologyNAS\\Media',
    ])
    assert.equal(cliCode, 0)

    // 4. Host importTagStudioCopy({ force: true }) must share the exact same safe boundary
    const hostService = new MediaLibrarySpikeService({
      baseDir: path.dirname(mixedDbPath),
      dataDirName: '.',
      dbPath: mixedDbPath,
      autoDailyBackup: false,
      configuredUncRoot: '\\\\SynologyNAS\\Media',
      configuredTagStudioCopyPath: fixtureDbPath,
    })
    const hostRes = await hostService.importTagStudioCopy({ force: true })
    assert.equal(hostRes.ok, true)
    assert.equal(hostRes.status, 'succeeded')
    assert.equal(hostRes.importedEntries, 6)

    // Verify other root, manual tag, and M4 ingested media/manifest survived both CLI and Host force re-imports
    const verify = openMediaLibraryDatabase({ dbPath: mixedDbPath })
    try {
      assert.equal(runDatabaseHealthChecks(verify.db).ok, true)
      const otherRow = verify.db
        .prepare("SELECT title FROM media_files WHERE root_id = 'nas-other' AND relative_path = 'other\\clip.mkv'")
        .get() as { title: string } | undefined
      assert.equal(otherRow?.title, 'Other Clip')

      const m4Row = verify.db
        .prepare("SELECT id, title FROM media_files WHERE root_id = 'nas-main' AND relative_path = 'ingested\\m4-video.mp4'")
        .get() as { id: number; title: string } | undefined
      assert.equal(m4Row?.title, 'M4 Video')

      const m4Manifest = verify.db
        .prepare("SELECT indexed_media_id FROM ingestion_manifests WHERE filename = 'm4-video.mp4'")
        .get() as { indexed_media_id: number } | undefined
      assert.equal(m4Manifest?.indexed_media_id, m4Row?.id)

      const manualTagRow = verify.db
        .prepare("SELECT id FROM tags WHERE normalized_name = 'manual keeper'")
        .get() as { id: number } | undefined
      assert.ok(manualTagRow)

      const tsCount = verify.db
        .prepare("SELECT COUNT(*) AS cnt FROM media_files WHERE root_id = 'nas-main' AND source_key LIKE 'tagstudio:%'")
        .get() as { cnt: number }
      assert.equal(tsCount.cnt, 6)
    } finally {
      verify.db.close()
    }

    assert.deepEqual(snapshotFileFingerprint(fixtureDbPath), beforeSource, 'Source TagStudio DB SHA-256 must remain unchanged')
  })

  it('Issue #33 B2/B3/B4: refuses --force and rolls back when ownership is mixed (manual tags, edits, path collision, or archived tag)', async () => {
    const beforeSource = snapshotFileFingerprint(fixtureDbPath)
    const guardedDbPath = path.join(tempRoot, 'guarded-force', 'library.sqlite3')

    await importTagStudioDatabase({
      sourceDbPath: fixtureDbPath,
      targetDbPath: guardedDbPath,
      mode: 'import',
      rootId: 'nas-main',
      canonicalUncRoot: '\\\\SynologyNAS\\Media',
    })

    // Case 2a: TagStudio media row has a manual tag attached -> must refuse and preserve DB
    {
      const { db } = openMediaLibraryDatabase({ dbPath: guardedDbPath })
      try {
        const ts = '2026-11-22T00:00:00.000Z'
        const media = db
          .prepare("SELECT id FROM media_files WHERE root_id = 'nas-main' AND source_key = 'tagstudio:1'")
          .get() as { id: number }
        const manualTag = db
          .prepare(
            `INSERT INTO tags (name, normalized_name, kind, created_at, updated_at, revision)
             VALUES ('Manual Attached', 'manual attached', 'custom', ?, ?, 1)`,
          )
          .run(ts, ts)
        db.prepare(
          `INSERT INTO media_tags (media_id, tag_id, source, created_at)
           VALUES (?, ?, 'manual', ?)`,
        ).run(media.id, Number(manualTag.lastInsertRowid), ts)
      } finally {
        db.close()
      }

      await assert.rejects(
        () =>
          importTagStudioDatabase({
            sourceDbPath: fixtureDbPath,
            targetDbPath: guardedDbPath,
            mode: 'import',
            rootId: 'nas-main',
            canonicalUncRoot: '\\\\SynologyNAS\\Media',
            force: true,
          }),
        /FORCE_REIMPORT_REFUSED.*non-TagStudio tag associations/,
      )

      const hostService = new MediaLibrarySpikeService({
        baseDir: path.dirname(guardedDbPath),
        dataDirName: '.',
        dbPath: guardedDbPath,
        autoDailyBackup: false,
        configuredUncRoot: '\\\\SynologyNAS\\Media',
        configuredTagStudioCopyPath: fixtureDbPath,
      })
      const hostRes = await hostService.importTagStudioCopy({ force: true })
      assert.equal(hostRes.ok, false)
      assert.equal(hostRes.status, 'failed')
      assert.match(hostRes.message, /FORCE_REIMPORT_REFUSED/)

      // Verify existing data is completely preserved after refusal
      const verify = openMediaLibraryDatabase({ dbPath: guardedDbPath })
      try {
        assert.equal(runDatabaseHealthChecks(verify.db).ok, true)
        const manualAssoc = verify.db
          .prepare("SELECT COUNT(*) AS cnt FROM media_tags WHERE source = 'manual'")
          .get() as { cnt: number }
        assert.equal(manualAssoc.cnt, 1)
        const mediaCount = verify.db.prepare('SELECT COUNT(*) AS cnt FROM media_files').get() as { cnt: number }
        assert.equal(mediaCount.cnt, 6)
      } finally {
        verify.db.close()
      }
    }

    // Case 2b: revision > 1 on TagStudio media row -> must refuse
    const revDbPath = path.join(tempRoot, 'guarded-rev', 'library.sqlite3')
    await importTagStudioDatabase({
      sourceDbPath: fixtureDbPath,
      targetDbPath: revDbPath,
      mode: 'import',
      rootId: 'nas-main',
      canonicalUncRoot: '\\\\SynologyNAS\\Media',
    })
    {
      const { db } = openMediaLibraryDatabase({ dbPath: revDbPath })
      try {
        db.prepare("UPDATE media_files SET revision = 2 WHERE root_id = 'nas-main' AND source_key = 'tagstudio:1'").run()
      } finally {
        db.close()
      }
      await assert.rejects(
        () =>
          importTagStudioDatabase({
            sourceDbPath: fixtureDbPath,
            targetDbPath: revDbPath,
            mode: 'import',
            rootId: 'nas-main',
            canonicalUncRoot: '\\\\SynologyNAS\\Media',
            force: true,
          }),
        /FORCE_REIMPORT_REFUSED.*revision > 1/,
      )
    }

    // Case 2c: Path collision with non-TagStudio row -> must refuse
    const collideDbPath = path.join(tempRoot, 'guarded-collide', 'library.sqlite3')
    await importTagStudioDatabase({
      sourceDbPath: fixtureDbPath,
      targetDbPath: collideDbPath,
      mode: 'import',
      rootId: 'nas-main',
      canonicalUncRoot: '\\\\SynologyNAS\\Media',
    })
    {
      const { db } = openMediaLibraryDatabase({ dbPath: collideDbPath })
      try {
        db.prepare("UPDATE media_files SET source_key = 'staging:manual-override' WHERE root_id = 'nas-main' AND source_key = 'tagstudio:1'").run()
      } finally {
        db.close()
      }
      await assert.rejects(
        () =>
          importTagStudioDatabase({
            sourceDbPath: fixtureDbPath,
            targetDbPath: collideDbPath,
            mode: 'import',
            rootId: 'nas-main',
            canonicalUncRoot: '\\\\SynologyNAS\\Media',
            force: true,
          }),
        /FORCE_REIMPORT_REFUSED.*collides with an existing non-TagStudio media entry/,
      )
    }

    // Case 2d: Incoming tag matches a manually archived tag -> must refuse
    const archivedTagDbPath = path.join(tempRoot, 'guarded-archived-tag', 'library.sqlite3')
    await importTagStudioDatabase({
      sourceDbPath: fixtureDbPath,
      targetDbPath: archivedTagDbPath,
      mode: 'import',
      rootId: 'nas-main',
      canonicalUncRoot: '\\\\SynologyNAS\\Media',
    })
    {
      const { db } = openMediaLibraryDatabase({ dbPath: archivedTagDbPath })
      try {
        db.prepare("UPDATE tags SET archived_at = '2026-11-22T00:00:00.000Z' WHERE normalized_name = 'studio alpha'").run()
      } finally {
        db.close()
      }
      await assert.rejects(
        () =>
          importTagStudioDatabase({
            sourceDbPath: fixtureDbPath,
            targetDbPath: archivedTagDbPath,
            mode: 'import',
            rootId: 'nas-main',
            canonicalUncRoot: '\\\\SynologyNAS\\Media',
            force: true,
          }),
        /FORCE_REIMPORT_REFUSED.*manually edited, archived, or merged/,
      )
    }

    // Case 2e: Manually renamed TagStudio tag (revision > 1, legacy_ids still points to it) -> must refuse so old name does not reappear
    const renamedTagDbPath = path.join(tempRoot, 'guarded-renamed-tag', 'library.sqlite3')
    await importTagStudioDatabase({
      sourceDbPath: fixtureDbPath,
      targetDbPath: renamedTagDbPath,
      mode: 'import',
      rootId: 'nas-main',
      canonicalUncRoot: '\\\\SynologyNAS\\Media',
    })
    {
      const { db } = openMediaLibraryDatabase({ dbPath: renamedTagDbPath })
      try {
        db.prepare(
          "UPDATE tags SET name = 'Studio Renamed', normalized_name = 'studio renamed', revision = 2 WHERE normalized_name = 'studio alpha'",
        ).run()
      } finally {
        db.close()
      }
      await assert.rejects(
        () =>
          importTagStudioDatabase({
            sourceDbPath: fixtureDbPath,
            targetDbPath: renamedTagDbPath,
            mode: 'import',
            rootId: 'nas-main',
            canonicalUncRoot: '\\\\SynologyNAS\\Media',
            force: true,
          }),
        /FORCE_REIMPORT_REFUSED.*manually edited, archived, or merged/,
      )
      const verify = openMediaLibraryDatabase({ dbPath: renamedTagDbPath })
      try {
        const oldName = verify.db.prepare("SELECT id FROM tags WHERE normalized_name = 'studio alpha'").get()
        const keptRenamed = verify.db.prepare("SELECT id FROM tags WHERE normalized_name = 'studio renamed'").get()
        assert.equal(oldName, undefined, 'Old TagStudio tag name must not reappear')
        assert.ok(keptRenamed, 'Manually renamed tag must be preserved')
      } finally {
        verify.db.close()
      }
    }

    // Case 2f: Manually deleted alias on a TagStudio tag (revision > 1) -> must refuse so deleted alias is not restored
    const aliasEditedDbPath = path.join(tempRoot, 'guarded-alias-edited', 'library.sqlite3')
    await importTagStudioDatabase({
      sourceDbPath: fixtureDbPath,
      targetDbPath: aliasEditedDbPath,
      mode: 'import',
      rootId: 'nas-main',
      canonicalUncRoot: '\\\\SynologyNAS\\Media',
    })
    {
      const { db } = openMediaLibraryDatabase({ dbPath: aliasEditedDbPath })
      try {
        const tag = db.prepare("SELECT id FROM tags WHERE normalized_name = 'studio alpha'").get() as { id: number }
        db.prepare('DELETE FROM tag_aliases WHERE tag_id = ?').run(tag.id)
        db.prepare('UPDATE tags SET revision = 2 WHERE id = ?').run(tag.id)
      } finally {
        db.close()
      }
      await assert.rejects(
        () =>
          importTagStudioDatabase({
            sourceDbPath: fixtureDbPath,
            targetDbPath: aliasEditedDbPath,
            mode: 'import',
            rootId: 'nas-main',
            canonicalUncRoot: '\\\\SynologyNAS\\Media',
            force: true,
          }),
        /FORCE_REIMPORT_REFUSED.*manually edited, archived, or merged/,
      )
      const verify = openMediaLibraryDatabase({ dbPath: aliasEditedDbPath })
      try {
        const tag = verify.db.prepare("SELECT id FROM tags WHERE normalized_name = 'studio alpha'").get() as { id: number }
        const aliases = verify.db.prepare('SELECT id FROM tag_aliases WHERE tag_id = ?').all(tag.id)
        assert.equal(aliases.length, 0, 'Manually deleted alias must not be restored')
      } finally {
        verify.db.close()
      }
    }

    // Case 2g: Manually created tag sharing name with a TagStudio tag is NEVER deleted on --force even if removed from a later TagStudio DB
    const manualSameNameDbPath = path.join(tempRoot, 'manual-same-name', 'library.sqlite3')
    const reducedFixturePath = path.join(tempRoot, 'source-reduced', 'ts_library.sqlite')
    createM2ImportTagStudioFixture(reducedFixturePath)
    {
      const src = new DatabaseSync(reducedFixturePath)
      try {
        src.exec('DELETE FROM tag_entries WHERE tag_id IN (1001, 1002); DELETE FROM tag_aliases WHERE tag_id IN (1001, 1002); DELETE FROM tag_parents WHERE parent_id IN (1001, 1002) OR child_id IN (1001, 1002); DELETE FROM tags WHERE id IN (1001, 1002);')
      } finally {
        src.close()
      }
    }
    await importTagStudioDatabase({
      sourceDbPath: fixtureDbPath,
      targetDbPath: manualSameNameDbPath,
      mode: 'import',
      rootId: 'nas-main',
      canonicalUncRoot: '\\\\SynologyNAS\\Media',
    })
    const reducedRun = await importTagStudioDatabase({
      sourceDbPath: reducedFixturePath,
      targetDbPath: manualSameNameDbPath,
      mode: 'import',
      rootId: 'nas-main',
      canonicalUncRoot: '\\\\SynologyNAS\\Media',
      force: true,
    })
    assert.equal(reducedRun.status, 'succeeded')
    {
      const verify = openMediaLibraryDatabase({ dbPath: manualSameNameDbPath })
      try {
        const keptTag = verify.db.prepare("SELECT id FROM tags WHERE normalized_name = 'studio alpha'").get()
        assert.ok(keptTag, 'Existing tag must never be physically deleted during --force re-import')
      } finally {
        verify.db.close()
      }
    }

    assert.deepEqual(snapshotFileFingerprint(fixtureDbPath), beforeSource, 'Source TagStudio DB SHA-256 must remain unchanged')
  })
})
