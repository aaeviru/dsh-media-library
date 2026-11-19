import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { Config } from './config.ts';
import { MediaLibrarySpikeService } from './spike-service.ts';
import type {
  AliasInput,
  CommitIngestionInput,
  CommitIngestionResult,
  CreateBackupInput,
  CreateBackupResult,
  CreateTagInput,
  DeletePerformerAliasInput,
  DeletePerformerAliasResult,
  ExportMappingReportInput,
  ExportMappingReportResult,
  FetchedMetadataCandidate,
  FetchIngestionMetadataInput,
  GetMediaInput,
  ImportTagStudioInput,
  ImportTagStudioResult,
  IngestionManifest,
  IngestionTask,
  LibraryOverview,
  ListPerformerReviewInput,
  ListTagsInput,
  ListTagsResult,
  ManifestPerformerPreview,
  MediaActionResult,
  MediaDetailItem,
  MergePreviewResult,
  MergeTagsInput,
  MergeTagsResult,
  OpenStagingFileInput,
  OpsStatus,
  PerformerAliasRecord,
  PerformerReviewItem,
  PreviewManifestPerformersInput,
  PreviewMergeInput,
  PromotePerformerTagInput,
  PromotePerformerTagResult,
  ReconcileIngestionResult,
  RenameTagInput,
  ResolvePerformerReviewInput,
  ResolvePerformerReviewResult,
  ReviewIngestionInput,
  ReviewIngestionResult,
  ScanStagingResult,
  SearchMediaInput,
  SearchMediaResult,
  SetMediaTagsInput,
  SetMediaTagsResult,
  SpikeStatus,
  TagMutationResult,
  TagRevisionInput,
  UpsertPerformerAliasInput,
  UpsertPerformerAliasResult,
} from './types.ts';

export type { Config } from './config.ts';

/**
 * Host Remote service for the Media Library plugin.
 * Exposes a strictly mediaId- and controlled-query-based RPC surface over Typert (`mediaLibrary` namespace).
 */
export class MediaLibraryRemote extends TypertRemoteService {
  static inject = ['typert'];

  static get Config(): typeof Config {
    return Config;
  }

  readonly spikeService: MediaLibrarySpikeService;

  constructor(ctx: Context, config: Config) {
    super(ctx, 'mediaLibrary', { namespace: 'mediaLibrary' });
    this.spikeService = new MediaLibrarySpikeService({
      dataDirName: config.dataDir,
      configuredUncRoot: () => config.uncRoot.get(),
      configuredTagStudioCopyPath: () => config.tagstudioCopyPath.get(),
      configuredNasBackupDir: () => config.nasBackupDir.get(),
      configuredStagingDir: () => config.stagingDir.get(),
      allowCrossDeviceCopy: config.allowCrossDeviceCopy,
      configuredTargetSubdir: () => config.ingestionTargetSubdir.get(),
      cmadbBaseUrl: config.cmadbBaseUrl,
      ppvdbBaseUrl: config.ppvdbBaseUrl,
      configuredCmadbCookie: () => config.cmadbCookie.get(),
      configuredPpvdbCookie: () => config.ppvdbCookie.get(),
      backupRetentionCount: config.backupRetentionCount,
      preMigrateRetentionCount: config.preMigrateRetentionCount,
      autoDailyBackup: config.autoDailyBackup,
      probeTimeoutMs: config.probeTimeoutMs,
    });
  }

  /**
   * Read Host runtime diagnostics, local non-SMB SQLite paths, and M1 test items.
   */
  @Remote('spikeStatus')
  async spikeStatus(): Promise<SpikeStatus> {
    return this.spikeService.getSpikeStatus();
  }

  /**
   * Read local SQLite database overview, counts, and last import summary.
   */
  @Remote('getLibraryOverview')
  async getLibraryOverview(): Promise<LibraryOverview> {
    return this.spikeService.getLibraryOverview();
  }

  /**
   * List or search tags by name, shorthand, or alias.
   */
  @Remote('listTags')
  async listTags(input?: ListTagsInput): Promise<ListTagsResult> {
    return this.spikeService.listTags(input);
  }

  /**
   * Search imported media by text, catalog number, date range, and multi-tag AND filters with stable keyset pagination.
   */
  @Remote('searchMedia')
  async searchMedia(input?: SearchMediaInput): Promise<SearchMediaResult> {
    return this.spikeService.searchMedia(input);
  }

