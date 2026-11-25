import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import { getCurrentSchemaVersion, migrateDatabase, V1_SCHEMA_MIGRATION } from '../../src/db/schema.ts';
import { normalizeLookupKey } from '../../src/inventory/tagstudio-inventory.ts';
import { addAlias, archiveTag, createTag } from '../../src/mutations/index.ts';
import { normalizeLabel } from '../../src/mutations/transaction.ts';
import { previewTagNames } from '../../src/performers/index.ts';
import { MediaLibrarySpikeService } from '../../src/spike-service.ts';
import { normalizeTagName } from '../../src/types.ts';

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function createMigratedDb(): Promise<{ dir: string; dbPath: string; db: DatabaseSync }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preview-tags-'));
  cleanups.push(dir);
  const dbPath = path.join(dir, 'library.sqlite3');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  await migrateDatabase(db, { dbPath, appVersion: '0.7.10' });
  return { dir, dbPath, db };
}

describe('Host previewTagNames pure-read resolver (Issue #71 B1..B3)', () => {
  it('resolves direct/case/whitespace matches, alias matches, archived tags, and archived-only aliases', async () => {
    const { db } = await createMigratedDb();
    try {
      const highRes = createTag(db, { name: 'High Res' });
      assert.equal(highRes.ok, true);
      if (!highRes.ok) return;

      const aliasAdded = addAlias(db, {
        tagId: highRes.tagId,
        alias: 'HD Video',
        expectedRevision: highRes.revision,
      });
      assert.equal(aliasAdded.ok, true);

      const outdoor = createTag(db, { name: 'Outdoor' });
      assert.equal(outdoor.ok, true);
      if (!outdoor.ok) return;

      const archivedTag = createTag(db, { name: 'Deprecated Tag' });
      assert.equal(archivedTag.ok, true);
      if (!archivedTag.ok) return;

      const archivedAlias = addAlias(db, {
        tagId: archivedTag.tagId,
        alias: 'Old Alias',
        expectedRevision: archivedTag.revision,
      });
      assert.equal(archivedAlias.ok, true);
      if (!archivedAlias.ok) return;

      const archivedRes = archiveTag(db, {
        tagId: archivedTag.tagId,
        expectedRevision: archivedAlias.revision,
      });
      assert.equal(archivedRes.ok, true);

      // Imported/historical shared alias pointing to both an archived tag and an active tag ->
      // archived target is filtered out and the active tag wins via 'alias'.
      const activeFallback = createTag(db, { name: 'Active Target' });
      assert.equal(activeFallback.ok, true);
      if (!activeFallback.ok) return;
      db.prepare(
        `INSERT INTO tag_aliases (tag_id, alias, normalized_alias)
         VALUES (?, ?, ?), (?, ?, ?)`,
      ).run(
        archivedTag.tagId,
        'Shared Alias',
        'shared alias',
        activeFallback.tagId,
        'Shared Alias',
        'shared alias',
      );

      const entries = previewTagNames(db, [
        '  outdoor  ',
        'HIGH   res',
        '  hd   video ',
        'Deprecated Tag',
        'Old Alias',
        'Shared Alias',
        'Brand New Tag',
        '   ',
        'OUTDOOR',
      ]);

      assert.deepEqual(entries, [
        {
          rawName: 'outdoor',
          matchedTagId: outdoor.tagId,
          matchedTagName: 'Outdoor',
          matchedVia: 'name',
        },
        {
          rawName: 'HIGH   res',
          matchedTagId: highRes.tagId,
          matchedTagName: 'High Res',
          matchedVia: 'name',
        },
        {
          rawName: 'hd   video',
          matchedTagId: highRes.tagId,
          matchedTagName: 'High Res',
          matchedVia: 'alias',
        },
        {
          rawName: 'Deprecated Tag',
          matchedTagId: null,
          matchedTagName: null,
          matchedVia: 'new',
        },
        {
          rawName: 'Old Alias',
          matchedTagId: null,
          matchedTagName: null,
          matchedVia: 'new',
        },
        {
          rawName: 'Shared Alias',
          matchedTagId: activeFallback.tagId,
          matchedTagName: 'Active Target',
          matchedVia: 'alias',
        },
        {
          rawName: 'Brand New Tag',
          matchedTagId: null,
          matchedTagName: null,
          matchedVia: 'new',
        },
        {
          rawName: 'OUTDOOR',
          matchedTagId: outdoor.tagId,
          matchedTagName: 'Outdoor',
          matchedVia: 'name',
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('resolves >50 tags without any 30-tag truncation cap and preserves input order', async () => {
    const { db } = await createMigratedDb();
    try {
      const totalTags = 65;
      const tagIds = new Map<string, number>();
      for (let i = 1; i <= totalTags; i += 1) {
        const name = `CatalogTag ${String(i).padStart(2, '0')}`;
        const created = createTag(db, { name });
        assert.equal(created.ok, true);
        if (!created.ok) return;
        tagIds.set(name, created.tagId);
        if (i === 60) {
          const added = addAlias(db, {
            tagId: created.tagId,
            alias: 'Sixtieth Alias',
            expectedRevision: created.revision,
          });
          assert.equal(added.ok, true);
        }
      }

      const queryNames: string[] = [];
      for (let i = totalTags; i >= 1; i -= 1) {
        queryNames.push(`catalogtag ${String(i).padStart(2, '0')}`);
      }
      queryNames.push('sixtieth alias', 'Totally Unknown Beyond 65');

      const result = previewTagNames(db, queryNames);
      assert.equal(result.length, totalTags + 2);
      for (let idx = 0; idx < totalTags; idx += 1) {
        const num = totalTags - idx;
        const expectedCanonical = `CatalogTag ${String(num).padStart(2, '0')}`;
        assert.deepEqual(result[idx], {
          rawName: `catalogtag ${String(num).padStart(2, '0')}`,
          matchedTagId: tagIds.get(expectedCanonical)!,
          matchedTagName: expectedCanonical,
          matchedVia: 'name',
        });
      }
      assert.deepEqual(result[totalTags], {
        rawName: 'sixtieth alias',
        matchedTagId: tagIds.get('CatalogTag 60')!,
        matchedTagName: 'CatalogTag 60',
        matchedVia: 'alias',
      });
      assert.deepEqual(result[totalTags + 1], {
        rawName: 'Totally Unknown Beyond 65',
        matchedTagId: null,
        matchedTagName: null,
        matchedVia: 'new',
      });
    } finally {
      db.close();
    }
  });

  it('handles databases without tags/tag_aliases tables gracefully as new entries', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const result = previewTagNames(db, ['Alpha', '  ', 'Beta']);
      assert.deepEqual(result, [
        { rawName: 'Alpha', matchedTagId: null, matchedTagName: null, matchedVia: 'new' },
        { rawName: 'Beta', matchedTagId: null, matchedTagName: null, matchedVia: 'new' },
      ]);
    } finally {
      db.close();
    }
  });

  it('MediaLibrarySpikeService.previewTagNames fast-paths empty input, works in degraded read-only mode, and never triggers auto-backup', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preview-svc-'));
    cleanups.push(dir);
    const dbPath = path.join(dir, 'library.sqlite3');

    // Fast-path empty/blank input before DB even exists
    const uninitService = new MediaLibrarySpikeService({
      baseDir: dir,
      dbPath,
      autoDailyBackup: true,
    });
    assert.deepEqual(await uninitService.previewTagNames({ names: [] }), []);
    assert.deepEqual(await uninitService.previewTagNames({ names: ['   ', '\t'] }), []);
    assert.equal(fs.existsSync(dbPath), false, 'empty/blank input must fast-path without creating DB');

    // Seed normal service (autoDailyBackup disabled during setup)
    const writerService = new MediaLibrarySpikeService({
      baseDir: dir,
      dbPath,
      autoDailyBackup: false,
    });
    const created = await writerService.createTag({ name: 'Cinema' });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const aliased = await writerService.addAlias({
      tagId: created.tagId,
      alias: 'Movie',
      expectedRevision: created.revision,
    });
    assert.equal(aliased.ok, true);

    // Normal mode previewTagNames
    const normalRes = await writerService.previewTagNames({
      names: ['cinema', 'MOVIE', 'UnseenTag'],
    });
    assert.deepEqual(normalRes, [
      { rawName: 'cinema', matchedTagId: created.tagId, matchedTagName: 'Cinema', matchedVia: 'name' },
      { rawName: 'MOVIE', matchedTagId: created.tagId, matchedTagName: 'Cinema', matchedVia: 'alias' },
      { rawName: 'UnseenTag', matchedTagId: null, matchedTagName: null, matchedVia: 'new' },
    ]);

    // Verify previewTagNames does NOT trigger daily auto-backup even when a new day arrives
    const backupDir = path.join(dir, 'backups');
    let currentDay = new Date('2026-11-25T10:00:00.000Z');
    const readerWithBackup = new MediaLibrarySpikeService({
      baseDir: dir,
      dbPath,
      autoDailyBackup: true,
      now: () => currentDay,
    });
    await readerWithBackup.initialize();
    const backupsAfterInit = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    // Advance clock by 2 days so a write-triggered backup would fire, then call previewTagNames
    currentDay = new Date('2026-11-27T10:00:00.000Z');
    const afterTwoDays = await readerWithBackup.previewTagNames({ names: ['Cinema', 'Movie'] });
    assert.equal(afterTwoDays.length, 2);
    const backupsAfterPreview = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    assert.deepEqual(
      backupsAfterPreview,
      backupsAfterInit,
      'pure-read previewTagNames must not trigger daily auto-backup',
    );

    // Degraded read-only mode (supportedMaxVersion lower than current DB schema)
    const degradedService = new MediaLibrarySpikeService({
      baseDir: dir,
      dbPath,
      supportedMaxVersion: 1,
      autoDailyBackup: false,
    });
    const ops = await degradedService.getOpsStatus();
    assert.equal(ops.degradedState.degraded, true);

    const degradedRes = await degradedService.previewTagNames({
      names: ['Cinema', 'movie', 'StillNew'],
    });
    assert.deepEqual(degradedRes, [
      { rawName: 'Cinema', matchedTagId: created.tagId, matchedTagName: 'Cinema', matchedVia: 'name' },
      { rawName: 'movie', matchedTagId: created.tagId, matchedTagName: 'Cinema', matchedVia: 'alias' },
      { rawName: 'StillNew', matchedTagId: null, matchedTagName: null, matchedVia: 'new' },
    ]);
  });

  it('is strictly pure read-only as the VERY FIRST call on a fresh service (no DB creation, no migration, no interrupted-task write, no auto-backup)', async () => {
    const sha256File = (filePath: string): string =>
      crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

    // 1. Fresh service with non-existent DB path + non-empty input: must NOT create DB or backup dir
    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preview-first-missing-'));
    cleanups.push(missingDir);
    const missingDbPath = path.join(missingDir, 'nested', 'library.sqlite3');
    const missingService = new MediaLibrarySpikeService({
      baseDir: missingDir,
      dbPath: missingDbPath,
      autoDailyBackup: true,
    });
    const missingRes = await missingService.previewTagNames({ names: ['  Alpha  ', 'Beta'] });
    assert.deepEqual(missingRes, [
      { rawName: 'Alpha', matchedTagId: null, matchedTagName: null, matchedVia: 'new' },
      { rawName: 'Beta', matchedTagId: null, matchedTagName: null, matchedVia: 'new' },
    ]);
    assert.equal(fs.existsSync(missingDbPath), false, 'first non-empty previewTagNames must not create DB file');
    assert.equal(fs.existsSync(path.dirname(missingDbPath)), false, 'first non-empty previewTagNames must not create DB directory');
    assert.equal(fs.existsSync(path.join(path.dirname(missingDbPath), 'backups')), false, 'must not create backups directory');

    // 2. Fresh service pointing at an existing v7 DB with a running ingestion task and autoDailyBackup=true:
    //    must NOT trigger daily auto-backup or mark the running task interrupted, and DB bytes stay identical.
    const seededDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preview-first-v7-'));
    cleanups.push(seededDir);
    const seededDbPath = path.join(seededDir, 'library.sqlite3');
    const backupDir = path.join(seededDir, 'backups');
    const db = new DatabaseSync(seededDbPath);
    try {
      db.exec('PRAGMA foreign_keys = ON;');
      await migrateDatabase(db, { dbPath: seededDbPath, appVersion: '0.7.10' });
      const tag = createTag(db, { name: 'StudioTag' });
      assert.equal(tag.ok, true);
      if (!tag.ok) return;
      const alias = addAlias(db, { tagId: tag.tagId, alias: 'StudioAlias', expectedRevision: tag.revision });
      assert.equal(alias.ok, true);
      const nowIso = '2026-11-25T00:00:00.000Z';
      db.prepare(
        `INSERT INTO ingestion_tasks (target_key, op, status, phase, message, started_at, phase_started_at)
         VALUES ('manifest:1', 'commit', 'running', 'copy', 'in progress', ?, ?)`,
      ).run(nowIso, nowIso);
    } finally {
      db.close();
    }

    const beforeStat = fs.statSync(seededDbPath);
    const beforeHash = sha256File(seededDbPath);

    const freshReader = new MediaLibrarySpikeService({
      baseDir: seededDir,
      dbPath: seededDbPath,
      autoDailyBackup: true,
      now: () => new Date('2026-11-26T12:00:00.000Z'),
    });
    const firstCallRes = await freshReader.previewTagNames({
      names: ['studiotag', 'STUDIOALIAS', 'UnknownFresh'],
    });
    assert.equal(firstCallRes[0]?.matchedVia, 'name');
    assert.equal(firstCallRes[1]?.matchedVia, 'alias');
    assert.equal(firstCallRes[1]?.matchedTagName, 'StudioTag');
    assert.equal(firstCallRes[2]?.matchedVia, 'new');

    const afterStat = fs.statSync(seededDbPath);
    const afterHash = sha256File(seededDbPath);
    assert.equal(afterHash, beforeHash, 'first-call previewTagNames must not modify DB bytes');
    assert.equal(afterStat.size, beforeStat.size, 'first-call previewTagNames must not change DB size');
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, 'first-call previewTagNames must not touch DB mtime');
    assert.equal(fs.existsSync(backupDir), false, 'first-call previewTagNames must not create daily auto-backup');

    const verifyDb = new DatabaseSync(seededDbPath, { readOnly: true });
    try {
      const taskRow = verifyDb
        .prepare("SELECT status FROM ingestion_tasks WHERE target_key = 'manifest:1'")
        .get() as { status: string };
      assert.equal(taskRow.status, 'running', 'first-call previewTagNames must not mutate running ingestion_tasks');
    } finally {
      verifyDb.close();
    }

    // 3. Fresh service pointing at a pre-v3 (v1) DB without archived_at:
    //    must NOT migrate the DB and still resolve tags & aliases read-only.
    const v1Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preview-first-v1-'));
    cleanups.push(v1Dir);
    const v1DbPath = path.join(v1Dir, 'library.sqlite3');
    const v1Db = new DatabaseSync(v1DbPath);
    try {
      v1Db.exec('PRAGMA foreign_keys = ON;');
      await migrateDatabase(v1Db, {
        dbPath: v1DbPath,
        appVersion: '0.1.0',
        migrations: [V1_SCHEMA_MIGRATION],
      });
      const ts = '2026-11-25T00:00:00.000Z';
      v1Db.prepare('INSERT INTO tags (id, name, normalized_name, created_at, updated_at) VALUES (1, ?, ?, ?, ?)').run(
        'LegacyTag',
        'legacytag',
        ts,
        ts,
      );
      v1Db.prepare('INSERT INTO tag_aliases (tag_id, alias, normalized_alias) VALUES (1, ?, ?)').run(
        'LegacyAlias',
        'legacyalias',
      );
    } finally {
      v1Db.close();
    }

    const v1HashBefore = sha256File(v1DbPath);
    const v1Service = new MediaLibrarySpikeService({
      baseDir: v1Dir,
      dbPath: v1DbPath,
      autoDailyBackup: true,
    });
    const v1Res = await v1Service.previewTagNames({ names: ['legacytag', 'LEGACYALIAS', 'NotInV1'] });
    assert.deepEqual(v1Res, [
      { rawName: 'legacytag', matchedTagId: 1, matchedTagName: 'LegacyTag', matchedVia: 'name' },
      { rawName: 'LEGACYALIAS', matchedTagId: 1, matchedTagName: 'LegacyTag', matchedVia: 'alias' },
      { rawName: 'NotInV1', matchedTagId: null, matchedTagName: null, matchedVia: 'new' },
    ]);
    assert.equal(sha256File(v1DbPath), v1HashBefore, 'v1 DB bytes must remain untouched');
    const v1Check = new DatabaseSync(v1DbPath, { readOnly: true });
    try {
      assert.equal(getCurrentSchemaVersion(v1Check), 1, 'v1 DB must not be migrated by previewTagNames');
    } finally {
      v1Check.close();
    }
  });

  it('Client and Host tag normalization share one implementation', () => {
    const samples = ['  High   Res  ', '\tUPPER\n  Case ', '日本語  タグ', '   '];
    for (const sample of samples) {
      assert.equal(normalizeLookupKey(sample), normalizeTagName(sample));
      assert.equal(normalizeLabel(sample), normalizeTagName(sample));
    }
  });
});
