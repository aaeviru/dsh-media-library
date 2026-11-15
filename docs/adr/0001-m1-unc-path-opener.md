# ADR 0001: M1 Host UNC Path Resolution and Native Opener Adapter

- **Status**: Accepted (`D1.1`, Issue #1)
- **Date**: 2026-11-15
- **Refs**: [Issue #1](https://github.com/aaeviru/dsh-media-library/issues/1), [Issue #1 Contract](https://github.com/aaeviru/dsh-media-library/issues/1#issuecomment-6892348300)

## Context

`dsh-media-library` is a Windows-first DSH Desktop plugin for browsing a Synology NAS media library over SMB (`\\NAS\share\...`). When a user clicks **Open** or **Reveal in Explorer** on a media item in the React client, the DSH Host must:

1. Resolve the requested `mediaId` against an allowlisted `media_roots` entry (`canonical_unc_root`) and the entry's `relative_path`.
2. Reject any path traversal (`..`), drive-letter injection (`Z:\`), NUL byte, or prefix collision (`\\NAS\share` vs `\\NAS\share2`).
3. Launch the Windows default media player (e.g. PotPlayer) or highlight the file in `explorer.exe` without shell-injection hazards on filenames containing spaces, Chinese characters, commas, or >260-character UNC paths.
4. Return structured diagnostics (`FILE_NOT_FOUND`, `NAS_OFFLINE_OR_TIMEOUT`, `PERMISSION_DENIED`, `OPENER_FAILED`) when the NAS share or file is unavailable, rather than failing silently.

## Options Considered

### Option A: Delegate to `sessionController.openWorkspacePath(sessionId, targetPath, mode)`

`@deepseek-ai/dsh-service-session` exposes `openWorkspacePath(sessionId, targetPath, mode)` on `SessionController`.

- **Pros**: Reuses existing session service wiring.
- **Cons**:
  - Requires an active chat `sessionId` and resolves paths against `session.workspaceDir`. Media library browsing is a global desktop panel (`sidebar.panellist`) independent of any coding agent session workspace.
  - Exposes a generic `targetPath` parameter across the session boundary instead of enforcing `mediaId`-only lookup inside the Media Library Host service.
  - Does not perform a bounded pre-flight reachability check on SMB shares before invoking `rundll32.exe` or `explorer.exe`.

### Option B (Selected): Plugin Host Adapter over `@deepseek-ai/dsh-native-command` (`openNativeAssociatedPath` / `revealNativePath`)

The Media Library Host service (`MediaLibrarySpikeService`) owns the `mediaId -> (rootId, relativePath)` lookup, validates UNC containment via `path.win32`, runs a bounded `fs.promises.stat` reachability probe, and calls `openNativeAssociatedPath` / `revealNativePath` from `@deepseek-ai/dsh-native-command` (inlined into the plugin's Host bundle).

- **Pros**:
  - **Strict Trust Boundary**: `MediaLibraryRemote` (`openMedia`, `revealMedia`) accepts only `{ mediaId: string }`. Neither Client nor Typert Remote ever transmits raw Windows or UNC paths.
  - **Safe Process Spawning**: `@deepseek-ai/dsh-native-command` invokes `execFile` (`windowsHide: true`, no `cmd.exe` shell interpolation):
    - `open`: `rundll32.exe ["url.dll,FileProtocolHandler", resolvedUncPath]`
    - `reveal`: `explorer.exe [`/select,${resolvedUncPath}`]` with `ignoreExitCode: true` (necessary because `explorer.exe /select` frequently exits with code `1` on Windows even when the window opens and selects the target file).
  - **Structured SMB Diagnostics**: Because `rundll32.exe` and `explorer.exe /select` do not return meaningful exit codes when a UNC path is missing or offline, `MediaLibrarySpikeService` performs a bounded `fs.promises.stat` check (`probeTimeoutMs`, default `5000ms`) beforehand and maps `ENOENT`, `EACCES`/`EPERM`, and `ETIMEDOUT`/`EHOSTUNREACH` into `FILE_NOT_FOUND`, `PERMISSION_DENIED`, and `NAS_OFFLINE_OR_TIMEOUT`.
  - **Self-Contained `.tgz` Bundle**: `@deepseek-ai/dsh-native-command` is pure TypeScript over `node:child_process` and `node:path` and is inlined into `bundle/lib/index.js` during `tsdown` bundling, preserving the zero-external-runtime-dependency contract for `.tgz` installation.

## Decision

We adopt **Option B**:

1. **UNC Containment (`src/unc-path.ts`)**:
   - `normalizeCanonicalUncRoot(rawRoot)` validates `\\server\share` (or `\\?\UNC\server\share`) syntax using `path.win32`, rejecting drive letters, relative paths, and `.` / `..` segments.
   - `resolveAllowlistedUncPath(roots, rootId, relativePath)` rejects absolute/UNC/drive-letter/traversal segments in `relativePath`, resolves via `path.win32.resolve(canonicalRoot, relativePath)`, and verifies both `path.win32.relative(canonicalRoot, resolved)` and a case-insensitive `${canonicalRoot.toLowerCase()}\\` prefix check (preventing `\\NAS\share` from matching `\\NAS\share2\file.mkv`).
2. **Pre-flight Reachability + Native Opener (`src/spike-service.ts`)**:
   - Probes target file reachability with a configurable timeout before invoking `openNativeAssociatedPath` or `revealNativePath`.
   - Exposes `nodeSqliteAvailable` (`Boolean(process.getBuiltinModule?.('node:sqlite'))`) and local non-SMB database paths (`%DSH_HOME%/media-library/library.sqlite3`) in `spikeStatus()` so M1 cold-install verification confirms the Host SQLite runtime on Windows in one pass.
