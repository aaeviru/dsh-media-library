import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { MediaActionResult, SpikeStatus } from '../types.ts';

export interface MediaLibraryNamespace {
  spikeStatus: () => Promise<RemoteResult<SpikeStatus>>;
  openMedia: (mediaId: string) => Promise<RemoteResult<MediaActionResult>>;
  revealMedia: (mediaId: string) => Promise<RemoteResult<MediaActionResult>>;
}
