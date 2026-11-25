import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import {
  extractCatalogNumber,
  normalizeLookupKey,
} from '../inventory/tagstudio-inventory.ts'
import type {
  AmbiguousAliasWarning,
  CatalogMatchMode,
  ListTagsInput,
  ListTagsResult,
  MediaDetailItem,
  MediaFileStatus,
  MediaSearchItem,
  MediaSortField,
  MediaSortOrder,
  MediaTagChip,
  SearchMediaInput,
  SearchMediaResult,
  TagSummary,
} from '../types.ts'

export interface KeysetCursorPayload {
  readonly sortBy: MediaSortField
  readonly sortOrder: MediaSortOrder
  readonly isNull: 0 | 1
  readonly v: string
  readonly id: number
}

interface SortColumnSpec {
  readonly nullExpr: string
  readonly valExpr: string
}

// Normalize mixed added_at formats (TagStudio 'YYYY-MM-DD HH:MM:SS[.ffffff]', native ISO
// 'YYYY-MM-DDTHH:MM:SS.sssZ', timezone offsets like '+09:00', or date-only 'YYYY-MM-DD') into
// canonical UTC ISO-8601 ('YYYY-MM-DDTHH:MM:SS.fffZ') so lexicographic order matches chronological
// order. Guarding with a YYYY-MM-DD prefix prevents SQLite magic strings like 'now'.
const ADDED_AT_CANONICAL_EXPR =
  "CASE WHEN TRIM(COALESCE(mf.added_at, '')) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN strftime('%Y-%m-%dT%H:%M:%fZ', TRIM(mf.added_at)) ELSE NULL END"

const SORT_COLUMN_SPECS: Readonly<Record<MediaSortField, SortColumnSpec>> = {
  media_date: {
    nullExpr: "CASE WHEN mf.media_date IS NULL OR mf.media_date = '' THEN 1 ELSE 0 END",
    valExpr: "COALESCE(mf.media_date, '')",
  },
  added_at: {
    nullExpr: `CASE WHEN (${ADDED_AT_CANONICAL_EXPR}) IS NULL THEN 1 ELSE 0 END`,
    valExpr: `COALESCE(${ADDED_AT_CANONICAL_EXPR}, '')`,
  },
  catalog_number: {
    nullExpr: "CASE WHEN mf.catalog_number IS NULL OR mf.catalog_number = '' THEN 1 ELSE 0 END",
    valExpr: "LOWER(COALESCE(mf.catalog_number, ''))",
  },
  filename: {
    nullExpr: "CASE WHEN mf.filename IS NULL OR mf.filename = '' THEN 1 ELSE 0 END",
    valExpr: "LOWER(COALESCE(mf.filename, ''))",
  },
}

const VALID_SORT_FIELDS = new Set<MediaSortField>([
  'media_date',
  'added_at',
  'catalog_number',
  'filename',
])

const VALID_SORT_ORDERS = new Set<MediaSortOrder>(['desc', 'asc'])

export function validateSortField(raw: unknown): MediaSortField {
  if (raw === undefined) return 'media_date'
  if (typeof raw !== 'string' || !VALID_SORT_FIELDS.has(raw as MediaSortField)) {
    throw new Error(
      `Invalid sortBy "${String(raw)}": expected one of media_date, added_at, catalog_number, filename`,
    )
  }
  return raw as MediaSortField
}

export function validateSortOrder(raw: unknown): MediaSortOrder {
  if (raw === undefined) return 'desc'
  if (typeof raw !== 'string' || !VALID_SORT_ORDERS.has(raw as MediaSortOrder)) {
    throw new Error(`Invalid sortOrder "${String(raw)}": expected "desc" or "asc"`)
  }
  return raw as MediaSortOrder
}

export function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, ch => `\\${ch}`)
}

/**
 * Normalize a user-supplied catalog number query for exact or prefix matching (`B2`).
 * - Full catalog codes (e.g. `fc2 1476760`, `abp_909`) normalize via `extractCatalogNumber` (`FC2-PPV-1476760`, `ABP-909`).
 * - Partial prefixes (e.g. `abp`, `abp_`, `fc2-147`) fold case, normalize separators to `-`, and expand `FC2-<digits>` to `FC2-PPV-<digits>`.
 */
