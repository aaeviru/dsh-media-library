import { MediaLibraryIcon } from "./MediaLibraryIcon.js";
import { MediaLibraryPanel } from "./MediaLibraryPanel.js";
import { NS, en, zh } from "./locales.js";
export function mountMediaLibrary(ctx, mediaLibrary) {
    ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-media-library: dictionaries');
    const t = ctx.locale.bind(NS);
    ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'media-library',
        locale: NS,
        inject: () => ({ t, mediaLibrary }),
    }, MediaLibraryPanel));
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'media-library',
        order: 50,
        locale: NS,
        label: () => t('panel'),
    }, MediaLibraryIcon));
}
//# sourceMappingURL=mount.js.map