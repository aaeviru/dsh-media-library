import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type {
  GetMediaInput,
  ImportTagStudioInput,
  ImportTagStudioResult,
  LibraryOverview,
  ListTagsInput,
  ListTagsResult,
  MediaActionResult,
  MediaDetailItem,
  SearchMediaInput,
  SearchMediaResult,
  SpikeStatus,
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
}
