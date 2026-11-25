import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { normalizeTagName } from '../types.ts'

export interface FileFingerprint {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
  readonly mtimeIso: string
  readonly sha256: string
  readonly hasWalFile: boolean
  readonly hasShmFile: boolean
}

export interface DbVersionInfo {
  readonly current: number | null
  readonly initial: number | null
  readonly source: 'versions' | 'preferences' | 'none'
}

export interface CandidateSummary {
  readonly path: string
  readonly fingerprint: FileFingerprint
  readonly isTagStudioDb: boolean
  readonly dbVersion: DbVersionInfo
  readonly tables: readonly string[]
  readonly counts: {
    readonly entries: number
    readonly tags: number
    readonly customTags: number
    readonly tagAliases: number
    readonly tagEntries: number
    readonly tagParents: number
    readonly textFields: number
    readonly datetimeFields: number
    readonly categoryExclusions: number
    readonly folders: number
  }
  readonly activity: {
    readonly minEntryId: number | null
    readonly maxEntryId: number | null
    readonly minDateAdded: string | null
    readonly maxDateAdded: string | null
    readonly topRootPrefixes: ReadonlyArray<{ readonly prefix: string; readonly count: number }>
  }
  readonly classification:
    | 'PRIMARY_CANDIDATE'
    | 'DUPLICATE_OF_PRIMARY'
    | 'OLDER_OR_SMALLER_SNAPSHOT'
    | 'EMPTY_OR_SEED_ONLY'
    | 'NOT_TAGSTUDIO_DB'
  readonly reason: string
}

export interface CandidateComparisonReport {
  readonly generatedAt: string
  readonly totalCandidates: number
  readonly uniqueSha256Count: number
  readonly recommendedPrimaryPath: string | null
  readonly duplicateGroups: ReadonlyArray<{
    readonly sha256: string
    readonly paths: readonly string[]
  }>
  readonly candidates: readonly CandidateSummary[]
}

export interface OrphanSummary {
  readonly tagEntriesMissingEntry: readonly { readonly tagId: number; readonly entryId: number }[]
  readonly tagEntriesMissingTag: readonly { readonly tagId: number; readonly entryId: number }[]
  readonly tagAliasesMissingTag: readonly { readonly id: number; readonly name: string; readonly tagId: number }[]
  readonly tagParentsMissingParent: readonly { readonly parentId: number; readonly childId: number }[]
  readonly tagParentsMissingChild: readonly { readonly parentId: number; readonly childId: number }[]
  readonly tagParentsSelfLoop: readonly { readonly tagId: number }[]
  readonly textFieldsMissingEntry: readonly { readonly id: number; readonly name: string; readonly entryId: number }[]
  readonly datetimeFieldsMissingEntry: readonly { readonly id: number; readonly name: string; readonly entryId: number }[]
  readonly tagsMissingDisambiguation: readonly { readonly id: number; readonly name: string; readonly disambiguationId: number }[]
}

export interface FieldSummaryItem {
  readonly name: string
  readonly totalRows: number
  readonly nonEmptyRows: number
  readonly catalogPatternMatches: number
  readonly isoDateMatches: number
}

export interface TagStudioInventoryReport {
  readonly generatedAt: string
  readonly sanitized: boolean
  readonly source: {
    readonly path: string
    readonly sha256Before: string
    readonly sha256After: string
    readonly unchanged: boolean
    readonly size: number
    readonly mtimeIso: string
    readonly hasWalFile: boolean
    readonly hasShmFile: boolean
    readonly dbVersion: DbVersionInfo
    readonly tables: readonly string[]
  }
  readonly counts: {
    readonly entries: number
    readonly tags: number
    readonly customTags: number
    readonly tagAliases: number
    readonly tagEntries: number
    readonly tagParents: number
    readonly textFields: number
    readonly datetimeFields: number
    readonly textFieldTemplates: number
    readonly datetimeFieldTemplates: number
    readonly namespaces: number
    readonly tagColors: number
    readonly categoryExclusions: number
    readonly folders: number
  }
  readonly orphans: OrphanSummary
  readonly fieldDistribution: {
    readonly textFields: readonly FieldSummaryItem[]
    readonly datetimeFields: readonly FieldSummaryItem[]
  }
  readonly catalogAndDateDiscovery: {
    readonly catalogSources: {
      readonly inTextFields: number
      readonly textFieldNamesWithCatalog: readonly string[]
      readonly inTagNamesOrAliases: number
      readonly inFilename: number
      readonly inDirectoryPath: number
      readonly entriesWithAnyCatalogCandidate: number
      readonly entriesWithoutCatalogCandidate: number
      readonly conflictingCatalogEntries: ReadonlyArray<{
        readonly entryId: number
        readonly fieldCatalog: string
        readonly pathCatalog: string
        readonly samplePath: string
      }>
      readonly multiFileCatalogs: ReadonlyArray<{
        readonly catalogNumber: string
        readonly entryCount: number
        readonly entryIds: readonly number[]
        readonly samplePaths: readonly string[]
      }>
    }
    readonly dateSources: {
      readonly inDatetimeFields: number
      readonly datetimeFieldNamesWithDate: readonly string[]
      readonly inTextFields: number
      readonly inFilenameOrPath: number
      readonly inEntryTimestampsOnly: number
      readonly entriesWithoutSemanticDate: number
    }
  }
  readonly tagAndAliasAnomalies: {
    readonly duplicateTagNamesCaseFolded: ReadonlyArray<{
      readonly normalizedName: string
      readonly tags: ReadonlyArray<{ readonly id: number; readonly name: string; readonly shorthand: string | null }>
    }>
    readonly sharedAliases: ReadonlyArray<{
      readonly normalizedAlias: string
      readonly entries: ReadonlyArray<{
        readonly aliasId: number
        readonly alias: string
        readonly tagId: number
        readonly tagName: string
      }>
    }>
    readonly aliasTagNameCollisions: ReadonlyArray<{
      readonly normalizedKey: string
      readonly aliasId: number
      readonly alias: string
      readonly aliasTagId: number
      readonly collidingTagId: number
      readonly collidingTagName: string
    }>
  }
  readonly pathMapping: {
    readonly rootId: string
    readonly totalEntries: number
    readonly validRelativePaths: number
    readonly unmappedOrInvalidPaths: ReadonlyArray<{
      readonly entryId: number
      readonly rawPath: string
      readonly reason: string
    }>
    readonly duplicateNormalizedPaths: ReadonlyArray<{
      readonly normalizedRelativePath: string
      readonly entryIds: readonly number[]
      readonly rawPaths: readonly string[]
    }>
    readonly topDirectoryPrefixes: ReadonlyArray<{
      readonly prefix: string
      readonly count: number
    }>
    readonly sampleMappings: ReadonlyArray<{
      readonly entryId: number
      readonly sourcePath: string
      readonly rootId: string
      readonly relativeWin32Path: string
      readonly filename: string
      readonly extension: string
    }>
    readonly diskCheck: {
      readonly checked: boolean
      readonly mediaRootDir: string | null
      readonly existingFiles: number
      readonly missingFiles: number
      readonly missingSample: ReadonlyArray<{ readonly entryId: number; readonly relativePath: string }>
    }
  }
  readonly unresolvedDecisions: ReadonlyArray<{
    readonly id: string
    readonly topic: string
    readonly observedFact: string
    readonly proposedRule: string
    readonly boundaryNotCovered: string
  }>
}

/**
 * Compute SHA-256, size, mtime, and companion WAL/SHM presence for a database file.
 */
export function snapshotFileFingerprint(filePath: string): FileFingerprint {
  const resolved = path.resolve(filePath)
  const stat = statSync(resolved)
  if (!stat.isFile()) {
    throw new Error(`Expected regular file at ${resolved}`)
  }
  const buffer = readFileSync(resolved)
  const sha256 = createHash('sha256').update(buffer).digest('hex')
  return {
    path: resolved,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mtimeIso: stat.mtime.toISOString(),
    sha256,
    hasWalFile: existsSync(`${resolved}-wal`),
    hasShmFile: existsSync(`${resolved}-shm`),
  }
}

