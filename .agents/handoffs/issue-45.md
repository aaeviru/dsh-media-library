# [CONTRACT] Issue #45 v1

Source: https://github.com/aaeviru/dsh-media-library/issues/45 (2026-11-22 specification).
Authority: the user approved the design rules in this session (filename-bound manifest identity, automatic stale unindexed manifest cleanup on scan, and tag alias deduplication) and requested execution.
Baseline: c3187d823b590fb74b768f94218a08fc5cf3cb83.

## 1. Goal & Scope

- **Goal**: Bind unindexed manifest identity to case-insensitive `filename` across `stagingDir` changes, automatically clean up stale unindexed manifests when their files are no longer in `stagingDir`, deduplicate alias-matched tags across fetches/reviews, and keep `IngestionPanel` selection stable.
- **Allowed paths**: `src/ingestion/*`, `src/client/IngestionPanel.tsx`, `src/spike-service.ts`, `src/db/schema.ts` (default `appVersion` only), `tests/*`, `scripts/verify-ingestion-web.mjs`, `docs/design.md`, `.agents/handoffs/issue-45.md`, `package.json`, `bundle/package.json`.
- **Forbidden paths**: `deepseek-harness`, production NAS/TagStudio databases, root lockfiles, system registry, or user profiles.

## 2. Behavior Table (B1..B5)

| ID | Behavior | Classification | Evidence |
|---|---|---|---|
| B1 | Unindexed manifests (`state !== 'indexed'`) match staged files by case-insensitive `filename` across `stagingDir` changes and rebind `temp_path`, `target_relative_path`, `file_size`, and `source_id` while preserving fetched metadata, performer resolutions, and review state (clearing stale `failed` error when `temp_path` changes) | `INTENTIONAL_CHANGE` | `sqlite_fixture` + `wsl_dsh_web_cold_install_e2e` |
| B2 | `scanStagingDirectory` automatically deletes unindexed manifests (`state !== 'indexed'`, cascading to `performer_review_queue`) whose file is no longer in `stagingDir`, except frozen running-task manifests and approved `moving`/`failed` recovery candidates whose destination file already exists | `INTENTIONAL_CHANGE` | `sqlite_fixture` + `wsl_dsh_web_cold_install_e2e` |
| B3 | `fetchMetadataForManifest`, `reviewIngestionManifest`, and `mapManifestRow` deduplicate tags by `tagId` and normalized canonical tag name so alias-matched tags (e.g. `"無修正"` -> `tagId=8 "无码"`) never duplicate across repeated fetches | `INTENTIONAL_CHANGE` | `sqlite_fixture` |
| B4 | `IngestionPanel` matches staged files and unindexed manifests by `manifestId` -> case-insensitive `filename` -> `tempPath`, preserving selection and drafts across `f:` <-> `m:` transitions | `INTENTIONAL_CHANGE` | `wsl_dsh_web_cold_install_e2e` |
| B5 | Retain Host path allowlist/containment checks, short transactions, serialized execution lock, performer commit gates, and `moved-not-indexed` recovery boundaries | `PARITY_REQUIRED` | `sqlite_fixture` |

## 3. Shared Seams & Invariants

- Host remains the sole path authority (`validateManifestPaths` validates the rebound `temp_path` against current `stagingDir`).
- `moved-not-indexed` recovery (`reconcileIngestionManifests`) remains intact for approved manifests whose file has already been moved out of `stagingDir` into `targetRootPath`.
- No SQLite schema table migration required; additive version bump to `0.7.6`.

## 4. Risks & Rollback

- **Door**: Two-way (no SQLite schema migration).
- **Rollback**: Revert PR and reinstall `0.7.5`.
