import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { migrateDatabase, openMediaLibraryDatabase } from '../../src/db/schema.ts'
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  searchMediaInDatabase,
} from '../../src/search/search-repository.ts'
import { MediaLibrarySpikeService } from '../../src/spike-service.ts'
import type { MediaSortField, MediaSortOrder, SearchMediaInput } from '../../src/types.ts'

const ALL_SORT_FIELDS: readonly MediaSortField[] = [
  'media_date',
  'added_at',
  'catalog_number',
  'filename',
]
const ALL_SORT_ORDERS: readonly MediaSortOrder[] = ['desc', 'asc']

interface FixtureRow {
  readonly id: number
  readonly relativePath: string
  readonly filename: string
  readonly title: string | null
  readonly catalogNumber: string | null
  readonly mediaDate: string | null
  readonly addedAt: string | null
  readonly tagIds: readonly number[]
}

/**
 * Carefully crafted multi-row fixture exercising:
 * - NULL and empty-string ('') values in every sortable column
 * - Duplicate sort keys (to verify deterministic mf.id tie-breaking)
 * - Mixed-case ASCII and non-ASCII uppercase characters (to verify SQLite LOWER() parity)
 * - Multiple rows inside the NULL/empty bucket (to verify keyset pagination inside NULLS LAST)
 */
const FIXTURE_ROWS: readonly FixtureRow[] = [
  {
    id: 1,
    relativePath: 'dir1\\Beta.mkv',
    filename: 'Beta.mkv',
    title: 'Beta One',
    catalogNumber: 'abp-100',
    mediaDate: '2025-06-15',
    addedAt: '2026-01-10T10:00:00Z',
    tagIds: [1],
  },
  {
    id: 2,
    relativePath: 'dir1\\alpha.mkv',
    filename: 'alpha.mkv',
    title: 'Alpha Lower',
    catalogNumber: 'ABP-100',
    mediaDate: '2025-06-15',
    addedAt: '2026-01-10T10:00:00Z',
    tagIds: [1],
  },
  {
    id: 3,
    relativePath: 'dir2\\Alpha.mkv',
    filename: 'Alpha.mkv',
    title: 'Alpha Upper',
    catalogNumber: 'Abp-050',
    mediaDate: '2026-02-01',
    addedAt: '2026-03-01T08:00:00Z',
    tagIds: [1, 2],
  },
  {
    id: 4,
    relativePath: 'dir1\\Zebra.mkv',
    filename: 'Zebra.mkv',
    title: 'Null Date & Catalog',
    catalogNumber: null,
    mediaDate: null,
    addedAt: null,
    tagIds: [1],
  },
  {
    id: 5,
    relativePath: 'dir1\\empty-strings.mkv',
    filename: '',
    title: 'Empty Strings Row A',
    catalogNumber: '',
    mediaDate: '',
    addedAt: '',
    tagIds: [1],
  },
  {
    id: 6,
    relativePath: 'dir2\\empty-strings-b.mkv',
    filename: '',
    title: 'Empty Strings Row B',
    catalogNumber: null,
    mediaDate: null,
    addedAt: null,
    tagIds: [2],
  },
  {
    id: 7,
    relativePath: 'dir3\\empty-strings-c.mkv',
    filename: '',
    title: 'Empty Strings Row C',
    catalogNumber: '',
    mediaDate: '',
    addedAt: '',
    tagIds: [1],
  },
  {
    id: 8,
    relativePath: 'dir1\\Äpfel.mkv',
    filename: 'Äpfel.mkv',
    title: 'Non-ASCII Upper Umlaut',
    catalogNumber: 'SSIS-200',
    mediaDate: '2024-12-31',
    addedAt: '2026-02-15T12:00:00Z',
    tagIds: [1],
  },
  {
    id: 9,
    relativePath: 'dir1\\äpfel.mkv',
    filename: 'äpfel.mkv',
    title: 'Non-ASCII Lower Umlaut',
    catalogNumber: 'ssis-200',
    mediaDate: '2025-06-15',
    addedAt: '2026-02-15T12:00:00Z',
    tagIds: [2],
  },
  {
    id: 10,
    relativePath: 'dir1\\中文_B.mkv',
    filename: '中文_B.mkv',
    title: 'CJK B',
    catalogNumber: 'FC2-PPV-900',
    mediaDate: '2026-02-01',
    addedAt: '2026-04-01T00:00:00Z',
    tagIds: [1],
  },
  {
    id: 11,
    relativePath: 'dir1\\中文_a.mkv',
    filename: '中文_a.mkv',
    title: 'CJK a',
    catalogNumber: 'fc2-ppv-100',
    mediaDate: '2023-01-01',
    addedAt: '2025-12-31T23:59:59Z',
    tagIds: [1],
  },
]

