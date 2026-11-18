import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  collectDatabaseTableCounts,
  createDatabaseBackup,
  restoreDatabaseFromBackup,
} from '../../src/db/backup.ts'
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_MIGRATIONS,
  getCurrentSchemaVersion,
  migrateDatabase,
  openMediaLibraryDatabase,
  resolveLocalDatabasePath,
  runDatabaseHealthChecks,
  V1_SCHEMA_MIGRATION,
  type SchemaMigration,
} from '../../src/db/schema.ts'

describe('Local SQLite Schema, Migration Runner & Backup/Restore (Issue #3 B1, B2, B7)', () => {
  let tempRoot: string

  before(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-media-db-test-'))
  })

  after(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('B1: enforces local DSH_HOME database path and rejects SMB/UNC paths or plugin bundle paths', () => {
    const mockDshHome = path.join(tempRoot, 'dsh-home')
    const mockPluginDir = path.join(tempRoot, 'plugin-bundle')

    const defaultResolved = resolveLocalDatabasePath({
      dshHome: mockDshHome,
      pluginPackageDir: mockPluginDir,
    })
    assert.equal(defaultResolved, path.join(mockDshHome, 'media-library', 'library.sqlite3'))

    // Reject Windows UNC and POSIX network share paths
    assert.throws(
      () => resolveLocalDatabasePath({ dbPath: '\\\\SynologyNAS\\Media\\library.sqlite3' }),
      /never on an SMB\/UNC share/,
    )
    assert.throws(
      () => resolveLocalDatabasePath({ dbPath: '//SynologyNAS/Media/library.sqlite3' }),
      /never on an SMB\/UNC share/,
    )
    assert.throws(
      () => resolveLocalDatabasePath({ dshHome: '\\\\SynologyNAS\\dsh-home' }),
      /never on an SMB\/UNC share/,
    )

    // Reject path inside plugin package directory
    assert.throws(
      () =>
        resolveLocalDatabasePath({
          dbPath: path.join(mockPluginDir, 'data', 'library.sqlite3'),
          pluginPackageDir: mockPluginDir,
        }),
      /must not be stored inside the plugin package directory/,
    )
  })

  it('B1 & B2: initializes current schema with foreign keys enabled, indexes created, and health checks passing', async () => {
    const dbPath = path.join(tempRoot, 'v1-init', 'library.sqlite3')
    const { db } = openMediaLibraryDatabase({ dbPath })
    try {
      const fkRow = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
      assert.equal(fkRow.foreign_keys, 1)

      const res1 = await migrateDatabase(db, { dbPath })
      assert.equal(res1.previousVersion, 0)
      assert.equal(res1.currentVersion, CURRENT_SCHEMA_VERSION)
      assert.deepEqual(res1.appliedVersions, [1, 2, 3, 4, 5, 6])
      assert.equal(res1.preUpgradeBackupPath, null)
      assert.equal(res1.health.ok, true)

      // Re-running migrateDatabase is a no-op
      const res2 = await migrateDatabase(db, { dbPath })
      assert.equal(res2.previousVersion, CURRENT_SCHEMA_VERSION)
      assert.equal(res2.currentVersion, CURRENT_SCHEMA_VERSION)
      assert.deepEqual(res2.appliedVersions, [])

      // Enforce ON DELETE RESTRICT on tags referenced by media_tags
      db.exec(`
        INSERT INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
        VALUES ('nas-main', 'NAS', '\\\\NAS\\Media', 1, '2026-11-15T00:00:00Z');
        INSERT INTO media_files (id, root_id, relative_path, filename, extension, status, revision)
        VALUES (1, 'nas-main', '2026\\a.mkv', 'a.mkv', 'mkv', 'indexed', 1);
        INSERT INTO tags (id, name, normalized_name, kind, created_at, updated_at, revision)
        VALUES (10, 'Tag A', 'tag a', 'custom', '2026-11-15T00:00:00Z', '2026-11-15T00:00:00Z', 1);
        INSERT INTO media_tags (media_id, tag_id, source, created_at)
        VALUES (1, 10, 'manual', '2026-11-15T00:00:00Z');
      `)

      assert.throws(() => {
        db.exec('DELETE FROM tags WHERE id = 10;')
      }, /FOREIGN KEY constraint failed/)

      // Enforce self-loop check on tag_parents
      assert.throws(() => {
        db.exec('INSERT INTO tag_parents (tag_id, parent_tag_id) VALUES (10, 10);')
      }, /CHECK constraint failed/)
    } finally {
      db.close()
    }
  })

  it('B2: creates a pre-upgrade backup via SQLite backup API and rolls back failed migrations cleanly', async () => {
    const dbPath = path.join(tempRoot, 'v2-upgrade', 'library.sqlite3')
    const backupDir = path.join(tempRoot, 'v2-upgrade', 'backups')
    const { db } = openMediaLibraryDatabase({ dbPath })

    try {
      await migrateDatabase(db, { dbPath, backupDir, migrations: [V1_SCHEMA_MIGRATION] })
      db.exec(`
        INSERT INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
        VALUES ('nas-main', 'NAS', '\\\\NAS\\Media', 1, '2026-11-15T00:00:00Z');
      `)

      // Simulate a failing v2 migration
      const failingV2: SchemaMigration = {
        version: 2,
        description: 'Failing v2 migration test',
        up(conn) {
          conn.exec('CREATE TABLE temp_v2_table (id INTEGER PRIMARY KEY);')
          throw new Error('Simulated v2 migration failure')
        },
      }

      await assert.rejects(
        () =>
          migrateDatabase(db, {
            dbPath,
            backupDir,
            migrations: [V1_SCHEMA_MIGRATION, failingV2],
          }),
        /Simulated v2 migration failure/,
      )

      // Schema version must remain 1, temp_v2_table must be rolled back, and existing data intact
      assert.equal(getCurrentSchemaVersion(db), 1)
      const tableExists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'temp_v2_table'")
        .get()
      assert.equal(tableExists, undefined)

      // Now run a valid v2 migration and verify preUpgradeBackupPath was created
      const validV2: SchemaMigration = {
        version: 2,
        description: 'Valid v2 migration test',
        up(conn) {
          conn.exec('ALTER TABLE media_files ADD COLUMN custom_note TEXT;')
        },
      }
      const upgradeRes = await migrateDatabase(db, {
        dbPath,
        backupDir,
        migrations: [V1_SCHEMA_MIGRATION, validV2],
      })
      assert.equal(upgradeRes.previousVersion, 1)
      assert.equal(upgradeRes.currentVersion, 2)
      assert.deepEqual(upgradeRes.appliedVersions, [2])
      assert.ok(upgradeRes.preUpgradeBackupPath && existsSync(upgradeRes.preUpgradeBackupPath))
    } finally {
      db.close()
    }
  })

  it('B4: upgrades a populated v1 database without losing associations, text, sequence or FK enforcement', async () => {
    const dbPath = path.join(tempRoot, 'status-upgrade', 'library.sqlite3')
    const { db } = openMediaLibraryDatabase({ dbPath })
    try {
      await migrateDatabase(db, { dbPath, migrations: [V1_SCHEMA_MIGRATION] })
      db.exec(`
        INSERT INTO media_roots VALUES ('nas-main', 'NAS', '\\\\NAS\\Media', 1, '2026-11-15');
        INSERT INTO media_files(id, root_id, relative_path, filename, extension, status)
          VALUES (1, 'nas-main', 'a.mkv', 'a.mkv', 'mkv', 'offline'),
                 (99, 'nas-main', 'deleted.mkv', 'deleted.mkv', 'mkv', 'indexed');
        DELETE FROM media_files WHERE id = 99;
        INSERT INTO tags(id, name, normalized_name, created_at, updated_at) VALUES (1, 'A', 'a', 'now', 'now');
        INSERT INTO media_tags(media_id, tag_id, created_at) VALUES (1, 1, 'now');
        INSERT INTO media_text_fields(media_id, field_name, field_value) VALUES (1, 'title', 'Preserve me');
      `)
      const snapshot = () => ['media_files', 'media_tags', 'media_text_fields'].map(table => db.prepare(`SELECT * FROM ${table}`).all())
      const before = snapshot()
      const failedUpgrade: SchemaMigration = {
        ...DEFAULT_MIGRATIONS[1]!,
        up(conn) {
          DEFAULT_MIGRATIONS[1]!.up(conn)
          throw new Error('fail after rebuild')
        },
      }
      await assert.rejects(migrateDatabase(db, { dbPath, migrations: [V1_SCHEMA_MIGRATION, failedUpgrade] }), /fail after rebuild/)
      assert.equal(getCurrentSchemaVersion(db), 1)
      assert.deepEqual(snapshot(), before)
      assert.equal(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1)
      const migrated = await migrateDatabase(db, { dbPath })
      assert.ok(migrated.preUpgradeBackupPath && existsSync(migrated.preUpgradeBackupPath))
      assert.deepEqual(snapshot(), before)
      for (const status of ['unmapped', 'permission_denied', 'indexed', 'missing', 'offline']) {
        db.prepare('UPDATE media_files SET status = ? WHERE id = 1').run(status)
      }
      assert.throws(() => db.exec("UPDATE media_files SET status = 'invalid'"), /CHECK constraint failed/)
      assert.throws(() => db.exec('DELETE FROM media_roots'), /FOREIGN KEY constraint failed/)
      const inserted = db.prepare("INSERT INTO media_files(root_id, relative_path, filename, extension) VALUES ('nas-main', 'b.mkv', 'b.mkv', 'mkv')").run()
      assert.equal(Number(inserted.lastInsertRowid), 100)
      assert.equal(runDatabaseHealthChecks(db).ok, true)
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_media_files_keyset_order'").get())
    } finally {
      db.close()
    }
  })

  it('B7: backs up a database via node:sqlite backup() and restores into an empty directory with identical counts', async () => {
    const sourceDbPath = path.join(tempRoot, 'v1-init', 'library.sqlite3')
    const backupFilePath = path.join(tempRoot, 'backups', 'manual-snapshot.sqlite3')
    const restoredDbPath = path.join(tempRoot, 'restored-empty-dir', 'library.sqlite3')

    const backupRes = await createDatabaseBackup(sourceDbPath, backupFilePath)
    assert.equal(backupRes.health.ok, true)
    assert.equal(backupRes.counts.mediaRoots, 1)
    assert.equal(backupRes.counts.mediaFiles, 1)
    assert.equal(backupRes.counts.tags, 1)
    assert.equal(backupRes.counts.mediaTags, 1)

    const restoreRes = await restoreDatabaseFromBackup(backupFilePath, restoredDbPath)
    assert.equal(restoreRes.health.ok, true)
    assert.equal(restoreRes.countsMatch, true)
    assert.deepEqual(restoreRes.restoredCounts, backupRes.counts)

    const { db: restoredDb } = openMediaLibraryDatabase({ dbPath: restoredDbPath })
    try {
      assert.equal(runDatabaseHealthChecks(restoredDb).ok, true)
      assert.deepEqual(collectDatabaseTableCounts(restoredDb), backupRes.counts)
    } finally {
      restoredDb.close()
    }
  })
})
