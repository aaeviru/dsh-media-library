import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { collectDatabaseTableCounts, type DatabaseTableCounts } from '../db/backup.ts'
import {
  type DatabaseHealthCheckResult,
  migrateDatabase,
  openMediaLibraryDatabase,
  resolveLocalDatabasePath,
  runDatabaseHealthChecks,
} from '../db/schema.ts'
import {
  extractCatalogNumber,
  extractIsoDate,
  type FileFingerprint,
  normalizeLookupKey,
  normalizeRelativeMediaPath,
  withReadOnlySqlite,
} from '../inventory/tagstudio-inventory.ts'
import { normalizeCanonicalUncRoot, resolveAllowlistedUncPath } from '../unc-path.ts'

export interface TagStudioImportOptions {
  readonly sourceDbPath: string
  readonly targetDbPath?: string | undefined
  readonly dshHome?: string | undefined
  readonly pluginPackageDir?: string | undefined
  readonly mode: 'dry-run' | 'import'
  readonly rootId?: string | undefined
  readonly rootName?: string | undefined
  readonly canonicalUncRoot?: string | undefined
  readonly mediaRootDir?: string | undefined
  readonly force?: boolean | undefined
  readonly sanitizeReport?: boolean | undefined
  readonly now?: (() => Date) | undefined
  /**
   * Test hook to simulate a mid-transaction failure after inserting entries/tags
   * and verify that atomic rollback leaves the target database untouched (`B5`).
   */
  readonly injectFaultBeforeCommit?: boolean | undefined
}

export interface MergedDuplicateTagRecord {
  readonly normalizedName: string
  readonly targetTagId: number
  readonly winnerSourceTagId: number
  readonly winnerName: string
  readonly mergedSourceTagIds: readonly number[]
  readonly mergedNames: readonly string[]
}

export interface SkippedSidecarEntryRecord {
  readonly sourceEntryId: number
  readonly relativePath: string
  readonly filename: string
  readonly extension: string
  readonly reason: 'SYSTEM_DB_SIDECAR' | 'SYNOLOGY_VSMETA_SIDECAR'
  readonly associatedSourceTagIds: readonly number[]
}

export interface UnmappedEntryRecord {
  readonly sourceEntryId: number
  readonly rawPath: string
  readonly reason: string
}

export interface DuplicatePathEntryRecord {
  readonly sourceEntryId: number
  readonly normalizedRelativePath: string
  readonly keptSourceEntryId: number
}

export interface SharedAliasReportItem {
  readonly normalizedAlias: string
  readonly targetTagIds: readonly number[]
  readonly targetTagNames: readonly string[]
}

export interface ImportWarningItem {
  readonly code:
    | 'NON_THUMBS_DB_FILE_SKIPPED'
    | 'CONFLICTING_DUPLICATE_TAG_SHORTHAND'
    | 'SHARED_TAG_ALIAS'
  readonly message: string
  readonly details: Record<string, unknown>
}

export interface TagStudioReconciliationSummary {
  readonly entries: {
    readonly sourceEntries: number
    readonly importedEntries: number
    readonly skippedSidecarEntries: number
    readonly unmappedEntries: number
    readonly duplicatePathEntries: number
    readonly reconciled: boolean
  }
  readonly tags: {
    readonly sourceTags: number
    readonly importedTags: number
    readonly mergedDuplicateTags: number
    readonly reconciled: boolean
  }
  readonly tagAliases: {
    readonly sourceTagAliases: number
    readonly importedTagAliases: number
    readonly deduplicatedTagAliases: number
    readonly orphanedTagAliases: number
    readonly reconciled: boolean
  }
  readonly tagParents: {
    readonly sourceTagParents: number
    readonly importedTagParents: number
    readonly deduplicatedTagParents: number
    readonly selfLoopTagParents: number
    readonly orphanedTagParents: number
    readonly reconciled: boolean
  }
  readonly tagEntries: {
    readonly sourceTagEntries: number
    readonly importedMediaTags: number
    readonly deduplicatedAfterTagMerge: number
    readonly skippedSidecarTagEntries: number
    readonly orphanedTagEntries: number
    readonly orphanBreakdown: {
      readonly missingEntryOnly: number
      readonly missingTagOnly: number
      readonly missingBoth: number
      readonly unmappedEntry: number
    }
    readonly reconciled: boolean
  }
  readonly textFields: {
    readonly sourceTextFields: number
    readonly importedTextFields: number
    readonly skippedOrOrphanedTextFields: number
    readonly reconciled: boolean
  }
  readonly allReconciled: boolean
}

export interface TagStudioImportReport {
  readonly generatedAt: string
  readonly mode: 'dry-run' | 'import'
  readonly status: 'succeeded' | 'already_imported'
  readonly sanitized: boolean
  readonly rootId: string
  readonly canonicalUncRoot: string
  readonly sourceFingerprint: string
  readonly source: {
    readonly path: string
    readonly sha256Before: string
    readonly sha256After: string
    readonly unchanged: boolean
    readonly size: number
    readonly mtimeIso: string
  }
  readonly reconciliation: TagStudioReconciliationSummary
  readonly catalogAndDateSummary: {
    readonly entriesWithCatalog: number
    readonly entriesWithoutCatalog: number
    readonly catalogBySource: {
      readonly text_field: number
      readonly filename: number
      readonly directory: number
    }
    readonly entriesWithMediaDate: number
    readonly entriesWithoutMediaDate: number
    readonly dateBySource: {
      readonly datetime_field: number
      readonly text_field: number
      readonly filename_or_path: number
    }
  }
  readonly mergedDuplicateTags: readonly MergedDuplicateTagRecord[]
  readonly skippedSidecarEntries: readonly SkippedSidecarEntryRecord[]
  readonly unmappedEntries: readonly UnmappedEntryRecord[]
  readonly duplicatePathEntries: readonly DuplicatePathEntryRecord[]
  readonly sharedAliases: readonly SharedAliasReportItem[]
  readonly orphanedTagAliases: ReadonlyArray<{ readonly id: number; readonly alias: string; readonly tagId: number }>
  readonly orphanedTagParents: ReadonlyArray<{ readonly parentId: number; readonly childId: number }>
  readonly selfLoopTagParents: ReadonlyArray<{ readonly parentId: number; readonly childId: number }>
  readonly warnings: readonly ImportWarningItem[]
  readonly targetHealth: DatabaseHealthCheckResult
  readonly targetTableCounts: DatabaseTableCounts
}

function maskPathForSanitizedReport(rawPath: string, sanitize: boolean): string {
  if (!sanitize) return rawPath
  const normalized = rawPath.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  return parts
    .map((part, idx) => {
      const digest = createHash('sha256').update(part).digest('hex').slice(0, 6)
      if (idx === parts.length - 1) {
        const ext = path.posix.extname(part)
        return `file_${digest}${ext}`
      }
      return `dir_${digest}`
    })
    .join('\\')
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { 1: number } | undefined
  return Boolean(row)
}

