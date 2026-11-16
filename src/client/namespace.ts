import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
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
} from '../types.ts';

export interface MediaLibraryNamespace {
  spikeStatus: () => Promise<RemoteResult<SpikeStatus>>;
  getLibraryOverview: () => Promise<RemoteResult<LibraryOverview>>;
  listTags: (input?: ListTagsInput) => Promise<RemoteResult<ListTagsResult>>;
  searchMedia: (input?: SearchMediaInput) => Promise<RemoteResult<SearchMediaResult>>;
  getMedia: (input: GetMediaInput) => Promise<RemoteResult<MediaDetailItem | null>>;
  importTagStudioCopy: (input?: ImportTagStudioInput) => Promise<RemoteResult<ImportTagStudioResult>>;
  openMedia: (mediaId: string) => Promise<RemoteResult<MediaActionResult>>;
  revealMedia: (mediaId: string) => Promise<RemoteResult<MediaActionResult>>;
  createTag: (input: CreateTagInput) => Promise<RemoteResult<TagMutationResult>>;
  renameTag: (input: RenameTagInput) => Promise<RemoteResult<TagMutationResult>>;
  addAlias: (input: AliasInput) => Promise<RemoteResult<TagMutationResult>>;
  removeAlias: (input: AliasInput) => Promise<RemoteResult<TagMutationResult>>;
  setMediaTags: (input: SetMediaTagsInput) => Promise<RemoteResult<SetMediaTagsResult>>;
  previewMerge: (input: PreviewMergeInput) => Promise<RemoteResult<MergePreviewResult>>;
  mergeTags: (input: MergeTagsInput) => Promise<RemoteResult<MergeTagsResult>>;
  archiveTag: (input: TagRevisionInput) => Promise<RemoteResult<TagMutationResult>>;
  restoreTag: (input: TagRevisionInput) => Promise<RemoteResult<TagMutationResult>>;
}
