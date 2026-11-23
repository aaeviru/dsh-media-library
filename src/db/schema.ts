import { existsSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { APP_VERSION } from '../version.ts'

export const CURRENT_SCHEMA_VERSION = 7

export interface SchemaMigration {
  readonly version: number
  readonly description: string
  readonly up: (db: DatabaseSync) => void
  readonly rebuildsReferencedTables?: boolean
}

export interface SchemaVersionRecord {
  readonly version: number
  readonly appliedAt: string
  readonly appVersion: string
  readonly description: string
}

export interface DatabaseHealthCheckResult {
  readonly ok: boolean
  readonly foreignKeyErrors: ReadonlyArray<Record<string, unknown>>
  readonly integrityCheck: readonly string[]
}

export interface MigrateDatabaseOptions {
  readonly dbPath?: string | undefined
  readonly backupDir?: string | undefined
  readonly appVersion?: string | undefined
  readonly migrations?: readonly SchemaMigration[] | undefined
  readonly now?: (() => Date) | undefined
}

export interface MigrateDatabaseResult {
  readonly previousVersion: number
  readonly currentVersion: number
  readonly appliedVersions: readonly number[]
  readonly preUpgradeBackupPath: string | null
  readonly health: DatabaseHealthCheckResult
}

export interface ResolveLocalDatabasePathOptions {
  readonly dbPath?: string | undefined
  readonly dshHome?: string | undefined
  readonly pluginPackageDir?: string | undefined
}

/**
 * Check if a raw path string points to a Windows UNC or POSIX network share (`\\server\share` or `//server/share`).
 */
export function isNetworkSharePath(rawPath: string): boolean {
  const trimmed = rawPath.trim()
  return trimmed.startsWith('\\\\') || trimmed.startsWith('//')
}

function isSubPathOf(candidatePath: string, parentDirPath: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath)
  const resolvedParent = path.resolve(parentDirPath)
  if (resolvedCandidate === resolvedParent) return true
  const rel = path.relative(resolvedParent, resolvedCandidate)
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Resolve and validate the local SQLite database path (`B1` / `D1.1`).
 * - Defaults to `%DSH_HOME%/media-library/library.sqlite3` (or `~/.dsh/media-library/library.sqlite3`).
 * - Rejects UNC/SMB paths (`\\server\share...` or `//server/share...`).
 * - Rejects paths inside the plugin package/bundle directory.
 */
export function resolveLocalDatabasePath(options?: ResolveLocalDatabasePathOptions): string {
  const raw = options?.dbPath?.trim()
  if (raw === ':memory:') {
    return ':memory:'
  }

  const dshHome = options?.dshHome?.trim() || process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')
  const candidate = raw && raw.length > 0 ? raw : path.join(dshHome, 'media-library', 'library.sqlite3')

  if (candidate.includes('\0')) {
    throw new Error('Invalid SQLite database path: NUL byte is not allowed')
  }
  if (isNetworkSharePath(candidate) || isNetworkSharePath(dshHome)) {
    throw new Error(
      `Invalid SQLite database path "${candidate}": online SQLite database must reside on local disk, never on an SMB/UNC share`,
    )
  }

  const resolved = path.resolve(candidate)
  if (options?.pluginPackageDir && isSubPathOf(resolved, options.pluginPackageDir)) {
    throw new Error(
      `Invalid SQLite database path "${resolved}": database must not be stored inside the plugin package directory "${path.resolve(options.pluginPackageDir)}"`,
    )
  }

  return resolved
}

/**
 * Open a local SQLite connection with `PRAGMA foreign_keys = ON` and `busy_timeout = 5000`.
 */
export function openMediaLibraryDatabase(options?: ResolveLocalDatabasePathOptions): {
  readonly db: DatabaseSync
  readonly dbPath: string
} {
  const dbPath = resolveLocalDatabasePath(options)
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(dbPath), { recursive: true })
  }
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')
  return { db, dbPath }
}

