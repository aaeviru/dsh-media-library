# dsh-media-library

[English](README.md) | [简体中文](README.zh-CN.md)

A Windows-first DSH Desktop plugin (`@deepseek-ai/dsh-experimental-media-library`) for managing, searching, tagging, and ingesting a Synology NAS media library while keeping original media files on SMB and metadata in a fast local SQLite database.

## Status

**M1–M4 implemented** (current baseline: `v0.7.10`, SQLite schema `v7`).

- **M1 (Host/UNC & Inventory)**: Allowlisted Windows UNC path resolution, native default-app open & Explorer `/select` reveal, and read-only TagStudio SQLite inventory.
- **M2 (Migration, Search & Open)**: Lossless read-only import from TagStudio `ts_library.sqlite` (SHA-256 verified unchanged), local SQLite schema migrations, keyset-paginated search by tag/alias, catalog number (exact/prefix), date range, and keyword, plus context-menu/keyboard native actions.
- **M3 (Tag Management & Operations)**: Tag create/rename/alias/archive/restore, batch tagging, previewed transactional tag merge, audit logging, online SQLite backups with retention & optional NAS archive copy, read-only degraded mode, and portable JSON/CSV export.
- **M4 (Recoverable Ingestion & Performer Rules)**: Async staging folder scan, metadata lookup (`FC2CMADB` / `FC2PPVDB`), human review gate, deterministic performer alias rules & review queue, responsive non-blocking Host execution, process-wide move/reconcile serialization, default-off EXDEV copying (`allowCrossDeviceCopy: false`), bounded 3x1 MiB existing-target quick check, and crash recovery.

> **Scope boundaries**: No embedded video playback, transcoding, thumbnails, Synology Photos integration, or direct SQLite writes over SMB.

## Architecture

```text
React UI (DSH Web / Desktop Client)
   │  Typert Remote (mediaId, tagId, structured filters only — never raw UNC paths)
   ▼
DSH Host (single trusted boundary & sole SQLite writer)
   ├─ Local SQLite (%DSH_HOME%/media-library/library.sqlite3, schema v7)
   ├─ Allowlisted Media Roots (root_id + relative_path -> \\NAS\Share\...)
   ├─ Async Ingestion & Reconcile (process-wide exclusion, rename-first, opt-in EXDEV copy)
   └─ DSH native-command (open in default player / reveal in Windows Explorer)
                                   │
                                   ▼
                        Original media files on NAS SMB
```

### Hard Invariants
1. **Read-only TagStudio source**: `ts_library.sqlite` is never modified; imports verify source SHA-256 before and after.
2. **Local SQLite only**: Online database and backups live on local NTFS/SSD (`%DSH_HOME%/media-library/`), never on SMB shares or inside the plugin bundle.
3. **Host path boundary**: Client RPCs only pass IDs and controlled parameters; Host reconstructs and validates all Windows UNC paths with `path.win32` containment checks.

## Configuration

Key plugin settings (`src/config.ts`):

| Setting | Default | Description |
|---|---|---|
| `uncRoot` | `\\NAS\MediaTest` | Canonical Windows UNC root for the NAS media share (e.g. `\\SynologyNAS\Media`). |
| `dataDir` | `media-library` | Local subdirectory under `%DSH_HOME%` for `library.sqlite3` and `backups/`. |
| `stagingDir` | `""` | Staging folder for pending videos (defaults to `<uncRoot>\temp` when empty). Keep on the same SMB share as `uncRoot` for instant rename. |
| `ingestionTargetSubdir` | `ingested` | Target subdirectory under `uncRoot` where approved files are moved. |
| `allowCrossDeviceCopy` | `false` | Allow verified copy+SHA-256 fallback only when `rename` returns `EXDEV`. Disabled by default to prevent silent multi-GB transfers. |
| `nasBackupDir` | `""` | Optional NAS archive folder where verified local SQLite backups are copied. |
| `autoDailyBackup` | `true` | Create at most one verified backup per 24h when writes/imports occurred. |
| `tagstudioCopyPath` | `""` | Optional local path to a read-only TagStudio `ts_library.sqlite` copy for one-click import. |

## Development, Verification & Packaging

Run the unified 5-stage verification suite (git hygiene → bundle/typecheck/import audit → unit/SQLite/benchmark tests → `.tgz` packaging → isolated WSL DSH Web cold-install + Playwright E2E):

```sh
./scripts/verify.sh
```

Build and pack a distributable `.tgz` archive for Windows DSH Desktop cold installation:

```sh
./scripts/build-bundle.sh
./scripts/pack.sh ./dist
```

> Install plugins via the packed `.tgz` archive rather than `link:` directories. See [docs/operations-and-recovery.md](docs/operations-and-recovery.md) for backup, restore, and rollback procedures.

## Documentation

- [Design Proposal & Baseline](docs/design.md)
- [Operations, Backup & Cold-Fallback Recovery](docs/operations-and-recovery.md)
- [Development & Agent Workflow](docs/development/workflow.md)
- [Glossary](GLOSSARY.md)
- Architecture Decision Records:
  - [ADR 0001: M1 UNC Path Opener](docs/adr/0001-m1-unc-path-opener.md)
  - [ADR 0002: Staging Scan and Move](docs/adr/0002-staging-scan-and-move.md)
  - [ADR 0003: Responsive Host and Serialized Ingestion](docs/adr/0003-responsive-host-and-serialized-ingestion.md)
  - [ADR 0004: Tag Hierarchy and Kind](docs/adr/0004-tag-hierarchy-and-kind.md)

## References

- [dsh-downloader](https://github.com/aaeviru/dsh-downloader)
- [dsh-plugin-docs](https://github.com/aaeviru/dsh-plugin-docs)
- [TagStudio](https://github.com/TagStudioDev/TagStudio)
