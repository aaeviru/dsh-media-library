import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { collectDatabaseTableCounts } from '../../src/db/backup.ts'
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_MIGRATIONS,
  getCurrentSchemaVersion,
  migrateDatabase,
  openMediaLibraryDatabase,
  runDatabaseHealthChecks,
  V1_SCHEMA_MIGRATION,
  V2_MEDIA_STATUS_MIGRATION,
  V3_TAG_MANAGEMENT_MIGRATION,
  type SchemaMigration,
} from '../../src/db/schema.ts'

describe('Schema v3 migration (Issue #5 B6)', () => {
  let tempRoot: string
  before(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-media-v3-'))
  })
  after(() => rmSync(tempRoot, { recursive: true, force: true }))

  async function makeV2(dbPath: string) {
    const { db } = openMediaLibraryDatabase({ dbPath })
    await migrateDatabase(db, { dbPath, migrations: [V1_SCHEMA_MIGRATION, V2_MEDIA_STATUS_MIGRATION], appVersion: '0.2.0' })
    db.exec(`
      INSERT INTO media_roots VALUES ('nas-main', 'NAS', '\\\\NAS\\Media', 1, '2026-11-15');
      INSERT INTO media_files(id, root_id, relative_path, filename, extension, status)
        VALUES (1, 'nas-main', 'a.mkv', 'a.mkv', 'mkv', 'indexed'), (2, 'nas-main', 'b.mkv', 'b.mkv', 'mkv', 'offline');
      INSERT INTO tags(id, name, normalized_name, created_at, updated_at, revision) VALUES (1, 'A', 'a', 'now', 'now', 4), (2, 'B', 'b', 'now', 'now', 1);
      INSERT INTO tag_aliases(tag_id, alias, normalized_alias) VALUES (1, 'Aye', 'aye');
      INSERT INTO tag_parents(tag_id, parent_tag_id) VALUES (2, 1);
      INSERT INTO media_tags(media_id, tag_id, source, created_at) VALUES (1, 1, 'manual', 'now'), (2, 2, 'tagstudio-import', 'now');
      INSERT INTO media_text_fields(media_id, field_name, field_value) VALUES (1, 'title', 'Keep');
      INSERT INTO legacy_ids VALUES ('tagstudio', '1', 'tag', 1);
    `)
    return db
  }

  it('v2 -> v3 upgrades with a pre-upgrade backup and preserves every data count', async () => {
    const dbPath = path.join(tempRoot, 'up', 'library.sqlite3')
    const db = await makeV2(dbPath)
    try {
      assert.equal(getCurrentSchemaVersion(db), 2)
      const before = collectDatabaseTableCounts(db)
      const tagsBefore = db.prepare('SELECT id, name, normalized_name, revision FROM tags ORDER BY id').all()
      const res = await migrateDatabase(db, { dbPath, migrations: DEFAULT_MIGRATIONS.slice(0, 3) })
      assert.equal(res.previousVersion, 2)
      assert.equal(res.currentVersion, 3)
      assert.deepEqual(res.appliedVersions, [3])
      assert.ok(res.health.ok)
      assert.ok(res.preUpgradeBackupPath && existsSync(res.preUpgradeBackupPath))
      assert.match(path.basename(res.preUpgradeBackupPath), /^pre-migrate-v2-to-v3-.*\.sqlite3$/)

      const after = collectDatabaseTableCounts(db)
      assert.deepEqual({ ...after, schemaVersions: 0 }, { ...before, schemaVersions: 0 })
      assert.equal(after.schemaVersions, before.schemaVersions + 1)
      assert.deepEqual(db.prepare('SELECT id, name, normalized_name, revision FROM tags ORDER BY id').all(), tagsBefore)
      assert.deepEqual(
        db.prepare('SELECT archived_at, merged_into_id FROM tags').all().map(r => [r.archived_at, r.merged_into_id]),
        [[null, null], [null, null]],
      )
      assert.equal(Number((db.prepare('SELECT COUNT(*) AS c FROM mutation_log').get() as { c: number }).c), 0)
      assert.equal(
        (db.prepare('SELECT app_version FROM schema_versions WHERE version = 3').get() as { app_version: string }).app_version,
        '0.6.0',
      )
      assert.equal(runDatabaseHealthChecks(db).ok, true)

      // The backup is a faithful v2 snapshot.
      const backupDb = new DatabaseSync(res.preUpgradeBackupPath, { readOnly: true })
      try {
        assert.equal(getCurrentSchemaVersion(backupDb), 2)
        assert.deepEqual(collectDatabaseTableCounts(backupDb), before)
      } finally {
        backupDb.close()
      }
      // FK enforcement for the new self-reference.
      assert.throws(() => db.exec('UPDATE tags SET merged_into_id = 999 WHERE id = 2'), /FOREIGN KEY/)
    } finally {
      db.close()
    }
  })

  it('a failing v3 rolls back to v2 untouched but the backup was already taken', async () => {
    const dbPath = path.join(tempRoot, 'fail', 'library.sqlite3')
    const db = await makeV2(dbPath)
    try {
      const failing: SchemaMigration = {
        ...V3_TAG_MANAGEMENT_MIGRATION,
        up(conn) {
          V3_TAG_MANAGEMENT_MIGRATION.up(conn)
          throw new Error('v3 boom')
        },
      }
      await assert.rejects(
        () => migrateDatabase(db, { dbPath, migrations: [V1_SCHEMA_MIGRATION, V2_MEDIA_STATUS_MIGRATION, failing] }),
        /v3 boom/,
      )
      assert.equal(getCurrentSchemaVersion(db), 2)
      const cols = db.prepare("SELECT name FROM pragma_table_info('tags')").all().map(r => r.name)
      assert.equal(cols.includes('archived_at'), false)
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'mutation_log'").get(), undefined)
      assert.equal(collectDatabaseTableCounts(db).tags, 2)
    } finally {
      db.close()
    }
  })

  it('DEFAULT_MIGRATIONS ends at CURRENT_SCHEMA_VERSION and a fresh database reaches it directly', async () => {
    assert.equal(DEFAULT_MIGRATIONS.at(-1)?.version, CURRENT_SCHEMA_VERSION)
    const { db } = openMediaLibraryDatabase({ dbPath: ':memory:' })
    const res = await migrateDatabase(db)
    assert.equal(res.currentVersion, CURRENT_SCHEMA_VERSION)
    assert.equal(res.preUpgradeBackupPath, null)
    db.close()
  })
})