/**
 * Run `PRAGMA foreign_key_check` and `PRAGMA integrity_check` on an open SQLite connection.
 */
export function runDatabaseHealthChecks(db: DatabaseSync): DatabaseHealthCheckResult {
  const fkRows = db.prepare('PRAGMA foreign_key_check').all() as Array<Record<string, unknown>>
  const integrityRows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
  const integrityMessages = integrityRows.map(r => String(r.integrity_check))
  const integrityOk = integrityMessages.length === 1 && integrityMessages[0] === 'ok'
  return {
    ok: fkRows.length === 0 && integrityOk,
    foreignKeyErrors: fkRows,
    integrityCheck: integrityMessages,
  }
}

export const V1_SCHEMA_MIGRATION: SchemaMigration = {
  version: 1,
  description: 'Initial M2 schema: media_roots, media_files, tags, tag_aliases, tag_parents, media_tags, media_text_fields, import_runs, legacy_ids',
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE media_roots (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        canonical_unc_root TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL
      );

      CREATE TABLE media_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_id TEXT NOT NULL REFERENCES media_roots(id) ON DELETE RESTRICT,
        relative_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        extension TEXT NOT NULL,
        title TEXT,
        catalog_number TEXT,
        catalog_source TEXT CHECK (catalog_source IN ('text_field', 'filename', 'directory', 'manual') OR catalog_source IS NULL),
        media_date TEXT,
        date_source TEXT CHECK (date_source IN ('datetime_field', 'text_field', 'filename_or_path', 'manual') OR date_source IS NULL),
        added_at TEXT,
        file_size INTEGER,
        file_mtime TEXT,
        status TEXT NOT NULL DEFAULT 'indexed' CHECK (status IN ('indexed', 'missing', 'offline')),
        source_key TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(root_id, relative_path)
      );

      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        shorthand TEXT,
        color_namespace TEXT,
        color_slug TEXT,
        is_category INTEGER NOT NULL DEFAULT 0 CHECK (is_category IN (0, 1)),
        is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
        kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('builtin', 'custom', 'performer', 'studio', 'series')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE tag_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
        alias TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        UNIQUE(tag_id, normalized_alias)
      );

      CREATE TABLE tag_parents (
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
        parent_tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
        PRIMARY KEY (tag_id, parent_tag_id),
        CHECK (tag_id <> parent_tag_id)
      );

      CREATE TABLE media_tags (
        media_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
        source TEXT NOT NULL DEFAULT 'tagstudio-import' CHECK (source IN ('tagstudio-import', 'manual', 'ingestion', 'performer-rule')),
        confidence REAL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (media_id, tag_id)
      );

      CREATE TABLE media_text_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        media_id INTEGER NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
        field_name TEXT NOT NULL,
        field_value TEXT NOT NULL,
        is_multiline INTEGER NOT NULL DEFAULT 0 CHECK (is_multiline IN (0, 1)),
        position INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE import_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL,
        source_sha256 TEXT NOT NULL,
        root_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'import')),
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed', 'already_imported')),
        report_json TEXT NOT NULL
      );

      CREATE TABLE legacy_ids (
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        entity_type TEXT NOT NULL CHECK (entity_type IN ('entry', 'tag', 'tag_alias', 'text_field')),
        entity_id INTEGER NOT NULL,
        PRIMARY KEY (source_type, entity_type, source_id)
      );

      CREATE INDEX idx_media_files_catalog_number ON media_files(catalog_number);
      CREATE INDEX idx_media_files_media_date ON media_files(media_date DESC, id DESC);
      CREATE INDEX idx_media_files_filename ON media_files(filename);
      CREATE INDEX idx_media_tags_tag_media ON media_tags(tag_id, media_id);
      CREATE INDEX idx_tag_aliases_norm_tag ON tag_aliases(normalized_alias, tag_id);
      CREATE INDEX idx_legacy_ids_entity ON legacy_ids(entity_type, entity_id);
      CREATE INDEX idx_import_runs_fingerprint ON import_runs(source_type, source_fingerprint, status);
    `)
  },
}

export const V2_MEDIA_STATUS_MIGRATION: SchemaMigration = {
  version: 2,
  description: 'Persist unmapped/permission states and index stable keyset ordering',
  rebuildsReferencedTables: true,
  up(db): void {
    // SQLite's documented table-rebuild procedure: FK enforcement is disabled by
    // the runner BEFORE BEGIN, then foreign_key_check runs before COMMIT.
    // Keep the AUTOINCREMENT high-water mark, including previously deleted IDs.
    const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'media_files'").get()?.seq ?? 0
    db.exec(`
      CREATE TABLE media_files_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_id TEXT NOT NULL REFERENCES media_roots(id) ON DELETE RESTRICT,
        relative_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        extension TEXT NOT NULL,
        title TEXT,
        catalog_number TEXT,
        catalog_source TEXT CHECK (catalog_source IN ('text_field', 'filename', 'directory', 'manual') OR catalog_source IS NULL),
        media_date TEXT,
        date_source TEXT CHECK (date_source IN ('datetime_field', 'text_field', 'filename_or_path', 'manual') OR date_source IS NULL),
        added_at TEXT,
        file_size INTEGER,
        file_mtime TEXT,
        status TEXT NOT NULL DEFAULT 'indexed' CHECK (status IN ('indexed', 'missing', 'offline', 'unmapped', 'permission_denied')),
        source_key TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        UNIQUE(root_id, relative_path)
      );
      INSERT INTO media_files_v2 SELECT * FROM media_files;
      DROP TABLE media_files;
      ALTER TABLE media_files_v2 RENAME TO media_files;
      CREATE INDEX idx_media_files_catalog_number ON media_files(catalog_number);
      CREATE INDEX idx_media_files_media_date ON media_files(media_date DESC, id DESC);
      CREATE INDEX idx_media_files_keyset_order ON media_files(COALESCE(media_date, '') DESC, id DESC);
      CREATE INDEX idx_media_files_filename ON media_files(filename);
    `)
    db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'media_files'").run(sequence)
  },
}

export const V3_TAG_MANAGEMENT_MIGRATION: SchemaMigration = {
  version: 3,
  description: 'Safe tag management: tags.archived_at, tags.merged_into_id and append-only mutation_log audit table',
  up(db): void {
    db.exec(`
      ALTER TABLE tags ADD COLUMN archived_at TEXT;
      ALTER TABLE tags ADD COLUMN merged_into_id INTEGER REFERENCES tags(id) ON DELETE RESTRICT;
      CREATE TABLE mutation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        result TEXT NOT NULL
      );
      CREATE INDEX idx_mutation_log_action_ts ON mutation_log(action, ts);
      CREATE INDEX idx_tags_archived_at ON tags(archived_at);
    `)
  },
}

export const V4_INGESTION_MANIFESTS_MIGRATION: SchemaMigration = {
  version: 4,
  description: 'Recoverable M4 ingestion manifests state machine',
  up(db): void {
    db.exec(`
      CREATE TABLE ingestion_manifests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL UNIQUE,
        temp_path TEXT NOT NULL,
        target_root_id TEXT NOT NULL REFERENCES media_roots(id) ON DELETE RESTRICT,
        target_relative_path TEXT NOT NULL,
        filename TEXT NOT NULL,
        title TEXT,
        catalog_number TEXT,
        media_date TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        metadata_source TEXT,
        checksum_sha256 TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('planned', 'reviewed', 'moving', 'indexed', 'failed')),
        review_decision TEXT NOT NULL DEFAULT 'pending' CHECK (review_decision IN ('pending', 'approved', 'rejected')),
        last_error TEXT,
        indexed_media_id INTEGER REFERENCES media_files(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_ingestion_manifests_checksum ON ingestion_manifests(checksum_sha256);
      CREATE INDEX idx_ingestion_manifests_state ON ingestion_manifests(state, updated_at DESC);
    `)
  },
}

export const V5_INGESTION_TASKS_MIGRATION: SchemaMigration = {
  version: 5,
  description: 'Add ingestion_tasks table for Host concurrency lock and cross-tab progress tracking',
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ingestion_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_key TEXT NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('fetch', 'commit', 'reconcile')),
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
        message TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ingestion_tasks_target_status ON ingestion_tasks(target_key, status);
      CREATE INDEX IF NOT EXISTS idx_ingestion_tasks_started ON ingestion_tasks(started_at DESC, id DESC);
    `)
  },
}