  /**
   * Get full details for a single media item by its mediaId.
   */
  @Remote('getMedia')
  async getMedia(input: GetMediaInput): Promise<MediaDetailItem | null> {
    return this.spikeService.getMedia(input);
  }

  /**
   * Import a read-only TagStudio ts_library.sqlite copy into the local SQLite database.
   */
  @Remote('importTagStudioCopy')
  async importTagStudioCopy(input?: ImportTagStudioInput): Promise<ImportTagStudioResult> {
    return this.spikeService.importTagStudioCopy(input);
  }

  /**
   * Open a media item by its allowlisted mediaId in the default Windows media player.
   * @param mediaId - Registered media item identifier.
   */
  @Remote('openMedia')
  async openMedia(mediaId: string): Promise<MediaActionResult> {
    return this.spikeService.openMedia(mediaId);
  }

  /**
   * Reveal and highlight a media item by its allowlisted mediaId in Windows Explorer.
   * @param mediaId - Registered media item identifier.
   */
  @Remote('revealMedia')
  async revealMedia(mediaId: string): Promise<MediaActionResult> {
    return this.spikeService.revealMedia(mediaId);
  }

  /**
   * Create a custom tag (name is trimmed; normalized-name collisions return TAG_NAME_CONFLICT).
   */
  @Remote('createTag')
  async createTag(input: CreateTagInput): Promise<TagMutationResult> {
    return this.spikeService.createTag(input);
  }

  /**
   * Rename a tag using optimistic revision checking.
   */
  @Remote('renameTag')
  async renameTag(input: RenameTagInput): Promise<TagMutationResult> {
    return this.spikeService.renameTag(input);
  }

  /**
   * Add an alias to a tag; clashes with other tags' names or aliases return ALIAS_CONFLICT.
   */
  @Remote('addAlias')
  async addAlias(input: AliasInput): Promise<TagMutationResult> {
    return this.spikeService.addAlias(input);
  }

  /**
   * Remove an alias from a tag using optimistic revision checking.
   */
  @Remote('removeAlias')
  async removeAlias(input: AliasInput): Promise<TagMutationResult> {
    return this.spikeService.removeAlias(input);
  }

  /**
   * Atomically add and/or remove tags on up to 200 media items by mediaId and tagId.
   */
  @Remote('setMediaTags')
  async setMediaTags(input: SetMediaTagsInput): Promise<SetMediaTagsResult> {
    return this.spikeService.setMediaTags(input);
  }

  /**
   * Read-only impact preview of merging tag B (source) into tag A (target).
   */
  @Remote('previewMerge')
  async previewMerge(input: PreviewMergeInput): Promise<MergePreviewResult> {
    return this.spikeService.previewMerge(input);
  }

  /**
   * Merge tag B (source) into tag A (target) atomically; B is archived, never deleted.
   */
  @Remote('mergeTags')
  async mergeTags(input: MergeTagsInput): Promise<MergeTagsResult> {
    return this.spikeService.mergeTags(input);
  }

  /**
   * Archive a tag non-destructively (existing associations and search stay readable).
   */
  @Remote('archiveTag')
  async archiveTag(input: TagRevisionInput): Promise<TagMutationResult> {
    return this.spikeService.archiveTag(input);
  }

  /**
   * Restore an archived tag.
   */
  @Remote('restoreTag')
  async restoreTag(input: TagRevisionInput): Promise<TagMutationResult> {
    return this.spikeService.restoreTag(input);
  }

  /**
   * Read backup retention, degraded-mode status, and managed backup inventory.
   */
  @Remote('getOpsStatus')
  async getOpsStatus(): Promise<OpsStatus> {
    return this.spikeService.getOpsStatus();
  }

  /**
   * Create a verified online SQLite backup and prune excess old plugin backups.
   */
  @Remote('createBackup')
  async createBackup(input?: CreateBackupInput): Promise<CreateBackupResult> {
    return this.spikeService.createBackup(input);
  }

  /**
   * Export a portable JSON or CSV mapping report for recovery and audit.
   */
  @Remote('exportMappingReport')
  async exportMappingReport(input: ExportMappingReportInput): Promise<ExportMappingReportResult> {
    return this.spikeService.exportMappingReport(input);
  }

