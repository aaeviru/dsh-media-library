# Handoff & Contract Mirror: Issue #3 — M2: Implement versioned SQLite schema and verified TagStudio import

- **Issue**: [#3](https://github.com/aaeviru/dsh-media-library/issues/3)
- **Contract Comment**: [Issue #3 Comment (`type/contract`)](https://github.com/aaeviru/dsh-media-library/issues/3#issuecomment-6894486232)
- **Branch**: `feat/3-schema-and-import`
- **Status**: `status/verified` (All `B1..B9` verified via unit tests, anonymized SQLite fixtures, 3-layer WSL `dsh web` verification, and real read-only TagStudio copy import + backup/restore reconciliation)

## 1. Summary of Deliverables

1. **Local SQLite Path Boundary, Versioned Schema & Transactional Migration Runner (`src/db/schema.ts`)**:
   - `resolveLocalDatabasePath` defaults to `%DSH_HOME%/media-library/library.sqlite3` and rejects SMB/UNC paths (`\\...` or `//...`), NUL bytes, and paths inside the plugin package/bundle directory (`B1` / `D1.1`).
   - `openMediaLibraryDatabase` enables `PRAGMA foreign_keys = ON` and `PRAGMA busy_timeout = 5000`.
   - `migrateDatabase` applies v1 schema (`schema_versions`, `media_roots`, `media_files`, `tags`, `tag_aliases`, `tag_parents`, `media_tags`, `media_text_fields`, `import_runs`, `legacy_ids`) and search indexes inside `BEGIN IMMEDIATE ... COMMIT`, creating a timestamped backup via `node:sqlite`'s native `backup()` API before cross-version upgrades (`previousVersion > 0`) and rolling back cleanly on any migration or health-check failure (`B2`).
2. **Online Backup & Empty-Directory Restore Verification (`src/db/backup.ts`)**:
   - `createDatabaseBackup` uses `node:sqlite`'s `backup()` API and verifies `PRAGMA foreign_key_check`, `PRAGMA integrity_check`, and row counts across all 10 tables.
   - `restoreDatabaseFromBackup` restores into a staging file, verifies `foreign_key_check`, `integrity_check`, and exact table count parity against the source backup, and atomically swaps into the target path (`B7`).
3. **Read-Only TagStudio Importer & Reconciliation Engine (`src/import/tagstudio-importer.ts`, `scripts/import-tagstudio.ts`)**:
   - Enforces read-only access via `withReadOnlySqlite` (`{ readOnly: true }`) and verifies source `SHA-256`, `size`, and `mtime` before and after both `dry-run` and `import` (`B3`).
   - Implements all 5 approved M1 inventory rules (`D2.1..D2.5`, `B4`):
     - `D2.1`: Reconciles `tag_entries` across `importedMediaTags`, `deduplicatedAfterTagMerge`, `skippedSidecarTagEntries`, and `orphanedTagEntries` (`missingEntryOnly`, `missingTagOnly`, `missingBoth`, `unmappedEntry`).
     - `D2.2`: Extracts `catalog_number` by precedence (`text_fields` > `filename` > parent directory > `NULL`) with non-unique index support.
     - `D2.3`: Imports `entries.date_added` into `added_at` and extracts `media_date` by precedence (`datetime_fields` > `text_fields` ISO date > filename/path `YYYY-MM-DD` > `NULL`), never fabricating `media_date` from `mtime` or `date_added`.
     - `D2.4`: Consolidates case-folded duplicate tags (`trim + lowercase`), preserving all source `tag_id` mappings in `legacy_ids` and recording `mergedDuplicateTags` in `report_json`.
     - `D2.5`: Filters `.db` (`Thumbs.db`) and `.vsmeta` sidecar files into `skippedSidecarEntries` (with explicit warning if any `.db` file is not `Thumbs.db`).
   - Supports zero-disk-write `dry-run` mode (`:memory:`), atomic `import` rollback on error (`B5`), and `source_fingerprint` (`<sha256>@<rootId>`) idempotency (`B6`).
4. **Portable `<short-sha>` Packaging & 3-Layer Web Verification Gate (`scripts/pack.sh`, `scripts/verify-web.sh`, `scripts/verify.sh`, `docs/development/workflow.md`)**:
   - Updated `scripts/pack.sh` to default to `./dist` (or any caller-supplied relative directory) and output `dsh-media-library-<version>-<short-sha>.tgz`, and documented the 3-layer WSL `dsh web` verification gate in `docs/development/workflow.md` (`B9`).

## 2. Real Copy Import & Backup/Restore Reconciliation Summary (`B8`)

- **Source Read-Only Copy**: `/home/aaevi/projects/dsh-media-library-local-data/ts_library.sqlite`
  - `SHA-256 Before`: `6dc1b799b5e48d938fc8c376fd8715ad913e1771a75d78e708c3f4aede2ee158`
  - `SHA-256 After`:  `6dc1b799b5e48d938fc8c376fd8715ad913e1771a75d78e708c3f4aede2ee158` (`unchanged: true`)
- **Reconciliation Equations (`allReconciled: true`)**:
  - `entries`: `imported (2554) + skippedSidecar (16) + unmapped (0) + dupPath (0) == 2570`
  - `tags`: `imported (225) + mergedDuplicate (1) == 226`
  - `tag_aliases`: `imported (5) + dedup (0) + orphaned (0) == 5`
  - `tag_parents`: `imported (185) + dedup (0) + selfLoop (0) + orphaned (0) == 185`
  - `tag_entries`: `imported (3634) + dedupMerge (0) + skippedSidecar (2) + orphaned (1106) == 4742`
  - `text_fields`: `imported (16) + skippedOrOrphan (0) == 16`
  - `legacy_ids`: `2801` (`2554` entries + `226` tags + `5` aliases + `16` text_fields)
- **Health & Empty-Directory Restore Check**:
  - `foreign_key_check`: `0` errors
  - `integrity_check`: `["ok"]`
  - `restore-check`: `countsMatch: true` across all 10 tables (`schemaVersions=1`, `mediaRoots=1`, `mediaFiles=2554`, `tags=225`, `tagAliases=5`, `tagParents=185`, `mediaTags=3634`, `mediaTextFields=16`, `importRuns=1`, `legacyIds=2801`)

## 3. Seam Check Evidence Grading

| Seam | Evidence Grade | Proof / Status |
|---|---|---|
| `local_sqlite_schema_and_migrations` | `automated_seam` (`sqlite_fixture`) | Proven in `tests/db/schema-and-backup.test.ts` (`B1`, `B2`, `B7`: SMB/plugin-dir path rejection, FK enforcement, pre-upgrade `backup()`, failed migration rollback, empty-dir restore parity). |
| `tagstudio_readonly_import_and_reconciliation` | `automated_seam` (`sqlite_fixture` + `real_readonly_copy_import`) | Proven in `tests/import/tagstudio-importer.test.ts` (`B3..B8`) and real copy import (`2554 + 16 = 2570` entries, `225 + 1 = 226` tags, `3634 + 2 + 1106 = 4742` tag_entries, source SHA-256 unchanged). |
| `wsl_dsh_web_cold_install_e2e` | `automated_e2e` | Proven by `./scripts/verify.sh` -> `./scripts/verify-web.sh` with `dsh-media-library-0.1.0-<short-sha>.tgz`. |
| `windows_smb_e2e` | `N/A (schema & local SQLite layer; UI search + open in Issue #4)` | Issue #3 has no SMB opener changes; Windows Desktop search + open E2E is covered in Issue #4. |