export const V6_PERFORMER_ALIASES_MIGRATION: SchemaMigration = {
  version: 6,
  description: 'Add performer_aliases, performer_review_queue, and manifest actresses_json (Issue #8)',
  up(db): void {
    db.exec(`
      ALTER TABLE ingestion_manifests ADD COLUMN actresses_json TEXT NOT NULL DEFAULT '[]';

      CREATE TABLE IF NOT EXISTS performer_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        normalized_name TEXT NOT NULL,
        raw_alias TEXT NOT NULL,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE RESTRICT,
        policy TEXT NOT NULL DEFAULT 'auto' CHECK (policy IN ('auto', 'always_ask')),
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(normalized_name, tag_id)
      );
      CREATE INDEX IF NOT EXISTS idx_performer_aliases_norm ON performer_aliases(normalized_name);
      CREATE INDEX IF NOT EXISTS idx_performer_aliases_tag ON performer_aliases(tag_id);

      CREATE TABLE IF NOT EXISTS performer_review_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        manifest_id INTEGER REFERENCES ingestion_manifests(id) ON DELETE CASCADE,
        media_id INTEGER REFERENCES media_files(id) ON DELETE CASCADE,
        raw_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('unknown', 'ambiguous', 'archived_target')),
        candidate_tag_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'skipped')),
        resolution_mode TEXT,
        resolved_tag_id INTEGER REFERENCES tags(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(manifest_id, normalized_name)
      );
      CREATE INDEX IF NOT EXISTS idx_performer_review_status ON performer_review_queue(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_performer_review_manifest ON performer_review_queue(manifest_id);
    `)
  },
}

