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

export type CatalogMatchMode = 'exact' | 'prefix';

export type MediaFileStatus =
  | 'indexed'
  | 'missing'
  | 'offline'
  | 'unmapped'
  | 'permission_denied';

export interface TagSummary {
  readonly id: number;
  readonly name: string;
  readonly normalizedName: string;
  readonly shorthand: string | null;
  readonly aliases: readonly string[];
  readonly mediaCount: number;
}

export interface AmbiguousAliasWarning {
  readonly normalizedAlias: string;
  readonly matchingTags: ReadonlyArray<{
    readonly id: number;
    readonly name: string;
  }>;
}

export interface ListTagsInput {
  readonly query?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ListTagsResult {
  readonly tags: readonly TagSummary[];
  readonly ambiguousAliases: readonly AmbiguousAliasWarning[];
}

export interface MediaTagChip {
  readonly id: number;
  readonly name: string;
  readonly shorthand: string | null;
}

export interface MediaSearchItem {
  readonly mediaId: string;
  readonly id: number;
  readonly rootId: string;
  readonly relativePath: string;
  readonly filename: string;
  readonly extension: string;
  readonly title: string | null;
  readonly catalogNumber: string | null;
  readonly mediaDate: string | null;
  readonly addedAt: string | null;
  readonly status: MediaFileStatus;
  readonly revision: number;
  readonly tags: readonly MediaTagChip[];
}

export interface MediaDetailItem extends MediaSearchItem {
  readonly catalogSource: string | null;
  readonly dateSource: string | null;
  readonly textFields: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
    readonly isMultiline: boolean;
  }>;
}

export interface SearchMediaInput {
  readonly text?: string | undefined;
  readonly catalogNumber?: string | undefined;
  readonly catalogMatchMode?: CatalogMatchMode | undefined;
  readonly tagIds?: readonly number[] | undefined;
  readonly tagNamesOrAliases?: readonly string[] | undefined;
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface SearchMediaResult {
  readonly items: readonly MediaSearchItem[];
  readonly nextCursor: string | null;
  readonly totalMatching: number;
  readonly elapsedMs: number;
  readonly resolvedTagIds: readonly number[];
  readonly unresolvedTagQueries: readonly string[];
  readonly ambiguousAliases: readonly AmbiguousAliasWarning[];
}

export interface GetMediaInput {
  readonly mediaId: string;
}

export interface LibraryOverview {
  readonly databasePath: string;
  readonly databaseExists: boolean;
  readonly schemaVersion: number;
  readonly activeUncRoot: string;
  readonly defaultTagStudioSourcePath: string;
  readonly counts: {
    readonly mediaFiles: number;
    readonly tags: number;
    readonly tagAliases: number;
    readonly mediaTags: number;
    readonly importRuns: number;
  };
  readonly lastImport: {
    readonly finishedAt: string;
    readonly status: string;
    readonly sourceFingerprint: string;
    readonly importedEntries: number;
    readonly skippedSidecarEntries: number;
    readonly importedTags: number;
  } | null;
}

export interface ImportTagStudioInput {
  readonly sourceDbPath?: string | undefined;
  readonly uncRoot?: string | undefined;
  readonly force?: boolean | undefined;
}

export interface ImportTagStudioResult {
  readonly ok: boolean;
  readonly status: 'succeeded' | 'already_imported' | 'failed';
  readonly message: string;
  readonly importedEntries: number;
  readonly skippedSidecarEntries: number;
  readonly importedTags: number;
  readonly importedMediaTags: number;
  readonly sourceSha256: string;
}
