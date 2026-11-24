/**
 * Single runtime source of truth for the plugin version string inside `src/` (Issue #27).
 * Kept in lockstep with `package.json` and `bundle/package.json` via `scripts/verify.sh` and `scripts/pack.sh`.
 */
export const APP_VERSION = '0.7.10';
