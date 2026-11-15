export declare const NS = "mediaLibrary";
export declare const en: {
    readonly panel: "Media Library";
    readonly heading: "Media Library — M1 Host & UNC Spike";
    readonly subtitle: "Verify DSH Host opening and revealing real Synology NAS UNC files strictly via mediaId allowlist.";
    readonly refresh: "Refresh Status";
    readonly platform: "Host OS Platform";
    readonly nodeVersion: "Node.js Runtime";
    readonly nodeSqlite: "Built-in node:sqlite Driver";
    readonly localDbPath: "Local SQLite Path (Non-SMB)";
    readonly overrideConfigPath: "Host Override Config File";
    readonly activeUncRoot: "Active Canonical UNC Root";
    readonly testItemsHeading: "M1 UNC Path Verification Scenarios (mediaId-only RPC)";
    readonly openBtn: "Open Default Player";
    readonly revealBtn: "Reveal in Explorer";
    readonly lastActionHeading: "Last Host Action Result";
    readonly statusAvailable: "Available";
    readonly statusMissing: "Unavailable";
    readonly rpcError: "Host RPC call failed.";
};
export type MediaLibraryKey = keyof typeof en;
export declare const zh: Record<keyof typeof en, string>;
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        mediaLibrary: MediaLibraryKey;
    }
}
//# sourceMappingURL=locales.d.ts.map