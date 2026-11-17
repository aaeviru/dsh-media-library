# ADR 0002: Lightweight Async Staging Scan and Same-Share Rename Move

- **Status**: Accepted (Issue #7)
- **Date**: 2026-11-17
- **Refs**: [Issue #7](https://github.com/aaeviru/dsh-media-library/issues/7), [Issue #7 Contract](https://github.com/aaeviru/dsh-media-library/issues/7#issuecomment-6922757618)

## Context

In the initial Issue #7 implementation, `scanStagingFiles` walked the NAS `temp` directory synchronously, computed a full SHA-256 over SMB for every multi-GB video file, and persisted a `planned` row in `ingestion_manifests` for every scanned file. In real desktop testing over SMB, this froze the DSH Host process and created stale `planned` rows whenever files were renamed or removed externally in `temp`.

## Decision

1. **Pure Async Directory Scan (No Content Hashing, No DB Writes)**:
   - `scanStagingFiles` uses bounded-timeout async `fs.promises.readdir` and `fs.promises.stat` only.
   - If `stagingDir` is unconfigured and `uncRoot` is still the placeholder `\\NAS\MediaTest`, scanning fails fast with a clear configuration message rather than blocking on SMB timeout.
   - Staged files are matched in-memory against existing manifests by path/size; no `planned` rows are written during a scan.
2. **Lazy Manifest Persistence**:
   - An `ingestion_manifests` row is created only when the user takes an explicit action on a staged file (`fetchIngestionMetadata` or `reviewIngestion`), then transitions through `reviewed -> moving -> indexed | failed`.
3. **Same-NAS Rename First, Copy+Verify Fallback on `EXDEV`**:
   - Since both `temp` and `targetSubdir` live inside the same NAS share, `commitIngestion` attempts an async server-side `rename` first and verifies destination existence and `file_size`.
   - Only when `rename` returns `EXDEV` (cross-volume/cross-share) does it fall back to copy + size/SHA-256 verification + conservative source removal.

## Consequences

- **Pros**: Scanning `temp` completes in milliseconds over SMB; moving multi-GB files inside the NAS completes nearly instantaneously without pulling GBs back and forth through the desktop NIC; zero stale `planned` rows in SQLite.
- **Cons**: Same-share `rename` relies on SMB server-side rename + `file_size` verification rather than reading back every byte for SHA-256; cross-volume moves still use full copy+verify.
