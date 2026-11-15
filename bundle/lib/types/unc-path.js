import path from 'node:path';
const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:/;
/**
 * Validates and normalizes a canonical Windows UNC root path (`\\server\share` or `\\server\share\subpath`).
 * Uses `path.win32` exclusively so behavior is identical on Windows and Linux/WSL test hosts.
 */
export function normalizeCanonicalUncRoot(rawRoot) {
    const trimmed = rawRoot.trim();
    if (!trimmed || trimmed.includes('\0')) {
        return {
            ok: false,
            code: 'INVALID_UNC_ROOT',
            message: 'UNC root must not be empty or contain NUL characters.',
        };
    }
    const slashNormalized = trimmed.replace(/\//g, '\\');
    if (WINDOWS_DRIVE_PREFIX_RE.test(slashNormalized)) {
        return {
            ok: false,
            code: 'INVALID_UNC_ROOT',
            message: `Mapped drive letters are not allowed as canonical UNC roots: ${rawRoot}`,
        };
    }
    let body = '';
    let prefix = '\\\\';
    if (slashNormalized.toUpperCase().startsWith('\\\\?\\UNC\\')) {
        prefix = '\\\\?\\UNC\\';
        body = slashNormalized.slice('\\\\?\\UNC\\'.length);
    }
    else if (slashNormalized.startsWith('\\\\')) {
        prefix = '\\\\';
        body = slashNormalized.slice(2);
    }
    else {
        return {
            ok: false,
            code: 'INVALID_UNC_ROOT',
            message: `Root path must start with a Windows UNC prefix (\\\\server\\share): ${rawRoot}`,
        };
    }
    if (body.startsWith('\\')) {
        return {
            ok: false,
            code: 'INVALID_UNC_ROOT',
            message: `Invalid extra leading backslashes in UNC root: ${rawRoot}`,
        };
    }
    const rawSegments = body.split('\\').filter((seg) => seg.length > 0);
    if (rawSegments.length < 2) {
        return {
            ok: false,
            code: 'INVALID_UNC_ROOT',
            message: `UNC root must include both server and share name (\\\\server\\share): ${rawRoot}`,
        };
    }
    for (const seg of rawSegments) {
        if (seg === '.' || seg === '..') {
            return {
                ok: false,
                code: 'INVALID_UNC_ROOT',
                message: `UNC root must not contain traversal segments (. or ..): ${rawRoot}`,
            };
        }
    }
    if (prefix === '\\\\?\\UNC\\') {
        return {
            ok: true,
            canonicalRoot: `\\\\?\\UNC\\${rawSegments.join('\\')}`,
        };
    }
    const normalized = path.win32.normalize(`\\\\${rawSegments.join('\\')}`).replace(/\\+$/, '');
    return {
        ok: true,
        canonicalRoot: normalized,
    };
}
/**
 * Resolves a `(rootId, relativePath)` tuple against an allowlist of `MediaRootConfig` entries,
 * enforcing strict containment inside the root's `canonicalUncRoot`.
 */
export function resolveAllowlistedUncPath(roots, rootId, relativePath) {
    const rootConfig = roots.find((r) => r.rootId === rootId);
    if (!rootConfig) {
        return {
            ok: false,
            code: 'UNMAPPED_ROOT',
            message: `Unknown media root ID: ${rootId}`,
        };
    }
    if (!rootConfig.enabled) {
        return {
            ok: false,
            code: 'DISABLED_ROOT',
            message: `Media root '${rootId}' (${rootConfig.label}) is currently disabled.`,
        };
    }
    const rootCheck = normalizeCanonicalUncRoot(rootConfig.canonicalUncRoot);
    if (!rootCheck.ok) {
        return rootCheck;
    }
    const canonicalRoot = rootCheck.canonicalRoot;
    if (!relativePath || relativePath.trim().length === 0 || relativePath.includes('\0')) {
        return {
            ok: false,
            code: 'INVALID_RELATIVE_PATH',
            message: 'Relative media path must be non-empty and must not contain NUL bytes.',
        };
    }
    const trimmedRel = relativePath.trim();
    if (trimmedRel.startsWith('/') ||
        trimmedRel.startsWith('\\') ||
        WINDOWS_DRIVE_PREFIX_RE.test(trimmedRel)) {
        return {
            ok: false,
            code: 'PATH_TRAVERSAL_REJECTED',
            message: `Relative path must not start with a root slash, UNC prefix, or drive letter: ${relativePath}`,
        };
    }
    const slashNormalizedRel = trimmedRel.replace(/\//g, '\\');
    const rawSegments = slashNormalizedRel.split('\\');
    for (const segment of rawSegments) {
        if (segment === '..' || segment === '.') {
            return {
                ok: false,
                code: 'PATH_TRAVERSAL_REJECTED',
                message: `Relative path must not contain '.' or '..' segments: ${relativePath}`,
            };
        }
        if (segment.length === 0) {
            return {
                ok: false,
                code: 'INVALID_RELATIVE_PATH',
                message: `Relative path must not contain empty path segments: ${relativePath}`,
            };
        }
    }
    const resolvedUncPath = path.win32.resolve(canonicalRoot, slashNormalizedRel);
    const relFromRoot = path.win32.relative(canonicalRoot, resolvedUncPath);
    if (!relFromRoot ||
        relFromRoot === '.' ||
        relFromRoot.startsWith('..') ||
        path.win32.isAbsolute(relFromRoot)) {
        return {
            ok: false,
            code: 'PATH_TRAVERSAL_REJECTED',
            message: `Resolved path escapes allowlisted UNC root '${canonicalRoot}': ${relativePath}`,
        };
    }
    const requiredPrefix = `${canonicalRoot.toLowerCase()}\\`;
    if (!resolvedUncPath.toLowerCase().startsWith(requiredPrefix)) {
        return {
            ok: false,
            code: 'PATH_TRAVERSAL_REJECTED',
            message: `Resolved path failed strict UNC root prefix containment check: ${resolvedUncPath}`,
        };
    }
    return {
        ok: true,
        canonicalRoot,
        normalizedRelativePath: relFromRoot,
        resolvedUncPath,
    };
}
//# sourceMappingURL=unc-path.js.map