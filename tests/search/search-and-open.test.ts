import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { after, before, describe, it } from 'node:test'
import { migrateDatabase, openMediaLibraryDatabase } from '../../src/db/schema.ts'
import { importTagStudioDatabase } from '../../src/import/tagstudio-importer.ts'
import { createM2ImportTagStudioFixture } from '../../src/inventory/fixture-builder.ts'
import { MediaLibrarySpikeService } from '../../src/spike-service.ts'

function computePercentile(sortedValues: readonly number[], percentile: number): number {
  if (sortedValues.length === 0) return 0
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedValues.length) - 1),
  )
  return Number(sortedValues[idx]!.toFixed(2))
}

describe('M2 Read-Only Search, Keyset Pagination, Native Open & 10k/100k Benchmark (Issue #4 B1..B5)', () => {
  let tempRoot: string
  let fixtureSourcePath: string
  let localDbPath: string
  let service: MediaLibrarySpikeService
  let openedPaths: string[] = []
  let revealedPaths: string[] = []
  let nextProbeOverride: {
    ok: boolean
    code?: 'FILE_NOT_FOUND' | 'NAS_OFFLINE_OR_TIMEOUT' | 'PERMISSION_DENIED'
    message?: string
  } = { ok: true }

  before(async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-media-search-test-'))
    fixtureSourcePath = path.join(tempRoot, 'source', 'ts_library.sqlite')
    localDbPath = path.join(tempRoot, 'dsh-home', 'media-library', 'library.sqlite3')

    createM2ImportTagStudioFixture(fixtureSourcePath)
    await importTagStudioDatabase({
      sourceDbPath: fixtureSourcePath,
      targetDbPath: localDbPath,
      mode: 'import',
      rootId: 'nas-main',
      canonicalUncRoot: '\\\\SynologyNAS\\Media',
    })

    service = new MediaLibrarySpikeService({
      baseDir: path.join(tempRoot, 'dsh-home'),
      configuredUncRoot: '\\\\SynologyNAS\\Media',
      configuredTagStudioCopyPath: fixtureSourcePath,
      opener: {
        async openPath(targetPath: string) {
          openedPaths.push(targetPath)
        },
        async revealPath(targetPath: string) {
          revealedPaths.push(targetPath)
        },
      },
      fileProbe: async () => nextProbeOverride,
    })
  })

  after(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('B1: tag name, shorthand, and alias searches return the same tag identity and enforce multi-tag AND filtering', async () => {
    const overview = await service.getLibraryOverview()
    assert.equal(overview.databaseExists, true)
    assert.equal(overview.counts.mediaFiles, 6)
    assert.equal(overview.counts.tags, 7)

    // Search tag by name vs alias in listTags
    const byName = await service.listTags({ query: 'Performer A' })
    const byAlias = await service.listTags({ query: 'Actor_A_Alias' })
    assert.ok(byName.tags.length >= 1)
    assert.ok(byAlias.tags.length >= 1)
    const performerATagId = byName.tags[0]!.id
    assert.ok(byAlias.tags.some(t => t.id === performerATagId))

    // Search media by tag name ('Performer A') vs shorthand ('PA')
    const searchByName = await service.searchMedia({ tagNamesOrAliases: ['Performer A'] })
    const searchByShorthand = await service.searchMedia({ tagNamesOrAliases: ['PA'] })
    assert.deepEqual(searchByName.resolvedTagIds, [performerATagId])
    assert.deepEqual(searchByShorthand.resolvedTagIds, [performerATagId])
    assert.deepEqual(
      searchByName.items.map(i => i.mediaId),
      searchByShorthand.items.map(i => i.mediaId),
    )
    assert.equal(searchByName.totalMatching, 2)

    // Search media by merged alias 'alpha' vs tag name 'Studio Alpha'
    const searchByStudioName = await service.searchMedia({ tagNamesOrAliases: ['Studio Alpha'] })
    const searchByStudioAlias = await service.searchMedia({ tagNamesOrAliases: ['alpha'] })
    assert.deepEqual(searchByStudioName.resolvedTagIds, searchByStudioAlias.resolvedTagIds)
    assert.deepEqual(
      searchByStudioName.items.map(i => i.mediaId),
      searchByStudioAlias.items.map(i => i.mediaId),
    )
    assert.equal(searchByStudioName.totalMatching, 2) // LIB-101_part1.mkv and FC2-PPV-1476760/video.mp4

    // Multi-tag AND filter: Performer A AND Studio Alpha -> only LIB-101_part1.mkv
    const andSearch = await service.searchMedia({
      tagIds: [performerATagId, searchByStudioName.resolvedTagIds[0]!],
    })
    assert.equal(andSearch.totalMatching, 1)
    assert.equal(andSearch.items[0]?.filename, 'LIB-101_part1.mkv')

    // Shared/ambiguous alias ('actor_a_alias' shared between Performer A and Performer C) surfaces warning
    const sharedSearch = await service.searchMedia({ tagNamesOrAliases: ['actor_a_alias'] })
    assert.equal(sharedSearch.ambiguousAliases.length, 1)
    assert.equal(sharedSearch.ambiguousAliases[0]?.normalizedAlias, 'actor_a_alias')
    assert.equal(sharedSearch.ambiguousAliases[0]?.matchingTags.length, 2)
  })

  it('B2: normalizes catalog queries (exact & prefix) and enforces inclusive YYYY-MM-DD date boundaries without fabricating NULL dates', async () => {
    // Exact catalog with lowercase + spaces/underscores and FC2 normalization
    const fc2Exact = await service.searchMedia({
      catalogNumber: 'fc2 1476760',
      catalogMatchMode: 'exact',
    })
    assert.equal(fc2Exact.totalMatching, 1)
    assert.equal(fc2Exact.items[0]?.catalogNumber, 'FC2-PPV-1476760')

    const abpExact = await service.searchMedia({
      catalogNumber: 'abp_909',
      catalogMatchMode: 'exact',
    })
    assert.equal(abpExact.totalMatching, 1)
    assert.equal(abpExact.items[0]?.catalogNumber, 'ABP-909')

    // Prefix vs exact mode on partial prefix 'LIB'
    const libExact = await service.searchMedia({
      catalogNumber: 'LIB',
      catalogMatchMode: 'exact',
    })
    assert.equal(libExact.totalMatching, 0)

    const libPrefix = await service.searchMedia({
      catalogNumber: 'lib',
      catalogMatchMode: 'prefix',
    })
    assert.equal(libPrefix.totalMatching, 2)
    assert.deepEqual(
      libPrefix.items.map(i => i.catalogNumber),
      ['LIB-101', 'LIB-101'],
    )

    // Inclusive date range: 2026-10-15 to 2026-11-01 includes both boundary dates (3 items)
    // and excludes entries with NULL media_date (entries 4 and 9) even though their added_at is in Nov 2026
    const dateRange = await service.searchMedia({
      dateFrom: '2026-10-15',
      dateTo: '2026-11-01',
    })
    assert.equal(dateRange.totalMatching, 3)
    for (const item of dateRange.items) {
      assert.ok(item.mediaDate !== null)
      assert.ok(item.mediaDate >= '2026-10-15' && item.mediaDate <= '2026-11-01')
    }
  })

  it('B3: stable keyset pagination traverses the entire dataset with zero duplicate or missing rows', async () => {
    const fullRes = await service.searchMedia({ limit: 100 })
    assert.equal(fullRes.items.length, 6)

    const pagedIds: string[] = []
    let cursor: string | undefined
    let pageCount = 0

    do {
      const page = await service.searchMedia({ limit: 2, cursor })
      pageCount += 1
      for (const item of page.items) {
        pagedIds.push(item.mediaId)
      }
      cursor = page.nextCursor ?? undefined
    } while (cursor)

    assert.equal(pageCount, 3)
    assert.equal(new Set(pagedIds).size, 6, 'Keyset pagination must not produce duplicate rows')
    assert.deepEqual(pagedIds, fullRes.items.map(i => i.mediaId))
  })

  it('B4: resolves imported database mediaId to allowlisted UNC path for open/reveal, updates status on missing/offline, and rejects traversal/invalid IDs', async () => {
    openedPaths = []
    revealedPaths = []
    nextProbeOverride = { ok: true }

    const searchRes = await service.searchMedia({
      catalogNumber: 'ABP-909',
      catalogMatchMode: 'exact',
    })
    const cjkItem = searchRes.items[0]!
    assert.ok(cjkItem)

    const openOk = await service.openMedia(cjkItem.mediaId)
    assert.equal(openOk.ok, true)
    if (openOk.ok) {
      assert.equal(
        openOk.resolvedUncPath,
        '\\\\SynologyNAS\\Media\\中文目录\\2026-10-15_ABP-909 特辑.mp4',
      )
    }
    assert.equal(openedPaths.length, 1)

    const revealOk = await service.revealMedia(cjkItem.mediaId)
    assert.equal(revealOk.ok, true)
    assert.equal(revealedPaths.length, 1)

    // Simulate missing file on NAS -> returns FILE_NOT_FOUND and updates DB status to 'missing'
    nextProbeOverride = {
      ok: false,
      code: 'FILE_NOT_FOUND',
      message: 'Simulated missing file on NAS',
    }
    const missingRes = await service.openMedia(cjkItem.mediaId)
    assert.equal(missingRes.ok, false)
    if (!missingRes.ok) {
      assert.equal(missingRes.code, 'FILE_NOT_FOUND')
    }
    const detailAfterMissing = await service.getMedia({ mediaId: cjkItem.mediaId })
    assert.equal(detailAfterMissing?.status, 'missing')

    // Simulate NAS offline -> updates DB status to 'offline'
    nextProbeOverride = {
      ok: false,
      code: 'NAS_OFFLINE_OR_TIMEOUT',
      message: 'Simulated NAS timeout',
    }
    const offlineRes = await service.openMedia(cjkItem.mediaId)
    assert.equal(offlineRes.ok, false)
    if (!offlineRes.ok) {
      assert.equal(offlineRes.code, 'NAS_OFFLINE_OR_TIMEOUT')
    }
    const detailAfterOffline = await service.getMedia({ mediaId: cjkItem.mediaId })
    assert.equal(detailAfterOffline?.status, 'offline')

    // Reject arbitrary UNC paths, traversal strings, and non-existent IDs before probing or opening
    nextProbeOverride = { ok: true }
    const beforeOpenCount = openedPaths.length
    for (const badId of [
      '\\\\SynologyNAS\\Media\\secret.mkv',
      '../escape.mkv',
      'C:\\Windows\\System32\\cmd.exe',
      '99999999',
    ]) {
      const rejected = await service.openMedia(badId)
      assert.equal(rejected.ok, false)
      if (!rejected.ok) {
        assert.equal(rejected.code, 'UNKNOWN_MEDIA_ID')
      }
    }
    assert.equal(openedPaths.length, beforeOpenCount)
  })

  it('B5: measures search p95 on representative 10k and 100k SQLite fixtures and verifies p95 < 200 ms locally', async () => {
    const benchDbPath = path.join(tempRoot, 'bench-100k', 'library.sqlite3')
    const { db } = openMediaLibraryDatabase({ dbPath: benchDbPath })

    try {
      await migrateDatabase(db, { dbPath: benchDbPath })

      db.exec(`
        INSERT INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
        VALUES ('nas-main', 'NAS Bench', '\\\\SynologyNAS\\Media', 1, '2026-11-15T00:00:00Z');
      `)

      const insertTag = db.prepare(
        `INSERT INTO tags (id, name, normalized_name, shorthand, kind, created_at, updated_at, revision)
         VALUES (?, ?, ?, ?, 'custom', '2026-11-15T00:00:00Z', '2026-11-15T00:00:00Z', 1)`,
      )
      const insertAlias = db.prepare(
        `INSERT INTO tag_aliases (tag_id, alias, normalized_alias) VALUES (?, ?, ?)`,
      )
      const insertFile = db.prepare(
        `INSERT INTO media_files (
           id, root_id, relative_path, filename, extension, title,
           catalog_number, catalog_source, media_date, date_source,
           added_at, status, revision
         ) VALUES (?, 'nas-main', ?, ?, 'mkv', ?, ?, 'filename', ?, 'filename_or_path', '2026-11-15T00:00:00Z', 'indexed', 1)`,
      )
      const insertMediaTag = db.prepare(
        `INSERT INTO media_tags (media_id, tag_id, source, created_at)
         VALUES (?, ?, 'tagstudio-import', '2026-11-15T00:00:00Z')`,
      )

      const studios = ['ABP', 'SSIS', 'IPX', 'STARS', 'MIDV', 'SONE', 'PRED', 'JUL', 'MIDE', 'FSDSS']

      const populateRange = (startId: number, endId: number) => {
        db.exec('BEGIN IMMEDIATE;')
        try {
          if (startId === 1) {
            for (let t = 1; t <= 250; t++) {
              insertTag.run(t, `Performer_${t}`, `performer_${t}`, `P${t}`)
              insertAlias.run(t, `ActorAlias_${t}`, `actoralias_${t}`)
            }
          }
          for (let i = startId; i <= endId; i++) {
            const studio = studios[i % studios.length]!
            const num = String(100 + (i % 9000)).padStart(4, '0')
            const catalog = `${studio}-${num}`
            const year = 2020 + (i % 7)
            const month = String(1 + (i % 12)).padStart(2, '0')
            const day = String(1 + (i % 28)).padStart(2, '0')
            const mediaDate = i % 5 === 0 ? null : `${year}-${month}-${day}`
            const relPath = `${year}\\${month}\\${catalog}\\${catalog}_item_${i}.mkv`
            const filename = `${catalog}_item_${i}.mkv`
            insertFile.run(i, relPath, filename, `Title ${catalog} #${i}`, catalog, mediaDate)

            const tag1 = 1 + (i % 250)
            const tag2 = 1 + ((i * 7) % 250)
            insertMediaTag.run(i, tag1)
            if (tag2 !== tag1) {
              insertMediaTag.run(i, tag2)
            }
          }
          db.exec('COMMIT;')
        } catch (err) {
          db.exec('ROLLBACK;')
          throw err
        }
      }

      const runRepresentativeQueries = async (): Promise<{ p50: number; p95: number; max: number }> => {
        const benchService = new MediaLibrarySpikeService({ dbPath: benchDbPath })
        const coldStart = performance.now()
        const coldResult = await benchService.searchMedia({ limit: 50 })
        const coldMs = performance.now() - coldStart
        console.log(`[Host initialization + first search] measured=${coldMs.toFixed(2)}ms, reported=${coldResult.elapsedMs}ms`)
        assert.ok(Math.abs(coldResult.elapsedMs - coldMs) < 2, 'Host elapsedMs must include initialization/connection overhead')
        const workloads = [
          () => benchService.searchMedia({ limit: 50 }),
          () => benchService.searchMedia({ catalogNumber: 'SSIS-0542', catalogMatchMode: 'exact', limit: 50 }),
          () => benchService.searchMedia({ catalogNumber: 'ABP-01', catalogMatchMode: 'prefix', limit: 50 }),
          () => benchService.searchMedia({ tagIds: [15], limit: 50 }),
          () => benchService.searchMedia({ tagIds: [15, 106], limit: 50 }),
          () => benchService.searchMedia({ tagNamesOrAliases: ['actoralias_42'], limit: 50 }),
          () => benchService.searchMedia({ dateFrom: '2024-01-01', dateTo: '2024-06-30', limit: 50 }),
          () => benchService.searchMedia({ tagIds: [15], dateFrom: '2022-01-01', dateTo: '2026-12-31', limit: 50 }),
          () => benchService.searchMedia({ text: 'SSIS-0542', limit: 50 }),
          async () => {
            const first = await benchService.searchMedia({ limit: 50 })
            return benchService.searchMedia({ limit: 50, cursor: first.nextCursor ?? undefined })
          },
        ]

        const samples: number[] = []
        for (let round = 0; round < 3; round++) {
          for (const fn of workloads) {
            const t0 = performance.now()
            const res = await fn()
            const dt = performance.now() - t0
            assert.ok(res.items.length >= 0)
            samples.push(dt)
          }
        }
        samples.sort((a, b) => a - b)
        return {
          p50: computePercentile(samples, 50),
          p95: computePercentile(samples, 95),
          max: Number(samples[samples.length - 1]!.toFixed(2)),
        }
      }

      // 1. Measure on 10k rows
      populateRange(1, 10_000)
      db.exec('ANALYZE;')
      const stats10k = await runRepresentativeQueries()
      console.log(`[Benchmark 10k]  p50=${stats10k.p50}ms, p95=${stats10k.p95}ms, max=${stats10k.max}ms`)
      assert.ok(
        stats10k.p95 < 200,
        `Expected 10k search p95 < 200ms, got ${stats10k.p95}ms`,
      )

      // 2. Extend to 100k rows and measure
      populateRange(10_001, 100_000)
      db.exec('ANALYZE;')
      const stats100k = await runRepresentativeQueries()
      console.log(`[Benchmark 100k] p50=${stats100k.p50}ms, p95=${stats100k.p95}ms, max=${stats100k.max}ms`)
      assert.ok(
        stats100k.p95 < 200,
        `Expected 100k search p95 < 200ms, got ${stats100k.p95}ms`,
      )
    } finally {
      db.close()
    }
  })
})
