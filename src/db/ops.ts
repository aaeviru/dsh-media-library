import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type {
  BackupKind,
  CreateBackupResult,
  ExportMappingReportResult,
  ManagedBackupEntry,
  MappingReportFormat,
} from '../types.ts'
import { createDatabaseBackup } from './backup.ts'
import { getCurrentSchemaVersion, isNetworkSharePath } from './schema.ts'

export const DEFAULT_DAILY_BACKUP_RETENTION = 14
export const DEFAULT_PRE_MIGRATE_BACKUP_RETENTION = 5
export const DAILY_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000

const DAILY_PREFIX = 'library-backup-'
const BACKUP_EXT = '.sqlite3'
const STATE_FILENAME = '.backup-state.json'

export interface ChangeWatermark {
  readonly maxMutationId: number
  readonly maxImportId: number
  readonly mediaCount: number
  readonly tagCount: number
}

export interface AutoBackupStateFile {
  readonly lastBackupAt: string
  readonly lastBackupPath: string
  readonly lastSha256: string
  readonly watermark: ChangeWatermark
}

const DAILY_BACKUP_FILENAME_RE = /^library-backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.sqlite3$/
const PRE_MIGRATE_BACKUP_FILENAME_RE = /^pre-migrate-v\d+-to-v\d+-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.sqlite3$/

export interface ParsedBackupFilename {
  readonly kind: BackupKind
  readonly timestampMs: number
  readonly timestampIso: string
}

/**
 * Strictly parse plugin-generated backup filenames and extract their UTC timestamp (`Issue #36`).
 * Returns `null` for manual/unrelated files even if they share prefixes or `.sqlite3` extension.
 */
export function parseManagedBackupFilename(filename: string): ParsedBackupFilename | null {
  let kind: BackupKind
  let match = DAILY_BACKUP_FILENAME_RE.exec(filename)
  if (match) {
    kind = 'daily'
  } else {
    match = PRE_MIGRATE_BACKUP_FILENAME_RE.exec(filename)
    if (!match) return null
    kind = 'pre-migrate'
  }
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
  const timestampMs = Date.parse(iso)
  if (!Number.isFinite(timestampMs)) return null
  // Guard against calendar rollovers such as 2026-02-31.
  if (new Date(timestampMs).toISOString() !== iso) return null
  return { kind, timestampMs, timestampIso: iso }
}

export function classifyBackupFilename(filename: string): BackupKind | null {
  return parseManagedBackupFilename(filename)?.kind ?? null
}

/**
 * List plugin-managed `.sqlite3` backups in `backupDir`, newest first by parsed backup timestamp.
 * Ignores unrelated or user-placed files so retention pruning never touches them.
 */
export function listManagedBackups(backupDir: string): ManagedBackupEntry[] {
  if (!fs.existsSync(backupDir)) return []
  const entries = fs.readdirSync(backupDir, { withFileTypes: true })
  const result: Array<ManagedBackupEntry & { readonly parsedTimestampMs: number }> = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const parsed = parseManagedBackupFilename(entry.name)
    if (!parsed) continue
    const fullPath = path.join(backupDir, entry.name)
    const stat = fs.statSync(fullPath)
    result.push({
      filename: entry.name,
      path: fullPath,
      kind: parsed.kind,
      size: stat.size,
      mtimeIso: stat.mtime.toISOString(),
      parsedTimestampMs: parsed.timestampMs,
    })
  }
  result.sort(
    (a, b) =>
      b.parsedTimestampMs - a.parsedTimestampMs ||
      b.mtimeIso.localeCompare(a.mtimeIso) ||
      b.filename.localeCompare(a.filename),
  )
  return result.map(({ parsedTimestampMs: _ignored, ...entry }) => entry)
}

/**
 * Delete only excess plugin-managed backups beyond `dailyRetention` / `preMigrateRetention`.
 * Never removes user-created files or drops below 1 when retention >= 1.
 */
