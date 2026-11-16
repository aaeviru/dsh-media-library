import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  addAlias,
  archiveTag,
  createTag,
  removeAlias,
  renameTag,
  requestTagDeletion,
  restoreTag,
  runMutation,
} from '../../src/mutations/index.ts'
import { listTagsInDatabase } from '../../src/search/search-repository.ts'
import { openSeededDb, tagRow } from './helpers.ts'

describe('Tag & alias mutations (Issue #5 B1, B2, B5, B6)', () => {
  it('B1: creates a trimmed tag at revision 1 and audits it', async () => {
    const s = await openSeededDb()
    const res = createTag(s.db, { name: '  New Tag  ' })
    assert.ok(res.ok)
    assert.equal(res.revision, 1)
    const row = tagRow(s.db, res.tagId)
    assert.equal(row.name, 'New Tag')
    assert.equal(row.normalized_name, 'new tag')
    const log = s.db.prepare('SELECT action, result, payload_json FROM mutation_log WHERE id = ?').get(res.mutationId) as {
      action: string
      result: string
      payload_json: string
    }
    assert.equal(log.action, 'tag.create')
    assert.equal(log.result, 'success')
    assert.equal(JSON.parse(log.payload_json).tagId, res.tagId)
  })

  it('B1: rejects empty names and normalized-name conflicts without writing or auditing', async () => {
    const s = await openSeededDb()
    s.tag('Existing')
    const before = s.snapshot()
    for (const name of ['', '   ', '\u0000x']) {
      const r = createTag(s.db, { name })
      assert.equal(r.ok, false)
      assert.equal(!r.ok && r.code, 'INVALID_INPUT')
    }
    const dup = createTag(s.db, { name: '  EXISTING ' })
    assert.equal(!dup.ok && dup.code, 'TAG_NAME_CONFLICT')
    assert.equal(s.snapshot(), before)
    assert.equal(s.logCount(), 0)
  })

  it('B1: rename needs the current revision; mismatch is REVISION_CONFLICT and writes nothing', async () => {
    const s = await openSeededDb()
    const id = s.tag('Old')
    const ok = renameTag(s.db, { tagId: id, name: 'Newer', expectedRevision: 1 })
    assert.ok(ok.ok)
    assert.equal(ok.revision, 2)
    const before = s.snapshot()
    const stale = renameTag(s.db, { tagId: id, name: 'Stale', expectedRevision: 1 })
    assert.equal(!stale.ok && stale.code, 'REVISION_CONFLICT')
    assert.equal(s.snapshot(), before)
    assert.equal(tagRow(s.db, id).name, 'Newer')
    s.tag('Other')
    const clash = renameTag(s.db, { tagId: id, name: 'OTHER', expectedRevision: 2 })
    assert.equal(!clash.ok && clash.code, 'TAG_NAME_CONFLICT')
    // Case-only rename of the same tag is allowed.
    assert.ok(renameTag(s.db, { tagId: id, name: 'NEWER', expectedRevision: 2 }).ok)
  })

  it('B2: ALIAS_CONFLICT against other tags names/aliases (normalised); shared legacy aliases are untouched', async () => {
    const s = await openSeededDb()
    const a = s.tag('Alpha')
    const b = s.tag('Beta')
    const c = s.tag('Gamma')
    s.alias(b, 'bee')
    // Legacy shared alias on two tags (imports may produce these) must stay.
    s.alias(a, 'shared')
    s.alias(c, 'shared')
    const sharedBefore = s.db.prepare("SELECT COUNT(*) AS c FROM tag_aliases WHERE normalized_alias = 'shared'").get() as { c: number }

    const byName = addAlias(s.db, { tagId: a, alias: ' BETA ', expectedRevision: 1 })
    assert.equal(!byName.ok && byName.code, 'ALIAS_CONFLICT')
    const byAlias = addAlias(s.db, { tagId: a, alias: 'Bee', expectedRevision: 1 })
    assert.equal(!byAlias.ok && byAlias.code, 'ALIAS_CONFLICT')
    const own = addAlias(s.db, { tagId: a, alias: 'alpha', expectedRevision: 1 })
    assert.equal(!own.ok && own.code, 'ALIAS_CONFLICT')
    assert.equal(s.logCount(), 0)

    const good = addAlias(s.db, { tagId: a, alias: 'A-One', expectedRevision: 1 })
    assert.ok(good.ok)
    assert.equal(good.revision, 2)
    const dupSame = addAlias(s.db, { tagId: a, alias: 'a-one', expectedRevision: 2 })
    assert.equal(!dupSame.ok && dupSame.code, 'ALIAS_CONFLICT')
    const sharedAfter = s.db.prepare("SELECT COUNT(*) AS c FROM tag_aliases WHERE normalized_alias = 'shared'").get() as { c: number }
    assert.equal(sharedAfter.c, sharedBefore.c)
  })

  it('B2: alias add/remove bump revision; removal needs expectedRevision and an existing alias', async () => {
    const s = await openSeededDb()
    const a = s.tag('Alpha')
    const added = addAlias(s.db, { tagId: a, alias: 'Al', expectedRevision: 1 })
    assert.ok(added.ok && added.revision === 2)
    const stale = removeAlias(s.db, { tagId: a, alias: 'Al', expectedRevision: 1 })
    assert.equal(!stale.ok && stale.code, 'REVISION_CONFLICT')
    const missing = removeAlias(s.db, { tagId: a, alias: 'nope', expectedRevision: 2 })
    assert.equal(!missing.ok && missing.code, 'ALIAS_NOT_FOUND')
    const removed = removeAlias(s.db, { tagId: a, alias: ' AL ', expectedRevision: 2 })
    assert.ok(removed.ok && removed.revision === 3)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS c FROM tag_aliases').get()?.c, 0)
    assert.equal(s.logCount(), 2)
  })

  it('B5: archive hides from default listTags, keeps associations; restore brings it back; no hard delete', async () => {
    const s = await openSeededDb()
    const [m] = s.media(1)
    const t = s.tag('Keeper')
    s.assoc(m!, t)
    const archived = archiveTag(s.db, { tagId: t, expectedRevision: 1 })
    assert.ok(archived.ok)
    assert.notEqual(tagRow(s.db, t).archived_at, null)
    assert.equal(listTagsInDatabase(s.db).tags.length, 0)
    const withArchived = listTagsInDatabase(s.db, { includeArchived: true }).tags
    assert.equal(withArchived.length, 1)
    assert.equal(withArchived[0]!.archived, true)
    assert.equal(withArchived[0]!.mediaCount, 1)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS c FROM media_tags').get()?.c, 1)

    const again = archiveTag(s.db, { tagId: t, expectedRevision: 2 })
    assert.equal(!again.ok && again.code, 'TAG_ARCHIVED')
    const rename = renameTag(s.db, { tagId: t, name: 'X', expectedRevision: 2 })
    assert.equal(!rename.ok && rename.code, 'TAG_ARCHIVED')
    const alias = addAlias(s.db, { tagId: t, alias: 'x', expectedRevision: 2 })
    assert.equal(!alias.ok && alias.code, 'TAG_ARCHIVED')

    const restored = restoreTag(s.db, { tagId: t, expectedRevision: 2 })
    assert.ok(restored.ok && restored.revision === 3)
    assert.equal(tagRow(s.db, t).archived_at, null)
    assert.equal(listTagsInDatabase(s.db).tags.length, 1)
    const notArchived = restoreTag(s.db, { tagId: t, expectedRevision: 3 })
    assert.equal(!notArchived.ok && notArchived.code, 'TAG_NOT_ARCHIVED')
  })

  it('B5: deletion request on a referenced tag is TAG_IN_USE; nothing is ever physically deleted', async () => {
    const s = await openSeededDb()
    const [m] = s.media(1)
    const used = s.tag('Used')
    const parentOnly = s.tag('ParentOnly')
    const unused = s.tag('Unused')
    s.assoc(m!, used)
    s.edge(used, parentOnly)
    const before = s.snapshot()
    const r1 = requestTagDeletion(s.db, { tagId: used, expectedRevision: 1 })
    assert.equal(!r1.ok && r1.code, 'TAG_IN_USE')
    const r2 = requestTagDeletion(s.db, { tagId: parentOnly, expectedRevision: 1 })
    assert.equal(!r2.ok && r2.code, 'TAG_IN_USE')
    assert.equal(s.snapshot(), before)
    const r3 = requestTagDeletion(s.db, { tagId: unused, expectedRevision: 1 })
    assert.ok(r3.ok)
    assert.notEqual(tagRow(s.db, unused).archived_at, null, 'unreferenced tag is archived, not removed')
    assert.equal(s.db.prepare('SELECT COUNT(*) AS c FROM tags').get()?.c, 3)
  })

  it('B6: a mutation that fails mid-transaction rolls back data AND audit', async () => {
    const s = await openSeededDb()
    s.db.exec(`
      CREATE TRIGGER boom BEFORE INSERT ON tag_aliases WHEN NEW.alias = 'explode'
      BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;
    `)
    const a = s.tag('Alpha')
    const before = s.snapshot()
    const res = addAlias(s.db, { tagId: a, alias: 'explode', expectedRevision: 1 })
    assert.equal(!res.ok && res.code, 'INTERNAL_ERROR')
    assert.match(!res.ok ? res.message : '', /simulated failure/)
    assert.equal(s.snapshot(), before)
    assert.equal(s.db.isTransaction, false)
    assert.equal(s.logCount(), 0)
    // The connection stays usable.
    assert.ok(addAlias(s.db, { tagId: a, alias: 'fine', expectedRevision: 1 }).ok)
  })

  it('B6: a failing audit insert rolls the data change back (no write without audit)', async () => {
    const s = await openSeededDb()
    s.db.exec(`
      CREATE TRIGGER no_audit BEFORE INSERT ON mutation_log
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;
    `)
    const before = s.snapshot()
    const res = createTag(s.db, { name: 'Ghost' })
    assert.equal(!res.ok && res.code, 'INTERNAL_ERROR')
    assert.equal(s.snapshot(), before)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS c FROM tags').get()?.c, 0)
  })

  it('B6: the write runner refuses to run with foreign keys disabled', async () => {
    const s = await openSeededDb()
    s.db.exec('PRAGMA foreign_keys = OFF;')
    const res = runMutation(s.db, 'x', () => ({ payload: {}, result: {} }))
    assert.equal(res.ok, false)
    assert.equal(s.logCount(), 0)
  })
})
