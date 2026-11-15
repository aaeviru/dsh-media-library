export interface MediaRootConfig {
  readonly rootId: string;
  readonly label: string;
  readonly canonicalUncRoot: string;
  readonly enabled: boolean;
}

export interface M1TestMediaItem {
  readonly mediaId: string;
  readonly rootId: string;
  readonly relativePath: string;
  readonly label: string;
  readonly scenario: 'basic' | 'spaces' | 'cjk' | 'comma' | 'long_path' | 'missing_file';
}

export type MediaActionErrorCode =
  | 'UNKNOWN_MEDIA_ID'
  | 'UNMAPPED_ROOT'
  | 'DISABLED_ROOT'
  | 'INVALID_UNC_ROOT'
  | 'INVALID_RELATIVE_PATH'
  | 'PATH_TRAVERSAL_REJECTED'
  | 'FILE_NOT_FOUND'
  | 'NAS_OFFLINE_OR_TIMEOUT'
  | 'PERMISSION_DENIED'
  | 'OPENER_FAILED';

export type MediaActionResult =
  | {
      readonly ok: true;
      readonly mediaId: string;
      readonly action: 'open' | 'reveal';
      readonly resolvedUncPath: string;
      readonly elapsedMs: number;
    }
  | {
      readonly ok: false;
      readonly mediaId: string;
      readonly action: 'open' | 'reveal';
      readonly code: MediaActionErrorCode;
      readonly message: string;
      readonly resolvedUncPath?: string;
      readonly elapsedMs: number;
    };

export interface SpikeStatus {
  readonly platform: string;
  readonly nodeVersion: string;
  readonly nodeSqliteAvailable: boolean;
  readonly localDataDir: string;
  readonly localDatabasePath: string;
  readonly spikeOverridePath: string;
  readonly activeUncRoot: string;
  readonly roots: readonly MediaRootConfig[];
  readonly items: readonly M1TestMediaItem[];
}
