import { MediaLibraryRemote } from "./remote.js";
export { Config } from "./config.js";
export { MediaLibraryRemote } from "./remote.js";
export { MediaLibrarySpikeService } from "./spike-service.js";
export * from "./types.js";
export * from "./unc-path.js";
export const name = 'dsh-media-library';
export const inject = ['typert'];
export function apply(ctx, config) {
    new MediaLibraryRemote(ctx, config);
}
//# sourceMappingURL=index.js.map