import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { snapshotFileFingerprint } from '../inventory/tagstudio-inventory.ts'
import {
  type DatabaseHealthCheckResult,
  isNetworkSharePath,
  resolveLocalDatabasePath,
  runDatabaseHealthChecks,
} from './schema.ts'

export interface DatabaseTableCounts {
  readonly schemaVersions: number
  readonly mediaRoots: number
  readonly mediaFiles: number
  readonly tags: number
  readonly tagAliases: number
  readonly tagParents: number
  readonly mediaTags: number
  readonly mediaTextFields: number
  readonly importRuns: number
  readonly legacyIds: number
}

export interface BackupVerificationResult {
  readonly backupPath: string
  readonly sha256: string
  readonly size: number
  readonly health: DatabaseHealthCheckResult
  readonly counts: DatabaseTableCounts
}

export interface RestoreVerificationResult {
  readonly backupPath: string
  readonly targetDbPath: string
  readonly sha256: string
  readonly health: DatabaseHealthCheckResult
  readonly sourceCounts: DatabaseTableCounts
  readonly restoredCounts: DatabaseTableCounts
  readonly countsMatch: boolean
}

function countTableRows(db: DatabaseSync, tableName: string): number {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { 1: number } | undefined
  if (!exists) return 0
  const row = db.prepare(`SELECT COUNT(*) AS cnt FROM "${tableName}"`).get() as { cnt: number }
  return Number(row.cnt)
}

/**
 * Collect exact row counts for all owned media-library tables.
 */
export function collectDatabaseTableCounts(db: DatabaseSync): DatabaseTableCounts {
  return {
    schemaVersions: countTableRows(db, 'schema_versions'),
    mediaRoots: countTableRows(db, 'media_roots'),
    mediaFiles: countTableRows(db, 'media_files'),
    tags: countTableRows(db, 'tags'),
    tagAliases: countTableRows(db, 'tag_aliases'),
    tagParents: countTableRows(db, 'tag_parents'),
    mediaTags: countTableRows(db, 'media_tags'),
    mediaTextFields: countTableRows(db, 'media_text_fields'),
    importRuns: countTableRows(db, 'import_runs'),
    legacyIds: countTableRows(db, 'legacy_ids'),
  }
}

export function areTableCountsEqual(a: DatabaseTableCounts, b: DatabaseTableCounts): boolean {
  return (
    a.schemaVersions === b.schemaVersions &&
    a.mediaRoots === b.mediaRoots &&
    a.mediaFiles === b.mediaFiles &&
    a.tags === b.tags &&
    a.tagAliases === b.tagAliases &&
    a.tagParents === b.tagParents &&
    a.mediaTags === b.mediaTags &&
    a.mediaTextFields === b.mediaTextFields &&
    a.importRuns === b.importRuns &&
    a.legacyIds === b.legacyIds
  )
}

/**
 * Create a consistent online SQLite backup using `node:sqlite`'s native `backup()` API (`B7`)
 * and verify `foreign_key_check` + `integrity_check` + table counts on the created backup file.
 */
export async function createDatabaseBackup(
  source: DatabaseSync | string,
  backupFilePath: string,
): Promise<BackupVerificationResult> {
  if (isNetworkSharePath(backupFilePath)) {
    throw new Error(`Invalid backup destination "${backupFilePath}": online backup target must be a local path`)
  }
  const resolvedBackupPath = path.resolve(backupFilePath)
  mkdirSync(path.dirname(resolvedBackupPath), { recursive: true })
  if (existsSync(resolvedBackupPath)) {
    rmSync(resolvedBackupPath, { force: true })
  }

  if (typeof source === 'string') {
    const resolvedSourcePath = resolveLocalDatabasePath({ dbPath: source })
    const srcDb = new DatabaseSync(resolvedSourcePath, { readOnly: true })
    try {
      await backup(srcDb, resolvedBackupPath)
    } finally {
      srcDb.close()
    }
  } else {
    await backup(source, resolvedBackupPath)
  }

  const verifyDb = new DatabaseSync(resolvedBackupPath, { readOnly: true })
  let health: DatabaseHealthCheckResult
  let counts: DatabaseTableCounts
  try {
    verifyDb.exec('PRAGMA foreign_keys = ON;')
    health = runDatabaseHealthChecks(verifyDb)
    if (!health.ok) {
      throw new Error(
        `Backup health check failed for ${resolvedBackupPath}: fk=${JSON.stringify(health.foreignKeyErrors)}, integrity=${JSON.stringify(health.integrityCheck)}`,
      )
    }
    counts = collectDatabaseTableCounts(verifyDb)
  } finally {
    verifyDb.close()
  }

  const fp = snapshotFileFingerprint(resolvedBackupPath)
  return {
    backupPath: resolvedBackupPath,
    sha256: fp.sha256,
    size: fp.size,
    health,
    counts,
  }
}

