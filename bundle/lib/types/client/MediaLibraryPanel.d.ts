import type { MediaLibraryKey } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';
type Translate = (key: MediaLibraryKey) => string;
export declare function MediaLibraryPanel({ t, mediaLibrary, }: {
    t: Translate;
    mediaLibrary: MediaLibraryNamespace;
}): import("react").JSX.Element;
export {};
//# sourceMappingURL=MediaLibraryPanel.d.ts.map