  /**
   * Scan the configured staging temp directory and plan recoverable manifests.
   */
  @Remote('scanStagingFiles')
  async scanStagingFiles(): Promise<ScanStagingResult> {
    return this.spikeService.scanStagingFiles();
  }

  /**
   * List staged/reviewed/moving/indexed/failed ingestion manifests.
   */
  @Remote('listIngestionManifests')
  async listIngestionManifests(): Promise<IngestionManifest[]> {
    return this.spikeService.listIngestionManifests();
  }

  /**
   * List durable ingestion task progress records (running/succeeded/failed/interrupted).
   */
  @Remote('listIngestionTasks')
  async listIngestionTasks(): Promise<IngestionTask[]> {
    return this.spikeService.listIngestionTasks();
  }

  /**
   * Fetch candidate metadata and tags from FC2CMADB/FC2PPVDB for a staged manifest.
   */
  @Remote('fetchIngestionMetadata')
  async fetchIngestionMetadata(input: FetchIngestionMetadataInput): Promise<FetchedMetadataCandidate> {
    return this.spikeService.fetchIngestionMetadata(input);
  }

  /**
   * Record human review approval/rejection and confirmed tags for a manifest.
   */
  @Remote('reviewIngestion')
  async reviewIngestion(input: ReviewIngestionInput): Promise<ReviewIngestionResult> {
    return this.spikeService.reviewIngestion(input);
  }

  /**
   * Execute a reviewed ingestion manifest (move + verify + index + conservative cleanup).
   */
  @Remote('commitIngestion')
  async commitIngestion(input: CommitIngestionInput): Promise<CommitIngestionResult> {
    return this.spikeService.commitIngestion(input);
  }

  /**
   * Reconcile interrupted manifests (copied-not-deleted, moved-not-indexed, indexed-but-missing).
   */
  @Remote('reconcileIngestion')
  async reconcileIngestion(): Promise<ReconcileIngestionResult> {
    return this.spikeService.reconcileIngestion();
  }

  /**
   * Open a video file currently inside the Host-configured staging temp folder using the native player.
   */
  @Remote('openStagingFile')
  async openStagingFile(input: OpenStagingFileInput): Promise<MediaActionResult> {
    return this.spikeService.openStagingFile(input);
  }

  /**
   * Preview deterministic performer-alias matches, pending review items, and normal tag matches for a manifest.
   */
  @Remote('previewManifestPerformers')
  async previewManifestPerformers(input: PreviewManifestPerformersInput): Promise<ManifestPerformerPreview> {
    return this.spikeService.previewManifestPerformers(input);
  }

  /**
   * List explicit performer-alias mappings with remediation and ambiguity metadata.
   */
  @Remote('listPerformerAliases')
  async listPerformerAliases(): Promise<PerformerAliasRecord[]> {
    return this.spikeService.listPerformerAliases();
  }

  /**
   * Create or update a durable performer-alias mapping (normalized source name -> tagId).
   */
  @Remote('upsertPerformerAlias')
  async upsertPerformerAlias(input: UpsertPerformerAliasInput): Promise<UpsertPerformerAliasResult> {
    return this.spikeService.upsertPerformerAlias(input);
  }

  /**
   * Remove a performer-alias mapping by id.
   */
  @Remote('deletePerformerAlias')
  async deletePerformerAlias(input: DeletePerformerAliasInput): Promise<DeletePerformerAliasResult> {
    return this.spikeService.deletePerformerAlias(input);
  }

  /**
   * List pending or historical performer review queue items.
   */
  @Remote('listPerformerReviewQueue')
  async listPerformerReviewQueue(input?: ListPerformerReviewInput): Promise<PerformerReviewItem[]> {
    return this.spikeService.listPerformerReviewQueue(input);
  }

  /**
   * Resolve a performer review queue item (bind existing tag, create performer tag, or skip).
   */
  @Remote('resolvePerformerReview')
  async resolvePerformerReview(input: ResolvePerformerReviewInput): Promise<ResolvePerformerReviewResult> {
    return this.spikeService.resolvePerformerReview(input);
  }

  /**
   * Promote an auto-applied performer-rule media tag association to manual protection.
   */
  @Remote('promotePerformerTagToManual')
  async promotePerformerTagToManual(input: PromotePerformerTagInput): Promise<PromotePerformerTagResult> {
    return this.spikeService.promotePerformerTagToManual(input);
  }
}
