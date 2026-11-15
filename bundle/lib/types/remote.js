var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { Config } from "./config.js";
import { MediaLibrarySpikeService } from "./spike-service.js";
/**
 * Host Remote service for the Media Library plugin.
 * Exposes a strictly mediaId-based RPC surface over Typert (`mediaLibrary` namespace).
 */
let MediaLibraryRemote = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _spikeStatus_decorators;
    let _openMedia_decorators;
    let _revealMedia_decorators;
    return class MediaLibraryRemote extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _spikeStatus_decorators = [Remote('spikeStatus')];
            _openMedia_decorators = [Remote('openMedia')];
            _revealMedia_decorators = [Remote('revealMedia')];
            __esDecorate(this, null, _spikeStatus_decorators, { kind: "method", name: "spikeStatus", static: false, private: false, access: { has: obj => "spikeStatus" in obj, get: obj => obj.spikeStatus }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _openMedia_decorators, { kind: "method", name: "openMedia", static: false, private: false, access: { has: obj => "openMedia" in obj, get: obj => obj.openMedia }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _revealMedia_decorators, { kind: "method", name: "revealMedia", static: false, private: false, access: { has: obj => "revealMedia" in obj, get: obj => obj.revealMedia }, metadata: _metadata }, null, _instanceExtraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        static inject = ['typert'];
        static get Config() {
            return Config;
        }
        spikeService = __runInitializers(this, _instanceExtraInitializers);
        constructor(ctx, config) {
            super(ctx, 'mediaLibrary', { namespace: 'mediaLibrary' });
            const baseDir = ctx.baseDir;
            this.spikeService = new MediaLibrarySpikeService({
                baseDir,
                dataDirName: config.dataDir,
                configuredUncRoot: () => config.uncRoot.get(),
                probeTimeoutMs: config.probeTimeoutMs,
            });
        }
        /**
         * Read Host runtime diagnostics, local non-SMB SQLite paths, and M1 test items.
         */
        async spikeStatus() {
            return this.spikeService.getSpikeStatus();
        }
        /**
         * Open a media item by its allowlisted mediaId in the default Windows media player.
         * @param mediaId - Registered media item identifier.
         */
        async openMedia(mediaId) {
            return this.spikeService.openMedia(mediaId);
        }
        /**
         * Reveal and highlight a media item by its allowlisted mediaId in Windows Explorer.
         * @param mediaId - Registered media item identifier.
         */
        async revealMedia(mediaId) {
            return this.spikeService.revealMedia(mediaId);
        }
    };
})();
export { MediaLibraryRemote };
//# sourceMappingURL=remote.js.map