interface SourceTagRow {
  readonly id: number
  readonly name: string
  readonly shorthand: string | null
  readonly color_namespace: string | null
  readonly color_slug: string | null
  readonly is_category: number
  readonly is_hidden: number
}

interface SourceAliasRow {
  readonly id: number
  readonly name: string
  readonly tag_id: number
}

interface SourceParentRow {
  readonly parent_id: number
  readonly child_id: number
}

interface SourceEntryRow {
  readonly id: number
  readonly path: string
  readonly filename: string
  readonly suffix: string
  readonly date_created: string | null
  readonly date_modified: string | null
  readonly date_added: string | null
}

interface SourceTagEntryRow {
  readonly tag_id: number
  readonly entry_id: number
}

interface SourceTextFieldRow {
  readonly id: number
  readonly name: string
  readonly entry_id: number
  readonly value: string | null
  readonly is_multiline: number
}

interface SourceDatetimeFieldRow {
  readonly id: number
  readonly name: string
  readonly entry_id: number
  readonly value: string | null
}

/**
 * Restrict `--force` re-import to TagStudio-owned rows under `rootId` (`Issue #33`, `#3 B6`).
 * Refuses and throws before mutating if ownership cannot be safely separated from manual edits,
 * M4 ingestion records, non-TagStudio path collisions, or manually archived/merged tags.
 */
function prepareScopedForceReimport(
  db: DatabaseSync,
  options: {
    readonly rootId: string
    readonly rootName: string
    readonly canonicalUncRoot: string
    readonly sourceEntries: readonly SourceEntryRow[]
    readonly sourceTags: readonly SourceTagRow[]
  },
): void {
  const { rootId, rootName, canonicalUncRoot, sourceEntries, sourceTags } = options
  const allowlistRoots = [{ rootId, label: rootName, canonicalUncRoot, enabled: true }]

  // 1. Collect incoming non-sidecar normalized relative paths under `rootId` to detect collisions with non-TagStudio rows.
  const incomingPathsLower = new Set<string>()
  for (const entry of sourceEntries) {
    const normPath = normalizeRelativeMediaPath(String(entry.path ?? ''))
    if (!normPath.ok) continue
    const uncRes = resolveAllowlistedUncPath(allowlistRoots, rootId, normPath.relativeWin32Path)
    if (!uncRes.ok) continue
    const filename = path.win32.basename(uncRes.normalizedRelativePath)
    const ext =
      path.win32.extname(filename).replace(/^\./, '').toLowerCase() ||
      String(entry.suffix ?? '').replace(/^\./, '').toLowerCase()
    if (ext === 'db' || ext === 'vsmeta') continue
    incomingPathsLower.add(uncRes.normalizedRelativePath.toLowerCase())
  }

  const nonTagStudioRows = db
    .prepare(
      `SELECT relative_path
       FROM media_files
       WHERE root_id = ?
         AND (source_key IS NULL OR source_key NOT LIKE 'tagstudio:%')`,
    )
    .all(rootId) as Array<{ relative_path: string }>
  for (const row of nonTagStudioRows) {
    const rel = String(row.relative_path)
    if (incomingPathsLower.has(rel.toLowerCase())) {
      throw new Error(
        `FORCE_REIMPORT_REFUSED: Cannot safely force re-import root "${rootId}": incoming TagStudio path "${rel}" collides with an existing non-TagStudio media entry.`,
      )
    }
  }

  // 2. Refuse if any incoming tag collides with a manually archived or merged tag.
  const tagCols = new Set(
    (db.prepare('PRAGMA table_info("tags")').all() as Array<{ name: string }>).map(r => String(r.name)),
  )
  if (tagCols.has('archived_at') || tagCols.has('merged_into_id')) {
    const checkTagStateStmt = db.prepare(
      `SELECT name,
              ${tagCols.has('archived_at') ? 'archived_at' : 'NULL AS archived_at'},
              ${tagCols.has('merged_into_id') ? 'merged_into_id' : 'NULL AS merged_into_id'}
       FROM tags
       WHERE normalized_name = ?`,
    )
    const seenNormNames = new Set<string>()
    for (const tag of sourceTags) {
      const norm = normalizeLookupKey(String(tag.name))
      if (seenNormNames.has(norm)) continue
      seenNormNames.add(norm)
      const existing = checkTagStateStmt.get(norm) as
        | { name: string; archived_at: string | null; merged_into_id: number | null }
        | undefined
      if (existing && (existing.archived_at !== null || existing.merged_into_id !== null)) {
        throw new Error(
          `FORCE_REIMPORT_REFUSED: Cannot safely force re-import root "${rootId}": existing tag "${existing.name}" was manually archived or merged.`,
        )
      }
    }
  }

  // 3. Stage the exact set of TagStudio-owned media_files under `rootId` in a temp table (avoids SQLite bind limits).
  db.exec('DROP TABLE IF EXISTS temp._force_scoped_media;')
  db.exec('CREATE TEMP TABLE _force_scoped_media (id INTEGER PRIMARY KEY);')
  db.prepare(
    `INSERT INTO temp._force_scoped_media (id)
     SELECT id FROM media_files
     WHERE root_id = ? AND source_key LIKE 'tagstudio:%'`,
  ).run(rootId)

  try {
    const editedCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS cnt
             FROM media_files mf
             JOIN temp._force_scoped_media sm ON sm.id = mf.id
             WHERE mf.revision > 1`,
          )
          .get() as { cnt: number }
      ).cnt,
    )
    if (editedCount > 0) {
      throw new Error(
        `FORCE_REIMPORT_REFUSED: Cannot safely force re-import root "${rootId}": ${editedCount} previously imported TagStudio media row(s) have manual edits (revision > 1).`,
      )
    }

    const mixedTagCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(DISTINCT mt.media_id) AS cnt
             FROM media_tags mt
             JOIN temp._force_scoped_media sm ON sm.id = mt.media_id
             WHERE mt.source <> 'tagstudio-import'`,
          )
          .get() as { cnt: number }
      ).cnt,
    )
    if (mixedTagCount > 0) {
      throw new Error(
        `FORCE_REIMPORT_REFUSED: Cannot safely force re-import root "${rootId}": ${mixedTagCount} previously imported TagStudio media row(s) have non-TagStudio tag associations (manual/ingestion/performer-rule).`,
      )
    }

    if (hasTable(db, 'ingestion_manifests')) {
      const manifestRefCount = Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS cnt
               FROM ingestion_manifests im
               JOIN temp._force_scoped_media sm ON sm.id = im.indexed_media_id`,
            )
            .get() as { cnt: number }
        ).cnt,
      )
      if (manifestRefCount > 0) {
        throw new Error(
          `FORCE_REIMPORT_REFUSED: Cannot safely force re-import root "${rootId}": ${manifestRefCount} media row(s) are referenced by ingestion_manifests.`,
        )
      }
    }

    if (hasTable(db, 'performer_review_queue')) {
      const queueRefCount = Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS cnt
               FROM performer_review_queue prq
               JOIN temp._force_scoped_media sm ON sm.id = prq.media_id`,
            )
            .get() as { cnt: number }
        ).cnt,
      )
      if (queueRefCount > 0) {
        throw new Error(
          `FORCE_REIMPORT_REFUSED: Cannot safely force re-import root "${rootId}": ${queueRefCount} media row(s) are referenced by performer_review_queue.`,
        )
      }
    }

    // 4. Delete ONLY the verified TagStudio-owned media rows & dependent rows for `rootId`.
    db.exec(`
      DELETE FROM legacy_ids
      WHERE source_type = 'tagstudio'
        AND entity_type = 'text_field'
        AND entity_id IN (
          SELECT mtf.id FROM media_text_fields mtf
          JOIN temp._force_scoped_media sm ON sm.id = mtf.media_id
        );
      DELETE FROM legacy_ids
      WHERE source_type = 'tagstudio'
        AND entity_type = 'entry'
        AND entity_id IN (SELECT id FROM temp._force_scoped_media);
      DELETE FROM media_tags
      WHERE media_id IN (SELECT id FROM temp._force_scoped_media)
        AND source = 'tagstudio-import';
      DELETE FROM media_text_fields
      WHERE media_id IN (SELECT id FROM temp._force_scoped_media);
      DELETE FROM media_files
      WHERE id IN (SELECT id FROM temp._force_scoped_media);
    `)

    // 5. Prune strictly unreferenced, unmodified TagStudio-origin tags ONLY when no other TagStudio root exists.
    const otherTagStudioRoots = Number(
      (
        db
          .prepare(
            `SELECT COUNT(DISTINCT root_id) AS cnt
             FROM media_files
             WHERE root_id <> ? AND source_key LIKE 'tagstudio:%'`,
          )
          .get(rootId) as { cnt: number }
      ).cnt,
    )
    if (otherTagStudioRoots === 0) {
      const hasPerformerAliases = hasTable(db, 'performer_aliases')
      const hasPerformerQueue = hasTable(db, 'performer_review_queue')
      db.exec('DROP TABLE IF EXISTS temp._force_prunable_tags;')
      db.exec('CREATE TEMP TABLE _force_prunable_tags (id INTEGER PRIMARY KEY);')
      db.exec(`
        INSERT INTO temp._force_prunable_tags (id)
        SELECT t.id
        FROM tags t
        WHERE t.revision = 1
          ${tagCols.has('archived_at') ? 'AND t.archived_at IS NULL' : ''}
          ${tagCols.has('merged_into_id') ? 'AND t.merged_into_id IS NULL' : ''}
          AND EXISTS (
            SELECT 1 FROM legacy_ids l
            WHERE l.source_type = 'tagstudio' AND l.entity_type = 'tag' AND l.entity_id = t.id
          )
          AND NOT EXISTS (SELECT 1 FROM media_tags mt WHERE mt.tag_id = t.id)
          ${tagCols.has('merged_into_id') ? 'AND NOT EXISTS (SELECT 1 FROM tags t2 WHERE t2.merged_into_id = t.id)' : ''}
          ${hasPerformerAliases ? 'AND NOT EXISTS (SELECT 1 FROM performer_aliases pa WHERE pa.tag_id = t.id)' : ''}
          ${hasPerformerQueue ? 'AND NOT EXISTS (SELECT 1 FROM performer_review_queue prq WHERE prq.resolved_tag_id = t.id)' : ''};

        DELETE FROM tag_parents
        WHERE tag_id IN (SELECT id FROM temp._force_prunable_tags)
           OR parent_tag_id IN (SELECT id FROM temp._force_prunable_tags);
        DELETE FROM legacy_ids
        WHERE source_type = 'tagstudio'
          AND entity_type = 'tag_alias'
          AND entity_id IN (
            SELECT ta.id FROM tag_aliases ta
            JOIN temp._force_prunable_tags pt ON pt.id = ta.tag_id
          );
        DELETE FROM tag_aliases
        WHERE tag_id IN (SELECT id FROM temp._force_prunable_tags);
        DELETE FROM legacy_ids
        WHERE source_type = 'tagstudio'
          AND entity_type = 'tag'
          AND entity_id IN (SELECT id FROM temp._force_prunable_tags);
        DELETE FROM tags
        WHERE id IN (SELECT id FROM temp._force_prunable_tags);
        DROP TABLE IF EXISTS temp._force_prunable_tags;
      `)
    }
  } finally {
    db.exec('DROP TABLE IF EXISTS temp._force_scoped_media;')
  }
}