/**
 * Execute a callback against a strictly read-only SQLite connection and assert
 * byte-for-byte + metadata immutability before and after.
 */
export function withReadOnlySqlite<T>(
  filePath: string,
  fn: (db: DatabaseSync, before: FileFingerprint) => T,
): { readonly result: T; readonly before: FileFingerprint; readonly after: FileFingerprint } {
  const before = snapshotFileFingerprint(filePath)
  const db = new DatabaseSync(before.path, { readOnly: true })
  let result: T
  try {
    result = fn(db, before)
  } finally {
    db.close()
  }
  const after = snapshotFileFingerprint(filePath)
  if (
    before.sha256 !== after.sha256 ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(
      `Read-only invariant violated for ${before.path}: before(${before.sha256}, ${before.size}, ${before.mtimeMs}) !== after(${after.sha256}, ${after.size}, ${after.mtimeMs})`,
    )
  }
  return { result, before, after }
}

/**
 * Normalize tag or alias string for case-folded uniqueness/lookup comparison.
 */
export function normalizeLookupKey(value: string): string {
  return normalizeTagName(value)
}

/**
 * Extract and normalize a catalog number candidate:
 * - Standard & MGS/Sirouto hyphenated codes: `ABC-123`, `300MAAN-341`, `T28-513`, `T-28634`, `MBR-AA024`
 * - FC2 codes with or without PPV: `FC2-PPV-1234567`, `FC2-1476760` -> `FC2-PPV-<digits>`
 * - Date-indexed uncensored codes: `061315_01-10mu`, `052615_086-1pon`, `052215_221-caribpr`
 * Returns null if no recognizable catalog number pattern is present.
 */
const FC2_REGEX = /(?<![A-Za-z0-9])FC2[\s-_]*(?:PPV[\s-_]*)?(\d{5,8})(?![A-Za-z0-9])/i
export const UNCENSORED_STUDIO_REGEX =
  /(?<![A-Za-z0-9])(\d{6}[_-]\d{2,4})[-_](1pon(?:do)?|10mu(?:sume)?|carib(?:pr)?|pacopacomama)(?![A-Za-z0-9])/i
const NORMALIZED_UNCENSORED_STUDIO_REGEX =
  /(?<![A-Za-z0-9])(1pon(?:do)?|10mu(?:sume)?|carib(?:pr)?|pacopacomama)[-_](\d{6}[_-]\d{2,4})(?![A-Za-z0-9])/i
const STANDARD_CATALOG_REGEX =
  /(?<![A-Za-z0-9])(\d{0,3}[A-Za-z]{1,6}\d{0,2})[-_]([A-Za-z]{0,2}\d{2,6})([A-Za-z])?(?![A-Za-z0-9])/gi

export const UNCENSORED_STUDIO_PREFIXES: ReadonlySet<string> = new Set([
  '1PON',
  '1PONDO',
  '10MU',
  '10MUSUME',
  'CARIB',
  'CARIBPR',
  'PACOPACOMAMA',
])

export const IGNORED_CATALOG_PREFIXES: ReadonlySet<string> = new Set([
  'UTF',
  'ISO',
  'SHA',
  'WIN',
  'PART',
  'CD',
  'DISC',
  'DISK',
  'FPS',
  'AAC',
  'MP',
  'WMV',
  'AVI',
  'MKV',
  'VIDEO',
  'AUDIO',
  'SAMPLE',
  'H264',
  'H265',
  'X264',
  'X265',
  'HEVC',
  'AVC',
  '1080P',
  '720P',
  '480P',
  '2160P',
  'FHD',
  'UHD',
  'MP3',
  'MP4',
  'MOV',
  'FLV',
  'WEBM',
  'M4V',
  'MPG',
  'MPEG',
  'FC2',
  'PPV',
])

export function extractCatalogNumber(text: string | null | undefined): string | null {
  if (!text) return null

  const fc2Match = FC2_REGEX.exec(text)
  if (fc2Match) {
    return `FC2-PPV-${fc2Match[1]}`
  }

  const uncensoredMatch = UNCENSORED_STUDIO_REGEX.exec(text)
  if (uncensoredMatch) {
    const code = uncensoredMatch[1]!.replace(/-/g, '_')
    const studio = uncensoredMatch[2]!.toUpperCase()
    return `${studio}-${code}`
  }

  const normalizedUncensoredMatch = NORMALIZED_UNCENSORED_STUDIO_REGEX.exec(text)
  if (normalizedUncensoredMatch) {
    const studio = normalizedUncensoredMatch[1]!.toUpperCase()
    const code = normalizedUncensoredMatch[2]!.replace(/-/g, '_')
    return `${studio}-${code}`
  }

  for (const stdMatch of text.matchAll(STANDARD_CATALOG_REGEX)) {
    const prefix = stdMatch[1]!.toUpperCase()
    const numberPart = stdMatch[2]!.toUpperCase()
    const suffix = (stdMatch[3] ?? '').toUpperCase()

    // Must contain at least one letter in prefix, and not be an ignored technical token or uncensored studio prefix.
    if (
      !/[A-Z]/.test(prefix) ||
      IGNORED_CATALOG_PREFIXES.has(prefix) ||
      UNCENSORED_STUDIO_PREFIXES.has(prefix)
    ) {
      continue
    }
    // Single-letter prefixes (e.g. T-28634, C-2058) require at least 4 digits to avoid matching e.g. 'v-10'
    if (prefix.length === 1 && numberPart.length < 4) {
      continue
    }
    return `${prefix}-${numberPart}${suffix}`
  }

  return null
}

/**
 * Extract an ISO date (`YYYY-MM-DD`) from a field or path string.
 */