function sqliteAsciiLower(value: string): string {
  return value.replace(/[A-Z]/g, ch => ch.toLowerCase())
}

function getExpectedIds(
  rows: readonly FixtureRow[],
  sortBy: MediaSortField,
  sortOrder: MediaSortOrder,
): string[] {
  const getRaw = (r: FixtureRow): string | null => {
    switch (sortBy) {
      case 'media_date':
        return r.mediaDate
      case 'added_at':
        return r.addedAt
      case 'catalog_number':
        return r.catalogNumber
      case 'filename':
        return r.filename
    }
  }
  const caseFold = sortBy === 'catalog_number' || sortBy === 'filename'

  return [...rows]
    .sort((a, b) => {
      const ra = getRaw(a)
      const rb = getRaw(b)
      const nullA = ra === null || ra === '' ? 1 : 0
      const nullB = rb === null || rb === '' ? 1 : 0
      // NULLS LAST in BOTH asc and desc
      if (nullA !== nullB) return nullA - nullB

      if (nullA === 0) {
        const va = caseFold ? sqliteAsciiLower(ra!) : ra!
        const vb = caseFold ? sqliteAsciiLower(rb!) : rb!
        if (va !== vb) {
          const cmp = va < vb ? -1 : 1
          return sortOrder === 'asc' ? cmp : -cmp
        }
      }
      return sortOrder === 'asc' ? a.id - b.id : b.id - a.id
    })
    .map(r => String(r.id))
}

