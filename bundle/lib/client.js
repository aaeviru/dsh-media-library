window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-experimental-media-library",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let zod = require("zod");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		//#region ../../home/aaevi/projects/deepseek-harness/packages/typert/protocol/lib/types/remote-info.js
		/** Lazy assembly of generated Remote definitions using caller-supplied Zod; no runtime imports. */
		/**
		* Retain one generated definition per endpoint without constructing parsers or projections.
		* The class instance builds its shared descriptor/method index on first access;
		* input schemas and JSON Schema projections are cached only when requested.
		* @param spec - compiler-produced method facts and Zod factories.
		* @param zod - the generated artifact's Zod runtime for named-input parsers.
		* @returns a lazy, mountable info instance with no registration or transport effects.
		*/
		function createTypertRemoteInfo(spec, zod) {
			return new RemoteInfo(spec, zod);
		}
		var RemoteInfo = class {
			spec;
			zod;
			index;
			constructor(spec, zod) {
				this.spec = spec;
				this.zod = zod;
			}
			get package() {
				return this.spec.package;
			}
			get descriptors() {
				return this.resolve().descriptors;
			}
			get methods() {
				return this.resolve().methods;
			}
			resolve() {
				if (this.index !== void 0) return this.index;
				const zod = this.zod;
				const descriptors = [];
				const methods = Object.create(null);
				for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
					const separator = endpoint.indexOf("/");
					const namespace = endpoint.slice(0, separator);
					const method = endpoint.slice(separator + 1);
					const parameters = definition.parameters.map((parameter) => ({
						...parameter,
						wire: parameter.wire ?? parameter.name
					}));
					const descriptor = {
						...definition,
						id: `${this.spec.package}#${endpoint}`,
						namespace,
						method,
						parameters,
						result: definition.result.description === void 0 ? definition.result : new ResultValue(definition.result)
					};
					if (definition.invocation.kind === "direct") {
						const inputs = [];
						methods[endpoint] = Object.assign(descriptor, {
							input(options) {
								const strict = options?.strict === true;
								return inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zod);
							},
							invoke(remote, input, signal) {
								const named = input;
								const values = parameters.map((parameter) => named[parameter.wire]);
								if (definition.cancellation !== void 0) values.push(signal);
								const receiver = Reflect.get(remote, namespace);
								return Reflect.get(receiver, method).apply(receiver, values);
							}
						});
					}
					descriptors.push(descriptor);
				}
				return this.index = {
					descriptors,
					methods
				};
			}
		};
		function optional(parameter) {
			return parameter.source === "json" && parameter.acceptsUndefined === true;
		}
		var NamedInput = class {
			parameters;
			strict;
			zod;
			schema;
			projection;
			constructor(parameters, strict, zod) {
				this.parameters = parameters;
				this.strict = strict;
				this.zod = zod;
			}
			codec(parameter) {
				return this.strict ? parameter.strictCodec : parameter.codec;
			}
			create = () => this.schema ??= this.zod.strictObject(Object.fromEntries(this.parameters.map((parameter) => {
				const value = this.codec(parameter).create();
				return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()];
			})));
			get jsonSchema() {
				return this.project().jsonSchema;
			}
			get jsonSchemaError() {
				return this.project().jsonSchemaError;
			}
			project() {
				if (this.projection !== void 0) return this.projection;
				const unavailable = this.parameters.find((parameter) => this.codec(parameter).jsonSchema === void 0);
				if (unavailable !== void 0) return this.projection = { jsonSchemaError: this.codec(unavailable).jsonSchemaError ?? `No JSON Schema for parameter ${unavailable.wire}` };
				return this.projection = { jsonSchema: {
					type: "object",
					properties: Object.fromEntries(this.parameters.map((parameter) => [parameter.wire, {
						...this.codec(parameter).jsonSchema,
						...parameter.description === void 0 ? {} : { description: parameter.description }
					}])),
					required: this.parameters.filter((parameter) => !optional(parameter)).map((parameter) => parameter.wire),
					additionalProperties: false
				} };
			}
		};
		var ResultValue = class {
			spec;
			projection;
			constructor(spec) {
				this.spec = spec;
			}
			get mode() {
				return this.spec.mode;
			}
			get typeSymbol() {
				return this.spec.typeSymbol;
			}
			get create() {
				return this.spec.create;
			}
			get decode() {
				return this.spec.decode;
			}
			get encode() {
				return this.spec.encode;
			}
			get description() {
				return this.spec.description;
			}
			get jsonSchemaError() {
				return this.spec.jsonSchemaError;
			}
			get jsonSchema() {
				if (this.projection === void 0) {
					const schema = this.spec.jsonSchema;
					this.projection = { value: schema === void 0 ? void 0 : {
						...schema,
						description: this.spec.description
					} };
				}
				return this.projection.value;
			}
		};
		//#endregion
		//#region lib/typert.remote-client.js
		let _mediaLibrary_mediaId$schema$value;
		const _mediaLibrary_mediaId$schema = () => _mediaLibrary_mediaId$schema$value ??= zod.z.string();
		let _mediaLibrary_actionResult$schema$value;
		const _mediaLibrary_actionResult$schema = () => _mediaLibrary_actionResult$schema$value ??= zod.z.union([zod.z.object({
			ok: zod.z.literal(true).readonly(),
			mediaId: zod.z.string().readonly(),
			action: zod.z.union([zod.z.literal("open"), zod.z.literal("reveal")]).readonly(),
			resolvedUncPath: zod.z.string().readonly(),
			elapsedMs: zod.z.number().readonly()
		}), zod.z.object({
			ok: zod.z.literal(false).readonly(),
			mediaId: zod.z.string().readonly(),
			action: zod.z.union([zod.z.literal("open"), zod.z.literal("reveal")]).readonly(),
			code: zod.z.union([
				zod.z.literal("UNKNOWN_MEDIA_ID"),
				zod.z.literal("UNMAPPED_ROOT"),
				zod.z.literal("DISABLED_ROOT"),
				zod.z.literal("INVALID_UNC_ROOT"),
				zod.z.literal("INVALID_RELATIVE_PATH"),
				zod.z.literal("PATH_TRAVERSAL_REJECTED"),
				zod.z.literal("FILE_NOT_FOUND"),
				zod.z.literal("NAS_OFFLINE_OR_TIMEOUT"),
				zod.z.literal("PERMISSION_DENIED"),
				zod.z.literal("OPENER_FAILED")
			]).readonly(),
			message: zod.z.string().readonly(),
			resolvedUncPath: zod.z.string().readonly().optional(),
			elapsedMs: zod.z.number().readonly()
		})]);
		let _mediaLibrary_spikeStatus$schema$value;
		const _mediaLibrary_spikeStatus$schema = () => _mediaLibrary_spikeStatus$schema$value ??= zod.z.object({
			platform: zod.z.string().readonly(),
			nodeVersion: zod.z.string().readonly(),
			nodeSqliteAvailable: zod.z.boolean().readonly(),
			localDataDir: zod.z.string().readonly(),
			localDatabasePath: zod.z.string().readonly(),
			spikeOverridePath: zod.z.string().readonly(),
			activeUncRoot: zod.z.string().readonly(),
			roots: zod.z.array(zod.z.object({
				rootId: zod.z.string().readonly(),
				label: zod.z.string().readonly(),
				canonicalUncRoot: zod.z.string().readonly(),
				enabled: zod.z.boolean().readonly()
			})).readonly(),
			items: zod.z.array(zod.z.object({
				mediaId: zod.z.string().readonly(),
				rootId: zod.z.string().readonly(),
				relativePath: zod.z.string().readonly(),
				label: zod.z.string().readonly(),
				scenario: zod.z.union([
					zod.z.literal("basic"),
					zod.z.literal("spaces"),
					zod.z.literal("cjk"),
					zod.z.literal("comma"),
					zod.z.literal("long_path"),
					zod.z.literal("missing_file")
				]).readonly()
			})).readonly()
		});
		const TYPERT_REMOTE = createTypertRemoteInfo({
			package: "@deepseek-ai/dsh-experimental-media-library",
			methods: {
				"mediaLibrary/openMedia": {
					service: "mediaLibrary",
					description: "Open a media item by its allowlisted mediaId in the default Windows media player.",
					invocation: { kind: "direct" },
					parameters: [{
						name: "mediaId",
						description: "Registered media item identifier.",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-experimental-media-library#mediaLibrary/openMedia:mediaId",
							create: _mediaLibrary_mediaId$schema,
							jsonSchema: { type: "string" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-experimental-media-library#mediaLibrary/openMedia:mediaId",
							create: _mediaLibrary_mediaId$schema,
							jsonSchema: { type: "string" }
						}
					}],
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-experimental-media-library/types#MediaActionResult",
						create: _mediaLibrary_actionResult$schema
					},
					sourceLocation: {
						file: "packages/experimental/dsh-media-library/src/remote.ts",
						line: 44,
						column: 3
					}
				},
				"mediaLibrary/revealMedia": {
					service: "mediaLibrary",
					description: "Reveal and highlight a media item by its allowlisted mediaId in Windows Explorer.",
					invocation: { kind: "direct" },
					parameters: [{
						name: "mediaId",
						description: "Registered media item identifier.",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-experimental-media-library#mediaLibrary/revealMedia:mediaId",
							create: _mediaLibrary_mediaId$schema,
							jsonSchema: { type: "string" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-experimental-media-library#mediaLibrary/revealMedia:mediaId",
							create: _mediaLibrary_mediaId$schema,
							jsonSchema: { type: "string" }
						}
					}],
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-experimental-media-library/types#MediaActionResult",
						create: _mediaLibrary_actionResult$schema
					},
					sourceLocation: {
						file: "packages/experimental/dsh-media-library/src/remote.ts",
						line: 53,
						column: 3
					}
				},
				"mediaLibrary/spikeStatus": {
					service: "mediaLibrary",
					description: "Read Host runtime diagnostics, local non-SMB SQLite paths, and M1 test items.",
					invocation: { kind: "direct" },
					parameters: [],
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-experimental-media-library/types#SpikeStatus",
						create: _mediaLibrary_spikeStatus$schema
					},
					sourceLocation: {
						file: "packages/experimental/dsh-media-library/src/remote.ts",
						line: 35,
						column: 3
					}
				}
			}
		}, zod.z);
		//#endregion
		//#region src/client/MediaLibraryIcon.tsx
		function MediaLibraryIcon() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				width: "18",
				height: "18",
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: "1.9",
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "2",
						y: "4",
						width: "20",
						height: "16",
						rx: "2"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M10 9l5 3-5 3V9z" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6 4v16" })
				]
			});
		}
		//#endregion
		//#region src/client/MediaLibraryPanel.tsx
		function MediaLibraryPanel({ t, mediaLibrary }) {
			const [status, setStatus] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			const [pendingMediaId, setPendingMediaId] = (0, react.useState)(null);
			const [lastResult, setLastResult] = (0, react.useState)(null);
			const [loadError, setLoadError] = (0, react.useState)(null);
			const refreshStatus = (0, react.useCallback)(async () => {
				setLoading(true);
				setLoadError(null);
				try {
					const res = await mediaLibrary.spikeStatus();
					if (res.ok) setStatus(res.value);
					else setLoadError(res.error.message || t("rpcError"));
				} catch (err) {
					setLoadError(err instanceof Error ? err.message : String(err));
				} finally {
					setLoading(false);
				}
			}, [mediaLibrary, t]);
			(0, react.useEffect)(() => {
				refreshStatus();
			}, [refreshStatus]);
			const handleAction = (0, react.useCallback)(async (action, mediaId) => {
				setPendingMediaId(`${action}:${mediaId}`);
				try {
					const res = action === "open" ? await mediaLibrary.openMedia(mediaId) : await mediaLibrary.revealMedia(mediaId);
					if (res.ok) setLastResult(res.value);
					else setLastResult({
						ok: false,
						mediaId,
						action,
						code: "OPENER_FAILED",
						message: res.error.message || t("rpcError"),
						elapsedMs: 0
					});
				} catch (err) {
					setLastResult({
						ok: false,
						mediaId,
						action,
						code: "OPENER_FAILED",
						message: err instanceof Error ? err.message : String(err),
						elapsedMs: 0
					});
				} finally {
					setPendingMediaId(null);
				}
			}, [mediaLibrary, t]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: "16px",
					padding: "24px",
					height: "100%",
					overflowY: "auto",
					boxSizing: "border-box"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							justifyContent: "space-between",
							alignItems: "flex-start",
							gap: "12px"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
							style: {
								margin: "0 0 6px 0",
								fontSize: "20px",
								fontWeight: 600
							},
							children: t("heading")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: {
								margin: 0,
								opacity: .78,
								fontSize: "13px"
							},
							children: t("subtitle")
						})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => void refreshStatus(),
							disabled: loading,
							style: {
								padding: "6px 12px",
								borderRadius: "6px",
								border: "1px solid rgba(128,128,128,0.35)",
								background: "transparent",
								color: "inherit",
								cursor: loading ? "wait" : "pointer",
								fontSize: "13px"
							},
							children: t("refresh")
						})]
					}),
					loadError ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							padding: "12px",
							borderRadius: "8px",
							border: "1px solid rgba(239,68,68,0.5)",
							background: "rgba(239,68,68,0.1)",
							fontSize: "13px"
						},
						children: loadError
					}) : null,
					status ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: {
							padding: "14px 16px",
							borderRadius: "8px",
							border: "1px solid rgba(128,128,128,0.25)",
							display: "grid",
							gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
							gap: "10px 18px",
							fontSize: "13px"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [t("platform"), ":"] }),
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: status.platform })
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [t("nodeVersion"), ":"] }),
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: status.nodeVersion })
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [t("nodeSqlite"), ":"] }),
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: status.nodeSqliteAvailable ? t("statusAvailable") : t("statusMissing") })
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [t("activeUncRoot"), ":"] }),
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: status.activeUncRoot })
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { gridColumn: "1 / -1" },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [t("localDbPath"), ":"] }),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: status.localDatabasePath })
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: { gridColumn: "1 / -1" },
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [t("overrideConfigPath"), ":"] }),
									" ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: status.spikeOverridePath })
								]
							})
						]
					}) : null,
					lastResult ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: {
							padding: "12px 16px",
							borderRadius: "8px",
							border: lastResult.ok ? "1px solid rgba(34,197,94,0.45)" : "1px solid rgba(239,68,68,0.45)",
							background: lastResult.ok ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)",
							fontSize: "13px",
							display: "flex",
							flexDirection: "column",
							gap: "4px"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: [t("lastActionHeading"), ":"] }),
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", { children: [
									"[",
									lastResult.ok ? "OK" : lastResult.code,
									"] ",
									lastResult.action,
									"(",
									lastResult.mediaId,
									")"
								] }),
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									"(",
									lastResult.elapsedMs,
									" ms)"
								] })
							] }),
							lastResult.resolvedUncPath ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "UNC:" }),
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: lastResult.resolvedUncPath })
							] }) : null,
							!lastResult.ok ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: lastResult.message }) : null
						]
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
						style: {
							display: "flex",
							flexDirection: "column",
							gap: "10px"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: {
								margin: 0,
								fontSize: "15px",
								fontWeight: 600
							},
							children: t("testItemsHeading")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: "8px"
							},
							children: (status?.items ?? []).map((item) => {
								const isOpening = pendingMediaId === `open:${item.mediaId}`;
								const isRevealing = pendingMediaId === `reveal:${item.mediaId}`;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										padding: "12px 14px",
										borderRadius: "8px",
										border: "1px solid rgba(128,128,128,0.25)",
										display: "flex",
										justifyContent: "space-between",
										alignItems: "center",
										gap: "12px",
										flexWrap: "wrap"
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											flexDirection: "column",
											gap: "4px",
											minWidth: 0
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											style: {
												fontWeight: 600,
												fontSize: "13px"
											},
											children: [
												item.label,
												" ",
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", {
													style: {
														opacity: .75,
														fontWeight: 400
													},
													children: [
														"(",
														item.mediaId,
														")"
													]
												})
											]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
											style: {
												fontSize: "12px",
												opacity: .82,
												wordBreak: "break-all"
											},
											children: item.relativePath
										})]
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											gap: "8px",
											flexShrink: 0
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											disabled: isOpening || isRevealing,
											onClick: () => void handleAction("open", item.mediaId),
											style: {
												padding: "6px 10px",
												borderRadius: "6px",
												border: "1px solid rgba(128,128,128,0.35)",
												background: "transparent",
												color: "inherit",
												cursor: "pointer",
												fontSize: "12px"
											},
											children: t("openBtn")
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											disabled: isOpening || isRevealing,
											onClick: () => void handleAction("reveal", item.mediaId),
											style: {
												padding: "6px 10px",
												borderRadius: "6px",
												border: "1px solid rgba(128,128,128,0.35)",
												background: "transparent",
												color: "inherit",
												cursor: "pointer",
												fontSize: "12px"
											},
											children: t("revealBtn")
										})]
									})]
								}, item.mediaId);
							})
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		const NS = "mediaLibrary";
		const en = {
			panel: "Media Library",
			heading: "Media Library — M1 Host & UNC Spike",
			subtitle: "Verify DSH Host opening and revealing real Synology NAS UNC files strictly via mediaId allowlist.",
			refresh: "Refresh Status",
			platform: "Host OS Platform",
			nodeVersion: "Node.js Runtime",
			nodeSqlite: "Built-in node:sqlite Driver",
			localDbPath: "Local SQLite Path (Non-SMB)",
			overrideConfigPath: "Host Override Config File",
			activeUncRoot: "Active Canonical UNC Root",
			testItemsHeading: "M1 UNC Path Verification Scenarios (mediaId-only RPC)",
			openBtn: "Open Default Player",
			revealBtn: "Reveal in Explorer",
			lastActionHeading: "Last Host Action Result",
			statusAvailable: "Available",
			statusMissing: "Unavailable",
			rpcError: "Host RPC call failed."
		};
		const zh = {
			panel: "媒体库",
			heading: "媒体库 — M1 Host 与 UNC 路径验证",
			subtitle: "严格通过 mediaId 白名单验证 DSH Host 打开与在资源管理器中定位群晖 NAS UNC 媒体文件。",
			refresh: "刷新状态",
			platform: "Host 操作系统",
			nodeVersion: "Node.js 版本",
			nodeSqlite: "内置 node:sqlite 驱动",
			localDbPath: "本地 SQLite 路径（非 SMB）",
			overrideConfigPath: "Host 本地验证配置文件",
			activeUncRoot: "当前生效的规范 UNC 根路径",
			testItemsHeading: "M1 UNC 路径验证用例（仅传递 mediaId）",
			openBtn: "调用默认播放器打开",
			revealBtn: "在资源管理器中定位",
			lastActionHeading: "最近一次 Host 执行结果",
			statusAvailable: "可用",
			statusMissing: "不可用",
			rpcError: "Host 远程调用失败。"
		};
		//#endregion
		//#region src/client/mount.ts
		function mountMediaLibrary(ctx, mediaLibrary) {
			ctx.effect(() => ctx.locale.register(NS, {
				en,
				zh
			}), "dsh-media-library: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: "media-library",
				locale: NS,
				inject: () => ({
					t,
					mediaLibrary
				})
			}, MediaLibraryPanel));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: "media-library",
				order: 50,
				locale: NS,
				label: () => t("panel")
			}, MediaLibraryIcon));
		}
		//#endregion
		//#region src/client/index.ts
		const inject = [
			"remote",
			"slots",
			"locale"
		];
		async function apply(ctx) {
			const transport = ctx.plugin(async (owner) => {
				await owner.remote.$mount(TYPERT_REMOTE);
			});
			const ui = ctx.inject([
				"remote.mediaLibrary",
				"slots",
				"locale"
			], (scope) => {
				mountMediaLibrary(scope, scope.remote.mediaLibrary);
			});
			const dispose = ctx.effect(function* () {
				yield transport.dispose;
				yield ui.dispose;
			}, "dsh-media-library: mount");
			try {
				await Promise.all([transport, ui]);
			} catch (error) {
				await dispose();
				throw error;
			}
			return dispose;
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map