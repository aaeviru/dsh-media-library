import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import { migrateDatabase } from '../../src/db/schema.ts';
import { addAlias, archiveTag, createTag } from '../../src/mutations/index.ts';
import { previewTagNames } from '../../src/performers/index.ts';
import { MediaLibrarySpikeService } from '../../src/spike-service.ts';

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
});