export const V7_INGESTION_PROGRESS_MIGRATION: SchemaMigration = {
  version: 7,
  description: 'Persist ingestion phase independently of task outcome (Issue #30)',
  up(db): void {
    db.exec(`
      ALTER TABLE ingestion_tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'validation';
      ALTER TABLE ingestion_tasks ADD COLUMN phase_started_at TEXT;
      UPDATE ingestion_tasks SET phase_started_at = started_at;
    `)
  },
}

export const DEFAULT_MIGRATIONS: readonly SchemaMigration[] = [
  V1_SCHEMA_MIGRATION,
  V2_MEDIA_STATUS_MIGRATION,
  V3_TAG_MANAGEMENT_MIGRATION,
  V4_INGESTION_MANIFESTS_MIGRATION,
  V5_INGESTION_TASKS_MIGRATION,
  V6_PERFORMER_ALIASES_MIGRATION,
  V7_INGESTION_PROGRESS_MIGRATION,
]

function ensureSchemaVersionsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL,
      app_version TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    );
  `)
}

export function getAppliedSchemaVersions(db: DatabaseSync): SchemaVersionRecord[] {
  ensureSchemaVersionsTable(db)
  const rows = db
    .prepare('SELECT version, applied_at, app_version, description FROM schema_versions ORDER BY version ASC')
    .all() as Array<{ version: number; applied_at: string; app_version: string; description: string }>
  return rows.map(r => ({
    version: Number(r.version),
    appliedAt: String(r.applied_at),
    appVersion: String(r.app_version),
    description: String(r.description),
  }))
}

export function getCurrentSchemaVersion(db: DatabaseSync): number {
  const versions = getAppliedSchemaVersions(db)
  return versions.length > 0 ? versions[versions.length - 1]!.version : 0
}

/**
 * Apply pending versioned migrations (`B2`).
 * - Before upgrading an existing database (`previousVersion > 0`) on disk, creates a timestamped backup using `node:sqlite`'s `backup()` API.
 * - Executes each migration inside `BEGIN IMMEDIATE ... COMMIT` and verifies `foreign_key_check` + `integrity_check` before committing.
 * - Rolls back cleanly on any failure without replacing or corrupting the existing database.
 */
export async function migrateDatabase(
  db: DatabaseSync,
  options?: MigrateDatabaseOptions,
): Promise<MigrateDatabaseResult> {
  db.exec('PRAGMA foreign_keys = ON;')
  ensureSchemaVersionsTable(db)

  const migrations = [...(options?.migrations ?? DEFAULT_MIGRATIONS)].sort((a, b) => a.version - b.version)
  const appVersion = options?.appVersion ?? APP_VERSION
  const nowFn = options?.now ?? (() => new Date())

  const previousVersion = getCurrentSchemaVersion(db)
  const pending = migrations.filter(m => m.version > previousVersion)

  let preUpgradeBackupPath: string | null = null
  if (
    pending.length > 0 &&
    previousVersion > 0 &&
    options?.dbPath &&
    options.dbPath !== ':memory:' &&
    existsSync(options.dbPath)
  ) {
    const backupDir = options.backupDir ?? path.join(path.dirname(options.dbPath), 'backups')
    if (isNetworkSharePath(backupDir)) {
      throw new Error(`Invalid backup directory "${backupDir}": online backup destination must be a local path`)
    }
    mkdirSync(backupDir, { recursive: true })
    const stamp = nowFn().toISOString().replace(/[:.]/g, '-')
    preUpgradeBackupPath = path.join(backupDir, `pre-migrate-v${previousVersion}-to-v${pending[pending.length - 1]!.version}-${stamp}.sqlite3`)
    await backup(db, preUpgradeBackupPath)
  }

  const appliedVersions: number[] = []
  const insertVersionStmt = db.prepare(
    'INSERT INTO schema_versions (version, applied_at, app_version, description) VALUES (?, ?, ?, ?)',
  )

  for (const migration of pending) {
    if (migration.rebuildsReferencedTables) db.exec('PRAGMA foreign_keys = OFF;')
    try {
      db.exec('BEGIN IMMEDIATE;')
      migration.up(db)
      insertVersionStmt.run(migration.version, nowFn().toISOString(), appVersion, migration.description)
      const health = runDatabaseHealthChecks(db)
      if (!health.ok) {
        throw new Error(
          `Database health check failed during migration v${migration.version}: fkErrors=${JSON.stringify(health.foreignKeyErrors)}, integrity=${JSON.stringify(health.integrityCheck)}`,
        )
      }
      db.exec('COMMIT;')
      appliedVersions.push(migration.version)
    } catch (err) {
      try {
        db.exec('ROLLBACK;')
      } catch {
        // Ignore rollback error if transaction was already aborted
      }
      throw err
    } finally {
      if (migration.rebuildsReferencedTables) db.exec('PRAGMA foreign_keys = ON;')
    }
  }

  const currentVersion = getCurrentSchemaVersion(db)
  const health = runDatabaseHealthChecks(db)
  if (!health.ok) {
    throw new Error(
      `Database health check failed after migrations: fkErrors=${JSON.stringify(health.foreignKeyErrors)}, integrity=${JSON.stringify(health.integrityCheck)}`,
    )
  }

  return {
    previousVersion,
    currentVersion,
    appliedVersions,
    preUpgradeBackupPath,
    health,
  }
}