export function normalizeCatalogQuery(
  rawQuery: string,
  mode: CatalogMatchMode = 'exact',
): string {
  const trimmed = rawQuery.trim()
  if (!trimmed) return ''

  if (mode === 'exact') {
    const extracted = extractCatalogNumber(trimmed)
    if (extracted) return extracted
  }

  let normalized = trimmed
    .toUpperCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')

  // Normalize FC2-<digits> prefix or exact code to FC2-PPV-<digits>
  normalized = normalized.replace(/^FC2-(?!PPV-)(\d+)/, 'FC2-PPV-$1')
  if (/^FC2$/i.test(normalized) && mode === 'prefix') {
    return 'FC2-'
  }
  return normalized
}

const STRICT_ISO_DATE_RE = /^((?:19|20)\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

export function validateIsoDateBound(
  rawDate: string | undefined,
  fieldName: 'dateFrom' | 'dateTo',
): string | null {
  if (!rawDate || rawDate.trim().length === 0) return null
  const trimmed = rawDate.trim()
  if (!STRICT_ISO_DATE_RE.test(trimmed)) {
    throw new Error(`Invalid ${fieldName} "${rawDate}": expected ISO YYYY-MM-DD format`)
  }
  return trimmed
}

export function encodeKeysetCursor(payload: KeysetCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeKeysetCursor(
  cursor: string,
  expectedSort?: {
    readonly sortBy: MediaSortField
    readonly sortOrder: MediaSortOrder
  },
): KeysetCursorPayload {
  let payload: KeysetCursorPayload
  try {
    const raw = Buffer.from(cursor.trim(), 'base64url').toString('utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Malformed cursor object')
    }

    const hasNewFields =
      'sortBy' in parsed || 'sortOrder' in parsed || 'isNull' in parsed || 'v' in parsed

    if (hasNewFields) {
      const sortBy = parsed.sortBy
      const sortOrder = parsed.sortOrder
      const isNull = parsed.isNull
      const v = parsed.v
      const id = parsed.id
      if (
        typeof sortBy !== 'string' ||
        !VALID_SORT_FIELDS.has(sortBy as MediaSortField) ||
        typeof sortOrder !== 'string' ||
        !VALID_SORT_ORDERS.has(sortOrder as MediaSortOrder) ||
        (isNull !== 0 && isNull !== 1) ||
        typeof v !== 'string' ||
        (isNull === 1 ? v !== '' : v.length === 0) ||
        typeof id !== 'number' ||
        !Number.isInteger(id) ||
        id <= 0
      ) {
        throw new Error('Malformed cursor fields')
      }
      payload = {
        sortBy: sortBy as MediaSortField,
        sortOrder: sortOrder as MediaSortOrder,
        isNull,
        v,
        id,
      }
    } else {
      // Legacy cursor compatibility: `{ d, id }` corresponds strictly to `media_date desc`
      const d = parsed.d
      const id = parsed.id
      if (
        typeof d !== 'string' ||
        typeof id !== 'number' ||
        !Number.isInteger(id) ||
        id <= 0
      ) {
        throw new Error('Malformed legacy cursor fields')
      }
      payload = {
        sortBy: 'media_date',
        sortOrder: 'desc',
        isNull: d === '' ? 1 : 0,
        v: d,
        id,
      }
    }
  } catch {
    throw new Error(`Invalid pagination cursor: "${cursor}"`)
  }

  if (
    expectedSort &&
    (payload.sortBy !== expectedSort.sortBy || payload.sortOrder !== expectedSort.sortOrder)
  ) {
    throw new Error(
      `Invalid pagination cursor: cursor sort (${payload.sortBy} ${payload.sortOrder}) does not match requested sort (${expectedSort.sortBy} ${expectedSort.sortOrder})`,
    )
  }

  return payload
}

function computeAsciiPrefixUpperBound(prefix: string): string | null {
  if (!prefix) return null
  const lastCode = prefix.charCodeAt(prefix.length - 1)
  if (lastCode >= 0xffff) return null
  return prefix.slice(0, -1) + String.fromCharCode(lastCode + 1)
}

function getTableColumns(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>
  return new Set(rows.map(r => String(r.name)))
}

/**
 * List tags and their aliases, supporting search by tag name, shorthand, or alias (`B1`).
 */
export function listTagsInDatabase(
  db: DatabaseSync,
  input?: ListTagsInput,
): ListTagsResult {
  const limit = Math.min(Math.max(Number(input?.limit ?? 100), 1), 500)
  const rawQuery = input?.query?.trim() ?? ''
  const normQuery = normalizeLookupKey(rawQuery)
  const tagCols = getTableColumns(db, 'tags')
  const hasArchivedAt = tagCols.has('archived_at')
  const hasMergedIntoId = tagCols.has('merged_into_id')
  // Archived tags stay readable (existing associations, search) but are not offered by default (B5).
  const archivedFilter = hasArchivedAt && !input?.includeArchived ? 't.archived_at IS NULL' : ''
  const archivedSelect = hasArchivedAt ? 't.archived_at' : 'NULL AS archived_at'
  const mergedSelect = hasMergedIntoId ? 't.merged_into_id' : 'NULL AS merged_into_id'

  let tagRows: Array<{
    id: number
    name: string
    normalized_name: string
    shorthand: string | null
    media_count: number
    exact_match: number
    revision: number
    archived_at: string | null
    merged_into_id: number | null
  }>

  if (!normQuery) {
    tagRows = db
      .prepare(
        `SELECT
           t.id,
           t.name,
           t.normalized_name,
           t.shorthand,
           (SELECT COUNT(*) FROM media_tags mt WHERE mt.tag_id = t.id) AS media_count,
           0 AS exact_match,
           t.revision,
           ${archivedSelect},
           ${mergedSelect}
         FROM tags t
         ${archivedFilter ? `WHERE ${archivedFilter}` : ''}
         ORDER BY media_count DESC, t.normalized_name ASC, t.id ASC
         LIMIT ?`,
      )
      .all(limit) as typeof tagRows
  } else {
    const likePattern = `%${escapeSqlLike(normQuery)}%`
    tagRows = db
      .prepare(
        `SELECT
           t.id,
           t.name,
           t.normalized_name,
           t.shorthand,
           (SELECT COUNT(*) FROM media_tags mt WHERE mt.tag_id = t.id) AS media_count,
           CASE
             WHEN t.normalized_name = ? THEN 2
             WHEN LOWER(COALESCE(t.shorthand, '')) = ? THEN 2
             WHEN EXISTS (
               SELECT 1 FROM tag_aliases ta
               WHERE ta.tag_id = t.id AND ta.normalized_alias = ?
             ) THEN 2
             ELSE 1
           END AS exact_match,
           t.revision,
           ${archivedSelect},
           ${mergedSelect}
         FROM tags t
         WHERE (t.normalized_name LIKE ? ESCAPE '\\'
            OR LOWER(COALESCE(t.shorthand, '')) LIKE ? ESCAPE '\\'
            OR EXISTS (
              SELECT 1 FROM tag_aliases ta
              WHERE ta.tag_id = t.id AND ta.normalized_alias LIKE ? ESCAPE '\\'
            ))
            ${archivedFilter ? `AND ${archivedFilter}` : ''}
         ORDER BY exact_match DESC, media_count DESC, t.normalized_name ASC, t.id ASC
         LIMIT ?`,
      )
      .all(normQuery, normQuery, normQuery, likePattern, likePattern, likePattern, limit) as typeof tagRows
  }

  const aliasesByTagId = new Map<number, string[]>()
  if (tagRows.length > 0) {
    const placeholders = tagRows.map(() => '?').join(', ')
    const aliasRows = db
      .prepare(
        `SELECT tag_id, alias
         FROM tag_aliases
         WHERE tag_id IN (${placeholders})
         ORDER BY normalized_alias ASC, id ASC`,
      )
      .all(...tagRows.map(r => Number(r.id))) as Array<{ tag_id: number; alias: string }>

    for (const ar of aliasRows) {
      const tid = Number(ar.tag_id)
      const list = aliasesByTagId.get(tid) ?? []
      list.push(String(ar.alias))
      aliasesByTagId.set(tid, list)
    }
  }

  // Detect any ambiguous aliases shared across multiple tags
  const sharedAliasRows = db
    .prepare(
      `SELECT ta.normalized_alias, t.id AS tag_id, t.name AS tag_name
       FROM tag_aliases ta
       JOIN tags t ON t.id = ta.tag_id
       WHERE ta.normalized_alias IN (
         SELECT normalized_alias
         FROM tag_aliases
         GROUP BY normalized_alias
         HAVING COUNT(DISTINCT tag_id) > 1
       )
       ORDER BY ta.normalized_alias ASC, t.id ASC`,
    )
    .all() as Array<{ normalized_alias: string; tag_id: number; tag_name: string }>

  const sharedMap = new Map<string, Array<{ id: number; name: string }>>()
  for (const row of sharedAliasRows) {
    const key = String(row.normalized_alias)
    if (normQuery && !key.includes(normQuery)) continue
    const list = sharedMap.get(key) ?? []
    list.push({ id: Number(row.tag_id), name: String(row.tag_name) })
    sharedMap.set(key, list)
  }

  const ambiguousAliases: AmbiguousAliasWarning[] = [...sharedMap.entries()].map(
    ([normalizedAlias, matchingTags]) => ({
      normalizedAlias,
      matchingTags,
    }),
  )

  const tags: TagSummary[] = tagRows.map(r => ({
    id: Number(r.id),
    name: String(r.name),
    normalizedName: String(r.normalized_name),
    shorthand: r.shorthand ? String(r.shorthand) : null,
    aliases: aliasesByTagId.get(Number(r.id)) ?? [],
    mediaCount: Number(r.media_count),
    revision: Number(r.revision),
    archived: r.archived_at !== null,
    mergedIntoId: r.merged_into_id !== null ? Number(r.merged_into_id) : null,
  }))

  return {
    tags,
    ambiguousAliases,
  }
}

/**
 * Resolve tag names or aliases to canonical `tag_id`s (`B1`).
 * Ensures searching by a tag's name or by its alias resolves to the exact same `tag_id`.
 */
export function resolveTagFilters(
  db: DatabaseSync,
  explicitTagIds?: readonly number[],
  tagNamesOrAliases?: readonly string[],
): {
  readonly resolvedTagIds: readonly number[]
  readonly unresolvedTagQueries: readonly string[]
  readonly ambiguousAliases: readonly AmbiguousAliasWarning[]
} {
  const resolvedSet = new Set<number>()
  const unresolvedTagQueries: string[] = []
  const ambiguousMap = new Map<string, ReadonlyArray<{ readonly id: number; readonly name: string }>>()

  if (explicitTagIds) {
    for (const rawId of explicitTagIds) {
      const id = Number(rawId)
      if (Number.isInteger(id) && id >= 0) {
        resolvedSet.add(id)
      }
    }
  }

  if (tagNamesOrAliases && tagNamesOrAliases.length > 0) {
    const byNameStmt = db.prepare(
      'SELECT id, name FROM tags WHERE normalized_name = ? OR LOWER(COALESCE(shorthand, \'\')) = ? ORDER BY id ASC',
    )
    const byAliasStmt = db.prepare(
      `SELECT t.id, t.name
       FROM tag_aliases ta
       JOIN tags t ON t.id = ta.tag_id
       WHERE ta.normalized_alias = ?
       ORDER BY t.id ASC`,
    )

    for (const rawToken of tagNamesOrAliases) {
      const norm = normalizeLookupKey(rawToken)
      if (!norm) continue

      const nameMatches = byNameStmt.all(norm, norm) as Array<{ id: number; name: string }>
      const aliasMatches = byAliasStmt.all(norm) as Array<{ id: number; name: string }>

      const combinedMap = new Map<number, string>()
      for (const m of nameMatches) {
        combinedMap.set(Number(m.id), String(m.name))
      }
      for (const m of aliasMatches) {
        combinedMap.set(Number(m.id), String(m.name))
      }

      if (combinedMap.size === 0) {
        unresolvedTagQueries.push(rawToken.trim())
        continue
      }

      const matchingTags = [...combinedMap.entries()].map(([id, name]) => ({ id, name }))
      if (matchingTags.length > 1) {
        ambiguousMap.set(norm, matchingTags)
      }
      // Pick canonical primary tag ID (first in deterministic order)
      resolvedSet.add(matchingTags[0]!.id)
    }
  }

  return {
    resolvedTagIds: [...resolvedSet],
    unresolvedTagQueries,
    ambiguousAliases: [...ambiguousMap.entries()].map(([normalizedAlias, matchingTags]) => ({
      normalizedAlias,
      matchingTags,
    })),
  }
}

function hydrateMediaTagsMap(
  db: DatabaseSync,
  mediaIds: readonly number[],
): Map<number, MediaTagChip[]> {
  const result = new Map<number, MediaTagChip[]>()
  if (mediaIds.length === 0) return result

  const placeholders = mediaIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT mt.media_id, t.id, t.name, t.shorthand
       FROM media_tags mt
       JOIN tags t ON t.id = mt.tag_id
       WHERE mt.media_id IN (${placeholders})
       ORDER BY t.normalized_name ASC, t.id ASC`,
    )
    .all(...mediaIds) as Array<{
    media_id: number
    id: number
    name: string
    shorthand: string | null
  }>

  for (const r of rows) {
    const mid = Number(r.media_id)
    const list = result.get(mid) ?? []
    list.push({
      id: Number(r.id),
      name: String(r.name),
      shorthand: r.shorthand ? String(r.shorthand) : null,
    })
    result.set(mid, list)
  }
  return result
}

/**
 * Execute a parameterized, keyset-paginated search over `media_files` (`B1`, `B2`, `B3`, `B5`).
 */
export function searchMediaInDatabase(
  db: DatabaseSync,
  input?: SearchMediaInput,
): SearchMediaResult {
  const startMs = performance.now()
  const limit = Math.min(Math.max(Number(input?.limit ?? 50), 1), 200)
  const catalogMatchMode: CatalogMatchMode = input?.catalogMatchMode === 'prefix' ? 'prefix' : 'exact'
  const sortBy = validateSortField(input?.sortBy)
  const sortOrder = validateSortOrder(input?.sortOrder)

  const dateFrom = validateIsoDateBound(input?.dateFrom, 'dateFrom')
  const dateTo = validateIsoDateBound(input?.dateTo, 'dateTo')
  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new Error(`Invalid date range: dateFrom (${dateFrom}) must be <= dateTo (${dateTo})`)
  }

  const cursorPayload = input?.cursor?.trim()
    ? decodeKeysetCursor(input.cursor, { sortBy, sortOrder })
    : null

  const { resolvedTagIds, unresolvedTagQueries, ambiguousAliases } = resolveTagFilters(
    db,
    input?.tagIds,
    input?.tagNamesOrAliases,
  )

  // If the caller specified a tag name/alias that does not exist in the DB, AND semantics require 0 matches
  if (unresolvedTagQueries.length > 0) {
    return {
      items: [],
      nextCursor: null,
      totalMatching: 0,
      elapsedMs: Number((performance.now() - startMs).toFixed(2)),
      resolvedTagIds,
      unresolvedTagQueries,
      ambiguousAliases,
    }
  }

  const whereClauses: string[] = ['1 = 1']
  const baseParams: Array<string | number> = []

  // 1. Catalog number filter (`B2`)
  const rawCatalog = input?.catalogNumber?.trim() ?? ''
  if (rawCatalog.length > 0) {
    const normCatalog = normalizeCatalogQuery(rawCatalog, catalogMatchMode)
    if (catalogMatchMode === 'exact') {
      whereClauses.push('mf.catalog_number = ?')
      baseParams.push(normCatalog)
    } else {
      const upperBound = computeAsciiPrefixUpperBound(normCatalog)
      const likePat = `${escapeSqlLike(normCatalog)}%`
      if (upperBound) {
        whereClauses.push(
          "mf.catalog_number >= ? AND mf.catalog_number < ? AND mf.catalog_number LIKE ? ESCAPE '\\'",
        )
        baseParams.push(normCatalog, upperBound, likePat)
      } else {
        whereClauses.push("mf.catalog_number LIKE ? ESCAPE '\\'")
        baseParams.push(likePat)
      }
    }
  }

  // 2. Inclusive ISO date range (`B2`: unknown NULL dates are never fabricated and excluded when date filter is active)
  if (dateFrom) {
    whereClauses.push('mf.media_date IS NOT NULL AND mf.media_date >= ?')
    baseParams.push(dateFrom)
  }
  if (dateTo) {
    whereClauses.push('mf.media_date IS NOT NULL AND mf.media_date <= ?')
    baseParams.push(dateTo)
  }

  // 3. General text search across title, catalog_number, filename, relative_path
  const rawText = input?.text?.trim() ?? ''
  if (rawText.length > 0) {
    const tokens = rawText.split(/\s+/).filter(Boolean).slice(0, 6)
    for (const token of tokens) {
      const likeToken = `%${escapeSqlLike(token)}%`
      const maybeCatalog = extractCatalogNumber(token)
      if (maybeCatalog) {
        whereClauses.push(
          "(mf.catalog_number = ? OR COALESCE(mf.title, '') LIKE ? ESCAPE '\\' OR mf.filename LIKE ? ESCAPE '\\' OR mf.relative_path LIKE ? ESCAPE '\\')",
        )
        baseParams.push(maybeCatalog, likeToken, likeToken, likeToken)
      } else {
        whereClauses.push(
          "(COALESCE(mf.title, '') LIKE ? ESCAPE '\\' OR COALESCE(mf.catalog_number, '') LIKE ? ESCAPE '\\' OR mf.filename LIKE ? ESCAPE '\\' OR mf.relative_path LIKE ? ESCAPE '\\')",
        )
        baseParams.push(likeToken, likeToken, likeToken, likeToken)
      }
    }
  }

  // 4. Multi-tag AND filter (`B1`)
  for (const tagId of resolvedTagIds) {
    whereClauses.push(
      'EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = mf.id AND mt.tag_id = ?)',
    )
    baseParams.push(tagId)
  }

  const baseWhereSql = whereClauses.join(' AND ')

  const countRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM media_files mf WHERE ${baseWhereSql}`)
    .get(...baseParams) as { cnt: number }
  const totalMatching = Number(countRow.cnt)

  const sortSpec = SORT_COLUMN_SPECS[sortBy]
  const useDefaultDateDescFastPath = sortBy === 'media_date' && sortOrder === 'desc'
  const dirSql = sortOrder === 'asc' ? 'ASC' : 'DESC'
  const cmpOp = sortOrder === 'asc' ? '>' : '<'

  const pageWhereClauses = [...whereClauses]
  const pageParams = [...baseParams]
  if (cursorPayload) {
    if (useDefaultDateDescFastPath) {
      // Preserves O(log N) scan on idx_media_files_keyset_order (COALESCE(media_date, '') DESC, id DESC)
      pageWhereClauses.push(
        "(COALESCE(mf.media_date, '') < ? OR (COALESCE(mf.media_date, '') = ? AND mf.id < ?))",
      )
      pageParams.push(cursorPayload.v, cursorPayload.v, cursorPayload.id)
    } else if (cursorPayload.isNull === 1) {
      pageWhereClauses.push(`(${sortSpec.nullExpr} = 1 AND mf.id ${cmpOp} ?)`)
      pageParams.push(cursorPayload.id)
    } else {
      pageWhereClauses.push(
        `(${sortSpec.nullExpr} > 0 OR (${sortSpec.nullExpr} = 0 AND (${sortSpec.valExpr} ${cmpOp} ? OR (${sortSpec.valExpr} = ? AND mf.id ${cmpOp} ?))))`,
      )
      pageParams.push(cursorPayload.v, cursorPayload.v, cursorPayload.id)
    }
  }

  const orderBySql = useDefaultDateDescFastPath
    ? "COALESCE(mf.media_date, '') DESC, mf.id DESC"
    : `${sortSpec.nullExpr} ASC, ${sortSpec.valExpr} ${dirSql}, mf.id ${dirSql}`

  const pageWhereSql = pageWhereClauses.join(' AND ')
  const rawRows = db
    .prepare(
      `SELECT
         mf.id,
         mf.root_id,
         mf.relative_path,
         mf.filename,
         mf.extension,
         mf.title,
         mf.catalog_number,
         mf.media_date,
         mf.added_at,
         mf.status,
         mf.revision,
         ${sortSpec.nullExpr} AS __sort_is_null,
         ${sortSpec.valExpr} AS __sort_key
       FROM media_files mf
       WHERE ${pageWhereSql}
       ORDER BY ${orderBySql}
       LIMIT ?`,
    )
    .all(...pageParams, limit + 1) as Array<{
    id: number
    root_id: string
    relative_path: string
    filename: string
    extension: string
    title: string | null
    catalog_number: string | null
    media_date: string | null
    added_at: string | null
    status: MediaFileStatus
    revision: number
    __sort_is_null: number
    __sort_key: string
  }>

  const hasNextPage = rawRows.length > limit
  const pageRows = hasNextPage ? rawRows.slice(0, limit) : rawRows
  const mediaIds = pageRows.map(r => Number(r.id))
  const tagsByMediaId = hydrateMediaTagsMap(db, mediaIds)

  const items: MediaSearchItem[] = pageRows.map(r => {
    const id = Number(r.id)
    return {
      mediaId: String(id),
      id,
      rootId: String(r.root_id),
      relativePath: String(r.relative_path),
      filename: String(r.filename),
      extension: String(r.extension),
      title: r.title !== null ? String(r.title) : null,
      catalogNumber: r.catalog_number !== null ? String(r.catalog_number) : null,
      mediaDate: r.media_date !== null ? String(r.media_date) : null,
      addedAt: r.added_at !== null ? String(r.added_at) : null,
      status: (r.status as MediaFileStatus) ?? 'indexed',
      revision: Number(r.revision),
      tags: tagsByMediaId.get(id) ?? [],
    }
  })

  let nextCursor: string | null = null
  if (hasNextPage && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1]!
    const isNull: 0 | 1 = Number(last.__sort_is_null) === 1 ? 1 : 0
    nextCursor = encodeKeysetCursor({
      sortBy,
      sortOrder,
      isNull,
      v: isNull === 1 ? '' : String(last.__sort_key),
      id: Number(last.id),
    })
  }

  return {
    items,
    nextCursor,
    totalMatching,
    elapsedMs: Number((performance.now() - startMs).toFixed(2)),
    resolvedTagIds,
    unresolvedTagQueries,
    ambiguousAliases,
  }
}

