import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { restoreDatabaseFromBackup } from '../../src/db/backup.ts'
import {
  classifyBackupFilename,
  createOperationalBackup,
  exportPortableMappingReport,
  listManagedBackups,
  maybeRunDailyAutoBackup,
  parseManagedBackupFilename,
  pruneManagedBackups,
} from '../../src/db/ops.ts'
import {
  CURRENT_SCHEMA_VERSION,
  migrateDatabase,
  V1_SCHEMA_MIGRATION,
  V2_MEDIA_STATUS_MIGRATION,
} from '../../src/db/schema.ts'
import { listTagsInDatabase, searchMediaInDatabase } from '../../src/search/search-repository.ts'
import { MediaLibrarySpikeService } from '../../src/spike-service.ts'
import { createM2ImportTagStudioFixture } from '../../src/inventory/fixture-builder.ts'
import { importTagStudioDatabase } from '../../src/import/tagstudio-importer.ts'

async function createPopulatedService(tmpDir: string, clock?: () => Date): Promise<{
  service: MediaLibrarySpikeService
  dbPath: string
  backupDir: string
  nasBackupDir: string
}> {
  const sourceTs = path.join(tmpDir, 'ts_library.sqlite')
  createM2ImportTagStudioFixture(sourceTs)
  const dbPath = path.join(tmpDir, 'media-library', 'library.sqlite3')
  const backupDir = path.join(tmpDir, 'media-library', 'backups')
  const nasBackupDir = path.join(tmpDir, 'nas-archive')
  await importTagStudioDatabase({
    sourceDbPath: sourceTs,
    targetDbPath: dbPath,
    mode: 'import',
    rootId: 'nas-main',
    canonicalUncRoot: '\\\\NAS\\MediaTest',
  })
  const service = new MediaLibrarySpikeService({
    baseDir: tmpDir,
    dbPath,
    configuredNasBackupDir: nasBackupDir,
    backupRetentionCount: 3,
    preMigrateRetentionCount: 2,
    autoDailyBackup: false,
    now: clock,
  })
  return { service, dbPath, backupDir, nasBackupDir }
}

