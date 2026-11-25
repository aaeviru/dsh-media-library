import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { migrateDatabase, openMediaLibraryDatabase } from '../../src/db/schema.ts'
import { MediaSearchCoordinator } from '../../src/client/ui/search-coordinator.ts'
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  searchMediaInDatabase,
} from '../../src/search/search-repository.ts'
import { MediaLibrarySpikeService } from '../../src/spike-service.ts'
import type {
  MediaSortField,
  MediaSortOrder,
  SearchMediaInput,
  SearchMediaResult,
} from '../../src/types.ts'

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
 * - Mixed added_at timestamp formats (TagStudio space-separated, microseconds, ISO Z, timezone offset, date-only)
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
    addedAt: '2026-01-10 18:00:00',
    tagIds: [1],
  },
  {
    id: 2,
    relativePath: 'dir1\\alpha.mkv',
    filename: 'alpha.mkv',
    title: 'Alpha Lower',
    catalogNumber: 'ABP-100',
    mediaDate: '2025-06-15',
    addedAt: '2026-01-10T01:00:00.000Z',
    tagIds: [1],
  },
  {
    id: 3,
    relativePath: 'dir2\\Alpha.mkv',
    filename: 'Alpha.mkv',
    title: 'Alpha Upper',
    catalogNumber: 'Abp-050',
    mediaDate: '2026-02-01',
    addedAt: '2026-01-10T10:00:00+09:00',
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
    addedAt: '2026-01-10 18:00:00.123456',
    tagIds: [1],
  },
  {
    id: 9,
    relativePath: 'dir1\\äpfel.mkv',
    filename: 'äpfel.mkv',
    title: 'Non-ASCII Lower Umlaut',
    catalogNumber: 'ssis-200',
    mediaDate: '2025-06-15',
    addedAt: '2026-01-10',
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

function canonicalAddedAtKey(raw: string | null): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null
  const isoCandidate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ? `${trimmed}T00:00:00.000Z`
    : trimmed.includes('T')
      ? trimmed
      : trimmed.replace(' ', 'T') + (/[Zz]|[+-]\d{2}:\d{2}$/.test(trimmed) ? '' : 'Z')
  const ms = Date.parse(isoCandidate)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

function getExpectedIds(
  rows: readonly FixtureRow[],
  sortBy: MediaSortField,
  sortOrder: MediaSortOrder,
): string[] {
  const getKey = (r: FixtureRow): string | null => {
    switch (sortBy) {
      case 'media_date':
        return r.mediaDate && r.mediaDate.length > 0 ? r.mediaDate : null
      case 'added_at':
        return canonicalAddedAtKey(r.addedAt)
      case 'catalog_number':
        return r.catalogNumber && r.catalogNumber.length > 0
          ? sqliteAsciiLower(r.catalogNumber)
          : null
      case 'filename':
        return r.filename && r.filename.length > 0 ? sqliteAsciiLower(r.filename) : null
    }
  }

  return [...rows]
    .sort((a, b) => {
      const ka = getKey(a)
      const kb = getKey(b)
      const nullA = ka === null ? 1 : 0
      const nullB = kb === null ? 1 : 0
      // NULLS LAST in BOTH asc and desc
      if (nullA !== nullB) return nullA - nullB

      if (nullA === 0 && ka !== kb) {
        const cmp = ka! < kb! ? -1 : 1
        return sortOrder === 'asc' ? cmp : -cmp
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

  it('B1/B2/B3: added_at orders mixed TagStudio space timestamps, ISO Z, offsets, and microseconds chronologically across keyset pages', async () => {
    const mixedDbPath = path.join(tempRoot, 'mixed-added-at', 'library.sqlite3')
    const { db } = openMediaLibraryDatabase({ dbPath: mixedDbPath })
    try {
      await migrateDatabase(db, { dbPath: mixedDbPath })
      db.exec(`
        INSERT INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
        VALUES ('nas-main', 'NAS Test', '\\\\SynologyNAS\\Media', 1, '2026-01-01T00:00:00Z');
      `)
      const insert = db.prepare(`
        INSERT INTO media_files (
          id, root_id, relative_path, filename, extension, added_at, status, revision
        ) VALUES (?, 'nas-main', ?, ?, 'mkv', ?, 'indexed', 1)
      `)
      // Specifically includes Critic Round 1 repro: '2026-01-10 18:00:00' vs '2026-01-10T01:00:00.000Z'
      // Raw text ASC would place space (0x20) before 'T' (0x54), putting 18:00 before 01:00!
      const rows: ReadonlyArray<readonly [number, string | null]> = [
        [1, '2026-01-10 18:00:00'],
        [2, '2026-01-10T01:00:00.000Z'],
        [3, '2026-01-10T10:00:00+09:00'], // same UTC instant as id=2 (01:00:00Z)
        [4, '2026-01-10 18:00:00.123456'], // 123ms after id=1
        [5, '2026-01-10'], // 00:00:00Z
        [6, 'not-a-timestamp'], // unparseable -> NULLS LAST
        [7, 'now'], // SQLite magic keyword must NOT evaluate dynamically -> NULLS LAST
        [8, null],
      ]
      for (const [id, addedAt] of rows) {
        insert.run(id, `ts_${id}.mkv`, `ts_${id}.mkv`, addedAt)
      }

      // Chronological ASC: 5 (00:00Z) < 2,3 (01:00Z) < 1 (18:00Z) < 4 (18:00.123Z) < NULL/unparseable [6, 7, 8]
      const expectedAsc = ['5', '2', '3', '1', '4', '6', '7', '8']
      // Chronological DESC: 4 (18:00.123Z) > 1 (18:00Z) > 3,2 (01:00Z) > 5 (00:00Z) > NULL/unparseable [8, 7, 6]
      const expectedDesc = ['4', '1', '3', '2', '5', '8', '7', '6']

      for (const [sortOrder, expected] of [
        ['asc', expectedAsc],
        ['desc', expectedDesc],
      ] as const) {
        const full = searchMediaInDatabase(db, { sortBy: 'added_at', sortOrder, limit: 50 })
        assert.deepEqual(
          full.items.map(i => i.mediaId),
          expected,
          `Chronological added_at ${sortOrder} mismatch`,
        )

        // Verify keyset cursor pagination (limit=2 and limit=1) matches full chronological order
        for (const pageLimit of [2, 1]) {
          const paged: string[] = []
          let cursor: string | undefined
          do {
            const page = searchMediaInDatabase(db, {
              sortBy: 'added_at',
              sortOrder,
              limit: pageLimit,
              cursor,
            })
            paged.push(...page.items.map(i => i.mediaId))
            cursor = page.nextCursor ?? undefined
          } while (cursor)
          assert.deepEqual(
            paged,
            expected,
            `Paginated added_at ${sortOrder} (limit=${pageLimit}) diverged`,
          )
        }
      }
    } finally {
      db.close()
    }
  })

  it('B4: MediaSearchCoordinator prevents refreshAll from overwriting a newer sort selection during metadata wait', async () => {
    const createDeferred = <T,>() => {
      let resolve!: (value: T) => void
      const promise = new Promise<T>(res => {
        resolve = res
      })
      return { promise, resolve }
    }

    const makeResult = (query: SearchMediaInput): SearchMediaResult => ({
      items: [],
      nextCursor: `cursor:${query.sortBy ?? 'media_date'}:${query.sortOrder ?? 'desc'}`,
      totalMatching: 10,
      elapsedMs: 1,
      resolvedTagIds: [],
      unresolvedTagQueries: [],
      ambiguousAliases: [],
    })

    const coordinator = new MediaSearchCoordinator({
      keyword: '',
      catalogNumber: '',
      catalogMatchMode: 'exact',
      dateFrom: '',
      dateTo: '',
      selectedTagIds: [],
      sortBy: 'media_date',
      sortOrder: 'desc',
      tagSearchInput: '',
    })

    const searchCalls: SearchMediaInput[] = []
    let searching = false
    let activeCursor: string | null = null
    let lastError: string | null = null

    const metaGate = createDeferred<void>()
    const userSearchGate = createDeferred<void>()

    const callbacks = {
      searchMedia: async (input: SearchMediaInput) => {
        searchCalls.push(input)
        if (input.sortBy === 'filename') {
          await userSearchGate.promise
        }
        return { ok: true as const, value: makeResult(input) }
      },
      onSearchingChange: (next: boolean) => {
        searching = next
      },
      onLoadingMoreChange: () => {},
      onClearNextCursor: () => {
        activeCursor = null
      },
      onError: (msg: string | null) => {
        lastError = msg
      },
      onResult: (res: SearchMediaResult) => {
        activeCursor = res.nextCursor
      },
      fallbackRpcError: () => 'RPC error',
    }

    // 1. Start refreshAll while initial sort is media_date desc
    const refreshPromise = coordinator.refreshAll({
      loadMetadata: () => metaGate.promise,
      loadTags: async () => {},
      searchCallbacks: callbacks,
    })
    assert.equal(searching, true)

    // 2. User changes sort to filename asc BEFORE metadata RPCs finish
    coordinator.patchDraft({ sortBy: 'filename', sortOrder: 'asc' })
    const userSearchPromise = coordinator.executeSearch(callbacks, {
      overrideSortBy: 'filename',
      overrideSortOrder: 'asc',
    })

    // 3. Metadata RPCs finish while user's filename asc search is still in flight
    metaGate.resolve()
    const refreshOutcome = await refreshPromise
    assert.equal(refreshOutcome.searchSkippedDueToNewerRequest, true)
    // Refresh MUST NOT issue a stale media_date desc search or prematurely clear searching!
    assert.equal(searchCalls.length, 1)
    assert.equal(searchCalls[0]?.sortBy, 'filename')
    assert.equal(searchCalls[0]?.sortOrder, 'asc')
    assert.equal(searching, true)

    // 4. User's filename asc search resolves -> committed query & cursor match filename asc
    userSearchGate.resolve()
    await userSearchPromise
    assert.equal(searching, false)
    assert.equal(lastError, null)
    assert.equal(activeCursor, 'cursor:filename:asc')
    assert.equal(coordinator.getCommittedQuery()?.sortBy, 'filename')
    assert.equal(coordinator.getCommittedQuery()?.sortOrder, 'asc')

    // 5. Subsequent refreshAll (e.g. after import) reads the LATEST sort (catalog_number asc)
    coordinator.patchDraft({ sortBy: 'catalog_number', sortOrder: 'asc' })
    const postImportOutcome = await coordinator.refreshAll({
      loadMetadata: async () => {},
      loadTags: async () => {},
      searchCallbacks: callbacks,
    })
    assert.equal(postImportOutcome.searchSkippedDueToNewerRequest, false)
    assert.equal(searchCalls.length, 2)
    assert.equal(searchCalls[1]?.sortBy, 'catalog_number')
    assert.equal(searchCalls[1]?.sortOrder, 'asc')
    assert.equal(activeCursor, 'cursor:catalog_number:asc')
    assert.equal(searching, false)

    // 6. Out-of-order concurrent sort clicks discard stale response
    const slowFirst = createDeferred<void>()
    const fastSecond = createDeferred<void>()
    const raceCallbacks = {
      ...callbacks,
      searchMedia: async (input: SearchMediaInput) => {
        if (input.sortBy === 'added_at') {
          await slowFirst.promise
        } else {
          await fastSecond.promise
        }
        return { ok: true as const, value: makeResult(input) }
      },
    }
    coordinator.patchDraft({ sortBy: 'added_at', sortOrder: 'desc' })
    const firstClick = coordinator.executeSearch(raceCallbacks, {
      overrideSortBy: 'added_at',
      overrideSortOrder: 'desc',
    })
    coordinator.patchDraft({ sortBy: 'filename', sortOrder: 'desc' })
    const secondClick = coordinator.executeSearch(raceCallbacks, {
      overrideSortBy: 'filename',
      overrideSortOrder: 'desc',
    })
    fastSecond.resolve()
    await secondClick
    assert.equal(activeCursor, 'cursor:filename:desc')
    slowFirst.resolve()
    await firstClick
    assert.equal(activeCursor, 'cursor:filename:desc')
    assert.equal(coordinator.getCommittedQuery()?.sortBy, 'filename')
  })
})
