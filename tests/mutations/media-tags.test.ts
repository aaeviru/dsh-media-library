import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { archiveTag, removeAutomatedMediaTags, setMediaTags } from '../../src/mutations/index.ts'
import { openSeededDb } from './helpers.ts'

function mediaRevision(s: { db: import('node:sqlite').DatabaseSync }, id: number): number {
  return Number((s.db.prepare('SELECT revision FROM media_files WHERE id = ?').get(id) as { revision: number }).revision)
}

describe('Batch media tag mutations (Issue #5 B3)', () => {
  it('adds tags as source=manual, is idempotent, keeps the original source of existing links', async () => {
    const s = await openSeededDb()
    const [m1, m2] = s.media(2)
    const t = s.tag('T')
    s.assoc(m1!, t, 'tagstudio-import')
    const res = setMediaTags(s.db, { mediaIds: [String(m1), String(m2)], addTagIds: [t] })
    assert.ok(res.ok)
    assert.deepEqual([res.added, res.unchanged, res.removed, res.mediaCount], [1, 1, 0, 2])
    const rows = s.db.prepare('SELECT media_id, source FROM media_tags ORDER BY media_id').all() as Array<{ media_id: number; source: string }>
    assert.deepEqual(rows.map(r => [r.media_id, r.source]), [[m1, 'tagstudio-import'], [m2, 'manual']])
    assert.equal(mediaRevision(s, m1!), 1, 'untouched media revision unchanged')
    assert.equal(mediaRevision(s, m2!), 2)
    const again = setMediaTags(s.db, { mediaIds: [String(m1), String(m2)], addTagIds: [t] })
    assert.ok(again.ok && again.added === 0 && again.unchanged === 2)
    assert.equal(s.logCount(), 2)
  })

  it('removes associations of any source via the user path', async () => {
    const s = await openSeededDb()
    const [m] = s.media(1)
    const t1 = s.tag('A')
    const t2 = s.tag('B')
    s.assoc(m!, t1, 'manual')
    s.assoc(m!, t2, 'performer-rule')
    const res = setMediaTags(s.db, { mediaIds: [String(m)], removeTagIds: [t1, t2] })
    assert.ok(res.ok && res.removed === 2)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS c FROM media_tags').get()?.c, 0)
  })

  it('BATCH_TOO_LARGE: 201 ids rejected before touching the database; 200 accepted atomically', async () => {
    const s = await openSeededDb()
    const ids = s.media(201)
    const t = s.tag('T')
    const before = s.snapshot()
    const tooMany = setMediaTags(s.db, { mediaIds: ids.map(String), addTagIds: [t] })
    assert.equal(!tooMany.ok && tooMany.code, 'BATCH_TOO_LARGE')
    assert.equal(s.snapshot(), before)
    assert.equal(s.logCount(), 0)
    const exact = setMediaTags(s.db, { mediaIds: ids.slice(0, 200).map(String), addTagIds: [t] })
    assert.ok(exact.ok && exact.added === 200)
    assert.equal(s.logCount(), 1)
  })

  it('rolls the WHOLE batch back and reports per-item reasons (missing media, archived tag)', async () => {
    const s = await openSeededDb()
    const [m1, m2] = s.media(2)
    const live = s.tag('Live')
    const dead = s.tag('Dead')
    archiveTag(s.db, { tagId: dead, expectedRevision: 1 })
    const before = s.snapshot()
    const logs = s.logCount()

    const missing = setMediaTags(s.db, { mediaIds: [String(m1), '9999', String(m2)], addTagIds: [live] })
    assert.equal(!missing.ok && missing.code, 'MEDIA_NOT_FOUND')
    assert.deepEqual(!missing.ok && missing.failures.map(f => [f.mediaId, f.code]), [['9999', 'MEDIA_NOT_FOUND']])

    const archived = setMediaTags(s.db, { mediaIds: [String(m1), String(m2)], addTagIds: [live, dead] })
    assert.equal(!archived.ok && archived.code, 'TAG_ARCHIVED')
    assert.deepEqual(!archived.ok && archived.failures.map(f => [f.tagId, f.code]), [[dead, 'TAG_ARCHIVED']])

    const both = setMediaTags(s.db, { mediaIds: ['x', '9999'], addTagIds: [live, 777] })
    assert.equal(both.ok, false)
    assert.equal(!both.ok && both.failures.length, 3)

    assert.equal(s.snapshot(), before)
    assert.equal(s.logCount(), logs)
  })

  it('rolls back earlier items when a later write fails mid-batch', async () => {
    const s = await openSeededDb()
    const ids = s.media(3)
    const t = s.tag('T')
    s.db.exec(`
      CREATE TRIGGER fail_third BEFORE INSERT ON media_tags WHEN NEW.media_id = ${ids[2]}
      BEGIN SELECT RAISE(ABORT, 'disk full (simulated)'); END;
    `)
    const before = s.snapshot()
    const res = setMediaTags(s.db, { mediaIds: ids.map(String), addTagIds: [t] })
    assert.equal(!res.ok && res.code, 'INTERNAL_ERROR')
    assert.equal(s.snapshot(), before)
    assert.equal(s.logCount(), 0)
  })

  it('honours optional expectedMediaRevisions (REVISION_CONFLICT, nothing written)', async () => {
    const s = await openSeededDb()
    const [m1, m2] = s.media(2)
    const t = s.tag('T')
    assert.ok(setMediaTags(s.db, { mediaIds: [String(m1)], addTagIds: [t] }).ok) // m1 revision -> 2
    const before = s.snapshot()
    const res = setMediaTags(s.db, {
      mediaIds: [String(m1), String(m2)],
      removeTagIds: [t],
      expectedMediaRevisions: [{ mediaId: String(m1), revision: 1 }],
    })
    assert.equal(!res.ok && res.code, 'REVISION_CONFLICT')
    assert.equal(s.snapshot(), before)
    const fresh = setMediaTags(s.db, {
      mediaIds: [String(m1)],
      removeTagIds: [t],
      expectedMediaRevisions: [{ mediaId: String(m1), revision: 2 }],
    })
    assert.ok(fresh.ok)
  })

  it('validates inputs (empty, overlap, bad ids) as INVALID_INPUT', async () => {
    const s = await openSeededDb()
    const [m] = s.media(1)
    const t = s.tag('T')
    for (const input of [
      { mediaIds: [], addTagIds: [t] },
      { mediaIds: [String(m)] },
      { mediaIds: [String(m)], addTagIds: [t], removeTagIds: [t] },
      { mediaIds: [String(m)], addTagIds: [1.5] },
      { mediaIds: [String(m)], addTagIds: ['1' as unknown as number] },
    ]) {
      const r = setMediaTags(s.db, input)
      assert.equal(!r.ok && r.code, 'INVALID_INPUT', JSON.stringify(input))
    }
    assert.equal(s.logCount(), 0)
  })

  it('automation (ingestion / performer-rule) can never delete manual associations', async () => {
    const s = await openSeededDb()
    const [m] = s.media(1)
    const t1 = s.tag('Manual')
    const t2 = s.tag('Auto')
    const t3 = s.tag('OtherAuto')
    s.assoc(m!, t1, 'manual')
    s.assoc(m!, t2, 'performer-rule')
    s.assoc(m!, t3, 'ingestion')
    const res = removeAutomatedMediaTags(s.db, { actor: 'performer-rule', mediaIds: [m!], tagIds: [t1, t2, t3] })
    assert.ok(res.ok)
    assert.deepEqual([res.removed, res.skipped], [1, 2])
    const left = s.db.prepare('SELECT tag_id, source FROM media_tags ORDER BY tag_id').all() as Array<{ tag_id: number; source: string }>
    assert.deepEqual(left.map(r => [r.tag_id, r.source]), [[t1, 'manual'], [t3, 'ingestion']])
    const bad = removeAutomatedMediaTags(s.db, { actor: 'manual' as never, mediaIds: [m!], tagIds: [t1] })
    assert.equal(!bad.ok && bad.code, 'INVALID_INPUT')
  })
})