/**
 * Import or dry-run a TagStudio `.sqlite` read-only copy into the local DSH media library SQLite database (`B3..B6`, `B8`).
 */
export async function importTagStudioDatabase(
  options: TagStudioImportOptions,
): Promise<TagStudioImportReport> {
  const mode = options.mode
  const rootId = (options.rootId ?? 'nas-main').trim()
  const rootName = (options.rootName ?? 'Synology NAS Media').trim()
  const rootNorm = normalizeCanonicalUncRoot(options.canonicalUncRoot ?? '\\\\NAS\\Media')
  if (!rootNorm.ok) {
    throw new Error(`Invalid canonicalUncRoot: ${rootNorm.message}`)
  }
  const canonicalUncRoot = rootNorm.canonicalRoot
  const sanitize = options.sanitizeReport ?? false
  const nowFn = options.now ?? (() => new Date())

  const resolvedSourcePath = path.resolve(options.sourceDbPath)
  const resolvedTargetPath =
    mode === 'dry-run'
      ? options.targetDbPath
        ? resolveLocalDatabasePath({
            dbPath: options.targetDbPath,
            dshHome: options.dshHome,
            pluginPackageDir: options.pluginPackageDir,
          })
        : ':memory:'
      : resolveLocalDatabasePath({
          dbPath: options.targetDbPath,
          dshHome: options.dshHome,
          pluginPackageDir: options.pluginPackageDir,
        })

  if (resolvedTargetPath !== ':memory:' && resolvedSourcePath === resolvedTargetPath) {
    throw new Error(
      `Refusing to import: sourceDbPath and targetDbPath must not be the same file (${resolvedSourcePath})`,
    )
  }

  const startedAtIso = nowFn().toISOString()

  // Execute all reads of the TagStudio database inside withReadOnlySqlite so SHA-256 invariance is strictly enforced
  const { result: sourceSnapshot, before: fpBefore, after: fpAfter } = withReadOnlySqlite(
    resolvedSourcePath,
    (srcDb: DatabaseSync, fp: FileFingerprint) => {
      if (!hasTable(srcDb, 'entries') || !hasTable(srcDb, 'tags') || !hasTable(srcDb, 'tag_entries')) {
        throw new Error(
          `Source file ${fp.path} is not a valid TagStudio database (missing entries, tags, or tag_entries table)`,
        )
      }

      const tagCols = new Set(
        (srcDb.prepare('PRAGMA table_info("tags")').all() as Array<{ name: string }>).map(r => String(r.name)),
      )
      const tags = srcDb
        .prepare(
          `SELECT
             id,
             name,
             ${tagCols.has('shorthand') ? 'shorthand' : 'NULL AS shorthand'},
             ${tagCols.has('color_namespace') ? 'color_namespace' : 'NULL AS color_namespace'},
             ${tagCols.has('color_slug') ? 'color_slug' : 'NULL AS color_slug'},
             ${tagCols.has('is_category') ? 'COALESCE(is_category, 0)' : '0'} AS is_category,
             ${tagCols.has('is_hidden') ? 'COALESCE(is_hidden, 0)' : '0'} AS is_hidden
           FROM tags
           ORDER BY id ASC`,
        )
        .all() as unknown as SourceTagRow[]

      const aliases: SourceAliasRow[] = hasTable(srcDb, 'tag_aliases')
        ? (srcDb
            .prepare('SELECT id, name, tag_id FROM tag_aliases ORDER BY id ASC')
            .all() as unknown as SourceAliasRow[])
        : []

      const parents: SourceParentRow[] = hasTable(srcDb, 'tag_parents')
        ? (srcDb
            .prepare('SELECT parent_id, child_id FROM tag_parents ORDER BY parent_id ASC, child_id ASC')
            .all() as unknown as SourceParentRow[])
        : []

      const entryCols = new Set(
        (srcDb.prepare('PRAGMA table_info("entries")').all() as Array<{ name: string }>).map(r => String(r.name)),
      )
      const entries = srcDb
        .prepare(
          `SELECT
             id,
             path,
             filename,
             suffix,
             ${entryCols.has('date_created') ? 'date_created' : 'NULL AS date_created'},
             ${entryCols.has('date_modified') ? 'date_modified' : 'NULL AS date_modified'},
             ${entryCols.has('date_added') ? 'date_added' : 'NULL AS date_added'}
           FROM entries
           ORDER BY id ASC`,
        )
        .all() as unknown as SourceEntryRow[]

      const tagEntries = srcDb
        .prepare('SELECT tag_id, entry_id FROM tag_entries ORDER BY entry_id ASC, tag_id ASC')
        .all() as unknown as SourceTagEntryRow[]

      const textFields: SourceTextFieldRow[] = hasTable(srcDb, 'text_fields')
        ? (srcDb
            .prepare('SELECT id, name, entry_id, value, COALESCE(is_multiline, 0) AS is_multiline FROM text_fields ORDER BY id ASC')
            .all() as unknown as SourceTextFieldRow[])
        : []

      const datetimeFields: SourceDatetimeFieldRow[] = hasTable(srcDb, 'datetime_fields')
        ? (srcDb
            .prepare('SELECT id, name, entry_id, value FROM datetime_fields ORDER BY id ASC')
            .all() as unknown as SourceDatetimeFieldRow[])
        : []

      return {
        tags,
        aliases,
        parents,
        entries,
        tagEntries,
        textFields,
        datetimeFields,
      }
    },
  )

  const sourceFingerprint = `${fpBefore.sha256}@${rootId}`

  // In dry-run mode, we always execute against an isolated :memory: database so targetDbPath on disk is never created or modified
  const activeDbPath = mode === 'dry-run' ? ':memory:' : resolvedTargetPath
  const { db } = openMediaLibraryDatabase({
    dbPath: activeDbPath,
    dshHome: options.dshHome,
    pluginPackageDir: options.pluginPackageDir,
  })

  try {
    await migrateDatabase(db, {
      dbPath: activeDbPath,
      now: nowFn,
    })

    // Idempotency check (`B6`): if this exact source_fingerprint was already imported and `!options.force`
    if (mode === 'import' && !options.force) {
      const existingRun = db
        .prepare(
          `SELECT id, report_json
           FROM import_runs
           WHERE source_type = 'tagstudio'
             AND source_fingerprint = ?
             AND status = 'succeeded'
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get(sourceFingerprint) as { id: number; report_json: string } | undefined

      if (existingRun) {
        const previousReport = JSON.parse(existingRun.report_json) as TagStudioImportReport
        const targetHealth = runDatabaseHealthChecks(db)
        const targetTableCounts = collectDatabaseTableCounts(db)
        return {
          ...previousReport,
          generatedAt: nowFn().toISOString(),
          status: 'already_imported',
          source: {
            path: sanitize ? path.basename(resolvedSourcePath) : resolvedSourcePath,
            sha256Before: fpBefore.sha256,
            sha256After: fpAfter.sha256,
            unchanged: fpBefore.sha256 === fpAfter.sha256,
            size: fpAfter.size,
            mtimeIso: fpAfter.mtimeIso,
          },
          targetHealth,
          targetTableCounts,
        }
      }
    }

    // Group text_fields and datetime_fields by entry_id
    const textFieldsByEntry = new Map<number, SourceTextFieldRow[]>()
    for (const tf of sourceSnapshot.textFields) {
      const list = textFieldsByEntry.get(Number(tf.entry_id)) ?? []
      list.push(tf)
      textFieldsByEntry.set(Number(tf.entry_id), list)
    }

    const datetimeFieldsByEntry = new Map<number, SourceDatetimeFieldRow[]>()
    for (const df of sourceSnapshot.datetimeFields) {
      const list = datetimeFieldsByEntry.get(Number(df.entry_id)) ?? []
      list.push(df)
      datetimeFieldsByEntry.set(Number(df.entry_id), list)
    }

    // Group source tag_entries by entry_id and count valid entry associations per tag_id
    const sourceEntryIdSet = new Set<number>(sourceSnapshot.entries.map(e => Number(e.id)))
    const sourceTagIdSet = new Set<number>(sourceSnapshot.tags.map(t => Number(t.id)))
    const tagIdsByEntryId = new Map<number, number[]>()
    const validAssocCountBySourceTagId = new Map<number, number>()

    for (const te of sourceSnapshot.tagEntries) {
      const entryId = Number(te.entry_id)
      const tagId = Number(te.tag_id)
      const byEntry = tagIdsByEntryId.get(entryId) ?? []
      byEntry.push(tagId)
      tagIdsByEntryId.set(entryId, byEntry)

      if (sourceEntryIdSet.has(entryId) && sourceTagIdSet.has(tagId)) {
        validAssocCountBySourceTagId.set(tagId, (validAssocCountBySourceTagId.get(tagId) ?? 0) + 1)
      }
    }

    const warnings: ImportWarningItem[] = []
    const mergedDuplicateTags: MergedDuplicateTagRecord[] = []
    const skippedSidecarEntries: SkippedSidecarEntryRecord[] = []
    const unmappedEntries: UnmappedEntryRecord[] = []
    const duplicatePathEntries: DuplicatePathEntryRecord[] = []
    const orphanedTagAliases: Array<{ readonly id: number; readonly alias: string; readonly tagId: number }> = []
    const orphanedTagParents: Array<{ readonly parentId: number; readonly childId: number }> = []
    const selfLoopTagParents: Array<{ readonly parentId: number; readonly childId: number }> = []

    // Begin atomic import transaction (`B5`)
    db.exec('BEGIN IMMEDIATE;')
    try {
      // If force=true on an existing DB, only replace TagStudio-owned rows scoped to `rootId` (`Issue #33`)
      if (options.force) {
        prepareScopedForceReimport(db, {
          rootId,
          rootName,
          canonicalUncRoot,
          sourceEntries: sourceSnapshot.entries,
          sourceTags: sourceSnapshot.tags,
        })
      }

      // 1. Ensure media_root exists
      db.prepare(
        `INSERT INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           canonical_unc_root = excluded.canonical_unc_root`,
      ).run(rootId, rootName, canonicalUncRoot, startedAtIso)

      // 2. Consolidate and insert tags (`D2.4`)
      const tagsByNormalizedName = new Map<string, SourceTagRow[]>()
      for (const tag of sourceSnapshot.tags) {
        const norm = normalizeLookupKey(String(tag.name))
        const group = tagsByNormalizedName.get(norm) ?? []
        group.push(tag)
        tagsByNormalizedName.set(norm, group)
      }

      const sourceTagIdToTargetTagId = new Map<number, number>()
      const targetTagIdToName = new Map<number, string>()
      let importedTagsCount = 0
      let mergedDuplicateTagsCount = 0

      const selectExistingTagStmt = db.prepare('SELECT id, name FROM tags WHERE normalized_name = ?')
      const insertTagStmt = db.prepare(
        `INSERT INTO tags (
           name, normalized_name, shorthand, color_namespace, color_slug,
           is_category, is_hidden, kind, created_at, updated_at, revision
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      const upsertLegacyIdStmt = db.prepare(
        `INSERT INTO legacy_ids (source_type, source_id, entity_type, entity_id)
         VALUES ('tagstudio', ?, ?, ?)
         ON CONFLICT(source_type, entity_type, source_id) DO UPDATE SET entity_id = excluded.entity_id`,
      )

      for (const [normalizedName, group] of tagsByNormalizedName.entries()) {
        const sorted = [...group].sort((a, b) => {
          const countA = validAssocCountBySourceTagId.get(Number(a.id)) ?? 0
          const countB = validAssocCountBySourceTagId.get(Number(b.id)) ?? 0
          if (countB !== countA) return countB - countA
          const shortA = a.shorthand && String(a.shorthand).trim().length > 0 ? 1 : 0
          const shortB = b.shorthand && String(b.shorthand).trim().length > 0 ? 1 : 0
          if (shortB !== shortA) return shortB - shortA
          return Number(a.id) - Number(b.id)
        })

        const winner = sorted[0]!
        const distinctShorthands = new Set(
          sorted
            .map(t => (t.shorthand ? String(t.shorthand).trim() : ''))
            .filter(s => s.length > 0),
        )
        if (distinctShorthands.size > 1) {
          warnings.push({
            code: 'CONFLICTING_DUPLICATE_TAG_SHORTHAND',
            message: `Duplicate tags for "${normalizedName}" have conflicting shorthands: ${[...distinctShorthands].join(', ')}`,
            details: {
              normalizedName,
              sourceTagIds: sorted.map(t => Number(t.id)),
              shorthands: [...distinctShorthands],
            },
          })
        }

        const existingTag = selectExistingTagStmt.get(normalizedName) as { id: number; name: string } | undefined
        let targetTagId: number
        if (existingTag) {
          targetTagId = Number(existingTag.id)
        } else {
          const kind = Number(winner.id) === 0 || Number(winner.id) === 1 ? 'builtin' : 'custom'
          const info = insertTagStmt.run(
            String(winner.name).trim(),
            normalizedName,
            winner.shorthand ? String(winner.shorthand).trim() : null,
            winner.color_namespace ? String(winner.color_namespace) : null,
            winner.color_slug ? String(winner.color_slug) : null,
            Number(winner.is_category) ? 1 : 0,
            Number(winner.is_hidden) ? 1 : 0,
            kind,
            startedAtIso,
            startedAtIso,
          )
          targetTagId = Number(info.lastInsertRowid)
        }

        importedTagsCount += 1
        targetTagIdToName.set(targetTagId, String(winner.name).trim())

        for (const member of sorted) {
          sourceTagIdToTargetTagId.set(Number(member.id), targetTagId)
          upsertLegacyIdStmt.run(String(member.id), 'tag', targetTagId)
        }

        if (sorted.length > 1) {
          const losers = sorted.slice(1)
          mergedDuplicateTagsCount += losers.length
          mergedDuplicateTags.push({
            normalizedName: sanitize ? `tag_${createHash('sha256').update(normalizedName).digest('hex').slice(0, 6)}` : normalizedName,
            targetTagId,
            winnerSourceTagId: Number(winner.id),
            winnerName: sanitize ? `Tag_${winner.id}` : String(winner.name),
            mergedSourceTagIds: losers.map(l => Number(l.id)),
            mergedNames: losers.map(l => (sanitize ? `Tag_${l.id}` : String(l.name))),
          })
        }
      }

      // 3. Import tag_aliases
      let importedTagAliasesCount = 0
      let deduplicatedTagAliasesCount = 0
      const insertedAliasKeyToId = new Map<string, number>()
      const aliasToTargetTagIds = new Map<string, Set<number>>()

      const insertAliasStmt = db.prepare(
        `INSERT INTO tag_aliases (tag_id, alias, normalized_alias)
         VALUES (?, ?, ?)`,
      )
      const selectExistingAliasStmt = db.prepare(
        `SELECT id FROM tag_aliases WHERE tag_id = ? AND normalized_alias = ?`,
      )

      for (const aliasRow of sourceSnapshot.aliases) {
        const srcTagId = Number(aliasRow.tag_id)
        const targetTagId = sourceTagIdToTargetTagId.get(srcTagId)
        const rawAlias = String(aliasRow.name ?? '').trim()
        const normalizedAlias = normalizeLookupKey(rawAlias)

        if (targetTagId === undefined || normalizedAlias.length === 0) {
          orphanedTagAliases.push({
            id: Number(aliasRow.id),
            alias: sanitize ? `alias_${aliasRow.id}` : rawAlias,
            tagId: srcTagId,
          })
          continue
        }

        const dedupeKey = `${targetTagId}::${normalizedAlias}`
        const existingId =
          insertedAliasKeyToId.get(dedupeKey) ??
          (selectExistingAliasStmt.get(targetTagId, normalizedAlias) as { id: number } | undefined)?.id

        let targetAliasId: number
        if (existingId !== undefined) {
          targetAliasId = Number(existingId)
          deduplicatedTagAliasesCount += 1
        } else {
          const info = insertAliasStmt.run(targetTagId, rawAlias, normalizedAlias)
          targetAliasId = Number(info.lastInsertRowid)
          insertedAliasKeyToId.set(dedupeKey, targetAliasId)
          importedTagAliasesCount += 1
        }

        upsertLegacyIdStmt.run(String(aliasRow.id), 'tag_alias', targetAliasId)

        const sharedSet = aliasToTargetTagIds.get(normalizedAlias) ?? new Set<number>()
        sharedSet.add(targetTagId)
        aliasToTargetTagIds.set(normalizedAlias, sharedSet)
      }

      const sharedAliases: SharedAliasReportItem[] = []
      for (const [normAlias, tagIdSet] of aliasToTargetTagIds.entries()) {
        if (tagIdSet.size > 1) {
          const ids = [...tagIdSet].sort((a, b) => a - b)
          const names = ids.map(id => targetTagIdToName.get(id) ?? `Tag#${id}`)
          sharedAliases.push({
            normalizedAlias: sanitize ? `alias_${createHash('sha256').update(normAlias).digest('hex').slice(0, 6)}` : normAlias,
            targetTagIds: ids,
            targetTagNames: sanitize ? ids.map(id => `Tag_${id}`) : names,
          })
          warnings.push({
            code: 'SHARED_TAG_ALIAS',
            message: `Normalized alias "${normAlias}" is shared across ${ids.length} distinct tags`,
            details: { normalizedAlias: normAlias, targetTagIds: ids },
          })
        }
      }

      // 4. Import tag_parents
      let importedTagParentsCount = 0
      let deduplicatedTagParentsCount = 0
      const insertedParentPairs = new Set<string>()
      const insertParentStmt = db.prepare(
        `INSERT OR IGNORE INTO tag_parents (tag_id, parent_tag_id) VALUES (?, ?)`,
      )

      for (const parentRow of sourceSnapshot.parents) {
        const srcParentId = Number(parentRow.parent_id)
        const srcChildId = Number(parentRow.child_id)
        const targetParentId = sourceTagIdToTargetTagId.get(srcParentId)
        const targetChildId = sourceTagIdToTargetTagId.get(srcChildId)

        if (targetParentId === undefined || targetChildId === undefined) {
          orphanedTagParents.push({ parentId: srcParentId, childId: srcChildId })
          continue
        }
        if (targetChildId === targetParentId) {
          selfLoopTagParents.push({ parentId: srcParentId, childId: srcChildId })
          continue
        }

        const pairKey = `${targetChildId}->${targetParentId}`
        if (insertedParentPairs.has(pairKey)) {
          deduplicatedTagParentsCount += 1
          continue
        }
        insertedParentPairs.add(pairKey)
        insertParentStmt.run(targetChildId, targetParentId)
        importedTagParentsCount += 1
      }

      // 5. Filter & import entries (`D2.2`, `D2.3`, `D2.5`) + text_fields
      const allowlistRoots = [
        {
          rootId,
          label: rootName,
          canonicalUncRoot,
          enabled: true,
        },
      ]

      const sourceEntryIdToTargetMediaId = new Map<number, number>()
      const skippedSidecarEntryIdSet = new Set<number>()
      const unmappedEntryIdSet = new Set<number>()
      const seenNormalizedRelativePaths = new Map<string, number>()

      let importedEntriesCount = 0
      let importedTextFieldsCount = 0
      let skippedOrOrphanedTextFieldsCount = 0

      let entriesWithCatalog = 0
      let entriesWithoutCatalog = 0
      const catalogBySource = {
        text_field: 0,
        filename: 0,
        directory: 0,
      }

      let entriesWithMediaDate = 0
      let entriesWithoutMediaDate = 0
      const dateBySource = {
        datetime_field: 0,
        text_field: 0,
        filename_or_path: 0,
      }

      const insertMediaFileStmt = db.prepare(
        `INSERT INTO media_files (
           root_id, relative_path, filename, extension, title,
           catalog_number, catalog_source, media_date, date_source,
           added_at, file_size, file_mtime, status, source_key, revision
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      const insertTextFieldStmt = db.prepare(
        `INSERT INTO media_text_fields (media_id, field_name, field_value, is_multiline, position)
         VALUES (?, ?, ?, ?, ?)`,
      )

      for (const entry of sourceSnapshot.entries) {
        const srcEntryId = Number(entry.id)
        const rawPath = String(entry.path ?? '')
        const normPath = normalizeRelativeMediaPath(rawPath)

        if (!normPath.ok) {
          unmappedEntryIdSet.add(srcEntryId)
          unmappedEntries.push({
            sourceEntryId: srcEntryId,
            rawPath: maskPathForSanitizedReport(rawPath, sanitize),
            reason: normPath.reason ?? 'INVALID_RELATIVE_PATH',
          })
          continue
        }

        const uncResolution = resolveAllowlistedUncPath(allowlistRoots, rootId, normPath.relativeWin32Path)
        if (!uncResolution.ok) {
          unmappedEntryIdSet.add(srcEntryId)
          unmappedEntries.push({
            sourceEntryId: srcEntryId,
            rawPath: maskPathForSanitizedReport(rawPath, sanitize),
            reason: uncResolution.code,
          })
          continue
        }

        const relativeWin32Path = uncResolution.normalizedRelativePath
        const filename = path.win32.basename(relativeWin32Path)
        const extFromFilename = path.win32.extname(filename).replace(/^\./, '').toLowerCase()
        const extension = extFromFilename || String(entry.suffix ?? '').replace(/^\./, '').toLowerCase()

        // Rule D2.5: Skip .db (e.g. Thumbs.db) and .vsmeta system/sidecar files
        if (extension === 'db' || extension === 'vsmeta') {
          skippedSidecarEntryIdSet.add(srcEntryId)
          const assocTags = (tagIdsByEntryId.get(srcEntryId) ?? []).filter(tid => sourceTagIdSet.has(tid))
          skippedSidecarEntries.push({
            sourceEntryId: srcEntryId,
            relativePath: maskPathForSanitizedReport(relativeWin32Path, sanitize),
            filename: sanitize ? `sidecar_${srcEntryId}.${extension}` : filename,
            extension,
            reason: extension === 'vsmeta' ? 'SYNOLOGY_VSMETA_SIDECAR' : 'SYSTEM_DB_SIDECAR',
            associatedSourceTagIds: assocTags,
          })

          if (extension === 'db' && filename.toLowerCase() !== 'thumbs.db') {
            warnings.push({
              code: 'NON_THUMBS_DB_FILE_SKIPPED',
              message: `Skipped a .db file whose filename is not Thumbs.db: "${filename}" (entry_id=${srcEntryId})`,
              details: {
                sourceEntryId: srcEntryId,
                filename: sanitize ? `file_${srcEntryId}.db` : filename,
              },
            })
          }
          continue
        }

        // Guard against duplicate normalized paths under the same root_id
        const pathLookupKey = relativeWin32Path.toLowerCase()
        const existingOwnerEntryId = seenNormalizedRelativePaths.get(pathLookupKey)
        if (existingOwnerEntryId !== undefined) {
          duplicatePathEntries.push({
            sourceEntryId: srcEntryId,
            normalizedRelativePath: maskPathForSanitizedReport(relativeWin32Path, sanitize),
            keptSourceEntryId: existingOwnerEntryId,
          })
          continue
        }
        seenNormalizedRelativePaths.set(pathLookupKey, srcEntryId)

        const entryTextFields = textFieldsByEntry.get(srcEntryId) ?? []
        const entryDatetimeFields = datetimeFieldsByEntry.get(srcEntryId) ?? []

        // Extract title from text_fields if present
        let title: string | null = null
        for (const tf of entryTextFields) {
          if (String(tf.name).trim().toLowerCase() === 'title' && tf.value && String(tf.value).trim().length > 0) {
            title = String(tf.value).trim()
            break
          }
        }

        // Rule D2.2: Catalog number precedence: text_fields > filename > parent directory > NULL
        let catalogNumber: string | null = null
        let catalogSource: 'text_field' | 'filename' | 'directory' | null = null

        for (const tf of entryTextFields) {
          const candidate = extractCatalogNumber(tf.value)
          if (candidate) {
            catalogNumber = candidate
            catalogSource = 'text_field'
            break
          }
        }
        if (!catalogNumber) {
          const fromFilename = extractCatalogNumber(filename)
          if (fromFilename) {
            catalogNumber = fromFilename
            catalogSource = 'filename'
          }
        }
        if (!catalogNumber) {
          const parentDir = path.win32.dirname(relativeWin32Path)
          if (parentDir && parentDir !== '.') {
            const fromDir = extractCatalogNumber(parentDir)
            if (fromDir) {
              catalogNumber = fromDir
              catalogSource = 'directory'
            }
          }
        }

        if (catalogNumber && catalogSource) {
          entriesWithCatalog += 1
          catalogBySource[catalogSource] += 1
        } else {
          entriesWithoutCatalog += 1
        }

        // Rule D2.3: Media date precedence: datetime_fields > text_fields ISO date > filename/path YYYY-MM-DD > NULL
        // Never fabricate media_date from date_created, date_modified, or date_added!
        let mediaDate: string | null = null
        let dateSource: 'datetime_field' | 'text_field' | 'filename_or_path' | null = null

        for (const df of entryDatetimeFields) {
          const candidate = extractIsoDate(df.value)
          if (candidate) {
            mediaDate = candidate
            dateSource = 'datetime_field'
            break
          }
        }
        if (!mediaDate) {
          for (const tf of entryTextFields) {
            const candidate = extractIsoDate(tf.value)
            if (candidate) {
              mediaDate = candidate
              dateSource = 'text_field'
              break
            }
          }
        }
        if (!mediaDate) {
          const fromPath = extractIsoDate(relativeWin32Path)
          if (fromPath) {
            mediaDate = fromPath
            dateSource = 'filename_or_path'
          }
        }

        if (mediaDate && dateSource) {
          entriesWithMediaDate += 1
          dateBySource[dateSource] += 1
        } else {
          entriesWithoutMediaDate += 1
        }

        // Optional local filesystem check if mediaRootDir is provided
        let fileSize: number | null = null
        let fileMtime: string | null = null
        let status: 'indexed' | 'missing' = 'indexed'
        if (options.mediaRootDir) {
          const localMirrorPath = path.join(
            path.resolve(options.mediaRootDir),
            ...relativeWin32Path.split('\\'),
          )
          if (existsSync(localMirrorPath)) {
            const st = statSync(localMirrorPath)
            fileSize = st.size
            fileMtime = st.mtime.toISOString()
            status = 'indexed'
          } else {
            status = 'missing'
          }
        }

        const addedAt = entry.date_added ? String(entry.date_added) : null
        const sourceKey = `tagstudio:${srcEntryId}`

        const info = insertMediaFileStmt.run(
          rootId,
          relativeWin32Path,
          filename,
          extension,
          title,
          catalogNumber,
          catalogSource,
          mediaDate,
          dateSource,
          addedAt,
          fileSize,
          fileMtime,
          status,
          sourceKey,
        )
        const targetMediaId = Number(info.lastInsertRowid)
        sourceEntryIdToTargetMediaId.set(srcEntryId, targetMediaId)
        upsertLegacyIdStmt.run(String(srcEntryId), 'entry', targetMediaId)
        importedEntriesCount += 1

        // Preserve text_fields for this imported entry
        for (let idx = 0; idx < entryTextFields.length; idx++) {
          const tf = entryTextFields[idx]!
          const tfInfo = insertTextFieldStmt.run(
            targetMediaId,
            String(tf.name),
            String(tf.value ?? ''),
            Number(tf.is_multiline) ? 1 : 0,
            idx,
          )
          upsertLegacyIdStmt.run(String(tf.id), 'text_field', Number(tfInfo.lastInsertRowid))
          importedTextFieldsCount += 1
        }
      }

      skippedOrOrphanedTextFieldsCount = sourceSnapshot.textFields.length - importedTextFieldsCount

      // 6. Reconcile & import tag_entries (`D2.1`)
      let importedMediaTagsCount = 0
      let deduplicatedAfterTagMergeCount = 0
      let skippedSidecarTagEntriesCount = 0
      let orphanedTagEntriesCount = 0
      let missingEntryOnly = 0
      let missingTagOnly = 0
      let missingBoth = 0
      let unmappedEntryAssoc = 0

      const insertedMediaTagPairs = new Set<string>()
      const insertMediaTagStmt = db.prepare(
        `INSERT INTO media_tags (media_id, tag_id, source, confidence, created_at)
         VALUES (?, ?, 'tagstudio-import', NULL, ?)`,
      )

      for (const te of sourceSnapshot.tagEntries) {
        const srcEntryId = Number(te.entry_id)
        const srcTagId = Number(te.tag_id)
        const entryExistsInSource = sourceEntryIdSet.has(srcEntryId)
        const tagExistsInSource = sourceTagIdSet.has(srcTagId)

        if (!entryExistsInSource || !tagExistsInSource) {
          orphanedTagEntriesCount += 1
          if (!entryExistsInSource && !tagExistsInSource) {
            missingBoth += 1
          } else if (!entryExistsInSource) {
            missingEntryOnly += 1
          } else {
            missingTagOnly += 1
          }
          continue
        }

        if (skippedSidecarEntryIdSet.has(srcEntryId)) {
          skippedSidecarTagEntriesCount += 1
          continue
        }

        const targetMediaId = sourceEntryIdToTargetMediaId.get(srcEntryId)
        const targetTagId = sourceTagIdToTargetTagId.get(srcTagId)
        if (targetMediaId === undefined || targetTagId === undefined) {
          orphanedTagEntriesCount += 1
          unmappedEntryAssoc += 1
          continue
        }

        const pairKey = `${targetMediaId}:${targetTagId}`
        if (insertedMediaTagPairs.has(pairKey)) {
          deduplicatedAfterTagMergeCount += 1
          continue
        }
        insertedMediaTagPairs.add(pairKey)
        insertMediaTagStmt.run(targetMediaId, targetTagId, startedAtIso)
        importedMediaTagsCount += 1
      }

      if (options.injectFaultBeforeCommit) {
        throw new Error('Injected fault before commit to verify transaction rollback (`B5`)')
      }

      // Verify reconciliation equations (`B4`)
      const entriesReconciled =
        importedEntriesCount +
          skippedSidecarEntries.length +
          unmappedEntries.length +
          duplicatePathEntries.length ===
        sourceSnapshot.entries.length

      const tagsReconciled =
        importedTagsCount + mergedDuplicateTagsCount === sourceSnapshot.tags.length

      const aliasesReconciled =
        importedTagAliasesCount + deduplicatedTagAliasesCount + orphanedTagAliases.length ===
        sourceSnapshot.aliases.length

      const parentsReconciled =
        importedTagParentsCount +
          deduplicatedTagParentsCount +
          selfLoopTagParents.length +
          orphanedTagParents.length ===
        sourceSnapshot.parents.length

      const tagEntriesReconciled =
        importedMediaTagsCount +
          deduplicatedAfterTagMergeCount +
          skippedSidecarTagEntriesCount +
          orphanedTagEntriesCount ===
        sourceSnapshot.tagEntries.length

      const textFieldsReconciled =
        importedTextFieldsCount + skippedOrOrphanedTextFieldsCount ===
        sourceSnapshot.textFields.length

      const allReconciled =
        entriesReconciled &&
        tagsReconciled &&
        aliasesReconciled &&
        parentsReconciled &&
        tagEntriesReconciled &&
        textFieldsReconciled

      if (!allReconciled) {
        throw new Error(
          `TagStudio import reconciliation failed: entries=${entriesReconciled}, tags=${tagsReconciled}, aliases=${aliasesReconciled}, parents=${parentsReconciled}, tagEntries=${tagEntriesReconciled}, textFields=${textFieldsReconciled}`,
        )
      }

      const reconciliation: TagStudioReconciliationSummary = {
        entries: {
          sourceEntries: sourceSnapshot.entries.length,
          importedEntries: importedEntriesCount,
          skippedSidecarEntries: skippedSidecarEntries.length,
          unmappedEntries: unmappedEntries.length,
          duplicatePathEntries: duplicatePathEntries.length,
          reconciled: entriesReconciled,
        },
        tags: {
          sourceTags: sourceSnapshot.tags.length,
          importedTags: importedTagsCount,
          mergedDuplicateTags: mergedDuplicateTagsCount,
          reconciled: tagsReconciled,
        },
        tagAliases: {
          sourceTagAliases: sourceSnapshot.aliases.length,
          importedTagAliases: importedTagAliasesCount,
          deduplicatedTagAliases: deduplicatedTagAliasesCount,
          orphanedTagAliases: orphanedTagAliases.length,
          reconciled: aliasesReconciled,
        },
        tagParents: {
          sourceTagParents: sourceSnapshot.parents.length,
          importedTagParents: importedTagParentsCount,
          deduplicatedTagParents: deduplicatedTagParentsCount,
          selfLoopTagParents: selfLoopTagParents.length,
          orphanedTagParents: orphanedTagParents.length,
          reconciled: parentsReconciled,
        },
        tagEntries: {
          sourceTagEntries: sourceSnapshot.tagEntries.length,
          importedMediaTags: importedMediaTagsCount,
          deduplicatedAfterTagMerge: deduplicatedAfterTagMergeCount,
          skippedSidecarTagEntries: skippedSidecarTagEntriesCount,
          orphanedTagEntries: orphanedTagEntriesCount,
          orphanBreakdown: {
            missingEntryOnly,
            missingTagOnly,
            missingBoth,
            unmappedEntry: unmappedEntryAssoc,
          },
          reconciled: tagEntriesReconciled,
        },
        textFields: {
          sourceTextFields: sourceSnapshot.textFields.length,
          importedTextFields: importedTextFieldsCount,
          skippedOrOrphanedTextFields: skippedOrOrphanedTextFieldsCount,
          reconciled: textFieldsReconciled,
        },
        allReconciled,
      }

      // Run foreign_key_check and integrity_check before committing (`B5`)
      const preCommitHealth = runDatabaseHealthChecks(db)
      if (!preCommitHealth.ok) {
        throw new Error(
          `Database health check failed prior to commit: fk=${JSON.stringify(preCommitHealth.foreignKeyErrors)}, integrity=${JSON.stringify(preCommitHealth.integrityCheck)}`,
        )
      }

      const finishedAtIso = nowFn().toISOString()
      const preliminaryCounts = collectDatabaseTableCounts(db)
      const finalCounts: DatabaseTableCounts = {
        ...preliminaryCounts,
        importRuns: preliminaryCounts.importRuns + 1,
      }

      const report: TagStudioImportReport = {
        generatedAt: finishedAtIso,
        mode,
        status: 'succeeded',
        sanitized: sanitize,
        rootId,
        canonicalUncRoot,
        sourceFingerprint,
        source: {
          path: sanitize ? path.basename(resolvedSourcePath) : resolvedSourcePath,
          sha256Before: fpBefore.sha256,
          sha256After: fpAfter.sha256,
          unchanged: fpBefore.sha256 === fpAfter.sha256,
          size: fpAfter.size,
          mtimeIso: fpAfter.mtimeIso,
        },
        reconciliation,
        catalogAndDateSummary: {
          entriesWithCatalog,
          entriesWithoutCatalog,
          catalogBySource,
          entriesWithMediaDate,
          entriesWithoutMediaDate,
          dateBySource,
        },
        mergedDuplicateTags,
        skippedSidecarEntries,
        unmappedEntries,
        duplicatePathEntries,
        sharedAliases,
        orphanedTagAliases,
        orphanedTagParents,
        selfLoopTagParents,
        warnings,
        targetHealth: preCommitHealth,
        targetTableCounts: finalCounts,
      }

      db.prepare(
        `INSERT INTO import_runs (
           source_type, source_fingerprint, source_sha256, root_id,
           mode, started_at, finished_at, status, report_json
         ) VALUES ('tagstudio', ?, ?, ?, ?, ?, ?, 'succeeded', ?)`,
      ).run(
        sourceFingerprint,
        fpBefore.sha256,
        rootId,
        mode,
        startedAtIso,
        finishedAtIso,
        JSON.stringify(report),
      )

      db.exec('COMMIT;')
      return report
    } catch (err) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        // Ignore rollback error if transaction already closed
      }
      throw err
    }
  } finally {
    db.close()
  }
}
