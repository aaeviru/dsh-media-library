# Handoff: Issue #1 — M1: Verify DSH Host opening and revealing real NAS UNC files

- **Issue**: [#1](https://github.com/aaeviru/dsh-media-library/issues/1)
- **Contract**: [Issue #1 Comment (`type/contract`)](https://github.com/aaeviru/dsh-media-library/issues/1#issuecomment-6892348300)
- **Branch**: `feat/1-host-unc-spike-v3`
- **Status**: `status/approved` (Automated unit tests + 3-layer WSL `dsh web` Playwright E2E verified; awaiting Windows DSH Desktop + real NAS SMB manual E2E verification for `status/verified`)

## 1. Summary of Deliverables

1. **UNC Containment & Allowlist Resolution (`src/unc-path.ts`)**:
   - `normalizeCanonicalUncRoot(rawRoot)` validates Windows UNC share roots (`\\server\share...` and `\\?\UNC\server\share...`) using `path.win32`, rejecting drive letters (`Z:\`), single-segment roots, traversal segments (`.` / `..`), and NUL bytes.
   - `resolveAllowlistedUncPath(roots, rootId, relativePath)` enforces `rootId` allowlist lookup, rejects disabled roots, rejects relative path traversal (`..`), leading slashes, drive letters, and verifies both `path.win32.relative` and strict case-insensitive `${canonicalRoot.toLowerCase()}\\` prefix containment (preventing `\\NAS\share` vs `\\NAS\share2` prefix collision).
2. **Host Spike Service & Native Opener (`src/spike-service.ts`, `src/remote.ts`, `src/config.ts`, `src/index.ts`)**:
   - `MediaLibraryRemote` (`namespace: 'mediaLibrary'`) exposes `@Remote('spikeStatus')`, `@Remote('openMedia')`, and `@Remote('revealMedia')`, accepting strictly `mediaId: string` (Red Line #3).
   - `MediaLibrarySpikeService` performs a bounded pre-flight `fs.promises.stat` check (`probeTimeoutMs`, default `5000ms`) to classify `FILE_NOT_FOUND`, `PERMISSION_DENIED`, and `NAS_OFFLINE_OR_TIMEOUT` before calling `openNativeAssociatedPath` / `revealNativePath` from `@deepseek-ai/dsh-native-command`.
   - Supports configuring `uncRoot` via DSH plugin settings (`Config.uncRoot` `.volatile()`) or `%DSH_HOME%/media-library/m1-spike.json` override without rebuilding the `.tgz`.
   - Probes Node's built-in `node:sqlite` (`DatabaseSync`) availability and local non-SMB database path (`%DSH_HOME%/media-library/library.sqlite3`).
3. **Client UI (`src/client/*`)**:
   - Registers `main` (`key: 'media-library'`) and `sidebar.panellist` (`id: 'media-library'`) slots with bilingual (`en` / `zh`) dictionary support.
   - Displays Host runtime diagnostics (`platform`, `nodeVersion`, `nodeSqliteAvailable`, `localDatabasePath`, `activeUncRoot`) and interactive `Open Default Player` / `Reveal in Explorer` buttons for all 6 M1 test scenarios (`m1-basic-mkv`, `m1-spaces-mp4`, `m1-cjk-mkv`, `m1-comma-mkv`, `m1-long-path-mkv`, `m1-missing-file`).
4. **ADR, Packaging & 3-Layer WSL Web E2E (`docs/adr/0001-m1-unc-path-opener.md`, `scripts/build-bundle.sh`, `scripts/pack.sh`, `scripts/verify-web.sh`)**:
   - Recorded `D1.1` in `docs/adr/0001-m1-unc-path-opener.md`.
   - Built self-contained `bundle/lib/index.js`, `bundle/lib/typert.host.js` (validated against `@deepseek-ai/dsh-typert-loader`'s `validateTypertManifest`), and `bundle/lib/client.js` without modifying `/home/aaevi/projects/deepseek-harness`, while ignoring generated `/bundle/lib/` artifacts in `.gitignore`.
   - Verified cold-installing the `.tgz` into an isolated WSL `dsh web` profile and running Playwright headless Chromium E2E (`scripts/verify-web.sh`).

## 2. Seam Check Evidence Grading

| Seam | Evidence Grade | Proof / Status |
|---|---|---|
| `unc_allowlist_and_containment` | `automated_seam` | Proven in `tests/host/unc-spike.test.ts` (`B1` suite: traversal, drive letters, prefix collision, disabled/unmapped roots). |
| `media_id_only_rpc_and_typert_manifest` | `automated_seam` | Proven in `tests/host/unc-spike.test.ts` (`validateTypertManifest` from `@deepseek-ai/dsh-typert-loader` + raw UNC path rejection on `openMedia`). |
| `tgz_bundle_external_import_audit` | `automated_seam` | Proven by `./scripts/verify.sh` (`bundle/lib/index.js` and `bundle/lib/typert.host.js` import only `@deepseek-ai/cordis` and `node:*`). |
| `wsl_dsh_web_cold_install_e2e` | `automated_e2e` | Proven by `./scripts/verify-web.sh` (installs `.tgz` into isolated `web` profile, verifies `boot.html` & `/plugins/??...` HTTP 200, clicks Media Library sidebar in Playwright Chromium, verifies `spikeStatus()` and `openMedia('m1-missing-file') -> FILE_NOT_FOUND`). |
| `windows_smb_e2e` | `human_e2e_pending` | Requires cold-installing the `.tgz` into Windows DSH Desktop and clicking Open / Reveal against a real Synology NAS SMB share (`Refs #1`). |
