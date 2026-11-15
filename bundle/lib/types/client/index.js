import mediaLibraryRemote from '@deepseek-ai/dsh-experimental-media-library/remote';
import { mountMediaLibrary } from "./mount.js";
export const inject = ['remote', 'slots', 'locale'];
export async function apply(ctx) {
    const transport = ctx.plugin(async (owner) => {
        await owner.remote.$mount(mediaLibraryRemote);
    });
    const ui = ctx.inject(['remote.mediaLibrary', 'slots', 'locale'], (scope) => {
        mountMediaLibrary(scope, scope.remote.mediaLibrary);
    });
    const dispose = ctx.effect(function* () {
        yield transport.dispose;
        yield ui.dispose;
    }, 'dsh-media-library: mount');
    try {
        await Promise.all([transport, ui]);
    }
    catch (error) {
        await dispose();
        throw error;
    }
    return dispose;
}
//# sourceMappingURL=index.js.map