import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openNativeAssociatedPath, revealNativePath, } from '@deepseek-ai/dsh-native-command';
import { normalizeCanonicalUncRoot, resolveAllowlistedUncPath, } from "./unc-path.js";
export const DEFAULT_M1_ROOT_ID = 'nas-main';
const LONG_SUBDIR_A = 'Archive_Segment_Alpha_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJ';
const LONG_SUBDIR_B = 'Archive_Segment_Beta_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJK';
const LONG_SUBDIR_C = 'Archive_Segment_Gamma_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJ';
export const DEFAULT_M1_TEST_ITEMS = [
    {
        mediaId: 'm1-basic-mkv',
        rootId: DEFAULT_M1_ROOT_ID,
        relativePath: 'movies\\sample-basic.mkv',
        label: 'Basic ASCII path (.mkv)',
        scenario: 'basic',
    },
    {
        mediaId: 'm1-spaces-mp4',
        rootId: DEFAULT_M1_ROOT_ID,
        relativePath: 'movies\\Folder With Spaces\\Sample Video With Spaces.mp4',
        label: 'Path containing spaces (.mp4)',
        scenario: 'spaces',
    },
    {
        mediaId: 'm1-cjk-mkv',
        rootId: DEFAULT_M1_ROOT_ID,
        relativePath: '动画归档\\测试目录\\中文文件名测试_01.mkv',
        label: 'Chinese / CJK directory and filename (.mkv)',
        scenario: 'cjk',
    },
    {
        mediaId: 'm1-comma-mkv',
        rootId: DEFAULT_M1_ROOT_ID,
        relativePath: 'movies\\director, cut\\part 1, scene 2 [1080p].mkv',
        label: 'Path containing commas (explorer.exe /select, hazards)',
        scenario: 'comma',
    },
    {
        mediaId: 'm1-long-path-mkv',
        rootId: DEFAULT_M1_ROOT_ID,
        relativePath: `${LONG_SUBDIR_A}\\${LONG_SUBDIR_B}\\${LONG_SUBDIR_C}\\deeply_nested_long_unc_path_sample_video_exceeding_260_characters.mkv`,
        label: 'Long UNC path (> 260 characters)',
        scenario: 'long_path',
    },
    {
        mediaId: 'm1-missing-file',
        rootId: DEFAULT_M1_ROOT_ID,
        relativePath: 'movies\\__non_existent_m1_spike_target__.mkv',
        label: 'Missing target file (structured error check)',
        scenario: 'missing_file',
    },
];
export function resolveLocalDataDir(baseDir, dataDirName = 'media-library') {
    const effectiveBase = baseDir?.trim() ||
        process.env.DSH_HOME?.trim() ||
        path.join(os.homedir(), '.dsh');
    return path.resolve(effectiveBase, dataDirName);
}
export function probeNodeSqliteBuiltIn() {
    try {
        const getBuiltin = process.getBuiltinModule;
        if (typeof getBuiltin !== 'function') {
            return false;
        }
        const mod = getBuiltin('node:sqlite');
        return Boolean(mod && typeof mod.DatabaseSync === 'function');
    }
    catch {
        return false;
    }
}
export const defaultNativeOpener = {
    async openPath(targetPath) {
        await openNativeAssociatedPath(targetPath, AbortSignal.timeout(10_000));
    },
    async revealPath(targetPath) {
        await revealNativePath(targetPath, AbortSignal.timeout(10_000));
    },
};
export async function defaultUncFileProbe(resolvedUncPath, timeoutMs) {
    let timer;
    try {
        const statPromise = fs.promises.stat(resolvedUncPath);
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const timeoutErr = new Error(`Timed out after ${timeoutMs}ms while probing NAS path: ${resolvedUncPath}`);
                timeoutErr.code = 'ETIMEDOUT';
                reject(timeoutErr);
            }, timeoutMs);
        });
        const stats = await Promise.race([statPromise, timeoutPromise]);
        if (!stats.isFile()) {
            return {
                ok: false,
                code: 'FILE_NOT_FOUND',
                message: `Target UNC path is not a regular file: ${resolvedUncPath}`,
            };
        }
        return { ok: true };
    }
    catch (error) {
        return classifyFsError(error, resolvedUncPath);
    }
    finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}
