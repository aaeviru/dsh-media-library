import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { archiveTag, mergeTags, previewMerge } from '../../src/mutations/index.ts'
import { openSeededDb, tagRow } from './helpers.ts'

describe('Tag merge with impact preview (Issue #5 B4)', () => {
  it('previewMerge is read-only and reports media, dedupe, alias and edge impact', async () => {
    const s = await openSeededDb()
    const [m1, m2, m3] = s.media(3)
    const A = s.tag('A')
    const B = s.tag('B')
    const P = s.tag('Parent')
    s.assoc(m1!, A)
    s.assoc(m1!, B)
    s.assoc(m2!, B)
    s.assoc(m3!, B)
    s.alias(A, 'shared-alias')
    s.alias(B, 'Shared-Alias') // conflicts with A
    s.alias(B, 'b-only') // migrates
    s.edge(B, P)
    s.edge(A, P) // duplicate once B->A
    const before = s.snapshot()
    const p = previewMerge(s.db, { targetTagId: A, sourceTagId: B })
    assert.ok(p.ok)
    assert.deepEqual(
      [p.affectedMedia, p.dedupedMedia, p.aliasesMigrated, p.aliasesConflicting, p.parentEdgesMigrated, p.parentEdgesDeduped, p.wouldCreateCycle],
      [3, 1, 1, 1, 0, 1, false],
    )
    assert.deepEqual([p.targetRevision, p.sourceRevision], [1, 1])
    assert.equal(s.snapshot(), before)
    assert.equal(s.logCount(), 0, 'preview never audits')
  })

  it('merges: dedupes media, manual source wins, aliases migrate/drop, B archived with merged_into_id, single audit row', async () => {
    const s = await openSeededDb()
    const [m1, m2, m3, m4] = s.media(4)
    const A = s.tag('A')
    const B = s.tag('B')
    s.assoc(m1!, A, 'tagstudio-import')
    s.assoc(m1!, B, 'manual') // B manual beats A import
    s.assoc(m2!, A, 'manual')
    s.assoc(m2!, B, 'ingestion') // A manual stays
    s.assoc(m3!, B, 'performer-rule') // migrates, keeps source
    s.assoc(m4!, A, 'ingestion')
    s.alias(A, 'dup')
    s.alias(B, 'DUP')
    s.alias(B, 'moved')
    const res = mergeTags(s.db, { targetTagId: A, sourceTagId: B, expectedTargetRevision: 1, expectedSourceRevision: 1 })
    assert.ok(res.ok)
    assert.deepEqual(
      [res.migratedMediaTags, res.dedupedMediaTags, res.aliasesMigrated, res.aliasesDropped, res.targetRevision, res.sourceRevision],
      [1, 2, 1, 1, 2, 2],
    )
    const links = s.db.prepare('SELECT media_id, tag_id, source FROM media_tags ORDER BY media_id, tag_id').all() as Array<{ media_id: number; tag_id: number; source: string }>
    assert.deepEqual(
      links.map(l => [l.media_id, l.tag_id, l.source]),
      [[m1, A, 'manual'], [m2, A, 'manual'], [m3, A, 'performer-rule'], [m4, A, 'ingestion']],
    )
    const aliases = s.db.prepare('SELECT tag_id, alias FROM tag_aliases ORDER BY alias').all() as Array<{ tag_id: number; alias: string }>
    assert.deepEqual(aliases.map(a => [a.tag_id, a.alias]), [[A, 'dup'], [A, 'moved']])
    const b = tagRow(s.db, B)
    assert.notEqual(b.archived_at, null)
    assert.equal(b.merged_into_id, A)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS c FROM tags').get()?.c, 2, 'B is archived, never physically deleted')
    assert.equal(s.logCount(), 1)
    const log = s.db.prepare("SELECT payload_json FROM mutation_log WHERE action = 'tag.merge'").get() as { payload_json: string }
    assert.deepEqual(JSON.parse(log.payload_json).droppedAliases, ['DUP'])
    assert.equal(s.db.prepare('PRAGMA foreign_key_check').all().length, 0)
  })

  it('migrates and dedupes parent edges (both directions)', async () => {
    const s = await openSeededDb()
    const A = s.tag('A')
    const B = s.tag('B')
    const P = s.tag('P')
    const C = s.tag('C')
    s.edge(B, P) // B child of P -> A child of P
    s.edge(C, B) // C child of B -> C child of A
    s.edge(C, A) // duplicates mapped edge
    const p = previewMerge(s.db, { targetTagId: A, sourceTagId: B })
    assert.ok(p.ok && p.parentEdgesMigrated === 1 && p.parentEdgesDeduped === 1 && !p.wouldCreateCycle)
    assert.ok(mergeTags(s.db, { targetTagId: A, sourceTagId: B, expectedTargetRevision: 1, expectedSourceRevision: 1 }).ok)
    const edges = s.db.prepare('SELECT tag_id, parent_tag_id FROM tag_parents ORDER BY 1, 2').all() as Array<{ tag_id: number; parent_tag_id: number }>
    assert.deepEqual(edges.map(e => [e.tag_id, e.parent_tag_id]), [[A, P], [C, A]])
  })

  it('rejects cycles with MERGE_WOULD_CREATE_CYCLE and changes nothing', async () => {
    const s = await openSeededDb()
    const A = s.tag('A')
    const B = s.tag('B')
    const X = s.tag('X')
    const [m] = s.media(1)
    s.assoc(m!, B)
    s.edge(A, X) // A -> X
    s.edge(X, B) // X -> B  => after merge A -> X -> A
    const p = previewMerge(s.db, { targetTagId: A, sourceTagId: B })
    assert.ok(p.ok && p.wouldCreateCycle)
    const before = s.snapshot()
    const res = mergeTags(s.db, { targetTagId: A, sourceTagId: B, expectedTargetRevision: 1, expectedSourceRevision: 1 })
    assert.equal(!res.ok && res.code, 'MERGE_WOULD_CREATE_CYCLE')
    assert.equal(s.snapshot(), before)
    // A direct edge between the pair would become a self loop.
    const s2 = await openSeededDb()
    const A2 = s2.tag('A')
    const B2 = s2.tag('B')
    s2.edge(A2, B2)
    const r2 = mergeTags(s2.db, { targetTagId: A2, sourceTagId: B2, expectedTargetRevision: 1, expectedSourceRevision: 1 })
    assert.equal(!r2.ok && r2.code, 'MERGE_WOULD_CREATE_CYCLE')
  })

  it('requires the previewed revisions (REVISION_CONFLICT) and rejects A==B / archived / unknown tags', async () => {
    const s = await openSeededDb()
    const A = s.tag('A')
    const B = s.tag('B')
    const C = s.tag('C')
    const before = s.snapshot()
    const staleA = mergeTags(s.db, { targetTagId: A, sourceTagId: B, expectedTargetRevision: 9, expectedSourceRevision: 1 })
    assert.equal(!staleA.ok && staleA.code, 'REVISION_CONFLICT')
    const staleB = mergeTags(s.db, { targetTagId: A, sourceTagId: B, expectedTargetRevision: 1, expectedSourceRevision: 9 })
    assert.equal(!staleB.ok && staleB.code, 'REVISION_CONFLICT')
    const same = mergeTags(s.db, { targetTagId: A, sourceTagId: A, expectedTargetRevision: 1, expectedSourceRevision: 1 })
    assert.equal(!same.ok && same.code, 'INVALID_INPUT')
    const unknown = previewMerge(s.db, { targetTagId: A, sourceTagId: 999 })
    assert.equal(!unknown.ok && unknown.code, 'TAG_NOT_FOUND')
    assert.equal(s.snapshot(), before)
    archiveTag(s.db, { tagId: C, expectedRevision: 1 })
    const archivedSource = previewMerge(s.db, { targetTagId: A, sourceTagId: C })
    assert.equal(!archivedSource.ok && archivedSource.code, 'TAG_ARCHIVED')
    const archivedTarget = mergeTags(s.db, { targetTagId: C, sourceTagId: A, expectedTargetRevision: 2, expectedSourceRevision: 1 })
    assert.equal(!archivedTarget.ok && archivedTarget.code, 'TAG_ARCHIVED')
  })

  it('rolls back the whole merge when a mid-transaction write fails', async () => {
    const s = await openSeededDb()
    const [m1, m2] = s.media(2)
    const A = s.tag('A')
    const B = s.tag('B')
    s.assoc(m1!, B)
    s.assoc(m2!, B)
    s.alias(B, 'moved')
    s.db.exec(`
      CREATE TRIGGER fail_archive BEFORE UPDATE OF archived_at ON tags
      BEGIN SELECT RAISE(ABORT, 'simulated archive failure'); END;
    `)
    const before = s.snapshot()
    const res = mergeTags(s.db, { targetTagId: A, sourceTagId: B, expectedTargetRevision: 1, expectedSourceRevision: 1 })
    assert.equal(!res.ok && res.code, 'INTERNAL_ERROR')
    assert.equal(s.snapshot(), before)
    assert.equal(s.logCount(), 0)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS c FROM media_tags WHERE tag_id = ?').get(B)?.c, 2)
  })
})