const ISO_DATE_REGEX = /(?<!\d)((?:19|20)\d{2})[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])(?!\d)/
const COMPACT_DATE_REGEX = /(?<!\d)((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/

export function extractIsoDate(text: string | null | undefined): string | null {
  if (!text) return null
  const dashed = ISO_DATE_REGEX.exec(text)
  if (dashed) {
    return `${dashed[1]}-${dashed[2]}-${dashed[3]}`
  }
  const compact = COMPACT_DATE_REGEX.exec(text)
  if (compact) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`
  }
  return null
}

/**
 * Validate and normalize a TagStudio entry path into a safe Windows relative path (`relative_path` under `root_id`).
 */
export function normalizeRelativeMediaPath(rawPath: string): {
  readonly ok: boolean
  readonly relativeWin32Path: string
  readonly topPrefix: string
  readonly reason?: string
} {
  if (!rawPath || rawPath.trim().length === 0) {
    return { ok: false, relativeWin32Path: '', topPrefix: '(empty)', reason: 'EMPTY_PATH' }
  }
  if (rawPath.includes('\0')) {
    return { ok: false, relativeWin32Path: '', topPrefix: '(invalid)', reason: 'NUL_BYTE' }
  }
  const trimmed = rawPath.trim()
  if (/^[a-zA-Z]:/.test(trimmed)) {
    return { ok: false, relativeWin32Path: '', topPrefix: '(drive-letter)', reason: 'DRIVE_LETTER_PATH' }
  }
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//') || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    return { ok: false, relativeWin32Path: '', topPrefix: '(absolute)', reason: 'ABSOLUTE_OR_UNC_PATH' }
  }

  const slashUnified = trimmed.replace(/\//g, '\\')
  const rawSegments = slashUnified.split('\\').filter(seg => seg.length > 0 && seg !== '.')
  if (rawSegments.length === 0) {
    return { ok: false, relativeWin32Path: '', topPrefix: '(root)', reason: 'EMPTY_SEGMENTS' }
  }
  if (rawSegments.some(seg => seg === '..')) {
    return { ok: false, relativeWin32Path: '', topPrefix: '(traversal)', reason: 'PARENT_TRAVERSAL_SEGMENT' }
  }

  const normalized = path.win32.normalize(rawSegments.join('\\'))
  if (normalized === '.' || normalized.startsWith('..\\') || normalized === '..' || path.win32.isAbsolute(normalized)) {
    return { ok: false, relativeWin32Path: '', topPrefix: '(traversal)', reason: 'NORMALIZED_OUT_OF_ROOT' }
  }

  const segments = normalized.split('\\')
  const topPrefix = segments.length > 1 ? segments[0]! : '(root-files)'
  return {
    ok: true,
    relativeWin32Path: normalized,
    topPrefix,
  }
}

function sanitizeDisplayPath(raw: string, sanitize: boolean): string {
  if (!sanitize) return raw
  const normalized = raw.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts
    .map((part, idx) => {
      if (idx === parts.length - 1) {
        const ext = path.posix.extname(part)
        const digest = createHash('sha256').update(part).digest('hex').slice(0, 6)
        return `file_${digest}${ext}`
      }
      const digest = createHash('sha256').update(part).digest('hex').slice(0, 6)
      return `dir_${digest}`
    })
    .join('\\')
}

function listSqliteTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
    .all() as Array<{ name: string }>
  return rows.map(r => String(r.name))
}

function readDbVersion(db: DatabaseSync, tables: readonly string[]): DbVersionInfo {
  const tableSet = new Set(tables)
  if (tableSet.has('versions')) {
    const rows = db.prepare('SELECT key, value FROM versions').all() as Array<{ key: string; value: number }>
    const map = new Map(rows.map(r => [String(r.key), Number(r.value)]))
    return {
      current: map.get('CURRENT') ?? null,
      initial: map.get('INITIAL') ?? null,
      source: 'versions',
    }
  }
  if (tableSet.has('preferences')) {
    const row = db
      .prepare("SELECT value FROM preferences WHERE key = 'DB_VERSION'")
      .get() as { value: number | string } | undefined
    const val = row !== undefined ? Number(row.value) : null
    return {
      current: Number.isFinite(val) ? val : null,
      initial: Number.isFinite(val) ? val : null,
      source: 'preferences',
    }
  }
  return { current: null, initial: null, source: 'none' }
}

function safeCount(db: DatabaseSync, tableSet: ReadonlySet<string>, tableName: string): number {
  if (!tableSet.has(tableName)) return 0
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM "${tableName}"`).get() as { cnt: number }
  return Number(row.cnt)
}

function getTableColumns(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>
  return new Set(rows.map(r => String(r.name)))
}

/**
 * Recursively expand candidate file or directory paths into `.sqlite` / `.db` files.
 */
export function expandCandidatePaths(inputs: readonly string[]): string[] {
  const found = new Set<string>()
  const visit = (target: string): void => {
    const resolved = path.resolve(target)
    if (!existsSync(resolved)) {
      throw new Error(`Candidate path does not exist: ${resolved}`)
    }
    const st = statSync(resolved)
    if (st.isFile()) {
      found.add(resolved)
      return
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(resolved, { withFileTypes: true })) {
        const child = path.join(resolved, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue
          visit(child)
        } else if (
          entry.isFile() &&
          (entry.name.endsWith('.sqlite') ||
            entry.name.endsWith('.sqlite3') ||
            entry.name.endsWith('.db'))
        ) {
          found.add(path.resolve(child))
        }
      }
    }
  }
  for (const input of inputs) {
    visit(input)
  }
  return [...found].sort()
}

/**
 * Compare multiple candidate `ts_library.sqlite` files in read-only mode to identify
 * byte-identical copies, empty/seed-only libraries, older snapshots, and the primary candidate.
 */
export function compareTagStudioCandidates(
  candidateInputs: readonly string[],
  options?: { readonly sanitize?: boolean },
): CandidateComparisonReport {
  const sanitize = options?.sanitize ?? false
  const filePaths = expandCandidatePaths(candidateInputs)
  if (filePaths.length === 0) {
    throw new Error('No candidate .sqlite files found in the provided paths')
  }

  interface RawCandidate {
    path: string
    fingerprint: FileFingerprint
    isTagStudioDb: boolean
    dbVersion: DbVersionInfo
    tables: string[]
    counts: CandidateSummary['counts']
    activity: CandidateSummary['activity']
    score: number
  }

  const rawList: RawCandidate[] = filePaths.map(filePath => {
    const { result } = withReadOnlySqlite(filePath, (db, fingerprint) => {
      const tables = listSqliteTables(db)
      const tableSet = new Set(tables)
      const isTagStudioDb = tableSet.has('entries') && tableSet.has('tags') && tableSet.has('tag_entries')
      const dbVersion = readDbVersion(db, tables)
      const entries = safeCount(db, tableSet, 'entries')
      const tags = safeCount(db, tableSet, 'tags')
      const customTags = tableSet.has('tags')
        ? Number(
            (
              db.prepare('SELECT COUNT(*) AS cnt FROM tags WHERE id >= 1000 OR id NOT IN (0, 1)').get() as {
                cnt: number
              }
            ).cnt,
          )
        : 0
      const tagAliases = safeCount(db, tableSet, 'tag_aliases')
      const tagEntries = safeCount(db, tableSet, 'tag_entries')
      const tagParents = safeCount(db, tableSet, 'tag_parents')
      const textFields = safeCount(db, tableSet, 'text_fields')
      const datetimeFields = safeCount(db, tableSet, 'datetime_fields')
      const categoryExclusions = safeCount(db, tableSet, 'category_exclusions')
      const folders = safeCount(db, tableSet, 'folders')

      let minEntryId: number | null = null
      let maxEntryId: number | null = null
      let minDateAdded: string | null = null
      let maxDateAdded: string | null = null
      const prefixCounts = new Map<string, number>()

      if (isTagStudioDb && entries > 0) {
        const entryCols = getTableColumns(db, 'entries')
        const dateAddedExpr = entryCols.has('date_added') ? 'MIN(date_added) AS min_da, MAX(date_added) AS max_da' : 'NULL AS min_da, NULL AS max_da'
        const agg = db
          .prepare(`SELECT MIN(id) AS min_id, MAX(id) AS max_id, ${dateAddedExpr} FROM entries`)
          .get() as { min_id: number | null; max_id: number | null; min_da: string | null; max_da: string | null }
        minEntryId = agg.min_id !== null ? Number(agg.min_id) : null
        maxEntryId = agg.max_id !== null ? Number(agg.max_id) : null
        minDateAdded = agg.min_da !== null ? String(agg.min_da) : null
        maxDateAdded = agg.max_da !== null ? String(agg.max_da) : null

        const pathRows = db.prepare('SELECT path FROM entries').all() as Array<{ path: string }>
        for (const r of pathRows) {
          const norm = normalizeRelativeMediaPath(String(r.path ?? ''))
          const key = sanitize ? sanitizeDisplayPath(norm.topPrefix, true) : norm.topPrefix
          prefixCounts.set(key, (prefixCounts.get(key) ?? 0) + 1)
        }
      }

      const topRootPrefixes = [...prefixCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([prefix, count]) => ({ prefix, count }))

      const score =
        !isTagStudioDb
          ? -1
          : entries * 1_000_000 +
            tagEntries * 10_000 +
            customTags * 100 +
            (textFields + datetimeFields) * 10 +
            (dbVersion.current ?? 0)

      return {
        path: fingerprint.path,
        fingerprint,
        isTagStudioDb,
        dbVersion,
        tables,
        counts: {
          entries,
          tags,
          customTags,
          tagAliases,
          tagEntries,
          tagParents,
          textFields,
          datetimeFields,
          categoryExclusions,
          folders,
        },
        activity: {
          minEntryId,
          maxEntryId,
          minDateAdded,
          maxDateAdded,
          topRootPrefixes,
        },
        score,
      }
    })
    return result
  })

  // Group by SHA-256
  const shaGroups = new Map<string, string[]>()
  for (const c of rawList) {
    const list = shaGroups.get(c.fingerprint.sha256) ?? []
    list.push(c.path)
    shaGroups.set(c.fingerprint.sha256, list)
  }

  // Pick highest score among valid TagStudio DBs with entries > 0 (or customTags > 0)
  const sortedByScore = [...rawList].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Prefer non-backup paths when byte-identical
    const aIsBackup = /backup/i.test(a.path) ? 1 : 0
    const bIsBackup = /backup/i.test(b.path) ? 1 : 0
    if (aIsBackup !== bIsBackup) return aIsBackup - bIsBackup
    return a.path.localeCompare(b.path)
  })

  const best = sortedByScore.find(c => c.isTagStudioDb && (c.counts.entries > 0 || c.counts.customTags > 0)) ?? null
  const recommendedPrimaryPath = best ? best.path : null

  const candidates: CandidateSummary[] = sortedByScore.map(c => {
    if (!c.isTagStudioDb) {
      return {
        ...c,
        classification: 'NOT_TAGSTUDIO_DB',
        reason: 'Missing core TagStudio tables (entries, tags, tag_entries).',
      }
    }
    if (c.counts.entries === 0 && c.counts.customTags === 0) {
      return {
        ...c,
        classification: 'EMPTY_OR_SEED_ONLY',
        reason: 'Contains 0 entries and 0 custom tags (likely an empty initialized .TagStudio database).',
      }
    }
    if (best && c.path === best.path) {
      return {
        ...c,
        classification: 'PRIMARY_CANDIDATE',
        reason: `Highest content richness (${c.counts.entries} entries, ${c.counts.tagEntries} tag associations, ${c.counts.customTags} custom tags, DB v${c.dbVersion.current ?? '?'}).`,
      }
    }
    if (best && c.fingerprint.sha256 === best.fingerprint.sha256) {
      return {
        ...c,
        classification: 'DUPLICATE_OF_PRIMARY',
        reason: `Byte-for-byte identical (SHA-256 ${c.fingerprint.sha256.slice(0, 12)}...) to primary candidate ${best.path}.`,
      }
    }
    return {
      ...c,
      classification: 'OLDER_OR_SMALLER_SNAPSHOT',
      reason: `Smaller or older dataset (${c.counts.entries} entries, ${c.counts.tagEntries} tag associations, DB v${c.dbVersion.current ?? '?'}) compared to primary candidate.`,
    }
  })

  const duplicateGroups = [...shaGroups.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([sha256, paths]) => ({ sha256, paths }))

  return {
    generatedAt: new Date().toISOString(),
    totalCandidates: candidates.length,
    uniqueSha256Count: shaGroups.size,
    recommendedPrimaryPath,
    duplicateGroups,
    candidates,
  }
}

