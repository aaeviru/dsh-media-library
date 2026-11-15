import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { it } from 'node:test'
import { openMediaLibraryDatabase } from '../../src/db/schema.ts'
import { importTagStudioDatabase } from '../../src/import/tagstudio-importer.ts'
import { createM2ImportTagStudioFixture } from '../../src/inventory/fixture-builder.ts'
import { MediaLibrarySpikeService } from '../../src/spike-service.ts'

it('B4: override allowlists fail closed and action states survive fresh queries', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'issue-4-regression-'))
  const baseDir = path.join(root, 'home')
  const sourceDbPath = path.join(root, 'source.sqlite')
  const dbPath = path.join(baseDir, 'media-library/library.sqlite3')
  const overridePath = path.join(baseDir, 'media-library/m1-spike.json')
  try {
    createM2ImportTagStudioFixture(sourceDbPath)
    await importTagStudioDatabase({ sourceDbPath, targetDbPath: dbPath, mode: 'import', rootId: 'nas-main', canonicalUncRoot: '\\\\ApprovedNAS\\Media' })
    let probeCalls = 0
    let openerCalls = 0
    const service = new MediaLibrarySpikeService({
      baseDir,
      fileProbe: async () => { probeCalls++; return { ok: true } },
      opener: {
        openPath: async () => { openerCalls++ },
        revealPath: async () => { openerCalls++ },
      },
    })
    for (const [roots, code] of [
      [[], 'UNMAPPED_ROOT'],
      [[{ rootId: 'nas-main', label: 'Disabled', canonicalUncRoot: '\\\\ApprovedNAS\\Media', enabled: false }], 'DISABLED_ROOT'],
    ] as const) {
      writeFileSync(overridePath, JSON.stringify({ roots }))
      for (const action of ['openMedia', 'revealMedia'] as const) {
        const result = await service[action]('1')
        assert.equal(result.ok, false, `${action} must honor ${code}`)
        if (!result.ok) assert.equal(result.code, code)
        assert.equal((await service.getMedia({ mediaId: '1' }))?.status, 'unmapped')
        assert.equal((await service.searchMedia()).items.find(i => i.mediaId === '1')?.status, 'unmapped')
      }
    }
    assert.equal(probeCalls, 0)
    assert.equal(openerCalls, 0)
    rmSync(overridePath)
    const excludedByConstructor = new MediaLibrarySpikeService({ baseDir, roots: [] })
    const excluded = await excludedByConstructor.openMedia('1')
    assert.equal(excluded.ok, false)
    if (!excluded.ok) assert.equal(excluded.code, 'UNMAPPED_ROOT')

    const { db } = openMediaLibraryDatabase({ dbPath })
    try {
      db.exec('UPDATE media_roots SET enabled = 0')
      const explicitEnabledRoot = new MediaLibrarySpikeService({
        baseDir,
        roots: [{ rootId: 'nas-main', label: 'Configured', canonicalUncRoot: '\\\\ApprovedNAS\\Media', enabled: true }],
        fileProbe: async () => { throw new Error('Disabled database roots must not be probed') },
      })
      const disabled = await explicitEnabledRoot.revealMedia('1')
      assert.equal(disabled.ok, false)
      if (!disabled.ok) assert.equal(disabled.code, 'DISABLED_ROOT')
      db.exec('UPDATE media_roots SET enabled = 1')
    } finally {
      db.close()
    }
    const denied = new MediaLibrarySpikeService({ baseDir, fileProbe: async () => ({ ok: false, code: 'PERMISSION_DENIED' }) })
    const result = await denied.openMedia('1')
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'PERMISSION_DENIED')
    assert.equal((await service.getMedia({ mediaId: '1' }))?.status, 'permission_denied')
    assert.equal((await service.searchMedia()).items.find(i => i.mediaId === '1')?.status, 'permission_denied')
    assert.equal((await service.openMedia('1')).ok, true)
    assert.equal((await service.getMedia({ mediaId: '1' }))?.status, 'indexed')
  } finally {
    assert.ok(path.resolve(root).startsWith(path.join(tmpdir(), 'issue-4-regression-')))
    rmSync(root, { recursive: true, force: true })
  }
})