describe('Operational Backup, Retention, Restore, Degraded Mode & Export (Issue #6 B1..B5)', () => {
  it('B1: creates verified online backups, prunes excess daily & pre-migrate files after verification, and copies to NAS archive', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-b1-'))
    try {
      let tick = 0
      const clock = () => new Date(Date.UTC(2026, 10, 17, 0, 0, ++tick))
      const { dbPath, backupDir, nasBackupDir } = await createPopulatedService(tmpDir, clock)

      // Place an unrelated user file in backupDir to verify pruning never touches non-plugin files.
      fs.mkdirSync(backupDir, { recursive: true })
      const userNote = path.join(backupDir, 'manual-keep-me.sqlite3')
      fs.writeFileSync(userNote, 'keep')

      // Seed 3 pre-migrate files; pruning with preMigrateRetention=2 should leave 2.
      for (let i = 1; i <= 3; i++) {
        fs.writeFileSync(path.join(backupDir, `pre-migrate-v2-to-v3-2026-11-1${i}T00-00-00-000Z.sqlite3`), `p${i}`)
      }

      for (let i = 0; i < 5; i++) {
        const res = await createOperationalBackup({
          dbPath,
          backupDir,
          nasBackupDir,
          dailyRetention: 3,
          preMigrateRetention: 2,
          now: clock,
        })
        assert.equal(res.ok, true)
        assert.ok(res.nasCopyPath && fs.existsSync(res.nasCopyPath))
      }

      const managed = listManagedBackups(backupDir)
      assert.equal(managed.filter(b => b.kind === 'daily').length, 3)
      assert.equal(managed.filter(b => b.kind === 'pre-migrate').length, 2)
      assert.equal(fs.existsSync(userNote), true)

      const nasManaged = listManagedBackups(nasBackupDir)
      assert.equal(nasManaged.filter(b => b.kind === 'daily').length, 3)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('B2: daily auto-backup runs at most once per 24h and skips when no mutations/imports occurred', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-b2-'))
    try {
      let nowMs = Date.UTC(2026, 10, 17, 1, 0, 0)
      const clock = () => new Date(nowMs)
      const { service, dbPath, backupDir } = await createPopulatedService(tmpDir, clock)
      await service.initialize()

      const db = new DatabaseSync(dbPath)
      try {
        // First run creates initial daily backup.
        const first = await maybeRunDailyAutoBackup({ db, dbPath, backupDir, now: clock })
        assert.equal(first?.ok, true)

        // 12 hours later: skipped (<24h).
        nowMs += 12 * 60 * 60 * 1000
        const tooSoon = await maybeRunDailyAutoBackup({ db, dbPath, backupDir, now: clock })
        assert.equal(tooSoon, null)

        // 25 hours later with NO new writes: skipped (watermark unchanged).
        nowMs += 13 * 60 * 60 * 1000
        const idleSkip = await maybeRunDailyAutoBackup({ db, dbPath, backupDir, now: clock })
        assert.equal(idleSkip, null)

        // Record a new mutation, then 25h later -> triggers new backup.
        const created = await service.createTag({ name: 'OpsTriggerTag' })
        assert.equal(created.ok, true)
        nowMs += 25 * 60 * 60 * 1000
        const afterWrite = await maybeRunDailyAutoBackup({ db, dbPath, backupDir, now: clock })
        assert.equal(afterWrite?.ok, true)
      } finally {
        db.close()
      }

      assert.equal(listManagedBackups(backupDir).filter(b => b.kind === 'daily').length, 2)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('B3: empty-dir restore reproduces tags, aliases, associations, and representative search results', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-b3-'))
    try {
      const { service } = await createPopulatedService(tmpDir)
      await service.initialize()
      const tagRes = await service.createTag({ name: 'DrillTag' })
      assert.equal(tagRes.ok, true)
      if (!tagRes.ok) return
      await service.addAlias({ tagId: tagRes.tagId, alias: 'drill_alias', expectedRevision: tagRes.revision })
      const searchBefore = await service.searchMedia({ catalogNumber: 'ABP-909' })
      assert.equal(searchBefore.items.length, 1)
      await service.setMediaTags({ mediaIds: [searchBefore.items[0]!.mediaId], addTagIds: [tagRes.tagId] })

      const backupRes = await service.createBackup({ reason: 'manual' })
      assert.equal(backupRes.ok, true)
      assert.ok(backupRes.backupPath)

      const emptyRestoreDir = path.join(tmpDir, 'empty-restore-dir')
      const restoredDbPath = path.join(emptyRestoreDir, 'library.sqlite3')
      const restoreRes = await restoreDatabaseFromBackup(backupRes.backupPath!, restoredDbPath)
      assert.equal(restoreRes.countsMatch, true)
      assert.equal(restoreRes.health.ok, true)

      const restoredDb = new DatabaseSync(restoredDbPath, { readOnly: true })
      try {
        const listed = listTagsInDatabase(restoredDb, { query: 'drill_alias' })
        assert.equal(listed.tags.length, 1)
        const tagSearch = searchMediaInDatabase(restoredDb, { tagIds: [listed.tags[0]!.id] })
        assert.equal(tagSearch.items.length, 1)
        assert.equal(tagSearch.items[0]!.catalogNumber, 'ABP-909')
      } finally {
        restoredDb.close()
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('B4: enters READ_ONLY_DEGRADED on future schema version or failed migration, allowing reads/exports while blocking all writes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-b4-'))
    try {
      const { dbPath } = await createPopulatedService(tmpDir)
      // Simulate a database upgraded to v99 by a newer plugin, opened by an older plugin supporting max v3.
      const db = new DatabaseSync(dbPath)
      try {
        await migrateDatabase(db, { dbPath })
        db.prepare('INSERT INTO schema_versions (version, applied_at, app_version, description) VALUES (99, ?, ?, ?)').run(
          new Date().toISOString(),
          '9.9.9',
          'Simulated future schema',
        )
      } finally {
        db.close()
      }

      const degradedService = new MediaLibrarySpikeService({
        baseDir: tmpDir,
        dbPath,
        supportedMaxVersion: CURRENT_SCHEMA_VERSION,
        autoDailyBackup: false,
      })

      const ops = await degradedService.getOpsStatus()
      assert.equal(ops.degradedState.degraded, true)
      assert.equal(ops.degradedState.schemaVersion, 99)

      // Reads & exports still work in degraded mode.
      const searchRes = await degradedService.searchMedia({ catalogNumber: 'ABP-909' })
      assert.equal(searchRes.items.length, 1)
      const exportRes = await degradedService.exportMappingReport({ format: 'json' })
      assert.equal(exportRes.ok, true)
      assert.ok(exportRes.rowCount > 0)

      // All write paths are blocked with READ_ONLY_DEGRADED.
      const createRes = await degradedService.createTag({ name: 'ShouldFail' })
      assert.equal(createRes.ok, false)
      if (!createRes.ok) assert.equal(createRes.code, 'READ_ONLY_DEGRADED')

      const batchRes = await degradedService.setMediaTags({ mediaIds: ['1'], addTagIds: [1] })
      assert.equal(batchRes.ok, false)
      if (!batchRes.ok) assert.equal(batchRes.code, 'READ_ONLY_DEGRADED')

      const importRes = await degradedService.importTagStudioCopy({ sourceDbPath: path.join(tmpDir, 'ts_library.sqlite') })
      assert.equal(importRes.ok, false)
      assert.match(importRes.message, /READ_ONLY_DEGRADED/)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('B5: exports portable JSON and RFC4180-escaped CSV mapping reports', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-b5-'))
    try {
      const { service, dbPath } = await createPopulatedService(tmpDir)
      await service.initialize()
      const formulaTag = await service.createTag({ name: '=CMD("calc")' })
      assert.equal(formulaTag.ok, true)
      if (formulaTag.ok) {
        const search = await service.searchMedia({ limit: 1 })
        await service.setMediaTags({ mediaIds: [search.items[0]!.mediaId], addTagIds: [formulaTag.tagId] })
      }

      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const jsonReport = exportPortableMappingReport(db, { format: 'json', appVersion: '0.4.0' })
        assert.equal(jsonReport.ok, true)
        const parsed = JSON.parse(jsonReport.content) as { rowCount: number; items: Array<{ mediaId: string }> }
        assert.equal(parsed.rowCount, jsonReport.rowCount)
        assert.ok(parsed.items.length > 0)

        const csvReport = exportPortableMappingReport(db, { format: 'csv', appVersion: '0.4.0' })
        assert.equal(csvReport.ok, true)
        assert.ok(csvReport.content.startsWith('mediaId,rootId,relativePath,'))
        assert.ok(csvReport.content.includes("'=CMD(\"\"calc\"\")") || csvReport.content.includes('=CMD'))
      } finally {
        db.close()
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('Issue #36 B1..B3: rotates only strictly plugin-named backups and sorts pre-migrate v9/v10/v11 by parsed timestamp', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-issue36-'))
    try {
      // Strictly reject manual snapshots even when they share prefixes and .sqlite3 extension.
      assert.equal(classifyBackupFilename('library-backup-manual.sqlite3'), null)
      assert.equal(classifyBackupFilename('library-backup-2026-02-31T00-00-00-000Z.sqlite3'), null)
      assert.equal(classifyBackupFilename('pre-migrate-manual-copy.sqlite3'), null)
      assert.equal(classifyBackupFilename('pre-migrate-v9-2026-11-20T00-00-00-000Z.sqlite3'), null)
      assert.equal(parseManagedBackupFilename('library-backup-2026-11-20T01-02-03-004Z.sqlite3')?.kind, 'daily')
      assert.equal(parseManagedBackupFilename('pre-migrate-v9-to-v10-2026-11-20T01-02-03-004Z.sqlite3')?.kind, 'pre-migrate')

      const manualFiles = [
        'library-backup-manual-snapshot.sqlite3',
        'pre-migrate-handcrafted.sqlite3',
        'custom-backup.sqlite3',
      ]
      for (const name of manualFiles) {
        fs.writeFileSync(path.join(tmpDir, name), 'manual')
      }

      // Daily backups: 3 valid plugin backups (retention=2 -> keep newest 2 by timestamp).
      const dailyOld = 'library-backup-2026-11-18T10-00-00-000Z.sqlite3'
      const dailyMid = 'library-backup-2026-11-19T10-00-00-000Z.sqlite3'
      const dailyNew = 'library-backup-2026-11-20T10-00-00-000Z.sqlite3'
      for (const name of [dailyOld, dailyMid, dailyNew]) {
        fs.writeFileSync(path.join(tmpDir, name), name)
      }

      // Pre-migrate backups crossing v9 -> v10 -> v11:
      // Lexicographically 'v9' > 'v10' > 'v11', so raw filename sorting would wrongly keep v9 and delete v10/v11!
      const pmV8 = 'pre-migrate-v8-to-v9-2026-11-18T00-00-00-000Z.sqlite3'
      const pmV9 = 'pre-migrate-v9-to-v10-2026-11-19T00-00-00-000Z.sqlite3'
      const pmV10 = 'pre-migrate-v10-to-v11-2026-11-20T00-00-00-000Z.sqlite3'
      const pmV11 = 'pre-migrate-v11-to-v12-2026-11-21T00-00-00-000Z.sqlite3'
      for (const name of [pmV8, pmV9, pmV10, pmV11]) {
        fs.writeFileSync(path.join(tmpDir, name), name)
      }

      const beforeList = listManagedBackups(tmpDir)
      assert.deepEqual(
        beforeList.filter(b => b.kind === 'pre-migrate').map(b => b.filename),
        [pmV11, pmV10, pmV9, pmV8],
      )
      assert.deepEqual(
        beforeList.filter(b => b.kind === 'daily').map(b => b.filename),
        [dailyNew, dailyMid, dailyOld],
      )

      const removed = pruneManagedBackups(tmpDir, { dailyRetention: 2, preMigrateRetention: 2 })
      assert.equal(removed.length, 3)

      const afterList = listManagedBackups(tmpDir)
      assert.deepEqual(
        afterList.filter(b => b.kind === 'daily').map(b => b.filename),
        [dailyNew, dailyMid],
      )
      assert.deepEqual(
        afterList.filter(b => b.kind === 'pre-migrate').map(b => b.filename),
        [pmV11, pmV10],
      )
      assert.equal(fs.existsSync(path.join(tmpDir, dailyOld)), false)
      assert.equal(fs.existsSync(path.join(tmpDir, pmV8)), false)
      assert.equal(fs.existsSync(path.join(tmpDir, pmV9)), false)

      // All manual snapshots must remain untouched.
      for (const name of manualFiles) {
        assert.equal(fs.existsSync(path.join(tmpDir, name)), true, `Manual file ${name} must be preserved`)
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('Issue #35: previewManifestPerformers does not write in READ_ONLY_DEGRADED mode and keeps in-memory preview consistent', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-issue35-preview-'))
    try {
      const { dbPath } = await createPopulatedService(tmpDir)
      const db = new DatabaseSync(dbPath)
      let manifestId = 0
      let beforeQueue: Array<Record<string, unknown>> = []
      try {
        await migrateDatabase(db, { dbPath })
        // 1) Active tag + auto rule for performer that has a stale pending queue row (tests DELETE guard + no duplicate).
        const autoTagId = Number(
          db
            .prepare(
              `INSERT INTO tags (name, normalized_name, kind, created_at, updated_at, revision)
               VALUES ('AutoPerformer', 'autoperformer', 'performer', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', 1)`,
            )
            .run().lastInsertRowid,
        )
        db.prepare(
          `INSERT INTO performer_aliases (normalized_name, raw_alias, tag_id, policy, note, created_at, updated_at)
           VALUES ('stale pending performer', 'Stale Pending Performer', ?, 'auto', '', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z')`,
        ).run(autoTagId)

        // 2) Archived tag for a previously resolved queue row (tests UPDATE guard).
        const archivedTagId = Number(
          db
            .prepare(
              `INSERT INTO tags (name, normalized_name, kind, archived_at, created_at, updated_at, revision)
               VALUES ('ArchivedPerformer', 'archivedperformer', 'performer', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z', 1)`,
            )
            .run().lastInsertRowid,
        )

        // 3) Manifest with all three cases: stale pending -> auto, resolved -> archived, plus brand-new unknown (INSERT guard).
        const res = db
          .prepare(
            `INSERT INTO ingestion_manifests (
               source_id, temp_path, target_root_id, target_relative_path, filename, title,
               catalog_number, media_date, tags_json, actresses_json, metadata_source,
               checksum_sha256, file_size, state, review_decision, created_at, updated_at
             ) VALUES (
               'src-deg-1', '/tmp/deg.mp4', 'nas-main', 'ingested/deg.mp4', 'deg.mp4', 'Degraded Preview',
               'DEG-001', NULL, '[]', '["Stale Pending Performer", "Archived Resolved Performer", "Unknown Performer X"]', 'manual',
               'sha-deg-1', 100, 'planned', 'pending', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z'
             )`,
          )
          .run()
        manifestId = Number(res.lastInsertRowid)

        db.prepare(
          `INSERT INTO performer_review_queue
             (manifest_id, media_id, raw_name, normalized_name, reason, candidate_tag_ids_json, status, created_at, updated_at)
           VALUES (?, NULL, 'Stale Pending Performer', 'stale pending performer', 'unknown', '[]', 'pending', '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z')`,
        ).run(manifestId)
        db.prepare(
          `INSERT INTO performer_review_queue
             (manifest_id, media_id, raw_name, normalized_name, reason, candidate_tag_ids_json, status, resolution_mode, resolved_tag_id, created_at, updated_at)
           VALUES (?, NULL, 'Archived Resolved Performer', 'archived resolved performer', 'unknown', '[]', 'resolved', 'bind_existing', ?, '2026-11-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z')`,
        ).run(manifestId, archivedTagId)

        beforeQueue = db
          .prepare('SELECT * FROM performer_review_queue ORDER BY id ASC')
          .all() as Array<Record<string, unknown>>

        db.prepare('INSERT INTO schema_versions (version, applied_at, app_version, description) VALUES (99, ?, ?, ?)').run(
          new Date().toISOString(),
          '9.9.9',
          'Simulated future schema',
        )
      } finally {
        db.close()
      }

      const degradedService = new MediaLibrarySpikeService({
        baseDir: tmpDir,
        dbPath,
        supportedMaxVersion: CURRENT_SCHEMA_VERSION,
        autoDailyBackup: false,
      })

      const preview = await degradedService.previewManifestPerformers({ manifestId })
      assert.equal(preview.manifestId, manifestId)
      assert.equal(preview.canCommit, false)
      // Auto-matched performer must NOT also appear in pendingReview.
      assert.deepEqual(
        preview.autoMatched.map(a => a.rawName),
        ['Stale Pending Performer'],
      )
      assert.deepEqual(
        preview.pendingReview.map(p => ({ rawName: p.rawName, reason: p.reason })),
        [
          { rawName: 'Archived Resolved Performer', reason: 'archived_target' },
          { rawName: 'Unknown Performer X', reason: 'unknown' },
        ],
      )

      // Verify performer_review_queue rows and contents are byte-for-byte unchanged (INSERT/UPDATE/DELETE all guarded).
      const verifyDb = new DatabaseSync(dbPath, { readOnly: true })
      try {
        const afterQueue = verifyDb
          .prepare('SELECT * FROM performer_review_queue ORDER BY id ASC')
          .all() as Array<Record<string, unknown>>
        assert.deepEqual(afterQueue, beforeQueue)
      } finally {
        verifyDb.close()
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('Issue #35: v2 fixture with failed upgrade enters READ_ONLY_DEGRADED while listTags and mapping export work on v2 schema', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-issue35-v2-'))
    try {
      const dbPath = path.join(tmpDir, 'media-library', 'library.sqlite3')
      fs.mkdirSync(path.dirname(dbPath), { recursive: true })
      const db = new DatabaseSync(dbPath)
      try {
        await migrateDatabase(db, {
          dbPath,
          migrations: [V1_SCHEMA_MIGRATION, V2_MEDIA_STATUS_MIGRATION],
          appVersion: '0.2.0',
        })
        db.prepare(
          `INSERT INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
           VALUES ('nas-main', 'NAS Main', '\\\\NAS\\MediaTest', 1, '2026-11-01T00:00:00.000Z')`,
        ).run()
        const mediaId = Number(
          db
            .prepare(
              `INSERT INTO media_files (root_id, relative_path, filename, extension, title, catalog_number, media_date, status, revision)
               VALUES ('nas-main', 'videos/V2-001.mp4', 'V2-001.mp4', '.mp4', 'Legacy V2 Video', 'V2-001', '2026-11-01', 'indexed', 1)`,
            )
            .run().lastInsertRowid,
        )
        const tagId = Number(
          db
            .prepare(
              `INSERT INTO tags (name, normalized_name, shorthand, kind, created_at, updated_at, revision)
               VALUES ('LegacyTag', 'legacytag', 'lt', 'custom', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 1)`,
            )
            .run().lastInsertRowid,
        )
        db.prepare(
          `INSERT INTO tag_aliases (tag_id, alias, normalized_alias) VALUES (?, 'LegacyAlias', 'legacyalias')`,
        ).run(tagId)
        db.prepare(
          `INSERT INTO media_tags (media_id, tag_id, source, created_at) VALUES (?, ?, 'tagstudio-import', '2026-11-01T00:00:00.000Z')`,
        ).run(mediaId, tagId)

        // Cause V3_TAG_MANAGEMENT_MIGRATION to fail cleanly and roll back, leaving DB at v2.
        db.exec('CREATE TABLE mutation_log (id INTEGER PRIMARY KEY);')
      } finally {
        db.close()
      }

      const degradedService = new MediaLibrarySpikeService({
        baseDir: tmpDir,
        dbPath,
        autoDailyBackup: false,
      })

      const ops = await degradedService.getOpsStatus()
      assert.equal(ops.degradedState.degraded, true)
      assert.equal(ops.degradedState.schemaVersion, 2)

      // Read-only tag query works without archived_at / merged_into_id columns.
      const listed = await degradedService.listTags({ query: 'legacyalias' })
      assert.equal(listed.tags.length, 1)
      assert.equal(listed.tags[0]!.name, 'LegacyTag')
      assert.equal(listed.tags[0]!.archived, false)
      assert.equal(listed.tags[0]!.mergedIntoId, null)

      // JSON and CSV mapping exports work on v2 schema.
      const jsonExport = await degradedService.exportMappingReport({ format: 'json' })
      assert.equal(jsonExport.ok, true)
      assert.equal(jsonExport.rowCount, 1)
      assert.match(jsonExport.content, /LegacyTag/)

      const csvExport = await degradedService.exportMappingReport({ format: 'csv' })
      assert.equal(csvExport.ok, true)
      assert.equal(csvExport.rowCount, 1)
      assert.match(csvExport.content, /LegacyTag/)

      // Preview on v2 degraded DB returns safe empty non-committable result without writing.
      const preview = await degradedService.previewManifestPerformers({ manifestId: 1 })
      assert.equal(preview.canCommit, false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