export function pruneManagedBackups(
  backupDir: string,
  options?: {
    readonly dailyRetention?: number | undefined
    readonly preMigrateRetention?: number | undefined
  },
): string[] {
  const dailyLimit = Math.max(1, options?.dailyRetention ?? DEFAULT_DAILY_BACKUP_RETENTION)
  const preMigrateLimit = Math.max(1, options?.preMigrateRetention ?? DEFAULT_PRE_MIGRATE_BACKUP_RETENTION)
  const all = listManagedBackups(backupDir)

  const daily = all.filter(b => b.kind === 'daily')
  const preMigrate = all.filter(b => b.kind === 'pre-migrate')

  const removed: string[] = []
  for (const stale of daily.slice(dailyLimit)) {
    fs.rmSync(stale.path, { force: true })
    removed.push(stale.path)
  }
  for (const stale of preMigrate.slice(preMigrateLimit)) {
    fs.rmSync(stale.path, { force: true })
    removed.push(stale.path)
  }
  return removed
}

/**
 * Create a verified online SQLite backup (`B1`), prune old local backups only AFTER verification succeeds,
 * and optionally copy the verified local backup to `nasBackupDir` (with independent pruning).
 */
export async function createOperationalBackup(options: {
  readonly dbPath: string
  readonly backupDir: string
  readonly nasBackupDir?: string | undefined
  readonly dailyRetention?: number | undefined
  readonly preMigrateRetention?: number | undefined
  readonly now?: (() => Date) | undefined
}): Promise<CreateBackupResult> {
  if (isNetworkSharePath(options.backupDir)) {
    return {
      ok: false,
      error: `Invalid local backupDir "${options.backupDir}": online backup target must be local`,
    }
  }
  const nowFn = options.now ?? (() => new Date())
  const stamp = nowFn().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(options.backupDir, `${DAILY_PREFIX}${stamp}${BACKUP_EXT}`)

  try {
    const verified = await createDatabaseBackup(options.dbPath, backupPath)
    // Only prune stale backups AFTER the newly created backup passed integrity_check & foreign_key_check.
    const pruned = pruneManagedBackups(options.backupDir, {
      dailyRetention: options.dailyRetention,
      preMigrateRetention: options.preMigrateRetention,
    })

    let nasCopyPath: string | null = null
    let nasCopyWarning: string | null = null
    const rawNasDir = options.nasBackupDir?.trim() ?? ''
    if (rawNasDir) {
      try {
        fs.mkdirSync(rawNasDir, { recursive: true })
        const dest = path.join(rawNasDir, path.basename(verified.backupPath))
        fs.copyFileSync(verified.backupPath, dest)
        pruneManagedBackups(rawNasDir, {
          dailyRetention: options.dailyRetention,
          preMigrateRetention: options.preMigrateRetention,
        })
        nasCopyPath = dest
      } catch (nasErr) {
        nasCopyWarning = `Local backup succeeded, but NAS archive copy failed: ${nasErr instanceof Error ? nasErr.message : String(nasErr)}`
      }
    }

    return {
      ok: true,
      backupPath: verified.backupPath,
      sha256: verified.sha256,
      size: verified.size,
      prunedCount: pruned.length,
      nasCopyPath,
      nasCopyWarning,
    }
  } catch (err) {
    // Clean up failed partial backup if any.
    fs.rmSync(backupPath, { force: true })
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function safeMaxId(db: DatabaseSync, tableName: string): number {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { 1: number } | undefined
  if (!exists) return 0
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) AS maxId FROM "${tableName}"`).get() as { maxId: number }
  return Number(row.maxId)
}

function safeCount(db: DatabaseSync, tableName: string): number {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { 1: number } | undefined
  if (!exists) return 0
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM "${tableName}"`).get() as { cnt: number }
  return Number(row.cnt)
}

export function readChangeWatermark(db: DatabaseSync): ChangeWatermark {
  return {
    maxMutationId: safeMaxId(db, 'mutation_log'),
    maxImportId: safeMaxId(db, 'import_runs'),
    mediaCount: safeCount(db, 'media_files'),
    tagCount: safeCount(db, 'tags'),
  }
}

