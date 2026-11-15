import type { Context } from '@deepseek-ai/cordis';
import type { Config } from './config.ts';
import { MediaLibraryRemote } from './remote.ts';

export { Config } from './config.ts';
export { MediaLibraryRemote } from './remote.ts';
export { MediaLibrarySpikeService } from './spike-service.ts';
export * from './types.ts';
export * from './unc-path.ts';

export const name = 'dsh-media-library';
export const inject = ['typert'];

export function apply(ctx: Context, config: Config): void {
  new MediaLibraryRemote(ctx, config);
}
