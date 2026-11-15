import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.ts';
export { Config } from './config.ts';
export { MediaLibraryRemote } from './remote.ts';
export { MediaLibrarySpikeService } from './spike-service.ts';
export * from './types.ts';
export * from './unc-path.ts';
export declare const name = "dsh-media-library";
export declare const inject: string[];
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map