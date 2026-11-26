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
  readonly ingestionTargetSubdir?: string | undefined;
  readonly ingestionAutoDateSubdir?: boolean | undefined;
  readonly roots: readonly MediaRootConfig[];
  readonly items: readonly M1TestMediaItem[];
}

export type CatalogMatchMode = 'exact' | 'prefix';

export type MediaSortField = 'media_date' | 'added_at' | 'catalog_number' | 'filename';
export type MediaSortOrder = 'desc' | 'asc';

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
  readonly revision: number;
  readonly archived: boolean;
  readonly mergedIntoId: number | null;
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
  /** Archived tags are hidden unless explicitly requested (`B5`). */
  readonly includeArchived?: boolean | undefined;
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
  readonly sortBy?: MediaSortField | undefined;
  readonly sortOrder?: MediaSortOrder | undefined;
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

export type MutationErrorCode =
  | 'IN_PROGRESS'
  | 'INVALID_INPUT'
  | 'TAG_NOT_FOUND'
  | 'MEDIA_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'TAG_NAME_CONFLICT'
  | 'ALIAS_CONFLICT'
  | 'ALIAS_NOT_FOUND'
  | 'BATCH_TOO_LARGE'
  | 'TAG_IN_USE'
  | 'MERGE_WOULD_CREATE_CYCLE'
  | 'TAG_ARCHIVED'
  | 'TAG_NOT_ARCHIVED'
  | 'READ_ONLY_DEGRADED'
  | 'INTERNAL_ERROR';

/** One failing item of a rejected batch (all-or-nothing, so nothing was written). */
export interface MutationItemFailure {
  readonly mediaId: string | null;
  readonly tagId: number | null;
  readonly code: MutationErrorCode;
  readonly message: string;
}

export interface MutationError {
  readonly ok: false;
  readonly code: MutationErrorCode;
  readonly message: string;
  readonly failures: readonly MutationItemFailure[];
}

export interface CreateTagInput {
  readonly name: string;
}

export interface RenameTagInput {
  readonly tagId: number;
  readonly name: string;
  readonly expectedRevision: number;
}

export interface AliasInput {
  readonly tagId: number;
  readonly alias: string;
  readonly expectedRevision: number;
}

export interface TagRevisionInput {
  readonly tagId: number;
  readonly expectedRevision: number;
}

export interface TagMutationSuccess {
  readonly ok: true;
  readonly tagId: number;
  readonly revision: number;
  readonly mutationId: number;
}

export type TagMutationResult = TagMutationSuccess | MutationError;

export interface MediaRevisionExpectation {
  readonly mediaId: string;
  readonly revision: number;
}

export interface SetMediaTagsInput {
  readonly mediaIds: readonly string[];
  readonly addTagIds?: readonly number[] | undefined;
  readonly removeTagIds?: readonly number[] | undefined;
  /** Optional optimistic check against the revision shown in search results. */
  readonly expectedMediaRevisions?: readonly MediaRevisionExpectation[] | undefined;
}

export interface SetMediaTagsSuccess {
  readonly ok: true;
  readonly mutationId: number;
  readonly mediaCount: number;
  readonly added: number;
  readonly removed: number;
  readonly unchanged: number;
}

export type SetMediaTagsResult = SetMediaTagsSuccess | MutationError;

export interface PreviewMergeInput {
  /** Tag A: survives the merge. */
  readonly targetTagId: number;
  /** Tag B: archived with `merged_into_id = A`. */
  readonly sourceTagId: number;
}

export interface MergeTagsInput extends PreviewMergeInput {
  readonly expectedTargetRevision: number;
  readonly expectedSourceRevision: number;
}

export interface MergePreviewSuccess {
  readonly ok: true;
  readonly targetTagId: number;
  readonly sourceTagId: number;
  readonly targetRevision: number;
  readonly sourceRevision: number;
  /** Media items carrying tag B (affected by the merge). */
  readonly affectedMedia: number;
  /** Media items carrying both A and B (deduplicated). */
  readonly dedupedMedia: number;
  readonly aliasesMigrated: number;
  readonly aliasesConflicting: number;
  readonly parentEdgesMigrated: number;
  readonly parentEdgesDeduped: number;
  readonly performerAliasesMigrated?: number | undefined;
  readonly performerAliasesDeduped?: number | undefined;
  readonly wouldCreateCycle: boolean;
}