export function classifyFsError(error, resolvedUncPath) {
    const errno = error?.code ?? '';
    const rawMessage = error instanceof Error ? error.message : String(error);
    if (errno === 'EACCES' || errno === 'EPERM') {
        return {
            ok: false,
            code: 'PERMISSION_DENIED',
            message: `Access denied on SMB share for path '${resolvedUncPath}': ${rawMessage}`,
        };
    }
    if (errno === 'ETIMEDOUT' ||
        errno === 'EHOSTUNREACH' ||
        errno === 'ENETUNREACH' ||
        errno === 'ECONNREFUSED' ||
        errno === 'ECONNRESET' ||
        errno === 'EBUSY' ||
        errno === 'EIO') {
        return {
            ok: false,
            code: 'NAS_OFFLINE_OR_TIMEOUT',
            message: `NAS share is unreachable or timed out for '${resolvedUncPath}' (${errno}): ${rawMessage}`,
        };
    }
    if (errno === 'ENOENT' || errno === 'ENOTDIR') {
        return {
            ok: false,
            code: 'FILE_NOT_FOUND',
            message: `File not found at '${resolvedUncPath}': ${rawMessage}`,
        };
    }
    if (errno === 'UNKNOWN' && /network|unc|share|host/i.test(rawMessage)) {
        return {
            ok: false,
            code: 'NAS_OFFLINE_OR_TIMEOUT',
            message: `Windows SMB network path unreachable for '${resolvedUncPath}': ${rawMessage}`,
        };
    }
    return {
        ok: false,
        code: 'FILE_NOT_FOUND',
        message: `Unable to access target file '${resolvedUncPath}' (${errno || 'ERROR'}): ${rawMessage}`,
    };
}
export class MediaLibrarySpikeService {
    localDataDir;
    localDatabasePath;
    spikeOverridePath;
    configuredUncRoot;
    probeTimeoutMs;
    explicitRoots;
    explicitItems;
    opener;
    fileProbe;
    constructor(options = {}) {
        this.localDataDir = resolveLocalDataDir(options.baseDir, options.dataDirName ?? 'media-library');
        this.localDatabasePath = path.join(this.localDataDir, 'library.sqlite3');
        this.spikeOverridePath = path.join(this.localDataDir, 'm1-spike.json');
        this.configuredUncRoot = options.configuredUncRoot ?? '\\\\NAS\\MediaTest';
        this.probeTimeoutMs = options.probeTimeoutMs ?? 5000;
        this.explicitRoots = options.roots;
        this.explicitItems = options.items;
        this.opener = options.opener ?? defaultNativeOpener;
        this.fileProbe = options.fileProbe ?? defaultUncFileProbe;
    }
    readConfiguredUncRoot() {
        return typeof this.configuredUncRoot === 'function'
            ? this.configuredUncRoot()
            : this.configuredUncRoot;
    }
    readLocalOverrideFile() {
        try {
            if (!fs.existsSync(this.spikeOverridePath)) {
                return null;
            }
            const raw = fs.readFileSync(this.spikeOverridePath, 'utf8');
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : null;
        }
        catch {
            return null;
        }
    }
    getEffectiveRootsAndItems() {
        const override = this.readLocalOverrideFile();
        const rawUncRoot = override?.uncRoot?.trim() || this.readConfiguredUncRoot().trim() || '\\\\NAS\\MediaTest';
        const normalizedRoot = normalizeCanonicalUncRoot(rawUncRoot);
        const activeUncRoot = normalizedRoot.ok ? normalizedRoot.canonicalRoot : rawUncRoot;
        const roots = this.explicitRoots ??
            override?.roots ?? [
            {
                rootId: DEFAULT_M1_ROOT_ID,
                label: 'Primary Synology NAS Media Share (M1 Spike)',
                canonicalUncRoot: activeUncRoot,
                enabled: true,
            },
        ];
        const items = this.explicitItems ?? override?.items ?? [...DEFAULT_M1_TEST_ITEMS];
        return {
            activeUncRoot,
            roots,
            items,
        };
    }
    getSpikeStatus() {
        const { activeUncRoot, roots, items } = this.getEffectiveRootsAndItems();
        return {
            platform: process.platform,
            nodeVersion: process.version,
            nodeSqliteAvailable: probeNodeSqliteBuiltIn(),
            localDataDir: this.localDataDir,
            localDatabasePath: this.localDatabasePath,
            spikeOverridePath: this.spikeOverridePath,
            activeUncRoot,
            roots,
            items,
        };
    }
    async openMedia(mediaId) {
        return this.executeMediaAction('open', mediaId);
    }
    async revealMedia(mediaId) {
        return this.executeMediaAction('reveal', mediaId);
    }
    async executeMediaAction(action, mediaId) {
        const startMs = Date.now();
        const trimmedId = typeof mediaId === 'string' ? mediaId.trim() : '';
        const { roots, items } = this.getEffectiveRootsAndItems();
        const item = items.find((entry) => entry.mediaId === trimmedId);
        if (!item) {
            return {
                ok: false,
                mediaId: trimmedId,
                action,
                code: 'UNKNOWN_MEDIA_ID',
                message: `Unknown mediaId '${trimmedId}'. Client may only request registered mediaIds.`,
                elapsedMs: Date.now() - startMs,
            };
        }
        const resolution = resolveAllowlistedUncPath(roots, item.rootId, item.relativePath);
        if (!resolution.ok) {
            return {
                ok: false,
                mediaId: item.mediaId,
                action,
                code: resolution.code,
                message: resolution.message,
                elapsedMs: Date.now() - startMs,
            };
        }
        const { resolvedUncPath } = resolution;
        const probe = await this.fileProbe(resolvedUncPath, this.probeTimeoutMs);
        if (!probe.ok) {
            const code = probe.code ?? 'FILE_NOT_FOUND';
            return {
                ok: false,
                mediaId: item.mediaId,
                action,
                code,
                message: probe.message ?? `Target file probe failed: ${resolvedUncPath}`,
                resolvedUncPath,
                elapsedMs: Date.now() - startMs,
            };
        }
        try {
            if (action === 'open') {
                await this.opener.openPath(resolvedUncPath);
            }
            else {
                await this.opener.revealPath(resolvedUncPath);
            }
            return {
                ok: true,
                mediaId: item.mediaId,
                action,
                resolvedUncPath,
                elapsedMs: Date.now() - startMs,
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                ok: false,
                mediaId: item.mediaId,
                action,
                code: 'OPENER_FAILED',
                message: `Native ${action} command failed for '${resolvedUncPath}': ${message}`,
                resolvedUncPath,
                elapsedMs: Date.now() - startMs,
            };
        }
    }
}
//# sourceMappingURL=spike-service.js.map