import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { Config } from './config.ts';
import { MediaLibrarySpikeService } from './spike-service.ts';
import type { MediaActionResult, SpikeStatus } from './types.ts';
export type { Config } from './config.ts';
/**
 * Host Remote service for the Media Library plugin.
 * Exposes a strictly mediaId-based RPC surface over Typert (`mediaLibrary` namespace).
 */
export declare class MediaLibraryRemote extends TypertRemoteService {
    static inject: string[];
    static get Config(): typeof Config;
    readonly spikeService: MediaLibrarySpikeService;
    constructor(ctx: Context, config: Config);
    /**
     * Read Host runtime diagnostics, local non-SMB SQLite paths, and M1 test items.
     */
    spikeStatus(): Promise<SpikeStatus>;
    /**
     * Open a media item by its allowlisted mediaId in the default Windows media player.
     * @param mediaId - Registered media item identifier.
     */
    openMedia(mediaId: string): Promise<MediaActionResult>;
    /**
     * Reveal and highlight a media item by its allowlisted mediaId in Windows Explorer.
     * @param mediaId - Registered media item identifier.
     */
    revealMedia(mediaId: string): Promise<MediaActionResult>;
}
//# sourceMappingURL=remote.d.ts.map