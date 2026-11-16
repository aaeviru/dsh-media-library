import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { Config } from './config.ts';
import { MediaLibrarySpikeService } from './spike-service.ts';
import type {
  AliasInput,
  CreateTagInput,
  GetMediaInput,
  ImportTagStudioInput,
  ImportTagStudioResult,
  LibraryOverview,
  ListTagsInput,
  ListTagsResult,
  MediaActionResult,
  MediaDetailItem,
  MergePreviewResult,
  MergeTagsInput,
  MergeTagsResult,
  PreviewMergeInput,
  RenameTagInput,
  SearchMediaInput,
  SearchMediaResult,
  SetMediaTagsInput,
  SetMediaTagsResult,
  SpikeStatus,
  TagMutationResult,
  TagRevisionInput,
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
}