/**
 * Perform a complete read-only inventory on a TagStudio SQLite copy.
 */
export function inventoryTagStudioDatabase(
  dbPath: string,
  options?: {
    readonly rootId?: string
    readonly mediaRootDir?: string
    readonly sanitize?: boolean
    readonly sampleLimit?: number
  },
): TagStudioInventoryReport {
  const rootId = options?.rootId ?? 'nas-main'
  const mediaRootDir = options?.mediaRootDir ? path.resolve(options.mediaRootDir) : null
  const sanitize = options?.sanitize ?? false
  const sampleLimit = options?.sampleLimit ?? 10

  const { result, before, after } = withReadOnlySqlite(dbPath, (db, beforeFp) => {
    const tables = listSqliteTables(db)
    const tableSet = new Set(tables)
    if (!tableSet.has('entries') || !tableSet.has('tags') || !tableSet.has('tag_entries')) {
      throw new Error(`Database at ${beforeFp.path} is missing required TagStudio tables (entries, tags, tag_entries)`)
    }

    const dbVersion = readDbVersion(db, tables)
    const counts = {
      entries: safeCount(db, tableSet, 'entries'),
      tags: safeCount(db, tableSet, 'tags'),
      customTags: Number(
        (
          db.prepare('SELECT COUNT(*) AS cnt FROM tags WHERE id >= 1000 OR id NOT IN (0, 1)').get() as {
            cnt: number
          }
        ).cnt,
      ),
      tagAliases: safeCount(db, tableSet, 'tag_aliases'),
      tagEntries: safeCount(db, tableSet, 'tag_entries'),
      tagParents: safeCount(db, tableSet, 'tag_parents'),
      textFields: safeCount(db, tableSet, 'text_fields'),
      datetimeFields: safeCount(db, tableSet, 'datetime_fields'),
      textFieldTemplates: safeCount(db, tableSet, 'text_field_templates'),
      datetimeFieldTemplates: safeCount(db, tableSet, 'datetime_field_templates'),
      namespaces: safeCount(db, tableSet, 'namespaces'),
      tagColors: safeCount(db, tableSet, 'tag_colors'),
      categoryExclusions: safeCount(db, tableSet, 'category_exclusions'),
      folders: safeCount(db, tableSet, 'folders'),
    }

    // 1. Orphan detection
    const tagEntriesMissingEntry = (
      db
        .prepare(
          'SELECT te.tag_id AS tagId, te.entry_id AS entryId FROM tag_entries te LEFT JOIN entries e ON e.id = te.entry_id WHERE e.id IS NULL',
        )
        .all() as Array<{ tagId: number; entryId: number }>
    ).map(r => ({ tagId: Number(r.tagId), entryId: Number(r.entryId) }))

    const tagEntriesMissingTag = (
      db
        .prepare(
          'SELECT te.tag_id AS tagId, te.entry_id AS entryId FROM tag_entries te LEFT JOIN tags t ON t.id = te.tag_id WHERE t.id IS NULL',
        )
        .all() as Array<{ tagId: number; entryId: number }>
    ).map(r => ({ tagId: Number(r.tagId), entryId: Number(r.entryId) }))

    const tagAliasesMissingTag = tableSet.has('tag_aliases')
      ? (
          db
            .prepare(
              'SELECT ta.id AS id, ta.name AS name, ta.tag_id AS tagId FROM tag_aliases ta LEFT JOIN tags t ON t.id = ta.tag_id WHERE t.id IS NULL',
            )
            .all() as Array<{ id: number; name: string; tagId: number }>
        ).map(r => ({ id: Number(r.id), name: String(r.name), tagId: Number(r.tagId) }))
      : []

    const tagParentsMissingParent = tableSet.has('tag_parents')
      ? (
          db
            .prepare(
              'SELECT tp.parent_id AS parentId, tp.child_id AS childId FROM tag_parents tp LEFT JOIN tags t ON t.id = tp.parent_id WHERE t.id IS NULL',
            )
            .all() as Array<{ parentId: number; childId: number }>
        ).map(r => ({ parentId: Number(r.parentId), childId: Number(r.childId) }))
      : []

    const tagParentsMissingChild = tableSet.has('tag_parents')
      ? (
          db
            .prepare(
              'SELECT tp.parent_id AS parentId, tp.child_id AS childId FROM tag_parents tp LEFT JOIN tags t ON t.id = tp.child_id WHERE t.id IS NULL',
            )
            .all() as Array<{ parentId: number; childId: number }>
        ).map(r => ({ parentId: Number(r.parentId), childId: Number(r.childId) }))
      : []

    const tagParentsSelfLoop = tableSet.has('tag_parents')
      ? (
          db
            .prepare('SELECT parent_id AS tagId FROM tag_parents WHERE parent_id = child_id')
            .all() as Array<{ tagId: number }>
        ).map(r => ({ tagId: Number(r.tagId) }))
      : []

    const textFieldCols = tableSet.has('text_fields') ? getTableColumns(db, 'text_fields') : new Set<string>()
    const textFieldNameCol = textFieldCols.has('name') ? 'name' : textFieldCols.has('type_key') ? 'type_key' : null

    const textFieldsMissingEntry =
      tableSet.has('text_fields') && textFieldNameCol
        ? (
            db
              .prepare(
                `SELECT tf.id AS id, tf.${textFieldNameCol} AS name, tf.entry_id AS entryId FROM text_fields tf LEFT JOIN entries e ON e.id = tf.entry_id WHERE e.id IS NULL`,
              )
              .all() as Array<{ id: number; name: string; entryId: number }>
          ).map(r => ({ id: Number(r.id), name: String(r.name), entryId: Number(r.entryId) }))
        : []

    const dtFieldCols = tableSet.has('datetime_fields') ? getTableColumns(db, 'datetime_fields') : new Set<string>()
    const dtFieldNameCol = dtFieldCols.has('name') ? 'name' : dtFieldCols.has('type_key') ? 'type_key' : null

    const datetimeFieldsMissingEntry =
      tableSet.has('datetime_fields') && dtFieldNameCol
        ? (
            db
              .prepare(
                `SELECT df.id AS id, df.${dtFieldNameCol} AS name, df.entry_id AS entryId FROM datetime_fields df LEFT JOIN entries e ON e.id = df.entry_id WHERE e.id IS NULL`,
              )
              .all() as Array<{ id: number; name: string; entryId: number }>
          ).map(r => ({ id: Number(r.id), name: String(r.name), entryId: Number(r.entryId) }))
        : []

    const tagCols = getTableColumns(db, 'tags')
    const tagsMissingDisambiguation = tagCols.has('disambiguation_id')
      ? (
          db
            .prepare(
              'SELECT t.id AS id, t.name AS name, t.disambiguation_id AS disambiguationId FROM tags t LEFT JOIN tags d ON d.id = t.disambiguation_id WHERE t.disambiguation_id IS NOT NULL AND d.id IS NULL',
            )
            .all() as Array<{ id: number; name: string; disambiguationId: number }>
        ).map(r => ({
          id: Number(r.id),
          name: String(r.name),
          disambiguationId: Number(r.disambiguationId),
        }))
      : []

    // 2. Load tags and aliases for anomaly & catalog analysis
    const allTags = db
      .prepare(
        `SELECT id, name, ${tagCols.has('shorthand') ? 'shorthand' : 'NULL AS shorthand'} FROM tags ORDER BY id ASC`,
      )
      .all() as Array<{ id: number; name: string; shorthand: string | null }>

    const tagMap = new Map<number, { id: number; name: string; shorthand: string | null }>()
    const normalizedTagGroups = new Map<
      string,
      Array<{ id: number; name: string; shorthand: string | null }>
    >()
    for (const t of allTags) {
      const item = {
        id: Number(t.id),
        name: String(t.name),
        shorthand: t.shorthand !== null ? String(t.shorthand) : null,
      }
      tagMap.set(item.id, item)
      const norm = normalizeLookupKey(item.name)
      const group = normalizedTagGroups.get(norm) ?? []
      group.push(item)
      normalizedTagGroups.set(norm, group)
    }

    const duplicateTagNamesCaseFolded = [...normalizedTagGroups.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([normalizedName, list]) => ({ normalizedName, tags: list }))

    const allAliases = tableSet.has('tag_aliases')
      ? (db
          .prepare('SELECT id, name, tag_id AS tagId FROM tag_aliases ORDER BY id ASC')
          .all() as Array<{ id: number; name: string; tagId: number }>)
      : []

    const aliasByNorm = new Map<
      string,
      Array<{ aliasId: number; alias: string; tagId: number; tagName: string }>
    >()
    const aliasTagNameCollisions: Array<{
      normalizedKey: string
      aliasId: number
      alias: string
      aliasTagId: number
      collidingTagId: number
      collidingTagName: string
    }> = []

    const tagAliasesMap = new Map<number, string[]>()
    for (const a of allAliases) {
      const aliasId = Number(a.id)
      const alias = String(a.name)
      const tagId = Number(a.tagId)
      const tagName = tagMap.get(tagId)?.name ?? '(missing-tag)'
      const norm = normalizeLookupKey(alias)
      if (!norm) continue

      const list = aliasByNorm.get(norm) ?? []
      list.push({ aliasId, alias, tagId, tagName })
      aliasByNorm.set(norm, list)

      const tagAliasList = tagAliasesMap.get(tagId) ?? []
      tagAliasList.push(alias)
      tagAliasesMap.set(tagId, tagAliasList)

      const collidingTags = normalizedTagGroups.get(norm) ?? []
      for (const ct of collidingTags) {
        if (ct.id !== tagId) {
          aliasTagNameCollisions.push({
            normalizedKey: norm,
            aliasId,
            alias,
            aliasTagId: tagId,
            collidingTagId: ct.id,
            collidingTagName: ct.name,
          })
        }
      }
    }

    const sharedAliases = [...aliasByNorm.entries()]
      .filter(([, list]) => new Set(list.map(x => x.tagId)).size > 1)
      .map(([normalizedAlias, entries]) => ({ normalizedAlias, entries }))

    // 3. Field distribution & entry-level catalog/date discovery
    const textFieldStats = new Map<
      string,
      { totalRows: number; nonEmptyRows: number; catalogPatternMatches: number; isoDateMatches: number }
    >()
    const entryTextCatalogs = new Map<number, string[]>()
    const entryTextDates = new Map<number, string[]>()

    if (tableSet.has('text_fields') && textFieldNameCol) {
      const rows = db
        .prepare(`SELECT entry_id AS entryId, ${textFieldNameCol} AS name, value FROM text_fields`)
        .all() as Array<{ entryId: number; name: string; value: string | null }>
      for (const r of rows) {
        const name = String(r.name ?? '')
        const val = r.value !== null && r.value !== undefined ? String(r.value).trim() : ''
        const stat = textFieldStats.get(name) ?? {
          totalRows: 0,
          nonEmptyRows: 0,
          catalogPatternMatches: 0,
          isoDateMatches: 0,
        }
        stat.totalRows += 1
        if (val.length > 0) {
          stat.nonEmptyRows += 1
          const cat = extractCatalogNumber(val)
          if (cat) {
            stat.catalogPatternMatches += 1
            const list = entryTextCatalogs.get(Number(r.entryId)) ?? []
            list.push(cat)
            entryTextCatalogs.set(Number(r.entryId), list)
          }
          const dt = extractIsoDate(val)
          if (dt) {
            stat.isoDateMatches += 1
            const list = entryTextDates.get(Number(r.entryId)) ?? []
            list.push(dt)
            entryTextDates.set(Number(r.entryId), list)
          }
        }
        textFieldStats.set(name, stat)
      }
    }

    const dtFieldStats = new Map<
      string,
      { totalRows: number; nonEmptyRows: number; catalogPatternMatches: number; isoDateMatches: number }
    >()
    const entryDatetimeDates = new Map<number, string[]>()

    if (tableSet.has('datetime_fields') && dtFieldNameCol) {
      const rows = db
        .prepare(`SELECT entry_id AS entryId, ${dtFieldNameCol} AS name, value FROM datetime_fields`)
        .all() as Array<{ entryId: number; name: string; value: string | null }>
      for (const r of rows) {
        const name = String(r.name ?? '')
        const val = r.value !== null && r.value !== undefined ? String(r.value).trim() : ''
        const stat = dtFieldStats.get(name) ?? {
          totalRows: 0,
          nonEmptyRows: 0,
          catalogPatternMatches: 0,
          isoDateMatches: 0,
        }
        stat.totalRows += 1
        if (val.length > 0) {
          stat.nonEmptyRows += 1
          const dt = extractIsoDate(val)
          if (dt) {
            stat.isoDateMatches += 1
            const list = entryDatetimeDates.get(Number(r.entryId)) ?? []
            list.push(dt)
            entryDatetimeDates.set(Number(r.entryId), list)
          }
        }
        dtFieldStats.set(name, stat)
      }
    }

    // Check which entries have catalog numbers on their attached tags
    const entryTagCatalogs = new Map<number, string[]>()
    const tagCatalogCache = new Map<number, string | null>()
    for (const [tid, t] of tagMap.entries()) {
      let cat = extractCatalogNumber(t.name) ?? extractCatalogNumber(t.shorthand)
      if (!cat) {
        for (const al of tagAliasesMap.get(tid) ?? []) {
          cat = extractCatalogNumber(al)
          if (cat) break
        }
      }
      tagCatalogCache.set(tid, cat)
    }

    const allTagEntries = db
      .prepare('SELECT entry_id AS entryId, tag_id AS tagId FROM tag_entries')
      .all() as Array<{ entryId: number; tagId: number }>
    for (const te of allTagEntries) {
      const cat = tagCatalogCache.get(Number(te.tagId))
      if (cat) {
        const list = entryTagCatalogs.get(Number(te.entryId)) ?? []
        list.push(cat)
        entryTagCatalogs.set(Number(te.entryId), list)
      }
    }

    // 4. Inspect all entries for path mapping, catalog numbers, dates, and disk check
    const entryCols = getTableColumns(db, 'entries')
    const hasFilenameCol = entryCols.has('filename')
    const hasSuffixCol = entryCols.has('suffix')
    const hasTimestamps =
      entryCols.has('date_created') || entryCols.has('date_modified') || entryCols.has('date_added')

    const entryRows = db
      .prepare(
        `SELECT id, path, ${hasFilenameCol ? 'filename' : "'' AS filename"}, ${
          hasSuffixCol ? 'suffix' : "'' AS suffix"
        }, ${entryCols.has('date_created') ? 'date_created' : 'NULL AS date_created'}, ${
          entryCols.has('date_modified') ? 'date_modified' : 'NULL AS date_modified'
        }, ${entryCols.has('date_added') ? 'date_added' : 'NULL AS date_added'} FROM entries ORDER BY id ASC`,
      )
      .all() as Array<{
      id: number
      path: string
      filename: string
      suffix: string
      date_created: string | null
      date_modified: string | null
      date_added: string | null
    }>

    let inTextFieldsCount = 0
    let inTagNamesOrAliasesCount = 0
    let inFilenameCount = 0
    let inDirectoryPathCount = 0
    let entriesWithAnyCatalogCandidate = 0
    let entriesWithoutCatalogCandidate = 0

    const conflictingCatalogEntries: Array<{
      entryId: number
      fieldCatalog: string
      pathCatalog: string
      samplePath: string
    }> = []

    const catalogToEntries = new Map<string, Array<{ entryId: number; path: string }>>()

    let dateInDatetimeFieldsCount = 0
    let dateInTextFieldsCount = 0
    let dateInFilenameOrPathCount = 0
    let dateInEntryTimestampsOnlyCount = 0
    let entriesWithoutSemanticDate = 0

    let validRelativePaths = 0
    const unmappedOrInvalidPaths: Array<{ entryId: number; rawPath: string; reason: string }> = []
    const normPathMap = new Map<string, Array<{ entryId: number; rawPath: string }>>()
    const prefixCounts = new Map<string, number>()
    const sampleMappings: Array<{
      entryId: number
      sourcePath: string
      rootId: string
      relativeWin32Path: string
      filename: string
      extension: string
    }> = []

    let existingFiles = 0
    let missingFiles = 0
    const missingSample: Array<{ entryId: number; relativePath: string }> = []

    for (const row of entryRows) {
      const entryId = Number(row.id)
      const rawPath = String(row.path ?? '')
      const normPath = normalizeRelativeMediaPath(rawPath)

      if (!normPath.ok) {
        unmappedOrInvalidPaths.push({
          entryId,
          rawPath: sanitizeDisplayPath(rawPath, sanitize),
          reason: normPath.reason ?? 'INVALID_PATH',
        })
      } else {
        validRelativePaths += 1
        const prefixKey = sanitize ? sanitizeDisplayPath(normPath.topPrefix, true) : normPath.topPrefix
        prefixCounts.set(prefixKey, (prefixCounts.get(prefixKey) ?? 0) + 1)

        const foldKey = normPath.relativeWin32Path.toLowerCase()
        const existingList = normPathMap.get(foldKey) ?? []
        existingList.push({ entryId, rawPath: sanitizeDisplayPath(rawPath, sanitize) })
        normPathMap.set(foldKey, existingList)

        const winBasename = path.win32.basename(normPath.relativeWin32Path)
        const winExt = path.win32.extname(winBasename).replace(/^\./, '').toLowerCase()

        if (sampleMappings.length < sampleLimit) {
          sampleMappings.push({
            entryId,
            sourcePath: sanitizeDisplayPath(rawPath, sanitize),
            rootId,
            relativeWin32Path: sanitizeDisplayPath(normPath.relativeWin32Path, sanitize),
            filename: sanitize ? sanitizeDisplayPath(winBasename, true) : winBasename,
            extension: winExt || String(row.suffix ?? '').toLowerCase(),
          })
        }

        if (mediaRootDir !== null) {
          const localRel = normPath.relativeWin32Path.split('\\').join(path.sep)
          const fullLocalPath = path.join(mediaRootDir, localRel)
          if (existsSync(fullLocalPath)) {
            existingFiles += 1
          } else {
            missingFiles += 1
            if (missingSample.length < sampleLimit) {
              missingSample.push({
                entryId,
                relativePath: sanitizeDisplayPath(normPath.relativeWin32Path, sanitize),
              })
            }
          }
        }
      }

      // Catalog extraction per source
      const slashPath = rawPath.replace(/\\/g, '/')
      const lastSlash = slashPath.lastIndexOf('/')
      const derivedFilename =
        row.filename && String(row.filename).trim().length > 0
          ? String(row.filename)
          : lastSlash >= 0
            ? slashPath.slice(lastSlash + 1)
            : slashPath
      const dirPart = lastSlash >= 0 ? slashPath.slice(0, lastSlash) : ''

      const fieldCats = entryTextCatalogs.get(entryId) ?? []
      const tagCats = entryTagCatalogs.get(entryId) ?? []
      const fileCat = extractCatalogNumber(derivedFilename)
      const dirCat = extractCatalogNumber(dirPart)

      if (fieldCats.length > 0) inTextFieldsCount += 1
      if (tagCats.length > 0) inTagNamesOrAliasesCount += 1
      if (fileCat !== null) inFilenameCount += 1
      if (dirCat !== null) inDirectoryPathCount += 1

      const primaryFieldCat = fieldCats[0] ?? null
      const primaryPathCat = fileCat ?? dirCat ?? null
      if (primaryFieldCat && primaryPathCat && primaryFieldCat !== primaryPathCat) {
        conflictingCatalogEntries.push({
          entryId,
          fieldCatalog: primaryFieldCat,
          pathCatalog: primaryPathCat,
          samplePath: sanitizeDisplayPath(rawPath, sanitize),
        })
      }

      const resolvedCatalog = primaryFieldCat ?? tagCats[0] ?? fileCat ?? dirCat ?? null
      if (resolvedCatalog !== null) {
        entriesWithAnyCatalogCandidate += 1
        const list = catalogToEntries.get(resolvedCatalog) ?? []
        list.push({ entryId, path: sanitizeDisplayPath(rawPath, sanitize) })
        catalogToEntries.set(resolvedCatalog, list)
      } else {
        entriesWithoutCatalogCandidate += 1
      }

      // Date extraction per source
      const dtDates = entryDatetimeDates.get(entryId) ?? []
      const tfDates = entryTextDates.get(entryId) ?? []
      const pathDate = extractIsoDate(derivedFilename) ?? extractIsoDate(dirPart)
      const hasEntryTs =
        hasTimestamps &&
        Boolean(row.date_created || row.date_modified || row.date_added)

      if (dtDates.length > 0) dateInDatetimeFieldsCount += 1
      if (tfDates.length > 0) dateInTextFieldsCount += 1
      if (pathDate !== null) dateInFilenameOrPathCount += 1

      if (dtDates.length === 0 && tfDates.length === 0 && pathDate === null) {
        entriesWithoutSemanticDate += 1
        if (hasEntryTs) {
          dateInEntryTimestampsOnlyCount += 1
        }
      }
    }

    const multiFileCatalogs = [...catalogToEntries.entries()]
      .filter(([, list]) => list.length > 1)
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([catalogNumber, list]) => ({
        catalogNumber,
        entryCount: list.length,
        entryIds: list.map(x => x.entryId),
        samplePaths: list.slice(0, sampleLimit).map(x => x.path),
      }))

    const duplicateNormalizedPaths = [...normPathMap.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([normalizedRelativePath, list]) => ({
        normalizedRelativePath: sanitizeDisplayPath(normalizedRelativePath, sanitize),
        entryIds: list.map(x => x.entryId),
        rawPaths: list.map(x => x.rawPath),
      }))

    const topDirectoryPrefixes = [...prefixCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([prefix, count]) => ({ prefix, count }))

    const textFieldDistribution: FieldSummaryItem[] = [...textFieldStats.entries()]
      .sort((a, b) => b[1].totalRows - a[1].totalRows || a[0].localeCompare(b[0]))
      .map(([name, st]) => ({ name, ...st }))

    const datetimeFieldDistribution: FieldSummaryItem[] = [...dtFieldStats.entries()]
      .sort((a, b) => b[1].totalRows - a[1].totalRows || a[0].localeCompare(b[0]))
      .map(([name, st]) => ({ name, ...st }))

    const textFieldNamesWithCatalog = textFieldDistribution
      .filter(f => f.catalogPatternMatches > 0)
      .map(f => f.name)

    const datetimeFieldNamesWithDate = datetimeFieldDistribution
      .filter(f => f.isoDateMatches > 0)
      .map(f => f.name)

    const unresolvedDecisions = [
      {
        id: 'D2.1',
        topic: 'Catalog Number Extraction Precedence & Multi-File Policy',
        observedFact: `Catalog candidates found in text_fields (${inTextFieldsCount}), tags/aliases (${inTagNamesOrAliasesCount}), filenames (${inFilenameCount}), dirs (${inDirectoryPathCount}); conflicts=${conflictingCatalogEntries.length}, multi-file catalogs=${multiFileCatalogs.length}.`,
        proposedRule:
          'Precedence: explicit text_field > filename > parent directory > tag; allow NON-UNIQUE catalog_number across media_files so multi-part/multi-asset entries are preserved losslessly.',
        boundaryNotCovered:
          'Non-standard studio codes without hyphen/digits or bundles combining multiple distinct catalog numbers in one file.',
      },
      {
        id: 'D2.2',
        topic: 'Media Date Extraction Precedence & Unknown Date Handling',
        observedFact: `Dates found in datetime_fields (${dateInDatetimeFieldsCount}), text_fields (${dateInTextFieldsCount}), path/filename (${dateInFilenameOrPathCount}); entries with only filesystem/DB timestamps=${dateInEntryTimestampsOnlyCount}, entries without semantic date=${entriesWithoutSemanticDate}.`,
        proposedRule:
          'Precedence: explicit datetime_field > explicit date in text_field > structured YYYY-MM-DD in path/filename > NULL; never fabricate media_date from file mtime/date_added.',
        boundaryNotCovered:
          'Partial dates (year-only or year-month without day) which require either NULL media_date or explicit day normalization decision.',
      },
      {
        id: 'D2.3',
        topic: 'Case-Folded Duplicate Tag Names & Shared Alias Disambiguation',
        observedFact: `Case-folded duplicate tag groups=${duplicateTagNamesCaseFolded.length}, shared aliases across multiple tags=${sharedAliases.length}, alias-vs-tag-name collisions=${aliasTagNameCollisions.length}.`,
        proposedRule:
          'Normalize tag lookup keys via trim + case-folding; preserve distinct TagStudio tag IDs in legacy_ids and surface duplicate/shared-alias groups in import report for explicit merge or disambiguation rather than silent drop.',
        boundaryNotCovered:
          'Cross-script homographs or performer aliases that map to multiple active studios/performers.',
      },
    ]

    return {
      tables,
      dbVersion,
      counts,
      orphans: {
        tagEntriesMissingEntry,
        tagEntriesMissingTag,
        tagAliasesMissingTag,
        tagParentsMissingParent,
        tagParentsMissingChild,
        tagParentsSelfLoop,
        textFieldsMissingEntry,
        datetimeFieldsMissingEntry,
        tagsMissingDisambiguation,
      },
      fieldDistribution: {
        textFields: textFieldDistribution,
        datetimeFields: datetimeFieldDistribution,
      },
      catalogAndDateDiscovery: {
        catalogSources: {
          inTextFields: inTextFieldsCount,
          textFieldNamesWithCatalog,
          inTagNamesOrAliases: inTagNamesOrAliasesCount,
          inFilename: inFilenameCount,
          inDirectoryPath: inDirectoryPathCount,
          entriesWithAnyCatalogCandidate,
          entriesWithoutCatalogCandidate,
          conflictingCatalogEntries,
          multiFileCatalogs,
        },
        dateSources: {
          inDatetimeFields: dateInDatetimeFieldsCount,
          datetimeFieldNamesWithDate,
          inTextFields: dateInTextFieldsCount,
          inFilenameOrPath: dateInFilenameOrPathCount,
          inEntryTimestampsOnly: dateInEntryTimestampsOnlyCount,
          entriesWithoutSemanticDate,
        },
      },
      tagAndAliasAnomalies: {
        duplicateTagNamesCaseFolded,
        sharedAliases,
        aliasTagNameCollisions,
      },
      pathMapping: {
        rootId,
        totalEntries: counts.entries,
        validRelativePaths,
        unmappedOrInvalidPaths,
        duplicateNormalizedPaths,
        topDirectoryPrefixes,
        sampleMappings,
        diskCheck: {
          checked: mediaRootDir !== null,
          mediaRootDir,
          existingFiles,
          missingFiles,
          missingSample,
        },
      },
      unresolvedDecisions,
    }
  })

  return {
    generatedAt: new Date().toISOString(),
    sanitized: sanitize,
    source: {
      path: sanitize ? path.basename(before.path) : before.path,
      sha256Before: before.sha256,
      sha256After: after.sha256,
      unchanged: before.sha256 === after.sha256,
      size: before.size,
      mtimeIso: before.mtimeIso,
      hasWalFile: before.hasWalFile,
      hasShmFile: before.hasShmFile,
      dbVersion: result.dbVersion,
      tables: result.tables,
    },
    counts: result.counts,
    orphans: result.orphans,
    fieldDistribution: result.fieldDistribution,
    catalogAndDateDiscovery: result.catalogAndDateDiscovery,
    tagAndAliasAnomalies: result.tagAndAliasAnomalies,
    pathMapping: result.pathMapping,
    unresolvedDecisions: result.unresolvedDecisions,
  }
}