export function readAutoBackupState(backupDir: string): AutoBackupStateFile | null {
  const statePath = path.join(backupDir, STATE_FILENAME)
  if (!fs.existsSync(statePath)) return null
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8')) as AutoBackupStateFile
  } catch {
    return null
  }
}

export function writeAutoBackupState(backupDir: string, state: AutoBackupStateFile): void {
  fs.mkdirSync(backupDir, { recursive: true })
  fs.writeFileSync(path.join(backupDir, STATE_FILENAME), JSON.stringify(state, null, 2), 'utf8')
}

export function shouldTriggerDailyAutoBackup(
  prevState: AutoBackupStateFile | null,
  currentWatermark: ChangeWatermark,
  now: Date,
  intervalMs = DAILY_BACKUP_INTERVAL_MS,
): boolean {
  const hasAnyData =
    currentWatermark.mediaCount > 0 ||
    currentWatermark.tagCount > 0 ||
    currentWatermark.maxMutationId > 0 ||
    currentWatermark.maxImportId > 0
  if (!hasAnyData) return false

  if (!prevState) return true

  const elapsed = now.getTime() - new Date(prevState.lastBackupAt).getTime()
  if (!Number.isFinite(elapsed) || elapsed < intervalMs) return false

  return (
    currentWatermark.maxMutationId > prevState.watermark.maxMutationId ||
    currentWatermark.maxImportId > prevState.watermark.maxImportId
  )
}

/**
 * Run daily auto-backup at most once per 24h and only when new mutations or imports occurred (`B2`).
 */
export async function maybeRunDailyAutoBackup(options: {
  readonly db: DatabaseSync
  readonly dbPath: string
  readonly backupDir: string
  readonly nasBackupDir?: string | undefined
  readonly dailyRetention?: number | undefined
  readonly preMigrateRetention?: number | undefined
  readonly now?: (() => Date) | undefined
  readonly intervalMs?: number | undefined
}): Promise<CreateBackupResult | null> {
  const nowFn = options.now ?? (() => new Date())
  const now = nowFn()
  const watermark = readChangeWatermark(options.db)
  const prevState = readAutoBackupState(options.backupDir)
  if (!shouldTriggerDailyAutoBackup(prevState, watermark, now, options.intervalMs)) {
    return null
  }
  const result = await createOperationalBackup({
    dbPath: options.dbPath,
    backupDir: options.backupDir,
    nasBackupDir: options.nasBackupDir,
    dailyRetention: options.dailyRetention,
    preMigrateRetention: options.preMigrateRetention,
    now: () => now,
  })
  if (result.ok && result.backupPath && result.sha256) {
    writeAutoBackupState(options.backupDir, {
      lastBackupAt: now.toISOString(),
      lastBackupPath: result.backupPath,
      lastSha256: result.sha256,
      watermark,
    })
  }
  return result
}

