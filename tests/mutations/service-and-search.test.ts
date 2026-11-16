import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { importTagStudioDatabase } from '../../src/import/tagstudio-importer.ts'
import { createM2ImportTagStudioFixture } from '../../src/inventory/fixture-builder.ts'
import { MediaLibrarySpikeService } from '../../src/spike-service.ts'

describe('Service-level tag management on the imported fixture (Issue #5 B3, B5, B7)', () => {
  let tempRoot: string
  let service: MediaLibrarySpikeService

  before(async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-media-mut-svc-'))
    const source = path.join(tempRoot, 'source', 'ts_library.sqlite')
    const target = path.join(tempRoot, 'dsh-home', 'media-library', 'library.sqlite3')
    createM2ImportTagStudioFixture(source)
    await importTagStudioDatabase({
      sourceDbPath: source,
      targetDbPath: target,
      mode: 'import',
      rootId: 'nas-main',
      canonicalUncRoot: '\\\\SynologyNAS\\Media',
    })
    service = new MediaLibrarySpikeService({
      baseDir: path.join(tempRoot, 'dsh-home'),
      configuredUncRoot: '\\\\SynologyNAS\\Media',
      configuredTagStudioCopyPath: source,
    })
  })
  after(() => rmSync(tempRoot, { recursive: true, force: true }))

  it('search regression: create -> batch tag -> search returns it; archived tags stay searchable but leave the default tag list', async () => {
    const baseline = await service.searchMedia({ limit: 200 })
    assert.equal(baseline.totalMatching, 6)

    const created = await service.createTag({ name: 'Favorites' })
    assert.ok(created.ok)
    const targets = baseline.items.slice(0, 3).map(i => i.mediaId)
    const tagged = await service.setMediaTags({
      mediaIds: targets,
      addTagIds: [created.tagId],
      expectedMediaRevisions: baseline.items.slice(0, 3).map(i => ({ mediaId: i.mediaId, revision: i.revision })),
    })
    assert.ok(tagged.ok && tagged.added === 3)

    const found = await service.searchMedia({ tagIds: [created.tagId] })
    assert.equal(found.totalMatching, 3)
    assert.deepEqual(found.items.map(i => i.mediaId).sort(), [...targets].sort())
    const byName = await service.searchMedia({ tagNamesOrAliases: ['favorites'] })
    assert.equal(byName.totalMatching, 3)

    // Ordering and pagination semantics unchanged.
    const unfiltered = await service.searchMedia({ limit: 200 })
    assert.deepEqual(unfiltered.items.map(i => i.id), baseline.items.map(i => i.id))
    const p1 = await service.searchMedia({ limit: 2 })
    const p2 = await service.searchMedia({ limit: 2, cursor: p1.nextCursor ?? undefined })
    assert.deepEqual([...p1.items, ...p2.items].map(i => i.id), baseline.items.slice(0, 4).map(i => i.id))

    const archived = await service.archiveTag({ tagId: created.tagId, expectedRevision: created.revision })
    assert.ok(archived.ok)
    assert.equal((await service.searchMedia({ tagIds: [created.tagId] })).totalMatching, 3)
    assert.equal((await service.searchMedia({ tagNamesOrAliases: ['favorites'] })).totalMatching, 3)
    const list = await service.listTags({ limit: 500 })
    assert.equal(list.tags.some(t => t.id === created.tagId), false)
    const listAll = await service.listTags({ limit: 500, includeArchived: true })
    assert.equal(listAll.tags.find(t => t.id === created.tagId)?.archived, true)
    const chips = (await service.getMedia({ mediaId: targets[0]! }))?.tags.map(t => t.id)
    assert.ok(chips?.includes(created.tagId), 'existing associations remain readable')
    const addArchived = await service.setMediaTags({ mediaIds: [baseline.items[5]!.mediaId], addTagIds: [created.tagId] })
    assert.equal(!addArchived.ok && addArchived.code, 'TAG_ARCHIVED')
  })

  it('B7: XSS payloads are stored and returned verbatim as data (never interpreted or altered)', async () => {
    const payloads = ['<img src=x onerror=alert(1)>', '"><script>alert(1)</script>', "'; DROP TABLE tags; --"]
    for (const name of payloads) {
      const res = await service.createTag({ name })
      assert.ok(res.ok, name)
      const alias = await service.addAlias({ tagId: res.tagId, alias: `${name} alias`, expectedRevision: res.revision })
      assert.ok(alias.ok)
    }
    const all = await service.listTags({ limit: 500 })
    for (const name of payloads) {
      const tag = all.tags.find(t => t.name === name)
      assert.ok(tag, `payload ${name} listed verbatim`)
      assert.deepEqual(tag.aliases, [`${name} alias`])
    }
    assert.ok((await service.getLibraryOverview()).counts.tags >= payloads.length)
  })

  it('writes are audited, and previews / failures leave no audit row', async () => {
    const logRows = async () => {
      const { openMediaLibraryDatabase } = await import('../../src/db/schema.ts')
      const { db } = openMediaLibraryDatabase({ dbPath: path.join(tempRoot, 'dsh-home', 'media-library', 'library.sqlite3') })
      try {
        return Number((db.prepare('SELECT COUNT(*) AS c FROM mutation_log').get() as { c: number }).c)
      } finally {
        db.close()
      }
    }
    const before = await logRows()
    const t = await service.createTag({ name: 'Audit probe' })
    assert.ok(t.ok)
    assert.equal(await logRows(), before + 1)
    await service.createTag({ name: 'audit PROBE' }) // conflict
    await service.renameTag({ tagId: t.tagId, name: 'x', expectedRevision: 99 }) // stale
    const t2 = await service.createTag({ name: 'Audit probe 2' })
    assert.ok(t2.ok)
    await service.previewMerge({ targetTagId: t.tagId, sourceTagId: t2.tagId })
    assert.equal(await logRows(), before + 2)
  })
})
