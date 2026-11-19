# Backup, Restore & TagStudio Cold-Fallback Operations

## 1. Storage Ownership & Cutover Policy

- **Primary Metadata Store**: `%DSH_HOME%/media-library/library.sqlite3` (always local NTFS/SSD, never SMB/NAS and never inside the plugin bundle).
- **TagStudio Cold Fallback**: After switching to DSH Media Library, the original TagStudio `ts_library.sqlite` remains **read-only and untouched** as a cold fallback.
  - **No Automatic Write-Back**: Edits made in DSH Media Library (new tags, aliases, merges, batch tags) are stored only in `library.sqlite3` and are **not** synchronized back to TagStudio.
  - **Two-Week Observation Period**: Keep TagStudio archived in read-only cold status for at least **14 days** of daily DSH Media Library use before retiring TagStudio workflows.

## 2. Backup Locations & Retention Policy

- **Local Backups**: `%DSH_HOME%/media-library/backups/`
  - **Daily / Manual Backups** (`library-backup-<ISO-timestamp>.sqlite3`): Created via `node:sqlite` `backup()` API (safe while running), verified with `PRAGMA integrity_check` and `PRAGMA foreign_key_check`. Default retention: **14** most recent files.
  - **Pre-Migration Backups** (`pre-migrate-v<from>-to-v<to>-<ISO-timestamp>.sqlite3`): Automatically created before any schema upgrade. Default retention: **5** most recent files.
  - **Auto-Daily Dedupe**: Automatic startup checks run at most once per **24 hours** and only when `mutation_log` or `import_runs` shows new changes.
  - **Safe Pruning**: Stale backups matching plugin prefixes are pruned **only after** the new backup passes integrity checks. User-placed files are never deleted.
- **Optional NAS Archive Copy**: Configured via `nasBackupDir`. Only verified local backups are copied to the NAS archive directory (the plugin never runs SQLite `backup()` directly over SMB).

## 3. Recovery Objectives

- **RPO (Recovery Point Objective)**: At most 24 hours of metadata edits under automatic daily backup, or 0 edits if "Backup Now" is clicked after a tagging session.
- **RTO (Recovery Time Objective)**: < 2 minutes to restore into an empty directory and restart DSH.

## 4. Empty-Directory Restore & Version-Paired Rollback

1. Stop DSH Desktop / disable `@deepseek-ai/dsh-experimental-media-library`.
2. Choose a verified `.sqlite3` backup from `%DSH_HOME%/media-library/backups/` (or `nasBackupDir`).
3. Copy or restore it to `%DSH_HOME%/media-library/library.sqlite3` (and remove any stale `-wal`/`-shm` sidecars if present).
4. If rolling back a schema upgrade (e.g., `v7 -> v6` or `v3 -> v2`), restore the matching `pre-migrate-*` backup **and** reinstall the matching `.tgz` plugin version (`0.2.x` for v2, `0.3.x`/`0.4.x` for v3, `0.5.0` for v4, `0.5.1+` for v5, `0.6.x` for v6, `0.7.x` for v7).
5. Start DSH Desktop and open **Backup & Ops** to confirm `healthOk: true` and expected row counts.

## 5. Read-Only Degraded Mode

If startup detects a failed migration, a failed integrity check, or a database `schemaVersion` newer than the installed plugin supports:
- Host enters `READ_ONLY_DEGRADED`.
- Search, diagnostics, backup creation, and portable **JSON / CSV mapping report export** remain available.
- All mutating RPCs (`createTag`, `renameTag`, `addAlias`, `removeAlias`, `setMediaTags`, `mergeTags`, `archiveTag`, `restoreTag`, `importTagStudioCopy`, `scanStagingFiles`, `fetchIngestionMetadata`, `reviewIngestion`, `commitIngestion`, `reconcileIngestion`, `upsertPerformerAlias`, `deletePerformerAlias`, `resolvePerformerReview`, `promotePerformerTagToManual`) are blocked with `READ_ONLY_DEGRADED` until the database is restored or the plugin is upgraded.