/**
 * Look up a single media item by numeric `mediaId` (`"123"`).
 */
export function getMediaDetailInDatabase(
  db: DatabaseSync,
  mediaId: string,
): MediaDetailItem | null {
  const trimmed = mediaId.trim()
  if (!/^\d+$/.test(trimmed)) {
    return null
  }
  const numericId = Number(trimmed)
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    return null
  }

  const row = db
    .prepare(
      `SELECT
         mf.id,
         mf.root_id,
         mf.relative_path,
         mf.filename,
         mf.extension,
         mf.title,
         mf.catalog_number,
         mf.catalog_source,
         mf.media_date,
         mf.date_source,
         mf.added_at,
         mf.status,
         mf.revision
       FROM media_files mf
       WHERE mf.id = ?`,
    )
    .get(numericId) as
    | {
        id: number
        root_id: string
        relative_path: string
        filename: string
        extension: string
        title: string | null
        catalog_number: string | null
        catalog_source: string | null
        media_date: string | null
        date_source: string | null
        added_at: string | null
        status: MediaFileStatus
        revision: number
      }
    | undefined

  if (!row) return null

  const tagsMap = hydrateMediaTagsMap(db, [numericId])
  const textFieldRows = db
    .prepare(
      `SELECT field_name, field_value, is_multiline
       FROM media_text_fields
       WHERE media_id = ?
       ORDER BY position ASC, id ASC`,
    )
    .all(numericId) as Array<{
    field_name: string
    field_value: string
    is_multiline: number
  }>

  return {
    mediaId: String(numericId),
    id: numericId,
    rootId: String(row.root_id),
    relativePath: String(row.relative_path),
    filename: String(row.filename),
    extension: String(row.extension),
    title: row.title !== null ? String(row.title) : null,
    catalogNumber: row.catalog_number !== null ? String(row.catalog_number) : null,
    catalogSource: row.catalog_source !== null ? String(row.catalog_source) : null,
    mediaDate: row.media_date !== null ? String(row.media_date) : null,
    dateSource: row.date_source !== null ? String(row.date_source) : null,
    addedAt: row.added_at !== null ? String(row.added_at) : null,
    status: (row.status as MediaFileStatus) ?? 'indexed',
    revision: Number(row.revision),
    tags: tagsMap.get(numericId) ?? [],
    textFields: textFieldRows.map(tf => ({
      name: String(tf.field_name),
      value: String(tf.field_value),
      isMultiline: Boolean(tf.is_multiline),
    })),
  }
}