function escapeCsvCell(value: string): string {
  const neutralized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  if (/[",\r\n]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`
  }
  return neutralized
}

/**
 * Export a portable read-only JSON or RFC4180 CSV mapping report for recovery and audit (`B5`).
 */
export function exportPortableMappingReport(
  db: DatabaseSync,
  options: {
    readonly format: MappingReportFormat
    readonly appVersion: string
    readonly now?: (() => Date) | undefined
  },
): ExportMappingReportResult {
  const now = (options.now ?? (() => new Date()))()
  const schemaVersion = getCurrentSchemaVersion(db)

  const mediaRows = db
    .prepare(
      `SELECT mf.id, mf.root_id, mr.canonical_unc_root, mf.relative_path, mf.filename,
              mf.title, mf.catalog_number, mf.media_date, mf.status, mf.revision
       FROM media_files mf
       LEFT JOIN media_roots mr ON mr.id = mf.root_id
       ORDER BY mf.id ASC`,
    )
    .all() as Array<{
    id: number
    root_id: string
    canonical_unc_root: string | null
    relative_path: string
    filename: string
    title: string | null
    catalog_number: string | null
    media_date: string | null
    status: string
    revision: number
  }>

  const tagRows = db
    .prepare(
      `SELECT mt.media_id, t.id AS tag_id, t.name, t.archived_at, mt.source
       FROM media_tags mt
       INNER JOIN tags t ON t.id = mt.tag_id
       ORDER BY mt.media_id ASC, t.normalized_name ASC, t.id ASC`,
    )
    .all() as Array<{
    media_id: number
    tag_id: number
    name: string
    archived_at: string | null
    source: string
  }>

  const aliasRows = db
    .prepare('SELECT tag_id, alias FROM tag_aliases ORDER BY tag_id ASC, normalized_alias ASC')
    .all() as Array<{ tag_id: number; alias: string }>

  const aliasesByTag = new Map<number, string[]>()
  for (const row of aliasRows) {
    const list = aliasesByTag.get(Number(row.tag_id))
    if (list) list.push(String(row.alias))
    else aliasesByTag.set(Number(row.tag_id), [String(row.alias)])
  }

  const tagsByMedia = new Map<
    number,
    Array<{ id: number; name: string; source: string; archived: boolean; aliases: string[] }>
  >()
  for (const row of tagRows) {
    const mId = Number(row.media_id)
    const tId = Number(row.tag_id)
    const entry = {
      id: tId,
      name: String(row.name),
      source: String(row.source),
      archived: row.archived_at !== null,
      aliases: aliasesByTag.get(tId) ?? [],
    }
    const list = tagsByMedia.get(mId)
    if (list) list.push(entry)
    else tagsByMedia.set(mId, [entry])
  }

  const stamp = now.toISOString().replace(/[:.]/g, '-')
  if (options.format === 'json') {
    const payload = {
      exportedAt: now.toISOString(),
      appVersion: options.appVersion,
      schemaVersion,
      rowCount: mediaRows.length,
      items: mediaRows.map(m => ({
        mediaId: String(m.id),
        rootId: String(m.root_id),
        uncRoot: m.canonical_unc_root ? String(m.canonical_unc_root) : null,
        relativePath: String(m.relative_path),
        filename: String(m.filename),
        title: m.title ? String(m.title) : null,
        catalogNumber: m.catalog_number ? String(m.catalog_number) : null,
        mediaDate: m.media_date ? String(m.media_date) : null,
        status: String(m.status),
        revision: Number(m.revision),
        tags: tagsByMedia.get(Number(m.id)) ?? [],
      })),
    }
    const content = `${JSON.stringify(payload, null, 2)}\n`
    return {
      ok: true,
      format: 'json',
      filename: `media-library-mapping-${stamp}.json`,
      mimeType: 'application/json',
      rowCount: mediaRows.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      content,
    }
  }

  const lines: string[] = [
    'mediaId,rootId,relativePath,filename,title,catalogNumber,mediaDate,status,tags,aliases',
  ]
  for (const m of mediaRows) {
    const tags = tagsByMedia.get(Number(m.id)) ?? []
    const tagNames = tags.map(t => t.name).join(' | ')
    const aliasList = [...new Set(tags.flatMap(t => t.aliases))].join(' | ')
    lines.push(
      [
        escapeCsvCell(String(m.id)),
        escapeCsvCell(String(m.root_id)),
        escapeCsvCell(String(m.relative_path)),
        escapeCsvCell(String(m.filename)),
        escapeCsvCell(m.title ? String(m.title) : ''),
        escapeCsvCell(m.catalog_number ? String(m.catalog_number) : ''),
        escapeCsvCell(m.media_date ? String(m.media_date) : ''),
        escapeCsvCell(String(m.status)),
        escapeCsvCell(tagNames),
        escapeCsvCell(aliasList),
      ].join(','),
    )
  }
  const content = `${lines.join('\n')}\n`
  return {
    ok: true,
    format: 'csv',
    filename: `media-library-mapping-${stamp}.csv`,
    mimeType: 'text/csv;charset=utf-8',
    rowCount: mediaRows.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
    content,
  }
}
