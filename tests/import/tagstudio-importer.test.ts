import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { runImportCli } from '../../scripts/import-tagstudio.ts'
import { collectDatabaseTableCounts, restoreDatabaseFromBackup } from '../../src/db/backup.ts'
import { openMediaLibraryDatabase, runDatabaseHealthChecks } from '../../src/db/schema.ts'
import { importTagStudioDatabase } from '../../src/import/tagstudio-importer.ts'
import { createM2ImportTagStudioFixture } from '../../src/inventory/fixture-builder.ts'
import { snapshotFileFingerprint } from '../../src/inventory/tagstudio-inventory.ts'

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
})
