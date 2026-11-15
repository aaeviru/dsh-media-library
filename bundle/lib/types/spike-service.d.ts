import type { M1TestMediaItem, MediaActionResult, MediaRootConfig, SpikeStatus } from './types.ts';
export declare const DEFAULT_M1_ROOT_ID = "nas-main";
export declare const DEFAULT_M1_TEST_ITEMS: readonly M1TestMediaItem[];
export interface NativeOpener {
    openPath(targetPath: string): Promise<void>;
    revealPath(targetPath: string): Promise<void>;
}
export interface FileProbeResult {
    readonly ok: boolean;
    readonly code?: 'FILE_NOT_FOUND' | 'NAS_OFFLINE_OR_TIMEOUT' | 'PERMISSION_DENIED';
    readonly message?: string;
}
export type FileProbeFn = (resolvedUncPath: string, timeoutMs: number) => Promise<FileProbeResult>;
export interface SpikeOverrideFileSchema {
    readonly uncRoot?: string;
    readonly roots?: readonly MediaRootConfig[];
    readonly items?: readonly M1TestMediaItem[];
}
export interface SpikeServiceOptions {
    readonly baseDir?: string | undefined;
    readonly dataDirName?: string | undefined;
    readonly configuredUncRoot?: string | (() => string) | undefined;
    readonly probeTimeoutMs?: number | undefined;
    readonly roots?: readonly MediaRootConfig[] | undefined;
    readonly items?: readonly M1TestMediaItem[] | undefined;
    readonly opener?: NativeOpener | undefined;
    readonly fileProbe?: FileProbeFn | undefined;
}
export declare function resolveLocalDataDir(baseDir?: string, dataDirName?: string): string;
export declare function probeNodeSqliteBuiltIn(): boolean;
export declare const defaultNativeOpener: NativeOpener;
export declare function defaultUncFileProbe(resolvedUncPath: string, timeoutMs: number): Promise<FileProbeResult>;
export declare function classifyFsError(error: unknown, resolvedUncPath: string): {
    ok: false;
    code: 'FILE_NOT_FOUND' | 'NAS_OFFLINE_OR_TIMEOUT' | 'PERMISSION_DENIED';
    message: string;
};
export declare class MediaLibrarySpikeService {
    private readonly localDataDir;
    private readonly localDatabasePath;
    private readonly spikeOverridePath;
    private configuredUncRoot;
    private readonly probeTimeoutMs;
    private readonly explicitRoots;
    private readonly explicitItems;
    private readonly opener;
    private readonly fileProbe;
    constructor(options?: SpikeServiceOptions);
    private readConfiguredUncRoot;
    private readLocalOverrideFile;
    getEffectiveRootsAndItems(): {
        activeUncRoot: string;
        roots: readonly MediaRootConfig[];
        items: readonly M1TestMediaItem[];
    };
    getSpikeStatus(): SpikeStatus;
    openMedia(mediaId: string): Promise<MediaActionResult>;
    revealMedia(mediaId: string): Promise<MediaActionResult>;
    private executeMediaAction;
}
//# sourceMappingURL=spike-service.d.ts.map