export type MergePreviewResult = MergePreviewSuccess | MutationError;

export interface MergeTagsSuccess {
  readonly ok: true;
  readonly mutationId: number;
  readonly targetTagId: number;
  readonly targetRevision: number;
  readonly sourceTagId: number;
  readonly sourceRevision: number;
  readonly migratedMediaTags: number;
  readonly dedupedMediaTags: number;
  readonly aliasesMigrated: number;
  readonly aliasesDropped: number;
  readonly parentEdgesMigrated: number;
  readonly performerAliasesMigrated?: number | undefined;
  readonly performerAliasesDeduped?: number | undefined;
}

export type MergeTagsResult = MergeTagsSuccess | MutationError;

// ---------------------------------------------------------------------------
// Issue #6 M3: Backup, Restore, Degraded Mode & Portable Mapping Export
// ---------------------------------------------------------------------------

export type BackupKind = 'daily' | 'pre-migrate';

export interface ManagedBackupEntry {
  readonly filename: string;
  readonly path: string;
  readonly kind: BackupKind;
  readonly size: number;
  readonly mtimeIso: string;
}

export interface DegradedModeState {
  readonly degraded: boolean;
  readonly reason: string | null;
  readonly schemaVersion: number;
  readonly supportedMaxVersion: number;
  readonly healthOk: boolean;
  readonly checkedAt: string;
}

export interface OpsStatus {
  readonly localDataDir: string;
  readonly localDatabasePath: string;
  readonly backupDir: string;
  readonly nasBackupDir: string | null;
  readonly dailyRetentionCount: number;
  readonly preMigrateRetentionCount: number;
  readonly autoDailyBackup: boolean;
  readonly lastAutoBackupAt: string | null;
  readonly lastBackupSha256: string | null;
  readonly degradedState: DegradedModeState;
  readonly backups: readonly ManagedBackupEntry[];
}

export interface CreateBackupInput {
  readonly reason?: 'manual' | 'daily' | undefined;
}

export interface CreateBackupResult {
  readonly ok: boolean;
  readonly backupPath?: string | undefined;
  readonly sha256?: string | undefined;
  readonly size?: number | undefined;
  readonly prunedCount?: number | undefined;
  readonly nasCopyPath?: string | null | undefined;
  readonly nasCopyWarning?: string | null | undefined;
  readonly error?: string | undefined;
}

export type MappingReportFormat = 'json' | 'csv';

export interface ExportMappingReportInput {
  readonly format: MappingReportFormat;
}

export interface ExportMappingReportResult {
  readonly ok: boolean;
  readonly format: MappingReportFormat;
  readonly filename: string;
  readonly mimeType: string;
  readonly rowCount: number;
  readonly sha256: string;
  readonly content: string;
  readonly error?: string | undefined;
}

// ---------------------------------------------------------------------------
// Issue #7 M4: Recoverable Media Ingestion & Metadata Lookup
// ---------------------------------------------------------------------------

export type IngestionState = 'planned' | 'reviewed' | 'moving' | 'indexed' | 'failed';
export type IngestionReviewDecision = 'pending' | 'approved' | 'rejected';

export interface StagingFileItem {
  readonly filename: string;
  readonly relativePath: string;
  readonly tempPath: string;
  readonly targetRelativePath: string;
  readonly fileSize: number;
  readonly mtimeIso: string;
  readonly catalogNumber: string | null;
  readonly manifestId: number | null;
  readonly state: IngestionState | null;
  readonly reviewDecision: IngestionReviewDecision | null;
}

export interface IngestionManifestTag {
  readonly tagId?: number | undefined;
  readonly name: string;
}