describe('Issue #68: Multi-dimensional sorting & stable keyset pagination (B1..B3)', () => {
  let tempRoot: string
  let dbPath: string
  let service: MediaLibrarySpikeService

  before(async () => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-media-sorting-test-'))
    dbPath = path.join(tempRoot, 'dsh-home', 'media-library', 'library.sqlite3')

    const { db } = openMediaLibraryDatabase({ dbPath })
    try {
      await migrateDatabase(db, { dbPath })
      db.exec(`
        INSERT INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
        VALUES ('nas-main', 'NAS Test', '\\\\SynologyNAS\\Media', 1, '2026-01-01T00:00:00Z');
        INSERT INTO tags (id, name, normalized_name, kind, created_at, updated_at, revision)
        VALUES
          (1, 'Tag Alpha', 'tag alpha', 'custom', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1),
          (2, 'Tag Beta', 'tag beta', 'custom', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1);
      `)
      const insertFile = db.prepare(`
        INSERT INTO media_files (
          id, root_id, relative_path, filename, extension, title,
          catalog_number, media_date, added_at, status, revision
        ) VALUES (?, 'nas-main', ?, ?, 'mkv', ?, ?, ?, ?, 'indexed', 1)
      `)
      const insertMediaTag = db.prepare(`
        INSERT INTO media_tags (media_id, tag_id, source, created_at)
        VALUES (?, ?, 'manual', '2026-01-01T00:00:00Z')
      `)
      for (const row of FIXTURE_ROWS) {
        insertFile.run(
          row.id,
          row.relativePath,
          row.filename,
          row.title,
          row.catalogNumber,
          row.mediaDate,
          row.addedAt,
        )
        for (const tagId of row.tagIds) {
          insertMediaTag.run(row.id, tagId)
        }
      }
    } finally {
      db.close()
    }

    service = new MediaLibrarySpikeService({
      baseDir: path.join(tempRoot, 'dsh-home'),
      configuredUncRoot: '\\\\SynologyNAS\\Media',
    })
  })

  after(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('B1: default omitted sortBy/sortOrder matches explicit media_date desc', async () => {
    const defaultRes = await service.searchMedia({ limit: 100 })
    const explicitRes = await service.searchMedia({
      sortBy: 'media_date',
      sortOrder: 'desc',
      limit: 100,
    })
    assert.deepEqual(
      defaultRes.items.map(i => i.mediaId),
      explicitRes.items.map(i => i.mediaId),
    )
    assert.deepEqual(
      defaultRes.items.map(i => i.mediaId),
      getExpectedIds(FIXTURE_ROWS, 'media_date', 'desc'),
    )
  })

  it('B1/B2: all 4 sortBy × 2 sortOrder combinations enforce NULLS LAST, case-insensitive text sorting, and deterministic id tie-breakers', () => {
    const { db } = openMediaLibraryDatabase({ dbPath })
    try {
      for (const sortBy of ALL_SORT_FIELDS) {
        for (const sortOrder of ALL_SORT_ORDERS) {
          const res = searchMediaInDatabase(db, { sortBy, sortOrder, limit: 100 })
          assert.equal(res.totalMatching, FIXTURE_ROWS.length)
          assert.equal(res.nextCursor, null)

          const actualIds = res.items.map(i => i.mediaId)
          const expectedIds = getExpectedIds(FIXTURE_ROWS, sortBy, sortOrder)
          assert.deepEqual(
            actualIds,
            expectedIds,
            `Order mismatch for sortBy=${sortBy} sortOrder=${sortOrder}`,
          )

          // Explicitly verify NULL/empty values always appear strictly at the end
          let seenEmpty = false
          for (const item of res.items) {
            const rawVal =
              sortBy === 'media_date'
                ? item.mediaDate
                : sortBy === 'added_at'
                  ? item.addedAt
                  : sortBy === 'catalog_number'
                    ? item.catalogNumber
                    : item.filename
            const isEmpty = rawVal === null || rawVal === ''
            if (isEmpty) {
              seenEmpty = true
            } else {
              assert.equal(
                seenEmpty,
                false,
                `Non-empty value "${rawVal}" appeared after NULL/empty for ${sortBy} ${sortOrder}`,
              )
            }
          }
          assert.equal(seenEmpty, true, `Fixture must contain NULL/empty rows for ${sortBy}`)
        }
      }
    } finally {
      db.close()
    }
  })

  it('B3: full keyset pagination equivalence for all 8 sortBy × sortOrder combinations (limit: 2, 1, 3)', () => {
    const { db } = openMediaLibraryDatabase({ dbPath })
    try {
      for (const sortBy of ALL_SORT_FIELDS) {
        for (const sortOrder of ALL_SORT_ORDERS) {
          const unpaginated = searchMediaInDatabase(db, { sortBy, sortOrder, limit: 100 })
          const expectedIds = unpaginated.items.map(i => i.mediaId)
          assert.equal(expectedIds.length, FIXTURE_ROWS.length)

          for (const pageLimit of [2, 1, 3]) {
            const collected: string[] = []
            let cursor: string | undefined
            let pages = 0

            do {
              const page = searchMediaInDatabase(db, {
                sortBy,
                sortOrder,
                limit: pageLimit,
                cursor,
              })
              pages += 1
              assert.equal(page.totalMatching, FIXTURE_ROWS.length)
              assert.ok(page.items.length <= pageLimit)
              for (const item of page.items) {
                collected.push(item.mediaId)
              }
              cursor = page.nextCursor ?? undefined
              assert.ok(pages <= FIXTURE_ROWS.length + 2, 'Pagination loop guard tripped')
            } while (cursor)

            assert.equal(
              new Set(collected).size,
              FIXTURE_ROWS.length,
              `Duplicate rows detected for ${sortBy} ${sortOrder} limit=${pageLimit}`,
            )
            assert.deepEqual(
              collected,
              expectedIds,
              `Paginated sequence diverged for ${sortBy} ${sortOrder} limit=${pageLimit}`,
            )
          }
        }
      }
    } finally {
      db.close()
    }
  })

  it('B3: combined filter + sort + keyset pagination preserves exact equivalence', async () => {
    const filteredRows = FIXTURE_ROWS.filter(r => r.tagIds.includes(1))
    for (const sortBy of ALL_SORT_FIELDS) {
      for (const sortOrder of ALL_SORT_ORDERS) {
        const expectedIds = getExpectedIds(filteredRows, sortBy, sortOrder)
        const pagedIds: string[] = []
        let cursor: string | undefined
        do {
          const page = await service.searchMedia({
            tagIds: [1],
            sortBy,
            sortOrder,
            limit: 2,
            cursor,
          })
          assert.equal(page.totalMatching, filteredRows.length)
          pagedIds.push(...page.items.map(i => i.mediaId))
          cursor = page.nextCursor ?? undefined
        } while (cursor)
        assert.deepEqual(pagedIds, expectedIds)
      }
    }
  })

  it('B3: rejects mismatched sortBy/sortOrder cursors and supports legacy { d, id } cursor only for media_date desc', () => {
    const { db } = openMediaLibraryDatabase({ dbPath })
    try {
      // 1. Mismatched new cursors across sortBy or sortOrder must throw Invalid pagination cursor
      const page1DateDesc = searchMediaInDatabase(db, {
        sortBy: 'media_date',
        sortOrder: 'desc',
        limit: 2,
      })
      assert.ok(page1DateDesc.nextCursor)
      const decoded = decodeKeysetCursor(page1DateDesc.nextCursor)
      assert.equal(decoded.sortBy, 'media_date')
      assert.equal(decoded.sortOrder, 'desc')

      assert.throws(
        () =>
          searchMediaInDatabase(db, {
            sortBy: 'media_date',
            sortOrder: 'asc',
            limit: 2,
            cursor: page1DateDesc.nextCursor!,
          }),
        /Invalid pagination cursor/,
      )
      assert.throws(
        () =>
          searchMediaInDatabase(db, {
            sortBy: 'added_at',
            sortOrder: 'desc',
            limit: 2,
            cursor: page1DateDesc.nextCursor!,
          }),
        /Invalid pagination cursor/,
      )

      const page1FileAsc = searchMediaInDatabase(db, {
        sortBy: 'filename',
        sortOrder: 'asc',
        limit: 2,
      })
      assert.ok(page1FileAsc.nextCursor)
      assert.throws(
        () =>
          searchMediaInDatabase(db, {
            sortBy: 'filename',
            sortOrder: 'desc',
            limit: 2,
            cursor: page1FileAsc.nextCursor!,
          }),
        /Invalid pagination cursor/,
      )
      assert.throws(
        () =>
          searchMediaInDatabase(db, {
            sortBy: 'catalog_number',
            sortOrder: 'asc',
            limit: 2,
            cursor: page1FileAsc.nextCursor!,
          }),
        /Invalid pagination cursor/,
      )

      // 2. Legacy { d, id } cursor works for media_date desc (default & explicit)
      const fullDateDesc = searchMediaInDatabase(db, { limit: 100 })
      const secondItem = fullDateDesc.items[1]!
      const legacyCursor = Buffer.from(
        JSON.stringify({ d: secondItem.mediaDate ?? '', id: secondItem.id }),
        'utf8',
      ).toString('base64url')

      const fromLegacyDefault = searchMediaInDatabase(db, { limit: 100, cursor: legacyCursor })
      assert.deepEqual(
        fromLegacyDefault.items.map(i => i.mediaId),
        fullDateDesc.items.slice(2).map(i => i.mediaId),
      )

      // Legacy cursor inside NULL/empty bucket ({ d: '', id: ... })
      const firstNullIdx = fullDateDesc.items.findIndex(
        i => i.mediaDate === null || i.mediaDate === '',
      )
      assert.ok(firstNullIdx >= 0)
      const firstNullItem = fullDateDesc.items[firstNullIdx]!
      const legacyNullCursor = Buffer.from(
        JSON.stringify({ d: '', id: firstNullItem.id }),
        'utf8',
      ).toString('base64url')
      const afterNullLegacy = searchMediaInDatabase(db, { limit: 100, cursor: legacyNullCursor })
      assert.deepEqual(
        afterNullLegacy.items.map(i => i.mediaId),
        fullDateDesc.items.slice(firstNullIdx + 1).map(i => i.mediaId),
      )

      // Legacy cursor MUST be rejected for any non-(media_date, desc) sort
      for (const sortBy of ALL_SORT_FIELDS) {
        for (const sortOrder of ALL_SORT_ORDERS) {
          if (sortBy === 'media_date' && sortOrder === 'desc') continue
          assert.throws(
            () =>
              searchMediaInDatabase(db, {
                sortBy,
                sortOrder,
                limit: 2,
                cursor: legacyCursor,
              }),
            /Invalid pagination cursor/,
            `Legacy cursor must be rejected for ${sortBy} ${sortOrder}`,
          )
        }
      }

      // 3. Malformed / crafted cursors must throw Invalid pagination cursor
      const badCursors = [
        'not-valid-base64-json!!!',
        Buffer.from('null', 'utf8').toString('base64url'),
        Buffer.from(
          JSON.stringify({ sortBy: 'bogus', sortOrder: 'desc', isNull: 0, v: 'x', id: 1 }),
          'utf8',
        ).toString('base64url'),
        Buffer.from(
          JSON.stringify({ sortBy: 'filename', sortOrder: 'sideways', isNull: 0, v: 'x', id: 1 }),
          'utf8',
        ).toString('base64url'),
        Buffer.from(
          JSON.stringify({ sortBy: 'filename', sortOrder: 'asc', isNull: 2, v: 'x', id: 1 }),
          'utf8',
        ).toString('base64url'),
        Buffer.from(
          JSON.stringify({ sortBy: 'filename', sortOrder: 'asc', isNull: 1, v: 'non-empty', id: 1 }),
          'utf8',
        ).toString('base64url'),
        Buffer.from(
          JSON.stringify({ sortBy: 'filename', sortOrder: 'asc', isNull: 0, v: '', id: 1 }),
          'utf8',
        ).toString('base64url'),
        Buffer.from(
          JSON.stringify({ sortBy: 'filename', sortOrder: 'asc', isNull: 0, v: 'a', id: 0 }),
          'utf8',
        ).toString('base64url'),
      ]
      for (const bad of badCursors) {
        assert.throws(
          () => decodeKeysetCursor(bad),
          /Invalid pagination cursor/,
        )
      }

      // Roundtrip encode/decode sanity check
      const roundtrip = decodeKeysetCursor(
        encodeKeysetCursor({
          sortBy: 'catalog_number',
          sortOrder: 'asc',
          isNull: 0,
          v: 'abp-100',
          id: 42,
        }),
      )
      assert.deepEqual(roundtrip, {
        sortBy: 'catalog_number',
        sortOrder: 'asc',
        isNull: 0,
        v: 'abp-100',
        id: 42,
      })
    } finally {
      db.close()
    }
  })

  it('B1: strictly rejects invalid runtime sortBy and sortOrder values without SQL injection', () => {
    const { db } = openMediaLibraryDatabase({ dbPath })
    try {
      const invalidSortBys = [
        '',
        'title',
        'id',
        'MEDIA_DATE',
        'media_date; DROP TABLE media_files; --',
        123,
        null,
      ]
      for (const badSortBy of invalidSortBys) {
        assert.throws(
          () => searchMediaInDatabase(db, { sortBy: badSortBy as unknown as MediaSortField }),
          /Invalid sortBy/,
        )
      }

      const invalidSortOrders = [
        '',
        'DESC',
        'ascending',
        'desc; DROP TABLE media_files; --',
        0,
        null,
      ]
      for (const badSortOrder of invalidSortOrders) {
        assert.throws(
          () => searchMediaInDatabase(db, { sortOrder: badSortOrder as unknown as MediaSortOrder }),
          /Invalid sortOrder/,
        )
      }

      // Ensure table is intact after injection strings
      const check = searchMediaInDatabase(db, { limit: 100 })
      assert.equal(check.totalMatching, FIXTURE_ROWS.length)
    } finally {
      db.close()
    }
  })

  it('B1: Typert searchMedia input codec validates sortBy and sortOrder cleanly', async () => {
    const remoteMod = await import('../../lib/typert.remote-client.js')
    const descriptor = remoteMod.TYPERT_REMOTE.methods['mediaLibrary/searchMedia']
    assert.ok(descriptor)
    const param = descriptor.parameters[0]
    assert.ok(param && 'create' in param.codec)
    const schema = param.codec.create() as unknown as {
      safeParse: (input: unknown) =>
        | { readonly success: true; readonly data?: SearchMediaInput }
        | { readonly success: false }
    }

    for (const sortBy of ALL_SORT_FIELDS) {
      for (const sortOrder of ALL_SORT_ORDERS) {
        const validInput: SearchMediaInput = { sortBy, sortOrder, limit: 20 }
        const parsed = schema.safeParse(validInput)
        assert.equal(parsed.success, true, `Expected Typert schema to accept ${sortBy} ${sortOrder}`)
        if (parsed.success) {
          assert.equal(parsed.data?.sortBy, sortBy)
          assert.equal(parsed.data?.sortOrder, sortOrder)
        }
      }
    }

    assert.equal(schema.safeParse({ sortBy: 'invalid_col' }).success, false)
    assert.equal(schema.safeParse({ sortOrder: 'up' }).success, false)
  })
})
