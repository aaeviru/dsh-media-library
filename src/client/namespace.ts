import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type {
  AliasInput,
  CommitIngestionInput,
  CommitIngestionResult,
  CreateBackupInput,
  CreateBackupResult,
  CreateTagInput,
  ExportMappingReportInput,
  ExportMappingReportResult,
  FetchedMetadataCandidate,
  FetchIngestionMetadataInput,
  GetMediaInput,
  ImportTagStudioInput,
  ImportTagStudioResult,
  IngestionManifest,
  LibraryOverview,
  ListTagsInput,
  ListTagsResult,
  MediaActionResult,
  MediaDetailItem,
  MergePreviewResult,
  MergeTagsInput,
  MergeTagsResult,
  OpsStatus,
  PreviewMergeInput,
  ReconcileIngestionResult,
  RenameTagInput,
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
  getOpsStatus: () => Promise<RemoteResult<OpsStatus>>;
  createBackup: (input: CreateBackupInput) => Promise<RemoteResult<CreateBackupResult>>;
  exportMappingReport: (input: ExportMappingReportInput) => Promise<RemoteResult<ExportMappingReportResult>>;
  scanStagingFiles: () => Promise<RemoteResult<ScanStagingResult>>;
  listIngestionManifests: () => Promise<RemoteResult<IngestionManifest[]>>;
  fetchIngestionMetadata: (input: FetchIngestionMetadataInput) => Promise<RemoteResult<FetchedMetadataCandidate>>;
  reviewIngestion: (input: ReviewIngestionInput) => Promise<RemoteResult<ReviewIngestionResult>>;
  commitIngestion: (input: CommitIngestionInput) => Promise<RemoteResult<CommitIngestionResult>>;
  reconcileIngestion: () => Promise<RemoteResult<ReconcileIngestionResult>>;
}
