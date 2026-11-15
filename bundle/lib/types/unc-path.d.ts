import type { MediaActionErrorCode, MediaRootConfig } from './types.ts';
export type UncResolutionResult = {
    ok: true;
    canonicalRoot: string;
    normalizedRelativePath: string;
    resolvedUncPath: string;
} | {
    ok: false;
    code: MediaActionErrorCode;
    message: string;
};
/**
 * Validates and normalizes a canonical Windows UNC root path (`\\server\share` or `\\server\share\subpath`).
 * Uses `path.win32` exclusively so behavior is identical on Windows and Linux/WSL test hosts.
 */
export declare function normalizeCanonicalUncRoot(rawRoot: string): {
    ok: true;
    canonicalRoot: string;
} | {
    ok: false;
    code: 'INVALID_UNC_ROOT';
    message: string;
};
/**
 * Resolves a `(rootId, relativePath)` tuple against an allowlist of `MediaRootConfig` entries,
 * enforcing strict containment inside the root's `canonicalUncRoot`.
 */
export declare function resolveAllowlistedUncPath(roots: readonly MediaRootConfig[], rootId: string, relativePath: string): UncResolutionResult;
//# sourceMappingURL=unc-path.d.ts.map