export interface IngestionManifest {
  readonly id: number;
  readonly sourceId: string;
  readonly tempPath: string;
  readonly targetRootId: string;
  readonly targetRelativePath: string;
  readonly filename: string;
  readonly title: string | null;
  readonly catalogNumber: string | null;
  readonly mediaDate: string | null;
  readonly actresses: readonly string[];
  readonly tags: readonly IngestionManifestTag[];
  readonly metadataSource: string | null;
  readonly checksumSha256: string;
  readonly fileSize: number;
  readonly state: IngestionState;
  readonly reviewDecision: IngestionReviewDecision;
  readonly lastError: string | null;
  readonly indexedMediaId: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScanStagingResult {
  readonly ok: boolean;
  readonly stagingDir: string;
  readonly targetRootId: string;
  readonly targetSubdir: string;
  readonly autoDateSubdir?: boolean | undefined;
  readonly elapsedMs: number;
  readonly files: readonly StagingFileItem[];
  readonly manifests: readonly IngestionManifest[];
  readonly error?: string | undefined;
}

/**
 * Parse a strict calendar ISO date (`YYYY-MM-DD`) into `{ year, month }`.
 * Returns `null` for empty, malformed, or non-existent calendar dates (e.g. `2025-02-30`).
 */
export function parseIsoYearMonth(
  mediaDate: string | null | undefined,
): { readonly year: string; readonly month: string } | null {
  if (typeof mediaDate !== 'string') return null;
  const trimmed = mediaDate.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const yearNum = Number(match[1]);
  const monthNum = Number(match[2]);
  const dayNum = Number(match[3]);
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return null;
  const check = new Date(0);
  check.setUTCFullYear(yearNum, monthNum - 1, dayNum);
  check.setUTCHours(0, 0, 0, 0);
  if (
    check.getUTCFullYear() !== yearNum ||
    check.getUTCMonth() !== monthNum - 1 ||
    check.getUTCDate() !== dayNum
  ) {
    return null;
  }
  return { year: match[1]!, month: match[2]! };
}

/**
 * Pure Host/Client shared helper computing the canonical target relative path for ingestion (`Issue #69 B1/B2`).
 * - Expects `targetSubdir` to be already normalized or raw (without re-trimming segment spaces that `normalizeTargetSubdir` preserves).
 * - When `autoDateSubdir` is false, preserves flat `<targetSubdir>/<filename>` (or `<filename>` when subdir is empty).
 * - When `autoDateSubdir` is true, appends `YYYY/MM` from valid `mediaDate` (`YYYY-MM-DD`), falling back to local `now`.
 */
export function computeIngestionTargetRelativePath(options: {
  readonly filename: string;
  readonly targetSubdir: string;
  readonly autoDateSubdir: boolean;
  readonly mediaDate?: string | null | undefined;
  readonly now?: Date | undefined;
}): string {
  const cleanSubdir = options.targetSubdir
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
  if (!options.autoDateSubdir) {
    return cleanSubdir ? `${cleanSubdir}/${options.filename}` : options.filename;
  }
  const parsed = parseIsoYearMonth(options.mediaDate);
  const effectiveNow = options.now ?? new Date();
  const yyyyMm = parsed
    ? `${parsed.year}/${parsed.month}`
    : `${String(effectiveNow.getFullYear()).padStart(4, '0')}/${String(effectiveNow.getMonth() + 1).padStart(2, '0')}`;
  return cleanSubdir ? `${cleanSubdir}/${yyyyMm}/${options.filename}` : `${yyyyMm}/${options.filename}`;
}

export interface FetchIngestionMetadataInput {
  readonly manifestId?: number | undefined;
  readonly relativePath?: string | undefined;
}

export interface FetchedMetadataCandidate {
  readonly ok: boolean;
  readonly provider: string | null;
  readonly category: 'ok' | 'not_found' | 'auth_or_blocked' | 'rate_limited' | 'transient_http' | 'transient_network' | 'parse_error' | 'client_error' | 'no_code';
  readonly reason: string;
  readonly sourceUrl: string;
  readonly title: string | null;
  readonly writer: string | null;
  readonly actresses: readonly string[];
  readonly mediaDate: string | null;
  readonly candidateTags: readonly string[];
  readonly manifest: IngestionManifest | null;
}

export interface ReviewIngestionInput {
  readonly manifestId?: number | undefined;
  readonly relativePath?: string | undefined;
  readonly decision: 'approved' | 'rejected';
  readonly title?: string | undefined;
  readonly catalogNumber?: string | undefined;
  readonly mediaDate?: string | undefined;
  readonly tagIds?: readonly number[] | undefined;
  readonly newTagNames?: readonly string[] | undefined;
}

export interface ReviewIngestionResult {
  readonly ok: boolean;
  readonly code?: MutationErrorCode | 'MANIFEST_NOT_FOUND' | undefined;
  readonly message?: string | undefined;
  readonly manifest?: IngestionManifest | null | undefined;
}

export interface CommitIngestionInput {
  readonly manifestId: number;
}

export interface OpenStagingFileInput {
  readonly relativePath: string;
}

export type DeleteStagingFileErrorCode =
  | 'INVALID_INPUT'
  | 'MANIFEST_NOT_FOUND'
  | 'PATH_MISMATCH'
  | 'PATH_TRAVERSAL_REJECTED'
  | 'INVALID_UNC_ROOT'
  | 'ALREADY_INDEXED'
  | 'IN_PROGRESS'
  | 'FILE_NOT_FOUND'
  | 'FILE_CHANGED'
  | 'READ_ONLY_DEGRADED'
  | 'TRASH_MOVE_FAILED';

export interface DeleteStagingFileInput {
  readonly manifestId?: number | undefined;
  readonly relativePath?: string | undefined;
  readonly expectedFileSize: number;
}

export interface DeleteStagingFileResult {
  readonly ok: boolean;
  readonly code?: DeleteStagingFileErrorCode | undefined;
  readonly message: string;
  readonly deletedManifestId?: number | null | undefined;
  readonly trashRelativePath?: string | undefined;
  readonly fileSize?: number | undefined;
}

export interface CommitIngestionResult {
  readonly activeTask?: IngestionTask | undefined;
  readonly ok: boolean;
  readonly code?: 'REVIEW_REQUIRED' | 'PERFORMER_REVIEW_REQUIRED' | 'READ_ONLY_DEGRADED' | 'MANIFEST_NOT_FOUND' | 'MOVE_FAILED' | 'INDEX_FAILED' | 'CHECKSUM_MISMATCH' | 'IN_PROGRESS' | MediaActionErrorCode | undefined;
  readonly message: string;
  readonly idempotentReplay?: boolean | undefined;
  readonly mediaId?: number | null | undefined;
  readonly warning?: string | null | undefined;
  readonly manifest?: IngestionManifest | null | undefined;
}

export type IngestionTaskOp = 'fetch' | 'commit' | 'reconcile';
export type IngestionTaskStatus = 'running' | 'succeeded' | 'failed' | 'interrupted';

export type IngestionPhase = 'validation' | 'rename' | 'copy' | 'hash' | 'quick_check' | 'index' | 'cleanup';

export interface IngestionTask {
  readonly phase: IngestionPhase;
  readonly phaseStartedAt: string;
  readonly waitingWarning: boolean;
  readonly id: number;
  readonly targetKey: string;
  readonly op: IngestionTaskOp;
  readonly status: IngestionTaskStatus;
  readonly message: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface ReconcileIngestionResult {
  readonly activeTask?: IngestionTask | undefined;
  readonly ok: boolean;
  readonly reconciledCount: number;
  readonly copiedNotDeletedFixed: number;
  readonly movedNotIndexedFixed: number;
  readonly indexedButMissingMarked: number;
  readonly errors: readonly string[];
  readonly manifests: readonly IngestionManifest[];
}

// ---------------------------------------------------------------------------
// Issue #8 M4: Performer Alias Resolution & Review Queue
// ---------------------------------------------------------------------------

export type PerformerAliasPolicy = 'auto' | 'always_ask';
export type PerformerReviewReason = 'unknown' | 'ambiguous' | 'archived_target';
export type PerformerReviewStatus = 'pending' | 'resolved' | 'skipped';
export type PerformerResolutionMode = 'bind_existing' | 'create_performer_tag' | 'skip';

/**
 * Deterministic normalization for performer names (`Issue #8 B1`):
 * - NFKC (normalizes fullwidth/halfwidth Latin, halfwidth Katakana, composed/decomposed Unicode)
 * - Strips control characters, collapses all whitespace (including fullwidth U+3000), trims, and case-folds.
 */
export function normalizePerformerName(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface PerformerAliasRecord {
  readonly id: number;
  readonly normalizedName: string;
  readonly rawAlias: string;
  readonly tagId: number;
  readonly tagName: string;
  readonly tagKind: string;
  readonly targetArchived: boolean;
  readonly needsRemediation: boolean;
  readonly policy: PerformerAliasPolicy;
  readonly isAmbiguous: boolean;
  readonly note: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PerformerCandidateTag {
  readonly id: number;
  readonly name: string;
  readonly kind: string;
}

export interface PerformerReviewItem {
  readonly id: number;
  readonly manifestId: number | null;
  readonly manifestFilename: string | null;
  readonly mediaId: number | null;
  readonly rawName: string;
  readonly normalizedName: string;
  readonly reason: PerformerReviewReason;
  readonly candidateTags: readonly PerformerCandidateTag[];
  readonly status: PerformerReviewStatus;
  readonly resolutionMode: PerformerResolutionMode | null;
  readonly resolvedTagId: number | null;
  readonly resolvedTagName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PerformerPreviewEntry {
  readonly reviewId: number | null;
  readonly rawName: string;
  readonly normalizedName: string;
  readonly tagId: number;
  readonly tagName: string;
  readonly source: 'performer-rule' | 'manual';
  readonly confidence: number | null;
  readonly resolutionMode: PerformerResolutionMode | null;
  readonly alreadyManual: boolean;
}

export interface PerformerSkippedEntry {
  readonly reviewId: number;
  readonly rawName: string;
  readonly normalizedName: string;
}

/**
 * Deterministic normalization for normal tag names/aliases (`Issue #71`).
 * Matches Host `normalizeLabel` / `normalizeLookupKey` (trim, collapse whitespace, lowercase).
 */
export function normalizeTagName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

export interface NormalTagPreviewEntry {
  readonly rawName: string;
  readonly matchedTagId: number | null;
  readonly matchedTagName: string | null;
  readonly matchedVia: 'name' | 'alias' | 'new';
}

export interface PreviewTagNamesInput {
  readonly names: readonly string[];
}

export interface ManifestPerformerPreview {
  readonly manifestId: number;
  readonly canCommit: boolean;
  readonly autoMatched: readonly PerformerPreviewEntry[];
  readonly humanResolved: readonly PerformerPreviewEntry[];
  readonly skipped: readonly string[];
  readonly skippedEntries: readonly PerformerSkippedEntry[];
  readonly pendingReview: readonly PerformerReviewItem[];
  readonly normalTags: readonly NormalTagPreviewEntry[];
}

export interface PreviewManifestPerformersInput {
  readonly manifestId: number;
}

export interface UpsertPerformerAliasInput {
  readonly rawAlias: string;
  readonly tagId: number;
  readonly policy?: PerformerAliasPolicy | undefined;
  readonly note?: string | undefined;
}

export interface UpsertPerformerAliasResult {
  readonly ok: boolean;
  readonly code?: MutationErrorCode | undefined;
  readonly message?: string | undefined;
  readonly alias?: PerformerAliasRecord | null | undefined;
}

export interface DeletePerformerAliasInput {
  readonly aliasId: number;
}

export interface DeletePerformerAliasResult {
  readonly ok: boolean;
  readonly code?: MutationErrorCode | undefined;
  readonly message?: string | undefined;
}

export interface ListPerformerReviewInput {
  readonly status?: PerformerReviewStatus | 'all' | undefined;
  readonly manifestId?: number | undefined;
}

export interface ResolvePerformerReviewInput {
  readonly reviewId?: number | undefined;
  readonly manifestId?: number | undefined;
  readonly rawName?: string | undefined;
  readonly mode: PerformerResolutionMode;
  readonly tagId?: number | undefined;
  readonly newTagName?: string | undefined;
  readonly rememberRule?: boolean | undefined;
  readonly rulePolicy?: PerformerAliasPolicy | undefined;
}

export interface ResolvePerformerReviewResult {
  readonly ok: boolean;
  readonly code?: MutationErrorCode | 'REVIEW_NOT_FOUND' | undefined;
  readonly message?: string | undefined;
  readonly item?: PerformerReviewItem | null | undefined;
  readonly createdTagId?: number | null | undefined;
}

export interface PromotePerformerTagInput {
  readonly mediaId: string;
  readonly tagId: number;
}

export interface PromotePerformerTagResult {
  readonly ok: boolean;
  readonly code?: MutationErrorCode | undefined;
  readonly message?: string | undefined;
  readonly promoted?: boolean | undefined;
}
