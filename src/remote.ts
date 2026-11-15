import type { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { Config } from './config.ts';
import { MediaLibrarySpikeService } from './spike-service.ts';
import type { MediaActionResult, SpikeStatus } from './types.ts';

export type { Config } from './config.ts';

/**
 * Host Remote service for the Media Library plugin.
 * Exposes a strictly mediaId-based RPC surface over Typert (`mediaLibrary` namespace).
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
}
