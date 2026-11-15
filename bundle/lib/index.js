import { Context, Service } from "@deepseek-ai/cordis";
import fs from "node:fs";
import os, { release } from "node:os";
import path, { dirname, extname } from "node:path";
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
//#region ../../home/aaevi/projects/deepseek-harness/packages/typert/protocol/lib/index.js
/**
* Remote decorators and explicit Gateway bindings backed by versioned
* descriptors carried on decorated class prototypes. Strict reflection
* remains a Typert compiler responsibility.
* @module @deepseek-ai/dsh-typert-protocol
*/
const TYPERT_REMOTE_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/;
/**
* Test one generated Remote name against the Connection endpoint grammar.
* @param value - namespace, method, lookup, or Context segment.
* @returns whether the value can cross the shared RPC carrier unchanged.
*/
function isTypertRemoteSegment(value) {
	return value !== "." && value !== ".." && TYPERT_REMOTE_SEGMENT_PATTERN.test(value);
}
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";
/**
* Bind one visible Service field to a Cordis key and Remote namespace. A
* service that owns a Cordis Context also gives its tree `ctx.invocation`,
* `undefined` outside a Remote call, so no `TypertRemoteService` is needed for
* a Host composition to read it.
* @param service - owning Service instance, normally `this`.
* @param serviceKey - exact Cordis service key.
* @param options - optional wire namespace.
* @returns a frozen, inspectable binding with no compiler-injected metadata.
*/
function bindTypertRemote(service, serviceKey, options = {}) {
	validateName("service key", serviceKey);
	const namespace = options.namespace ?? serviceKey;
	validateName("namespace", namespace);
	const ctx = Reflect.get(service, "ctx");
	if (Context.is(ctx)) provideInvocationAccessor(ctx);
	return Object.freeze({
		service,
		serviceKey,
		namespace
	});
}
/** Cordis Service base that exposes its registered name through Typert Gateway. */
var TypertRemoteService = class extends Service {
	/** Visible binding consumed by the Gateway's source-mode discovery. */
	typertRemote;
	/**
	* Register the Service and bind the same key to Typert Gateway.
	* @param ctx - owning Cordis Context.
	* @param serviceKey - exact Cordis service key and default wire namespace.
	* @param options - optional wire namespace.
	*/
	constructor(ctx, serviceKey, options = {}) {
		super(ctx, serviceKey);
		this.typertRemote = bindTypertRemote(this, this.name, options);
	}
};
/**
* Make `ctx.invocation` read as `undefined` outside a Remote call instead of the
* reflect service's "cannot get property" error; a call-derived Context shadows
* the accessor with its own property. The first Remote Service constructed in a
* tree registers it on the root, where it outlives any one Service.
*/
function provideInvocationAccessor(ctx) {
	if (Object.hasOwn(ctx.root.reflect.props, "invocation")) return;
	ctx.root.accessor("invocation", { get: () => void 0 });
}
function Remote(methodExportOrOptions, context) {
	if (typeof methodExportOrOptions === "string") {
		validateName("Remote export name", methodExportOrOptions);
		return remoteDecorator({ kind: "direct" }, { exportName: methodExportOrOptions });
	}
	if (typeof methodExportOrOptions === "object") return remoteDecorator({ kind: "direct" }, markerOptions(methodExportOrOptions, REMOTE_OPTION_KEYS, "Remote options require name, mode: \"stream\", or resources"));
	if (context === void 0) throw new TypeError("typert-protocol: Remote decorator context is missing");
	addMarkerInitializer(context, { kind: "direct" });
}
const REMOTE_OPTION_KEYS = new Set([
	"name",
	"mode",
	"resources"
]);
/** Validate one decorator options object against its accepted keys and select the marker fields. */
function markerOptions(options, accepted, requirement) {
	const keys = Reflect.ownKeys(options);
	if (keys.length === 0 || keys.some((key) => typeof key !== "string" || !accepted.has(key)) || Object.hasOwn(options, "mode") && options.mode !== "stream") throw new TypeError(`typert-protocol: ${requirement}`);
	const { mode, name, resources } = options;
	if (name !== void 0) validateName("Remote export name", name);
	return {
		...mode === void 0 ? {} : { mode },
		...name === void 0 ? {} : { exportName: name },
		...resources === void 0 ? {} : { resources: resourceReaders(resources) }
	};
}
/** Freeze declared readers into the marker record; a misdeclared reader fails at decoration. */
function resourceReaders(resources) {
	const readers = {};
	for (const [kind, reader] of Object.entries(resources)) {
		if (typeof reader !== "function") throw new TypeError(`typert-protocol: Remote resource reader "${kind}" must be a function`);
		readers[kind] = reader;
	}
	if (Object.keys(readers).length === 0) throw new TypeError("typert-protocol: Remote resources require at least one reader");
	return Object.freeze(readers);
}
function remoteDecorator(invocation, options = {}) {
	return function(_method, context) {
		addMarkerInitializer(context, invocation, options);
	};
}
function readRemoteMethodDescriptor(prototype) {
	const property = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR);
	if (property === void 0) return void 0;
	const descriptor = property.value;
	if (descriptor === null || typeof descriptor !== "object") throw new TypeError("typert-protocol: Remote method descriptor must be an object");
	const version = Reflect.get(descriptor, "version");
	if (version !== 1) throw new TypeError(`typert-protocol: unsupported Remote method descriptor version ${String(version)}`);
	const methods = Reflect.get(descriptor, "methods");
	if (!Array.isArray(methods)) throw new TypeError("typert-protocol: Remote method descriptor methods must be an array");
	return descriptor;
}
function addMarkerInitializer(context, invocation, options = {}) {
	if (context.private || context.static || typeof context.name !== "string") throw new TypeError("typert-protocol: Remote decorators require a public instance method with a string name");
	const method = context.name;
	context.addInitializer(function() {
		const prototype = Object.getPrototypeOf(this);
		if (prototype === null) throw new TypeError(`typert-protocol: cannot mark Remote method "${method}" on an object without a prototype`);
		mark(prototype, method, invocation, options);
	});
}
function mark(prototype, method, invocation, { mode, exportName, resources }) {
	const descriptor = readRemoteMethodDescriptor(prototype);
	const marker = Object.freeze({
		method,
		...exportName === void 0 || exportName === method ? {} : { exportName },
		...mode === void 0 ? {} : { mode },
		invocation: Object.freeze(invocation),
		...resources === void 0 ? {} : { resources }
	});
	const current = descriptor?.methods.find((candidate) => candidate.method === method);
	if (current !== void 0) {
		if (current.exportName === marker.exportName && current.mode === marker.mode && current.resources === marker.resources && sameInvocation(current.invocation, invocation)) return;
		throw new Error(`typert-protocol: Remote method "${method}" has conflicting invocation markers`);
	}
	Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
		configurable: true,
		value: Object.freeze({
			version: 1,
			methods: Object.freeze([...descriptor?.methods ?? [], marker])
		})
	});
}
function sameInvocation(left, right) {
	if (left.kind === "direct") return right.kind === "direct";
	if (right.kind === "direct") return false;
	return left.context === right.context;
}
function validateName(subject, value) {
	if (!isTypertRemoteSegment(value)) throw new TypeError(`typert-protocol: ${subject} must contain only RPC endpoint segment characters`);
}
//#endregion
//#region ../../home/aaevi/projects/deepseek-harness/vendor/cosmokit/lib/index.js
/** Return true when a value is `null` or `undefined`. */
function isNullable(value) {
	return value === null || value === void 0;
}
/** Return true for non-array object values. */
function isPlainObject(data) {
	return data && typeof data === "object" && !Array.isArray(data);
}
/** Filter object entries and return a new object. */
function filterKeys(object, filter) {
	return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
/** Map object values while preserving the original key set. */
function mapValues(object, transform) {
	return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
/** Pick selected keys from an object, optionally including `undefined` values. */
function pick(source, keys, forced) {
	if (!keys) return { ...source };
	const result = {};
	for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
	return result;
}
/** Shared config references used by schema validators and plugin runtimes. */
const write = Symbol.for("cosmokit.volatile.write");
function snapshot(value, ancestors = /* @__PURE__ */ new Set()) {
	if (typeof value === "function") throw new TypeError("volatile config cannot contain functions");
	if (value === null || typeof value !== "object") return value;
	if (ancestors.has(value)) throw new TypeError("volatile config cannot contain cycles");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, ancestors)));
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("volatile config objects must be plain objects or arrays");
		return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, ancestors)])));
	} finally {
		ancestors.delete(value);
	}
}
/**
* Create a detached reference containing an immutable copy of the supplied data.
* @param value - validated config data; class instances and functions are unsupported.
* @returns a reference whose value is updated only by its owning runtime.
*/
function createVolatile(value) {
	let current = snapshot(value);
	return Object.freeze({
		get: () => current,
		[write]: (value) => {
			current = value;
		}
	});
}
/**
* Identify references across ESM/CJS copies of the shared library.
* @param value - a parsed config value.
* @returns whether the value implements the shared reference protocol.
*/
function isVolatile(value) {
	return typeof value === "object" && value !== null && write in value;
}
/** Test values using `instanceof` with a `toStringTag` fallback. */
function is(type, value) {
	if (arguments.length === 1) return (value) => is(type, value);
	return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
	return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
	return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
/** Binary source detection and base64/hex conversion helpers. */
var Binary;
(function(Binary) {
	Binary.is = isArrayBufferLike;
	Binary.isSource = isArrayBufferSource;
	function fromSource(source) {
		if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
		else return source;
	}
	Binary.fromSource = fromSource;
	function toBase64(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
		let binary = "";
		const bytes = new Uint8Array(source);
		for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
		return btoa(binary);
	}
	Binary.toBase64 = toBase64;
	function fromBase64(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
		return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
	}
	Binary.fromBase64 = fromBase64;
	function toHex(source) {
		source = fromSource(source);
		if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
		return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
	}
	Binary.toHex = toHex;
	function fromHex(source) {
		if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
		const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
		const buffer = [];
		for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
		return Uint8Array.from(buffer).buffer;
	}
	Binary.fromHex = fromHex;
})(Binary || (Binary = {}));
Binary.fromBase64;
Binary.toBase64;
Binary.fromHex;
Binary.toHex;
/** Deep-clone common JavaScript values while preserving prototypes and cycles. */
function clone(source, refs = /* @__PURE__ */ new Map()) {
	if (!source || typeof source !== "object") return source;
	if (is("Date", source)) return new Date(source.valueOf());
	if (is("RegExp", source)) return new RegExp(source.source, source.flags);
	if (isArrayBufferLike(source)) return source.slice(0);
	if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
	const cached = refs.get(source);
	if (cached) return cached;
	if (Array.isArray(source)) {
		const result = [];
		refs.set(source, result);
		source.forEach((value, index) => {
			result[index] = Reflect.apply(clone, null, [value, refs]);
		});
		return result;
	}
	const result = Object.create(Object.getPrototypeOf(source));
	refs.set(source, result);
	for (const key of Reflect.ownKeys(source)) {
		const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
		if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
		Reflect.defineProperty(result, key, descriptor);
	}
	return result;
}
/**
* Compare values recursively, treating two volatile references as equal regardless of value.
* Strict comparison distinguishes null/undefined, treats opaque objects by identity,
* compares URLs by normalized href, treats array holes as undefined, and considers distinct cyclic structures unequal.
* @param a - first value.
* @param b - second value.
* @param strict - whether to require strict data equality outside volatile references.
* @returns whether the values compare equal.
*/
function deepEqual(a, b, strict) {
	const ancestors = /* @__PURE__ */ new Set();
	function compare(a, b) {
		if (a === b) return true;
		if (isVolatile(a) || isVolatile(b)) return isVolatile(a) && isVolatile(b);
		if (!strict && isNullable(a) && isNullable(b)) return true;
		if (typeof a !== typeof b || typeof a !== "object" || !a || !b) return false;
		if (ancestors.has(a)) return false;
		function check(test, then) {
			return test(a) ? test(b) ? then(a, b) : false : test(b) ? false : void 0;
		}
		ancestors.add(a);
		try {
			return check(Array.isArray, (a, b) => {
				if (a.length !== b.length) return false;
				for (let index = 0; index < a.length; index++) if (!compare(a[index], b[index])) return false;
				return true;
			}) ?? check(is("Date"), (a, b) => a.valueOf() === b.valueOf()) ?? check(is("URL"), (a, b) => a.href === b.href) ?? check(is("RegExp"), (a, b) => a.source === b.source && a.flags === b.flags) ?? check(isArrayBufferLike, (a, b) => {
				if (a.byteLength !== b.byteLength) return false;
				const viewA = new Uint8Array(a);
				const viewB = new Uint8Array(b);
				for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
				return true;
			}) ?? ((!strict || [a, b].every((value) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) && Object.keys({
				...a,
				...b
			}).every((key) => compare(a[key], b[key])));
		} finally {
			ancestors.delete(a);
		}
	}
	return compare(a, b);
}
/** Time constants plus parsing and formatting helpers. */
var Time;
(function(Time) {
	Time.millisecond = 1;
	Time.second = 1e3;
	Time.minute = Time.second * 60;
	Time.hour = Time.minute * 60;
	Time.day = Time.hour * 24;
	Time.week = Time.day * 7;
	let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
	function setTimezoneOffset(offset) {
		timezoneOffset = offset;
	}
	Time.setTimezoneOffset = setTimezoneOffset;
	function getTimezoneOffset() {
		return timezoneOffset;
	}
	Time.getTimezoneOffset = getTimezoneOffset;
	function getDateNumber(date = /* @__PURE__ */ new Date(), offset) {
		if (typeof date === "number") date = new Date(date);
		if (offset === void 0) offset = timezoneOffset;
		return Math.floor((date.valueOf() / Time.minute - offset) / 1440);
	}
	Time.getDateNumber = getDateNumber;
	function fromDateNumber(value, offset) {
		const date = new Date(value * Time.day);
		if (offset === void 0) offset = timezoneOffset;
		return new Date(+date + offset * Time.minute);
	}
	Time.fromDateNumber = fromDateNumber;
	const numeric = /\d+(?:\.\d+)?/.source;
	const timeRegExp = new RegExp(`^${[
		"w(?:eek(?:s)?)?",
		"d(?:ay(?:s)?)?",
		"h(?:our(?:s)?)?",
		"m(?:in(?:ute)?(?:s)?)?",
		"s(?:ec(?:ond)?(?:s)?)?"
	].map((unit) => `(${numeric}${unit})?`).join("")}$`);
	function parseTime(source) {
		const capture = timeRegExp.exec(source);
		if (!capture) return 0;
		return (parseFloat(capture[1]) * Time.week || 0) + (parseFloat(capture[2]) * Time.day || 0) + (parseFloat(capture[3]) * Time.hour || 0) + (parseFloat(capture[4]) * Time.minute || 0) + (parseFloat(capture[5]) * Time.second || 0);
	}
	Time.parseTime = parseTime;
	function parseDate(date) {
		const parsed = parseTime(date);
		if (parsed) date = Date.now() + parsed;
		else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date}`;
		else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date)) date = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date}`;
		return date ? new Date(date) : /* @__PURE__ */ new Date();
	}
	Time.parseDate = parseDate;
	function format(ms) {
		const abs = Math.abs(ms);
		if (abs >= Time.day - Time.hour / 2) return Math.round(ms / Time.day) + "d";
		else if (abs >= Time.hour - Time.minute / 2) return Math.round(ms / Time.hour) + "h";
		else if (abs >= Time.minute - Time.second / 2) return Math.round(ms / Time.minute) + "m";
		else if (abs >= Time.second) return Math.round(ms / Time.second) + "s";
		return ms + "ms";
	}
	Time.format = format;
	function toDigits(source, length = 2) {
		return source.toString().padStart(length, "0");
	}
	Time.toDigits = toDigits;
	function template(template, time = /* @__PURE__ */ new Date()) {
		return template.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
	}
	Time.template = template;
})(Time || (Time = {}));
//#endregion
//#region ../../home/aaevi/projects/deepseek-harness/vendor/schemastery/lib/index.mjs
const kSchema = Symbol.for("schemastery");
const kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
	options;
	name = "ValidationError";
	constructor(message, options) {
		let prefix = "$";
		for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
		else if (typeof segment === "number") prefix += "[" + segment + "]";
		else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
		if (prefix.startsWith(".")) prefix = prefix.slice(1);
		super((prefix === "$" ? "" : `${prefix} `) + message);
		this.options = options;
	}
	static is(error) {
		return !!error?.[kValidationError];
	}
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
const Schema = function(options) {
	const schema = function(data, options = {}) {
		return Schema.resolve(data, schema, options)[0];
	};
	if (options.refs) {
		const refs = mapValues(options.refs, (options) => new Schema(options));
		const getRef = (uid) => refs[uid];
		for (const key in refs) {
			const options = refs[key];
			options.sKey = getRef(options.sKey);
			options.inner = getRef(options.inner);
			options.list = options.list && options.list.map(getRef);
			options.dict = options.dict && mapValues(options.dict, getRef);
		}
		return refs[options.uid];
	}
	Object.assign(schema, options);
	if (typeof schema.callback === "string") try {
		schema.callback = new Function("return " + schema.callback)();
	} catch {}
	Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
	Object.setPrototypeOf(schema, Schema.prototype);
	schema.meta ||= {};
	schema.toString = schema.toString.bind(schema);
	return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
	return {
		version: 1,
		vendor: "schemastery",
		validate: (value) => {
			try {
				return { value: Schema.resolve(value, this, {})[0] };
			} catch (error) {
				if (ValidationError.is(error)) return { issues: [{
					message: error.message,
					path: error.options.path
				}] };
				throw error;
			}
		}
	};
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
	if (globalThis.__schemastery_refs__) {
		globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
		return this.uid;
	}
	globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
	globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
	const result = {
		uid: this.uid,
		refs: globalThis.__schemastery_refs__
	};
	globalThis.__schemastery_refs__ = void 0;
	return result;
};
Schema.prototype.set = function set(key, value) {
	this.dict[key] = value;
	return this;
};
Schema.prototype.push = function push(value) {
	this.list.push(value);
	return this;
};
function mergeDesc(original, messages) {
	const result = typeof original === "string" ? { "": original } : { ...original };
	for (const locale in messages) {
		const value = messages[locale];
		if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
		else if (typeof value === "string") result[locale] = value;
	}
	return result;
}
function getInner(value) {
	return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
	return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
	const schema = Schema(this);
	const desc = mergeDesc(schema.meta.description, messages);
	if (Object.keys(desc).length) schema.meta.description = desc;
	if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
		return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
	});
	if (schema.list) schema.list = schema.list.map((inner, index) => {
		return inner.i18n(mapValues(messages, (data = {}) => {
			if (Array.isArray(getInner(data))) return getInner(data)[index];
			if (Array.isArray(data)) return data[index];
			return extractKeys(data);
		}));
	});
	if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
		if (getInner(data)) return getInner(data);
		return extractKeys(data);
	}));
	if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
	return schema;
};
Schema.prototype.extra = function extra(key, value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
};
for (const key of [
	"required",
	"disabled",
	"collapse",
	"hidden",
	"loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.deprecated = function deprecated() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "deprecated",
		type: "danger"
	});
	return schema;
};
Schema.prototype.experimental = function experimental() {
	const schema = Schema(this);
	schema.meta.badges ||= [];
	schema.meta.badges.push({
		text: "experimental",
		type: "warning"
	});
	return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
	const schema = Schema(this);
	const pattern = pick(regexp, ["source", "flags"]);
	schema.meta = {
		...schema.meta,
		pattern
	};
	return schema;
};
Schema.prototype.simplify = function simplify(value) {
	if (isVolatile(value)) value = value.get();
	if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
	if (isNullable(value)) return value;
	if (this.type === "object" || this.type === "dict") {
		const result = {};
		for (const key in value) {
			const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
			if (this.type === "dict" || !isNullable(item)) result[key] = item;
		}
		if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
		return result;
	} else if (this.type === "array" || this.type === "tuple") {
		const result = [];
		value.forEach((value, index) => {
			const schema = this.type === "array" ? this.inner : this.list[index];
			const item = schema ? schema.simplify(value) : value;
			result.push(item);
		});
		return result;
	} else if (this.type === "intersect") {
		const result = {};
		for (const item of this.list) Object.assign(result, item.simplify(value));
		return result;
	} else if (this.type === "union") for (const schema of this.list) try {
		Schema.resolve(value, schema, {});
		return schema.simplify(value);
	} catch {}
	return value;
};
Schema.prototype.toString = function toString(inline) {
	return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		role,
		extra
	};
	return schema;
};
for (const key of [
	"default",
	"link",
	"comment",
	"description",
	"max",
	"min",
	"step"
]) Object.assign(Schema.prototype, { [key](value) {
	const schema = Schema(this);
	schema.meta = {
		...schema.meta,
		[key]: value
	};
	return schema;
} });
Schema.prototype.volatile = function volatile() {
	if (this.meta.volatile) throw new TypeError("volatile schema is already wrapped");
	return this.extra("volatile", true);
};
const resolvers = {};
const checkedVolatile = Symbol("checked-volatile-schema");
function validateVolatileSchema(schema, path = [], blocked = false, seen = /* @__PURE__ */ new Map()) {
	const states = seen.get(schema) ?? /* @__PURE__ */ new Set();
	if (states.has(blocked)) return;
	states.add(blocked);
	seen.set(schema, states);
	if (schema.meta?.volatile && blocked) throw new ValidationError("volatile fields require a fixed object path without an enclosing volatile field", { path });
	const nested = blocked || !!schema.meta?.volatile;
	if (schema.dict) for (const [key, child] of Object.entries(schema.dict)) validateVolatileSchema(child, [...path, key], nested, seen);
	if (schema.sKey) validateVolatileSchema(schema.sKey, [...path, "<key>"], true, seen);
	if (schema.inner && (schema.type !== "lazy" || schema.inner[kSchema])) validateVolatileSchema(schema.inner, [...path, "*"], true, seen);
	if (schema.list) for (let index = 0; index < schema.list.length; index++) validateVolatileSchema(schema.list[index], [...path, String(index)], true, seen);
}
Schema.extend = function extend(type, resolve) {
	resolvers[type] = resolve;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
	if (!schema) return [data];
	if (!options[checkedVolatile]) {
		validateVolatileSchema(schema, options.path);
		options = {
			...options,
			[checkedVolatile]: true
		};
	}
	if (schema.meta?.volatile) {
		const inner = Schema(schema);
		inner.meta = {
			...schema.meta,
			volatile: false
		};
		const [value, adapted] = Schema.resolve(data, inner, options, strict);
		try {
			return [createVolatile(value), adapted];
		} catch (error) {
			throw new ValidationError(error instanceof Error ? error.message : String(error), options);
		}
	}
	if (options.ignore?.(data, schema)) return [data];
	if (isNullable(data) && schema.type !== "lazy") {
		if (schema.meta.required) throw new ValidationError(`missing required value`, options);
		let current = schema;
		let fallback = schema.meta.default;
		while (current?.type === "intersect" && isNullable(fallback)) {
			current = current.list[0];
			fallback = current?.meta.default;
		}
		if (isNullable(fallback)) return [data];
		data = clone(fallback);
	}
	const callback = resolvers[schema.type];
	if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
	try {
		return callback(data, schema, options, strict);
	} catch (error) {
		if (!schema.meta.loose) throw error;
		return [schema.meta.default];
	}
};
Schema.from = function from(source) {
	if (isNullable(source)) return Schema.any();
	else if ([
		"string",
		"number",
		"boolean"
	].includes(typeof source)) return Schema.const(source).required();
	else if (source[kSchema]) return source;
	else if (typeof source === "function") switch (source) {
		case String: return Schema.string().required();
		case Number: return Schema.number().required();
		case Boolean: return Schema.boolean().required();
		case Function: return Schema.function().required();
		default: return Schema.is(source).required();
	}
	else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
	const toJSON = () => {
		if (!schema.inner[kSchema]) {
			schema.inner = schema.builder();
			schema.inner.meta = {
				...schema.meta,
				...schema.inner.meta
			};
		}
		return schema.inner.toJSON();
	};
	const schema = new Schema({
		type: "lazy",
		builder,
		inner: { toJSON }
	});
	return schema;
};
Schema.natural = function natural() {
	return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
	return Schema.number().step(.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
	return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
		const date = new Date(value);
		if (isNaN(+date)) throw new ValidationError(`invalid date "${value}"`, options);
		return date;
	}, true)]);
};
Schema.regExp = function regExp(flag = "") {
	return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
		try {
			return new RegExp(value, flag);
		} catch (e) {
			throw new ValidationError(e.message, options);
		}
	}, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
	return Schema.union([
		Schema.is(ArrayBuffer),
		Schema.is(SharedArrayBuffer),
		Schema.transform(Schema.any(), (value, options) => {
			if (Binary.isSource(value)) return Binary.fromSource(value);
			throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
		}, true),
		...encoding ? [Schema.transform(Schema.string(), (value, options) => {
			try {
				return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
			} catch (e) {
				throw new ValidationError(e.message, options);
			}
		}, true)] : []
	]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
	if (!schema.inner[kSchema]) {
		schema.inner = schema.builder();
		schema.inner.meta = {
			...schema.meta,
			...schema.inner.meta
		};
		validateVolatileSchema(schema.inner, options.path, true);
	}
	return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
	return [data];
});
Schema.extend("never", (data, _, options) => {
	throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
	if (deepEqual(data, value)) return [value];
	throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
	const { max = Infinity, min = -Infinity } = meta;
	if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
	if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
	if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
	if (meta.pattern) {
		const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
		if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
	}
	checkWithinRange(data.length, meta, "string length", options);
	return [data];
});
function decimalShift(data, digits) {
	const str = data.toString();
	if (str.includes("e")) return data * Math.pow(10, digits);
	const index = str.indexOf(".");
	if (index === -1) return data * Math.pow(10, digits);
	const frac = str.slice(index + 1);
	const integer = str.slice(0, index);
	if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
	return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
	step = Math.abs(step);
	if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
	const index = step.toString().indexOf(".");
	const digits = step.toString().slice(index + 1).length;
	return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
	if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
	checkWithinRange(data, meta, "number", options);
	const { step } = meta;
	if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
	return [data];
});
Schema.extend("boolean", (data, _, options) => {
	if (typeof data === "boolean") return [data];
	throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
	let value = 0, keys = [];
	if (typeof data === "number") {
		value = data;
		for (const key in bits) if (data & bits[key]) keys.push(key);
	} else if (Array.isArray(data)) {
		keys = data;
		for (const key of keys) {
			if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
			if (key in bits) value |= bits[key];
		}
	} else throw new ValidationError(`expected number or array but got ${data}`, options);
	if (value === meta.default) return [value];
	return [value, keys];
});
Schema.extend("function", (data, _, options) => {
	if (typeof data === "function") return [data];
	throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
	if (typeof constructor === "function") {
		if (data instanceof constructor) return [data];
		throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
	} else {
		if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
		let prototype = Object.getPrototypeOf(data);
		while (prototype) {
			if (prototype.constructor?.name === constructor) return [data];
			prototype = Object.getPrototypeOf(prototype);
		}
		throw new ValidationError(`expected ${constructor} but got ${data}`, options);
	}
});
function property(data, key, schema, options) {
	try {
		const [value, adapted] = Schema.resolve(data[key], schema, {
			...options,
			path: [...options.path || [], key]
		});
		if (adapted !== void 0) data[key] = adapted;
		return value;
	} catch (e) {
		if (!options?.autofix) throw e;
		delete data[key];
		return schema.meta.volatile ? createVolatile(schema.meta.default) : schema.meta.default;
	}
}
Schema.extend("array", (data, { inner, meta }, options) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
	return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in data) {
		let rKey;
		try {
			rKey = Schema.resolve(key, sKey, options)[0];
		} catch (error) {
			if (strict) continue;
			throw error;
		}
		result[rKey] = property(data, key, inner, options);
		data[rKey] = data[key];
		if (key !== rKey) delete data[key];
	}
	return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
	if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
	const result = list.map((inner, index) => property(data, index, inner, options));
	if (strict) return [result];
	result.push(...data.slice(list.length));
	return [result];
});
function merge(result, data) {
	for (const key in data) {
		if (key in result) continue;
		result[key] = data[key];
	}
}
Schema.extend("object", (data, { dict }, options, strict) => {
	if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
	const result = {};
	for (const key in dict) {
		const value = property(data, key, dict[key], options);
		if (!isNullable(value) || key in data) result[key] = value;
	}
	if (!strict) merge(result, data);
	return [result];
});
Schema.extend("union", (data, { list, toString }, options, strict) => {
	const messages = [];
	for (const inner of list) try {
		return Schema.resolve(data, inner, options, strict);
	} catch (error) {
		messages.push(error);
	}
	throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString }, options, strict) => {
	if (!list.length) return [data];
	let result;
	for (const inner of list) {
		const value = Schema.resolve(data, inner, options, true)[0];
		if (isNullable(value)) continue;
		if (isNullable(result)) result = value;
		else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
		else if (typeof value === "object") merge(result ??= {}, value);
		else if (result !== value) throw new ValidationError(`expected ${toString()} but got ${JSON.stringify(data)}`, options);
	}
	if (!strict && isPlainObject(data)) merge(result, data);
	return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
	const [result, adapted = data] = Schema.resolve(data, inner, options, true);
	if (preserve) return [callback(result)];
	else return [callback(result), callback(adapted)];
});
const formatters = {};
function defineMethod(name, keys, format) {
	formatters[name] = format;
	Object.assign(Schema, { [name](...args) {
		const schema = new Schema({ type: name });
		keys.forEach((key, index) => {
			switch (key) {
				case "sKey":
					schema.sKey = args[index] ?? Schema.string();
					break;
				case "inner":
					schema.inner = Schema.from(args[index]);
					break;
				case "list":
					schema.list = args[index].map(Schema.from);
					break;
				case "dict":
					schema.dict = mapValues(args[index], Schema.from);
					break;
				case "bits":
					schema.bits = {};
					for (const key in args[index]) {
						if (typeof args[index][key] !== "number") continue;
						schema.bits[key] = args[index][key];
					}
					break;
				case "callback": {
					const callback = schema.callback = args[index];
					callback["toJSON"] ||= () => callback.toString();
					break;
				}
				case "constructor": {
					const constructor = schema.constructor = args[index];
					if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
					break;
				}
				default: schema[key] = args[index];
			}
		});
		if (name === "object" || name === "dict") schema.meta.default = {};
		else if (name === "array" || name === "tuple") schema.meta.default = [];
		else if (name === "bitset") schema.meta.default = 0;
		return schema;
	} });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
	if (typeof constructor === "function") return constructor.name;
	else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
	if (Object.keys(dict).length === 0) return "{}";
	return `{ ${Object.entries(dict).map(([key, inner]) => {
		return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
	}).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
	const result = list.map(({ toString: format }) => format()).join(" | ");
	return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
	return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
	"inner",
	"callback",
	"preserve"
], ({ inner }, isInner) => inner.toString(isInner));
//#endregion
//#region lib/types/config.js
const Config = Schema.object({
	uncRoot: Schema.string().default("\\\\NAS\\MediaTest").description("Canonical Windows UNC root path for M1 Host/SMB spike verification (e.g. \\\\SynologyNAS\\Media\\Library).").volatile(),
	dataDir: Schema.string().default("media-library").description("Subdirectory under the local DSH data directory (%DSH_HOME%/media-library) used for local SQLite storage."),
	probeTimeoutMs: Schema.number().min(100).default(5e3).description("Maximum milliseconds to wait when probing NAS file reachability before launching native opener.")
});
//#endregion
//#region ../../home/aaevi/projects/deepseek-harness/packages/util/native-command/lib/index.js
/**
* Shared no-shell `execFile` runner for host-native OS integrations.
* @module @deepseek-ai/dsh-native-command/runner
*/
/**
* Run a host command with utf8 stdio, abort propagation, and explicit GUI visibility.
* @param command - executable path or PATH name.
* @param args - argv (never a shell string).
* @param signal - caller/connection lifetime; abort terminates the child.
* @param window - Windows startup visibility: `hidden` for background commands,
* `visible` for GUI launchers. Ignored on other platforms.
* @returns captured stdout/stderr on exit 0.
*/
const runNativeCommand = (command, args, signal, window) => new Promise((resolve, reject) => {
	execFile(command, [...args], {
		encoding: "utf8",
		signal,
		windowsHide: window === "hidden"
	}, (error, stdout, stderr) => {
		if (error !== null) {
			reject(Object.assign(new Error(error.message, { cause: error }), {
				code: error.code,
				stdout,
				stderr
			}));
			return;
		}
		resolve({
			stdout,
			stderr
		});
	});
});
/**
* Cross-platform native path and text-document openers for Host UI
* integrations.
*
* The default intent prefers the default browser for documents it renders when
* the platform can name one, then falls back to the default application. WSL
* translates every path for the Windows desktop instead of assuming a Linux
* GUI. The text-editor intent never consults the browser. Windows hands every
* intent to Explorer: the shell's own default-application resolution, the one
* a double-click uses, selects the application, while a process that resolves
* the association itself reads a narrower record and reports none.
* @module @deepseek-ai/dsh-native-command/path-opener
*/
/** Documents a browser renders, as opposed to ones an editor merely edits. */
const BROWSER_DOCUMENTS = new Set([
	".html",
	".htm",
	".xhtml",
	".svg"
]);
/**
* The macOS bundle registered for `https` — the default browser, as
* LaunchServices records it. The nested version dict is stripped first
* because it carries its own `LSHandlerRoleAll`.
*/
function macBundleForHttps(plist) {
	const stripped = plist.replace(/LSHandlerPreferredVersions\s*=\s*\{[^}]*\};/g, "");
	const block = /\{[^{}]*LSHandlerURLScheme\s*=\s*"?https"?;[^{}]*\}/.exec(stripped)?.[0];
	if (block === void 0) return void 0;
	return /LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?;/.exec(block)?.[1];
}
/**
* Open one browser-renderable document with the default browser.
* @returns true when a browser took it; false when this platform cannot name
* one, or naming it failed — the caller then uses the default application.
*/
async function openInBrowser(path, signal, platform, run, env) {
	if (platform === "darwin") {
		let bundle;
		try {
			const { stdout } = await run("defaults", ["read", "com.apple.LaunchServices/com.apple.launchservices.secure"], signal, "hidden");
			bundle = macBundleForHttps(stdout);
		} catch {
			return false;
		}
		if (bundle === void 0) return false;
		await run("open", [
			"-b",
			bundle,
			path
		], signal, "hidden");
		return true;
	}
	if (platform === "linux") {
		const browser = env.BROWSER;
		if (browser === void 0 || browser === "") return false;
		await run(browser, [path], signal, "hidden");
		return true;
	}
	return false;
}
/** Whether one environment marker is set to a non-empty value. */
function present(value) {
	return value !== void 0 && value !== "";
}
/** Distinguish WSL from desktop Linux using its process and kernel markers. */
function isWsl(internals) {
	const env = internals.env ?? process.env;
	if (present(env.WSL_DISTRO_NAME) || present(env.WSL_INTEROP)) return true;
	return (internals.osRelease ?? release()).toLowerCase().includes("microsoft");
}
/**
* Encode one Windows path as the target Explorer can receive intact.
*
* Explorer parses its own command line and splits fields at commas and equals
* signs, so a raw path loses everything after the first separator and the shell
* opens a different target without reporting it; both separators are escaped.
* Nothing else is: Explorer rejects percent-encoded non-ASCII in a file URI and
* opens the user's Documents folder instead, while it resolves the literal
* characters, so Node's non-ASCII escapes are decoded back and its ASCII escapes
* stand. Node resolves the path before encoding it, so a verbatim `\\?\` or
* `\\?\UNC\` prefix reaches Explorer as the ordinary drive or UNC URI; a `\\.\`
* device path keeps that same UNC handling and names a device rather than a
* shell item, which this opener does not open.
* @param windowsPath - path already translated for the Windows desktop.
* @returns the target for an open, or the object of a `/select,` reveal.
*/
function explorerTarget(windowsPath) {
	return pathToFileURL(windowsPath, { windows: true }).href.replace(/(?:%[89A-F][0-9A-F])+/gi, (escaped) => decodeURIComponent(escaped)).replaceAll(",", "%2C").replaceAll("=", "%3D");
}
/**
* Hand one target to Explorer, accepting its delegated-handoff exit code.
*
* Explorer exits 1 after handing the request to the desktop process already
* running, so exit 1 means the shell took it. Every other failure still
* rejects, and cancellation wins over a delegate's exit 1.
* @param args - Explorer argv: the encoded target alone to open it, or `/select,<encoded target>` to reveal it.
* @param signal - caller lifetime; abort terminates the command.
* @param run - shell-free command runner.
* @throws The runner's failure unless it is Explorer's delegate exit 1.
*/
async function runExplorer(args, signal, run) {
	try {
		await run("explorer.exe", args, signal, "visible");
	} catch (error) {
		signal.throwIfAborted();
		if (!(error instanceof Error) || !("code" in error) || error.code !== 1) throw error;
	}
}
/**
* Open one Windows-resolvable path through Explorer, the shell that owns the
* default-application resolution a double-click uses.
* @param path - Windows-resolvable path; Explorer receives its encoded file URI as one argv element, never a command string.
* @param signal - caller lifetime; abort terminates the command.
* @param run - shell-free command runner.
*/
async function openWindowsPath(path, signal, run) {
	await runExplorer([explorerTarget(path)], signal, run);
}
/** Translate a WSL path before handing it to the Windows desktop. */
async function openWslPath(path, signal, run) {
	const translated = await run("wslpath", ["-w", path], signal, "hidden");
	signal.throwIfAborted();
	const windowsPath = translated.stdout.replace(/[\r\n]+$/, "");
	if (windowsPath === "") throw new Error("wslpath returned no Windows path");
	await openWindowsPath(windowsPath, signal, run);
}
/** Dispatch one shell-free platform command for the requested open intent. */
async function openNativePathWithIntent(path, signal, intent, internals = {}) {
	const platform = internals.platform ?? process.platform;
	const run = internals.run ?? runNativeCommand;
	const env = internals.env ?? process.env;
	const wsl = platform === "linux" && isWsl(internals);
	if (!wsl && intent === "default" && BROWSER_DOCUMENTS.has(extname(path).toLowerCase()) && await openInBrowser(path, signal, platform, run, env)) return;
	if (platform === "darwin") {
		await run("open", intent === "text-editor" ? ["-t", path] : [path], signal, "hidden");
		return;
	}
	if (platform === "win32") {
		await openWindowsPath(path, signal, run);
		return;
	}
	if (platform === "linux") {
		if (wsl) {
			await openWslPath(path, signal, run);
			return;
		}
		await run("xdg-open", [path], signal, "hidden");
		return;
	}
	throw new Error(`native path opener is unsupported on ${platform}`);
}
/**
* Open a filesystem path through its file-type association, including HTML and SVG.
* @param path - absolute or host-resolvable path; the caller verifies local access.
* @param signal - caller lifetime; abort terminates the native command.
* @param internals - platform, environment, and runner facts for adapter tests.
* @returns after the associated application accepts the path.
*/
function openNativeAssociatedPath(path, signal, internals = {}) {
	return openNativePathWithIntent(path, signal, "association", internals);
}
/**
* Identify the native file-manager action without inspecting the browser's platform.
* @param internals - platform and WSL facts.
* @returns the supported file-manager action, or null on unsupported platforms.
*/
function nativeFileManager(internals = {}) {
	const platform = internals.platform ?? process.platform;
	if (platform === "darwin") return "finder";
	if (platform === "win32" || platform === "linux" && isWsl(internals)) return "explorer";
	return platform === "linux" ? "directory" : null;
}
/**
* Reveal a file in Finder or Explorer, or open its parent in the Linux default file manager.
* @param path - absolute file path already authorized by the caller.
* @param signal - caller lifetime; abort terminates the native command.
* @param internals - platform, environment, and command runner for adapter tests.
* @returns after command completion; Explorer exit 1 is accepted as a delegated handoff, not proof of selection.
*/
async function revealNativePath(path, signal, internals = {}) {
	signal.throwIfAborted();
	const platform = internals.platform ?? process.platform;
	const run = internals.run ?? runNativeCommand;
	const manager = nativeFileManager({
		...internals,
		platform
	});
	if (manager === "finder") {
		await run("open", ["-R", path], signal, "hidden");
		return;
	}
	if (manager === "explorer") {
		let windowsPath = path;
		if (platform === "linux") {
			const translated = await run("wslpath", ["-w", path], signal, "hidden");
			signal.throwIfAborted();
			windowsPath = translated.stdout.replace(/[\r\n]+$/, "");
			if (windowsPath === "") throw new Error("wslpath returned no Windows path");
		}
		await runExplorer(["/select,", explorerTarget(windowsPath)], signal, run);
		return;
	}
	if (manager === "directory") {
		await run("xdg-open", [dirname(path)], signal, "hidden");
		return;
	}
	throw new Error(`native file manager is unsupported on ${platform}`);
}
String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class DshFileAssociations {
  [ComImport, Guid("973810ae-9599-4b88-9e4d-6ee98c9552da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IEnumHandlers {
    [PreserveSig] int Next(uint count, out IHandler handler, out uint fetched);
  }
  [ComImport, Guid("f04061ac-1659-4a3f-a954-775aa57fc083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IHandler {
    void GetName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string path, out int index);
    [PreserveSig] int IsRecommended();
    void MakeDefault([MarshalAs(UnmanagedType.LPWStr)] string description);
    void Invoke(IDataObject data);
    void CreateInvoker(IDataObject data, [MarshalAs(UnmanagedType.Interface)] out object invoker);
  }
  [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IDataObject data);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHAssocEnumHandlers(string extension, uint filter, out IEnumHandlers handlers);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IShellItem item);
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  static extern int AssocQueryString(uint flags, uint kind, string association, string extra, StringBuilder output, ref uint size);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHDefExtractIcon(string path, int index, uint flags, out IntPtr large, out IntPtr small, uint size);
  [DllImport("user32.dll")]
  static extern bool DestroyIcon(IntPtr icon);
  [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
  static extern int SHLoadIndirectString(string source, StringBuilder output, uint size, IntPtr reserved);

  [DllImport("shlwapi.dll", PreserveSig = false)]
  static extern void SHCreateThreadRef(IntPtr count, out IntPtr reference);
  [DllImport("shlwapi.dll", PreserveSig = false)]
  static extern void SHSetThreadRef(IntPtr reference);
  [DllImport("shell32.dll")]
  static extern void SHSetInstanceExplorer(IntPtr reference);
  [StructLayout(LayoutKind.Sequential)]
  struct Message {
    public IntPtr window;
    public uint message;
    public UIntPtr wParam;
    public IntPtr lParam;
    public uint time;
    public int x, y;
    public uint reserved;
  }
  [DllImport("user32.dll", SetLastError = true)]
  static extern UIntPtr SetTimer(IntPtr window, UIntPtr id, uint milliseconds, IntPtr callback);
  [DllImport("user32.dll")]
  static extern bool KillTimer(IntPtr window, UIntPtr id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")]
  static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr DispatchMessage(ref Message message);

  // Shell handlers may return before their asynchronous launch work releases the host.
  // The shared Shell reference, rather than an arbitrary delay, owns that lifetime.
  static void WithShellLifetime(Action action) {
    IntPtr count = Marshal.AllocHGlobal(sizeof(int));
    IntPtr reference = IntPtr.Zero;
    try {
      Marshal.WriteInt32(count, 0);
      SHCreateThreadRef(count, out reference);
      SHSetThreadRef(reference);
      SHSetInstanceExplorer(reference);
      int owned = Marshal.ReadInt32(count);
      try { action(); }
      finally {
        if (Marshal.ReadInt32(count) > owned) {
          // USER_TIMER_MINIMUM wakes the STA to inspect the reference count while dispatching COM work.
          UIntPtr timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 10, IntPtr.Zero);
          if (timer == UIntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
          try {
            while (Marshal.ReadInt32(count) > owned) {
              Message message;
              if (GetMessage(out message, IntPtr.Zero, 0, 0) <= 0) throw new InvalidOperationException("Shell handoff message loop ended");
              TranslateMessage(ref message);
              DispatchMessage(ref message);
            }
          } finally { KillTimer(IntPtr.Zero, timer); }
        }
      }
    } finally {
      SHSetInstanceExplorer(IntPtr.Zero);
      SHSetThreadRef(IntPtr.Zero);
      int remaining = reference == IntPtr.Zero ? 0 : Marshal.Release(reference);
      // An interrupted drain leaves its counter owned by the terminating helper process.
      if (remaining == 0) Marshal.FreeHGlobal(count);
    }
  }

  public sealed class Application {
    public string id;
    public string name;
    public string icon;
    public bool @default;
  }
  static string Associated(string extension, uint kind) {
    uint size = 0;
    AssocQueryString(0, kind, extension, null, null, ref size);
    if (size == 0) return null;
    var text = new StringBuilder((int)size);
    return AssocQueryString(0, kind, extension, null, text, ref size) == 0 ? text.ToString() : null;
  }
  // Resolve a packaged application's indirect icon reference, for example
  // @{Microsoft.WindowsNotepad_...?ms-resource://.../NotepadAppList.png}, to
  // the resource file the Shell would draw; an unresolved reference is null.
  static string ResolveIndirectIcon(string source) {
    var output = new StringBuilder(1024);
    return SHLoadIndirectString(source, output, (uint)output.Capacity, IntPtr.Zero) == 0 ? output.ToString() : null;
  }
  // Read one icon source into a 32px PNG: an image file directly, otherwise the
  // resource the Shell extracts at the given index. A missing resource is null.
  static string PngFromIconSource(string source, int index) {
    IntPtr large = IntPtr.Zero, small = IntPtr.Zero;
    try {
      if (Path.GetExtension(source).Equals(".png", StringComparison.OrdinalIgnoreCase)) {
        using (var original = Image.FromFile(source))
        using (var resized = new Bitmap(original, new Size(32, 32)))
        using (var stream = new MemoryStream()) {
          resized.Save(stream, ImageFormat.Png);
          return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
        }
      }
      if (SHDefExtractIcon(source, index, 0, out large, out small, 32) != 0 || large == IntPtr.Zero) return null;
      using (var image = Icon.FromHandle(large))
      using (var bitmap = image.ToBitmap())
      using (var stream = new MemoryStream()) {
        bitmap.Save(stream, ImageFormat.Png);
        return "data:image/png;base64," + Convert.ToBase64String(stream.ToArray());
      }
    } catch (Exception) {
      // Missing icon resources do not make the application unusable.
      return null;
    } finally {
      if (large != IntPtr.Zero) DestroyIcon(large);
      if (small != IntPtr.Zero) DestroyIcon(small);
    }
  }
  // Best-effort fallback: some handlers return their executable path from GetName, but a
  // packaged handler's name may be an AUMID or family name, which extracts no icon.
  static string IconData(IHandler handler, string id) {
    string source = null; int index = 0;
    try { handler.GetIconLocation(out source, out index); } catch (Exception) {
      // A handler without a drawable icon location falls back to its name.
    }
    if (!String.IsNullOrEmpty(source)) {
      source = Environment.ExpandEnvironmentVariables(source);
      if (source.StartsWith("@{", StringComparison.Ordinal) && source.EndsWith("}", StringComparison.Ordinal)) {
        var resolved = ResolveIndirectIcon(source);
        if (!String.IsNullOrEmpty(resolved)) source = resolved;
      }
      var icon = PngFromIconSource(source, index);
      if (icon != null) return icon;
    }
    return String.IsNullOrEmpty(id) || String.Equals(id, source, StringComparison.OrdinalIgnoreCase)
      ? null
      : PngFromIconSource(id, 0);
  }
  static void Visit(string path, Action<IHandler> visit) {
    var extension = Path.GetExtension(path);
    if (extension.Length == 0) return;
    IEnumHandlers handlers;
    SHAssocEnumHandlers(extension, 0, out handlers);
    try {
      while (true) {
        IHandler handler; uint fetched;
        int result = handlers.Next(1, out handler, out fetched);
        Marshal.ThrowExceptionForHR(result);
        if (result != 0 || fetched == 0) break;
        try { visit(handler); } finally { Marshal.FinalReleaseComObject(handler); }
      }
    } finally { Marshal.FinalReleaseComObject(handlers); }
  }
  public static Application[] List(string path) {
    var extension = Path.GetExtension(path);
    var executable = extension.Length == 0 ? null : Associated(extension, 2);
    var appId = extension.Length == 0 ? null : Associated(extension, 21);
    var apps = new List<Application>();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    Visit(path, delegate(IHandler handler) {
      string id, name;
      handler.GetName(out id); handler.GetUIName(out name);
      if (!seen.Add(id)) return;
      apps.Add(new Application { id = id, name = name, icon = IconData(handler, id),
        @default = String.Equals(id, executable, StringComparison.OrdinalIgnoreCase) || String.Equals(id, appId, StringComparison.OrdinalIgnoreCase) });
    });
    return apps.ToArray();
  }
  public static void Open(string path, string application) {
    WithShellLifetime(delegate { OpenRegistered(path, application); });
  }
  static void OpenRegistered(string path, string application) {
    bool opened = false;
    Visit(path, delegate(IHandler handler) {
      string id; handler.GetName(out id);
      if (opened || !String.Equals(id, application, StringComparison.OrdinalIgnoreCase)) return;
      var iid = typeof(IShellItem).GUID;
      IShellItem item;
      SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
      IDataObject data = null;
      try {
        var bhid = new Guid("b8c0bd9f-ed24-455c-83e6-d5390c4fe8c4");
        var dataIid = typeof(IDataObject).GUID;
        item.BindToHandler(IntPtr.Zero, ref bhid, ref dataIid, out data);
        handler.Invoke(data);
        opened = true;
      } finally {
        if (data != null) Marshal.FinalReleaseComObject(data);
        Marshal.FinalReleaseComObject(item);
      }
    });
    if (!opened) throw new InvalidOperationException("Application is not registered for this file");
  }
}`;
//#endregion
//#region lib/types/unc-path.js
const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:/;
/**
* Validates and normalizes a canonical Windows UNC root path (`\\server\share` or `\\server\share\subpath`).
* Uses `path.win32` exclusively so behavior is identical on Windows and Linux/WSL test hosts.
*/
function normalizeCanonicalUncRoot(rawRoot) {
	const trimmed = rawRoot.trim();
	if (!trimmed || trimmed.includes("\0")) return {
		ok: false,
		code: "INVALID_UNC_ROOT",
		message: "UNC root must not be empty or contain NUL characters."
	};
	const slashNormalized = trimmed.replace(/\//g, "\\");
	if (WINDOWS_DRIVE_PREFIX_RE.test(slashNormalized)) return {
		ok: false,
		code: "INVALID_UNC_ROOT",
		message: `Mapped drive letters are not allowed as canonical UNC roots: ${rawRoot}`
	};
	let body = "";
	let prefix = "\\\\";
	if (slashNormalized.toUpperCase().startsWith("\\\\?\\UNC\\")) {
		prefix = "\\\\?\\UNC\\";
		body = slashNormalized.slice(8);
	} else if (slashNormalized.startsWith("\\\\")) {
		prefix = "\\\\";
		body = slashNormalized.slice(2);
	} else return {
		ok: false,
		code: "INVALID_UNC_ROOT",
		message: `Root path must start with a Windows UNC prefix (\\\\server\\share): ${rawRoot}`
	};
	if (body.startsWith("\\")) return {
		ok: false,
		code: "INVALID_UNC_ROOT",
		message: `Invalid extra leading backslashes in UNC root: ${rawRoot}`
	};
	const rawSegments = body.split("\\").filter((seg) => seg.length > 0);
	if (rawSegments.length < 2) return {
		ok: false,
		code: "INVALID_UNC_ROOT",
		message: `UNC root must include both server and share name (\\\\server\\share): ${rawRoot}`
	};
	for (const seg of rawSegments) if (seg === "." || seg === "..") return {
		ok: false,
		code: "INVALID_UNC_ROOT",
		message: `UNC root must not contain traversal segments (. or ..): ${rawRoot}`
	};
	if (prefix === "\\\\?\\UNC\\") return {
		ok: true,
		canonicalRoot: `\\\\?\\UNC\\${rawSegments.join("\\")}`
	};
	return {
		ok: true,
		canonicalRoot: path.win32.normalize(`\\\\${rawSegments.join("\\")}`).replace(/\\+$/, "")
	};
}
/**
* Resolves a `(rootId, relativePath)` tuple against an allowlist of `MediaRootConfig` entries,
* enforcing strict containment inside the root's `canonicalUncRoot`.
*/
function resolveAllowlistedUncPath(roots, rootId, relativePath) {
	const rootConfig = roots.find((r) => r.rootId === rootId);
	if (!rootConfig) return {
		ok: false,
		code: "UNMAPPED_ROOT",
		message: `Unknown media root ID: ${rootId}`
	};
	if (!rootConfig.enabled) return {
		ok: false,
		code: "DISABLED_ROOT",
		message: `Media root '${rootId}' (${rootConfig.label}) is currently disabled.`
	};
	const rootCheck = normalizeCanonicalUncRoot(rootConfig.canonicalUncRoot);
	if (!rootCheck.ok) return rootCheck;
	const canonicalRoot = rootCheck.canonicalRoot;
	if (!relativePath || relativePath.trim().length === 0 || relativePath.includes("\0")) return {
		ok: false,
		code: "INVALID_RELATIVE_PATH",
		message: "Relative media path must be non-empty and must not contain NUL bytes."
	};
	const trimmedRel = relativePath.trim();
	if (trimmedRel.startsWith("/") || trimmedRel.startsWith("\\") || WINDOWS_DRIVE_PREFIX_RE.test(trimmedRel)) return {
		ok: false,
		code: "PATH_TRAVERSAL_REJECTED",
		message: `Relative path must not start with a root slash, UNC prefix, or drive letter: ${relativePath}`
	};
	const slashNormalizedRel = trimmedRel.replace(/\//g, "\\");
	const rawSegments = slashNormalizedRel.split("\\");
	for (const segment of rawSegments) {
		if (segment === ".." || segment === ".") return {
			ok: false,
			code: "PATH_TRAVERSAL_REJECTED",
			message: `Relative path must not contain '.' or '..' segments: ${relativePath}`
		};
		if (segment.length === 0) return {
			ok: false,
			code: "INVALID_RELATIVE_PATH",
			message: `Relative path must not contain empty path segments: ${relativePath}`
		};
	}
	const resolvedUncPath = path.win32.resolve(canonicalRoot, slashNormalizedRel);
	const relFromRoot = path.win32.relative(canonicalRoot, resolvedUncPath);
	if (!relFromRoot || relFromRoot === "." || relFromRoot.startsWith("..") || path.win32.isAbsolute(relFromRoot)) return {
		ok: false,
		code: "PATH_TRAVERSAL_REJECTED",
		message: `Resolved path escapes allowlisted UNC root '${canonicalRoot}': ${relativePath}`
	};
	const requiredPrefix = `${canonicalRoot.toLowerCase()}\\`;
	if (!resolvedUncPath.toLowerCase().startsWith(requiredPrefix)) return {
		ok: false,
		code: "PATH_TRAVERSAL_REJECTED",
		message: `Resolved path failed strict UNC root prefix containment check: ${resolvedUncPath}`
	};
	return {
		ok: true,
		canonicalRoot,
		normalizedRelativePath: relFromRoot,
		resolvedUncPath
	};
}
//#endregion
//#region lib/types/spike-service.js
const DEFAULT_M1_ROOT_ID = "nas-main";
const DEFAULT_M1_TEST_ITEMS = [
	{
		mediaId: "m1-basic-mkv",
		rootId: DEFAULT_M1_ROOT_ID,
		relativePath: "movies\\sample-basic.mkv",
		label: "Basic ASCII path (.mkv)",
		scenario: "basic"
	},
	{
		mediaId: "m1-spaces-mp4",
		rootId: DEFAULT_M1_ROOT_ID,
		relativePath: "movies\\Folder With Spaces\\Sample Video With Spaces.mp4",
		label: "Path containing spaces (.mp4)",
		scenario: "spaces"
	},
	{
		mediaId: "m1-cjk-mkv",
		rootId: DEFAULT_M1_ROOT_ID,
		relativePath: "动画归档\\测试目录\\中文文件名测试_01.mkv",
		label: "Chinese / CJK directory and filename (.mkv)",
		scenario: "cjk"
	},
	{
		mediaId: "m1-comma-mkv",
		rootId: DEFAULT_M1_ROOT_ID,
		relativePath: "movies\\director, cut\\part 1, scene 2 [1080p].mkv",
		label: "Path containing commas (explorer.exe /select, hazards)",
		scenario: "comma"
	},
	{
		mediaId: "m1-long-path-mkv",
		rootId: DEFAULT_M1_ROOT_ID,
		relativePath: `Archive_Segment_Alpha_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJ\\Archive_Segment_Beta_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJK\\Archive_Segment_Gamma_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJ\\deeply_nested_long_unc_path_sample_video_exceeding_260_characters.mkv`,
		label: "Long UNC path (> 260 characters)",
		scenario: "long_path"
	},
	{
		mediaId: "m1-missing-file",
		rootId: DEFAULT_M1_ROOT_ID,
		relativePath: "movies\\__non_existent_m1_spike_target__.mkv",
		label: "Missing target file (structured error check)",
		scenario: "missing_file"
	}
];
function resolveLocalDataDir(baseDir, dataDirName = "media-library") {
	const effectiveBase = baseDir?.trim() || process.env.DSH_HOME?.trim() || path.join(os.homedir(), ".dsh");
	return path.resolve(effectiveBase, dataDirName);
}
function probeNodeSqliteBuiltIn() {
	try {
		const getBuiltin = process.getBuiltinModule;
		if (typeof getBuiltin !== "function") return false;
		const mod = getBuiltin("node:sqlite");
		return Boolean(mod && typeof mod.DatabaseSync === "function");
	} catch {
		return false;
	}
}
const defaultNativeOpener = {
	async openPath(targetPath) {
		await openNativeAssociatedPath(targetPath, AbortSignal.timeout(1e4));
	},
	async revealPath(targetPath) {
		await revealNativePath(targetPath, AbortSignal.timeout(1e4));
	}
};
async function defaultUncFileProbe(resolvedUncPath, timeoutMs) {
	let timer;
	try {
		const statPromise = fs.promises.stat(resolvedUncPath);
		const timeoutPromise = new Promise((_, reject) => {
			timer = setTimeout(() => {
				const timeoutErr = /* @__PURE__ */ new Error(`Timed out after ${timeoutMs}ms while probing NAS path: ${resolvedUncPath}`);
				timeoutErr.code = "ETIMEDOUT";
				reject(timeoutErr);
			}, timeoutMs);
		});
		if (!(await Promise.race([statPromise, timeoutPromise])).isFile()) return {
			ok: false,
			code: "FILE_NOT_FOUND",
			message: `Target UNC path is not a regular file: ${resolvedUncPath}`
		};
		return { ok: true };
	} catch (error) {
		return classifyFsError(error, resolvedUncPath);
	} finally {
		if (timer !== void 0) clearTimeout(timer);
	}
}
function classifyFsError(error, resolvedUncPath) {
	const errno = error?.code ?? "";
	const rawMessage = error instanceof Error ? error.message : String(error);
	if (errno === "EACCES" || errno === "EPERM") return {
		ok: false,
		code: "PERMISSION_DENIED",
		message: `Access denied on SMB share for path '${resolvedUncPath}': ${rawMessage}`
	};
	if (errno === "ETIMEDOUT" || errno === "EHOSTUNREACH" || errno === "ENETUNREACH" || errno === "ECONNREFUSED" || errno === "ECONNRESET" || errno === "EBUSY" || errno === "EIO") return {
		ok: false,
		code: "NAS_OFFLINE_OR_TIMEOUT",
		message: `NAS share is unreachable or timed out for '${resolvedUncPath}' (${errno}): ${rawMessage}`
	};
	if (errno === "ENOENT" || errno === "ENOTDIR") return {
		ok: false,
		code: "FILE_NOT_FOUND",
		message: `File not found at '${resolvedUncPath}': ${rawMessage}`
	};
	if (errno === "UNKNOWN" && /network|unc|share|host/i.test(rawMessage)) return {
		ok: false,
		code: "NAS_OFFLINE_OR_TIMEOUT",
		message: `Windows SMB network path unreachable for '${resolvedUncPath}': ${rawMessage}`
	};
	return {
		ok: false,
		code: "FILE_NOT_FOUND",
		message: `Unable to access target file '${resolvedUncPath}' (${errno || "ERROR"}): ${rawMessage}`
	};
}
var MediaLibrarySpikeService = class {
	localDataDir;
	localDatabasePath;
	spikeOverridePath;
	configuredUncRoot;
	probeTimeoutMs;
	explicitRoots;
	explicitItems;
	opener;
	fileProbe;
	constructor(options = {}) {
		this.localDataDir = resolveLocalDataDir(options.baseDir, options.dataDirName ?? "media-library");
		this.localDatabasePath = path.join(this.localDataDir, "library.sqlite3");
		this.spikeOverridePath = path.join(this.localDataDir, "m1-spike.json");
		this.configuredUncRoot = options.configuredUncRoot ?? "\\\\NAS\\MediaTest";
		this.probeTimeoutMs = options.probeTimeoutMs ?? 5e3;
		this.explicitRoots = options.roots;
		this.explicitItems = options.items;
		this.opener = options.opener ?? defaultNativeOpener;
		this.fileProbe = options.fileProbe ?? defaultUncFileProbe;
	}
	readConfiguredUncRoot() {
		return typeof this.configuredUncRoot === "function" ? this.configuredUncRoot() : this.configuredUncRoot;
	}
	readLocalOverrideFile() {
		try {
			if (!fs.existsSync(this.spikeOverridePath)) return null;
			const raw = fs.readFileSync(this.spikeOverridePath, "utf8");
			const parsed = JSON.parse(raw);
			return parsed && typeof parsed === "object" ? parsed : null;
		} catch {
			return null;
		}
	}
	getEffectiveRootsAndItems() {
		const override = this.readLocalOverrideFile();
		const rawUncRoot = override?.uncRoot?.trim() || this.readConfiguredUncRoot().trim() || "\\\\NAS\\MediaTest";
		const normalizedRoot = normalizeCanonicalUncRoot(rawUncRoot);
		const activeUncRoot = normalizedRoot.ok ? normalizedRoot.canonicalRoot : rawUncRoot;
		return {
			activeUncRoot,
			roots: this.explicitRoots ?? override?.roots ?? [{
				rootId: "nas-main",
				label: "Primary Synology NAS Media Share (M1 Spike)",
				canonicalUncRoot: activeUncRoot,
				enabled: true
			}],
			items: this.explicitItems ?? override?.items ?? [...DEFAULT_M1_TEST_ITEMS]
		};
	}
	getSpikeStatus() {
		const { activeUncRoot, roots, items } = this.getEffectiveRootsAndItems();
		return {
			platform: process.platform,
			nodeVersion: process.version,
			nodeSqliteAvailable: probeNodeSqliteBuiltIn(),
			localDataDir: this.localDataDir,
			localDatabasePath: this.localDatabasePath,
			spikeOverridePath: this.spikeOverridePath,
			activeUncRoot,
			roots,
			items
		};
	}
	async openMedia(mediaId) {
		return this.executeMediaAction("open", mediaId);
	}
	async revealMedia(mediaId) {
		return this.executeMediaAction("reveal", mediaId);
	}
	async executeMediaAction(action, mediaId) {
		const startMs = Date.now();
		const trimmedId = typeof mediaId === "string" ? mediaId.trim() : "";
		const { roots, items } = this.getEffectiveRootsAndItems();
		const item = items.find((entry) => entry.mediaId === trimmedId);
		if (!item) return {
			ok: false,
			mediaId: trimmedId,
			action,
			code: "UNKNOWN_MEDIA_ID",
			message: `Unknown mediaId '${trimmedId}'. Client may only request registered mediaIds.`,
			elapsedMs: Date.now() - startMs
		};
		const resolution = resolveAllowlistedUncPath(roots, item.rootId, item.relativePath);
		if (!resolution.ok) return {
			ok: false,
			mediaId: item.mediaId,
			action,
			code: resolution.code,
			message: resolution.message,
			elapsedMs: Date.now() - startMs
		};
		const { resolvedUncPath } = resolution;
		const probe = await this.fileProbe(resolvedUncPath, this.probeTimeoutMs);
		if (!probe.ok) {
			const code = probe.code ?? "FILE_NOT_FOUND";
			return {
				ok: false,
				mediaId: item.mediaId,
				action,
				code,
				message: probe.message ?? `Target file probe failed: ${resolvedUncPath}`,
				resolvedUncPath,
				elapsedMs: Date.now() - startMs
			};
		}
		try {
			if (action === "open") await this.opener.openPath(resolvedUncPath);
			else await this.opener.revealPath(resolvedUncPath);
			return {
				ok: true,
				mediaId: item.mediaId,
				action,
				resolvedUncPath,
				elapsedMs: Date.now() - startMs
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				mediaId: item.mediaId,
				action,
				code: "OPENER_FAILED",
				message: `Native ${action} command failed for '${resolvedUncPath}': ${message}`,
				resolvedUncPath,
				elapsedMs: Date.now() - startMs
			};
		}
	}
};
//#endregion
//#region lib/types/remote.js
var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};
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
			_spikeStatus_decorators = [Remote("spikeStatus")];
			_openMedia_decorators = [Remote("openMedia")];
			_revealMedia_decorators = [Remote("revealMedia")];
			__esDecorate(this, null, _spikeStatus_decorators, {
				kind: "method",
				name: "spikeStatus",
				static: false,
				private: false,
				access: {
					has: (obj) => "spikeStatus" in obj,
					get: (obj) => obj.spikeStatus
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _openMedia_decorators, {
				kind: "method",
				name: "openMedia",
				static: false,
				private: false,
				access: {
					has: (obj) => "openMedia" in obj,
					get: (obj) => obj.openMedia
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			__esDecorate(this, null, _revealMedia_decorators, {
				kind: "method",
				name: "revealMedia",
				static: false,
				private: false,
				access: {
					has: (obj) => "revealMedia" in obj,
					get: (obj) => obj.revealMedia
				},
				metadata: _metadata
			}, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, {
				enumerable: true,
				configurable: true,
				writable: true,
				value: _metadata
			});
		}
		static inject = ["typert"];
		static get Config() {
			return Config;
		}
		spikeService = __runInitializers(this, _instanceExtraInitializers);
		constructor(ctx, config) {
			super(ctx, "mediaLibrary", { namespace: "mediaLibrary" });
			const baseDir = ctx.baseDir;
			this.spikeService = new MediaLibrarySpikeService({
				baseDir,
				dataDirName: config.dataDir,
				configuredUncRoot: () => config.uncRoot.get(),
				probeTimeoutMs: config.probeTimeoutMs
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
//#endregion
//#region lib/types/index.js
const name = "dsh-media-library";
const inject = ["typert"];
function apply(ctx, config) {
	new MediaLibraryRemote(ctx, config);
}
//#endregion
export { Config, MediaLibraryRemote, MediaLibrarySpikeService, apply, inject, name, normalizeCanonicalUncRoot, resolveAllowlistedUncPath };