/**
 * Format a Multi-Candidate Comparison Report as Markdown.
 */
export function formatComparisonMarkdown(report: CandidateComparisonReport): string {
  const lines: string[] = [
    '# TagStudio Candidate Databases Comparison Report',
    '',
    `- **Generated At**: \`${report.generatedAt}\``,
    `- **Total Candidates Inspected**: ${report.totalCandidates}`,
    `- **Unique SHA-256 Fingerprints**: ${report.uniqueSha256Count}`,
    `- **Recommended Primary Candidate**: ${report.recommendedPrimaryPath ? `\`${report.recommendedPrimaryPath}\`` : '_(none)_'}`,
    '',
    '## 1. Candidate Summary Table',
    '',
    '| Classification | Path | SHA-256 (prefix) | Size (B) | mtime (ISO) | WAL/SHM | DB Ver | Entries | Custom Tags | Aliases | Tag-Entries | Fields | Max Entry ID |',
    '|---|---|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ]

  for (const c of report.candidates) {
    const walShm = c.fingerprint.hasWalFile || c.fingerprint.hasShmFile ? 'YES (!)' : 'no'
    const ver = c.dbVersion.current !== null ? String(c.dbVersion.current) : '-'
    const fields = c.counts.textFields + c.counts.datetimeFields
    lines.push(
      `| \`${c.classification}\` | \`${c.path}\` | \`${c.fingerprint.sha256.slice(0, 12)}\` | ${c.fingerprint.size} | \`${c.fingerprint.mtimeIso}\` | ${walShm} | ${ver} | ${c.counts.entries} | ${c.counts.customTags} | ${c.counts.tagAliases} | ${c.counts.tagEntries} | ${fields} | ${c.activity.maxEntryId ?? '-'} |`,
    )
  }

  lines.push('', '## 2. Classification Details & Root Prefixes', '')
  for (const c of report.candidates) {
    const prefixes =
      c.activity.topRootPrefixes.length > 0
        ? c.activity.topRootPrefixes.map(p => `${p.prefix} (${p.count})`).join(', ')
        : '(none)'
    lines.push(
      `- **\`${c.path}\`** (\`${c.classification}\`): ${c.reason}`,
      `  - Top relative directory prefixes: \`${prefixes}\``,
    )
  }

  if (report.duplicateGroups.length > 0) {
    lines.push('', '## 3. Byte-Identical Duplicate Groups (Same SHA-256)', '')
    for (const grp of report.duplicateGroups) {
      lines.push(`- **SHA-256 \`${grp.sha256}\`**:`)
      for (const p of grp.paths) {
        lines.push(`  - \`${p}\``)
      }
    }
  }

  return lines.join('\n') + '\n'
}

