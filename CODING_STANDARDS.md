# Coding Standards (Review Stage)

Judgement rules for Critic and PR review on `dsh-media-library`. Mechanical checks (hardcoded colors, native `<select>`, external imports, typechecks) belong in `scripts/verify.sh`, not here.

## 1. Symmetric Write-Protection Guards

When adding a guard that refuses to overwrite or destroy user-managed data (such as `--force` imports, merges, or cleanup), check **both directions**:
- Existing records matched by the incoming payload (by both canonical key / `normalized_name` and `legacy_ids` mapping).
- State currently attached to the existing records about to be replaced or removed (e.g., edited/archived/merged tags linked to old media rows, even if those tags disappeared from the new source snapshot).

## 2. Zero Silent Bypass on Security Boundaries

When a helper enforces a Host security invariant (such as `stagingDir` or allowlisted `media_roots` containment) and is callable from both RPC and internal code/tests, require the boundary input unconditionally. Do not skip validation when an optional parameter is `undefined`.

## 3. Preserve Raw Filenames & Relative Paths

Use `.trim()` only to test whether a user-supplied filename or relative path is blank. Keep the raw string verbatim when splitting segments, resolving paths, or matching files so leading/trailing spaces cannot silently redirect operations to a sibling file.