/**
 * Restore a backup into `targetDbPath` (e.g. an empty data directory) using `node:sqlite`'s `backup()` API,
 * verifying `foreign_key_check`, `integrity_check`, and exact table count parity before atomic swap (`B7`).
 */
export async function restoreDatabaseFromBackup(
  backupFilePath: string,
  targetDbPath: string,
  options?: { readonly pluginPackageDir?: string | undefined },
): Promise<RestoreVerificationResult> {
  const resolvedBackupPath = path.resolve(backupFilePath)
  if (!existsSync(resolvedBackupPath)) {
    throw new Error(`Backup file does not exist: ${resolvedBackupPath}`)
  }
  const resolvedTargetPath = resolveLocalDatabasePath({
    dbPath: targetDbPath,
    pluginPackageDir: options?.pluginPackageDir,
  })
  if (resolvedTargetPath === ':memory:') {
    throw new Error('Cannot restore database backup to :memory: path')
  }
  if (resolvedBackupPath === resolvedTargetPath) {
    throw new Error('Backup path and target database path must be distinct')
  }

  mkdirSync(path.dirname(resolvedTargetPath), { recursive: true })
  const stagingPath = `${resolvedTargetPath}.restore-tmp-${process.pid}`
  if (existsSync(stagingPath)) {
    rmSync(stagingPath, { force: true })
  }

  let sourceCounts: DatabaseTableCounts
  const backupDb = new DatabaseSync(resolvedBackupPath, { readOnly: true })
  try {
    backupDb.exec('PRAGMA foreign_keys = ON;')
    const backupHealth = runDatabaseHealthChecks(backupDb)
    if (!backupHealth.ok) {
      throw new Error(
        `Source backup failed health check: fk=${JSON.stringify(backupHealth.foreignKeyErrors)}, integrity=${JSON.stringify(backupHealth.integrityCheck)}`,
      )
    }
    sourceCounts = collectDatabaseTableCounts(backupDb)
    await backup(backupDb, stagingPath)
  } finally {
    backupDb.close()
  }

  let restoredCounts: DatabaseTableCounts
  let health: DatabaseHealthCheckResult
  const verifyDb = new DatabaseSync(stagingPath, { readOnly: true })
  try {
    verifyDb.exec('PRAGMA foreign_keys = ON;')
    health = runDatabaseHealthChecks(verifyDb)
    restoredCounts = collectDatabaseTableCounts(verifyDb)
  } finally {
    verifyDb.close()
  }

  const countsMatch = areTableCountsEqual(sourceCounts, restoredCounts)
  if (!health.ok || !countsMatch) {
    rmSync(stagingPath, { force: true })
    throw new Error(
      `Restored database verification failed: healthOk=${health.ok}, countsMatch=${countsMatch}`,
    )
  }

  renameSync(stagingPath, resolvedTargetPath)
  const fp = snapshotFileFingerprint(resolvedTargetPath)

  return {
    backupPath: resolvedBackupPath,
    targetDbPath: resolvedTargetPath,
    sha256: fp.sha256,
    health,
    sourceCounts,
    restoredCounts,
    countsMatch,
  }
}