/**
 * Format a TagStudio Inventory Report as Markdown.
 */
export function formatInventoryMarkdown(report: TagStudioInventoryReport): string {
  const s = report.source
  const c = report.counts
  const o = report.orphans
  const cat = report.catalogAndDateDiscovery.catalogSources
  const dt = report.catalogAndDateDiscovery.dateSources
  const anom = report.tagAndAliasAnomalies
  const pm = report.pathMapping

  const totalOrphans =
    o.tagEntriesMissingEntry.length +
    o.tagEntriesMissingTag.length +
    o.tagAliasesMissingTag.length +
    o.tagParentsMissingParent.length +
    o.tagParentsMissingChild.length +
    o.tagParentsSelfLoop.length +
    o.textFieldsMissingEntry.length +
    o.datetimeFieldsMissingEntry.length +
    o.tagsMissingDisambiguation.length

  const lines: string[] = [
    '# TagStudio Read-Only Inventory Report',
    '',
    `- **Generated At**: \`${report.generatedAt}\``,
    `- **Source Path**: \`${s.path}\``,
    `- **SHA-256 Before**: \`${s.sha256Before}\``,
    `- **SHA-256 After**:  \`${s.sha256After}\` (**Unchanged**: \`${s.unchanged}\`)`,
    `- **File Size**: ${s.size} bytes | **mtime**: \`${s.mtimeIso}\``,
    `- **Companion WAL/SHM Present**: WAL=\`${s.hasWalFile}\`, SHM=\`${s.hasShmFile}\``,
    `- **TagStudio DB Version**: current=\`${s.dbVersion.current ?? 'unknown'}\`, initial=\`${s.dbVersion.initial ?? 'unknown'}\` (source: \`${s.dbVersion.source}\`)`,
    '',
    '## 1. Entity & Association Counts',
    '',
    '| Entity / Table | Count | Notes |',
    '|---|---:|---|',
    `| \`entries\` | ${c.entries} | Media files indexed |`,
    `| \`tags\` (total / custom) | ${c.tags} / ${c.customTags} | Excludes TagStudio built-in IDs 0 & 1 for custom count |`,
    `| \`tag_aliases\` | ${c.tagAliases} | Alternate search names for tags |`,
    `| \`tag_entries\` | ${c.tagEntries} | Entry-to-tag associations |`,
    `| \`tag_parents\` | ${c.tagParents} | Parent/subtag hierarchy edges |`,
    `| \`text_fields\` | ${c.textFields} | Entry text metadata rows |`,
    `| \`datetime_fields\` | ${c.datetimeFields} | Entry datetime metadata rows |`,
    `| \`category_exclusions\` | ${c.categoryExclusions} | DB v400 category exclusion rules |`,
    `| **Orphaned / Broken Rows** | ${totalOrphans} | Total across all foreign-key relations |`,
    '',
    '## 2. Catalog Number & Media Date Source Discovery',
    '',
    '### Catalog Number Sources',
    `- **In \`text_fields\`**: ${cat.inTextFields} entries (fields: ${cat.textFieldNamesWithCatalog.join(', ') || 'none'})`,
    `- **In \`tags\` / \`tag_aliases\`**: ${cat.inTagNamesOrAliases} entries`,
    `- **In \`filename\`**: ${cat.inFilename} entries`,
    `- **In parent directory path**: ${cat.inDirectoryPath} entries`,
    `- **Total entries with >=1 catalog candidate**: ${cat.entriesWithAnyCatalogCandidate} (without candidate: ${cat.entriesWithoutCatalogCandidate})`,
    `- **Conflicting field vs path catalog entries**: ${cat.conflictingCatalogEntries.length}`,
    `- **Multi-file catalog numbers (>1 entry per catalog)**: ${cat.multiFileCatalogs.length}`,
    '',
    '### Media Date Sources',
    `- **In \`datetime_fields\`**: ${dt.inDatetimeFields} entries (fields: ${dt.datetimeFieldNamesWithDate.join(', ') || 'none'})`,
    `- **In \`text_fields\`**: ${dt.inTextFields} entries`,
    `- **In filename / directory path**: ${dt.inFilenameOrPath} entries`,
    `- **Only in entry DB/filesystem timestamps (\`date_created\`/\`date_modified\`/\`date_added\`)**: ${dt.inEntryTimestampsOnly} entries`,
    `- **Entries without any semantic date**: ${dt.entriesWithoutSemanticDate} entries`,
    '',
    '## 3. Tag, Alias & Path Anomalies',
    '',
    `- **Case-folded duplicate tag name groups**: ${anom.duplicateTagNamesCaseFolded.length}`,
    `- **Shared/ambiguous aliases (1 alias -> multiple tags)**: ${anom.sharedAliases.length}`,
    `- **Alias colliding with another tag name**: ${anom.aliasTagNameCollisions.length}`,
    `- **Valid relative paths (\`${pm.rootId} + relative_path\`)**: ${pm.validRelativePaths} / ${pm.totalEntries}`,
    `- **Unmapped / invalid relative paths**: ${pm.unmappedOrInvalidPaths.length}`,
    `- **Case-folded duplicate relative paths**: ${pm.duplicateNormalizedPaths.length}`,
  ]

  if (pm.diskCheck.checked) {
    lines.push(
      `- **Disk verification against \`${pm.diskCheck.mediaRootDir}\`**: existing=${pm.diskCheck.existingFiles}, missing=${pm.diskCheck.missingFiles}`,
    )
  }

  lines.push('', '## 4. Decisions Required Before M2 Import (`NEEDS_DECISION`)', '')
  for (const d of report.unresolvedDecisions) {
    lines.push(
      `### ${d.id}: ${d.topic}`,
      `- **Observed**: ${d.observedFact}`,
      `- **Proposed Rule**: ${d.proposedRule}`,
      `- **\`boundary_not_covered\`**: ${d.boundaryNotCovered}`,
      '',
    )
  }

  return lines.join('\n')
}
