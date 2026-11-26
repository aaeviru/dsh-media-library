import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { extractCatalogNumber, extractIsoDate } from '../inventory/tagstudio-inventory.ts';
import { normalizeLabel, runMutation } from '../mutations/transaction.ts';
import { computeIngestionTargetRelativePath, parseIsoYearMonth } from '../types.ts';
import type {
  CommitIngestionResult,
  DeleteStagingFileInput,
  DeleteStagingFileResult,
  FetchedMetadataCandidate,
  IngestionManifest,
  IngestionManifestTag,
  IngestionPhase,
  IngestionReviewDecision,
  IngestionState,
  IngestionTask,
  IngestionTaskOp,
  IngestionTaskStatus,
  MediaRootConfig,
  ReconcileIngestionResult,
  ReviewIngestionInput,
  ReviewIngestionResult,
  ScanStagingResult,
  StagingFileItem,
} from '../types.ts';
import { resolveAllowlistedUncPath } from '../unc-path.ts';
import { evaluateManifestPerformers, normalizePerformerName } from '../performers/performer-service.ts';
import { type MetadataFetcher, parseFc2Code, resolveMetadataLookupRoute } from './metadata-fetcher.ts';

const VIDEO_EXTENSIONS = new Set(['.avi', '.mkv', '.mp4', '.mov', '.wmv', '.m4v', '.ts']);

/** Async production I/O; synchronous fixture adapters remain supported. */
export interface IngestionFileOps {
  exists(filePath: string): boolean | Promise<boolean>;
  statSize(filePath: string): number | Promise<number>;
  sha256(filePath: string): string | Promise<string>;
  readRange(filePath: string, offset: number, length: number): Buffer | Promise<Buffer>;
  ensureDir(dirPath: string): void | Promise<void>;
  rename(srcPath: string, destPath: string): void | Promise<void>;
  copyFile(srcPath: string, destPath: string): void | Promise<void>;
  removeFile(filePath: string): void | Promise<void>;
}

export const defaultIngestionFileOps: IngestionFileOps = {
  exists: async p => {
    try { await fsp.stat(p); return true; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  },
  statSize: async p => (await fsp.stat(p)).size,
  sha256: async p => {
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(p)) hash.update(chunk);
    return hash.digest('hex');
  },
  readRange: async (p, offset, length) => {
    const handle = await fsp.open(p, 'r');
    try {
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    } finally { await handle.close(); }
  },
  ensureDir: async d => { await fsp.mkdir(d, { recursive: true }); },
  rename: (src, dest) => fsp.rename(src, dest),
  copyFile: (src, dest) => fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL),
  removeFile: p => fsp.rm(p, { force: true }),
};

function deduplicateManifestTags(tags: readonly IngestionManifestTag[]): IngestionManifestTag[] {
  const seenTagIds = new Set<number>();
  const seenNames = new Set<string>();
  const result: IngestionManifestTag[] = [];
  for (const tag of tags) {
    const trimmed = tag.name.trim();
    const norm = normalizeLabel(trimmed);
    if (!norm) continue;
    if (tag.tagId !== undefined) {
      if (seenTagIds.has(tag.tagId) || seenNames.has(norm)) continue;
      seenTagIds.add(tag.tagId);
      seenNames.add(norm);
      result.push({ tagId: tag.tagId, name: trimmed });
    } else {
      if (seenNames.has(norm)) continue;
      seenNames.add(norm);
      result.push({ name: trimmed });
    }
  }
  return result;
}

function mapManifestRow(row: Record<string, unknown>): IngestionManifest {
  let tags: IngestionManifestTag[] = [];
  try {
    const parsed = JSON.parse(String(row.tags_json ?? '[]'));
    if (Array.isArray(parsed)) {
      const rawTags = parsed
        .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string'))
        .map((t) => ({
          tagId: typeof t.tagId === 'number' ? Number(t.tagId) : undefined,
          name: String(t.name),
        }));
      tags = deduplicateManifestTags(rawTags);
    }
  } catch {
    tags = [];
  }

  let actresses: string[] = [];
  try {
    const parsedActresses = JSON.parse(String(row.actresses_json ?? '[]'));
    if (Array.isArray(parsedActresses)) {
      actresses = parsedActresses.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    }
  } catch {
    actresses = [];
  }

  return {
    id: Number(row.id),
    sourceId: String(row.source_id),
    tempPath: String(row.temp_path),
    targetRootId: String(row.target_root_id),
    targetRelativePath: String(row.target_relative_path),
    filename: String(row.filename),
    title: row.title !== null && row.title !== undefined ? String(row.title) : null,
    catalogNumber: row.catalog_number !== null && row.catalog_number !== undefined ? String(row.catalog_number) : null,
    mediaDate: row.media_date !== null && row.media_date !== undefined ? String(row.media_date) : null,
    actresses,
    tags,
    metadataSource: row.metadata_source !== null && row.metadata_source !== undefined ? String(row.metadata_source) : null,
    checksumSha256: String(row.checksum_sha256),
    fileSize: Number(row.file_size),
    state: String(row.state) as IngestionState,
    reviewDecision: String(row.review_decision) as IngestionReviewDecision,
    lastError: row.last_error !== null && row.last_error !== undefined ? String(row.last_error) : null,
    indexedMediaId: row.indexed_media_id !== null && row.indexed_media_id !== undefined ? Number(row.indexed_media_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function resolveExistingTagByNameOrAlias(
  db: DatabaseSync,
  normalizedName: string,
): { id: number; name: string } | undefined {
  if (!normalizedName) return undefined;
  const direct = db
    .prepare('SELECT id, name FROM tags WHERE normalized_name = ? AND archived_at IS NULL LIMIT 1')
    .get(normalizedName) as { id: number; name: string } | undefined;
  if (direct) return { id: Number(direct.id), name: String(direct.name) };

  const viaAlias = db
    .prepare(
      `SELECT t.id, t.name
       FROM tag_aliases ta
       JOIN tags t ON t.id = ta.tag_id
       WHERE ta.normalized_alias = ?
         AND t.archived_at IS NULL
       ORDER BY t.id ASC
       LIMIT 1`,
    )
    .get(normalizedName) as { id: number; name: string } | undefined;
  return viaAlias ? { id: Number(viaAlias.id), name: String(viaAlias.name) } : undefined;
}

export function getIngestionManifestById(db: DatabaseSync, manifestId: number): IngestionManifest | null {
  const row = db.prepare('SELECT * FROM ingestion_manifests WHERE id = ?').get(manifestId) as
    | Record<string, unknown>
    | undefined;
  return row ? mapManifestRow(row) : null;
}

export function listIngestionManifests(
  db: DatabaseSync,
  options?: { readonly state?: IngestionState | undefined; readonly limit?: number | undefined },
): IngestionManifest[] {
  const limit = Math.min(Math.max(Number(options?.limit ?? 100), 1), 500);
  const rows = options?.state
    ? (db
        .prepare('SELECT * FROM ingestion_manifests WHERE state = ? ORDER BY updated_at DESC, id DESC LIMIT ?')
        .all(options.state, limit) as Array<Record<string, unknown>>)
    : (db
        .prepare('SELECT * FROM ingestion_manifests ORDER BY updated_at DESC, id DESC LIMIT ?')
        .all(limit) as Array<Record<string, unknown>>);
  return rows.map(mapManifestRow);
}

export { computeIngestionTargetRelativePath, parseIsoYearMonth };

export function normalizeTargetSubdir(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`STAGING_UNREACHABLE_OR_TIMEOUT: ${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function walkStagingVideosAsync(
  dir: string,
  baseDir: string,
  targetSubdir: string,
  autoDateSubdir: boolean,
  nowDate: Date,
  acc: Array<{
    filename: string;
    relativePath: string;
    tempPath: string;
    targetRelativePath: string;
    fileSize: number;
    mtimeIso: string;
    catalogNumber: string | null;
  }>,
): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkStagingVideosAsync(fullPath, baseDir, targetSubdir, autoDateSubdir, nowDate, acc);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(ext)) continue;
      const stat = await fsp.stat(fullPath);
      const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      const inferredDate = extractIsoDate(entry.name);
      const targetRel = computeIngestionTargetRelativePath({
        filename: entry.name,
        targetSubdir,
        autoDateSubdir,
        mediaDate: inferredDate,
        now: nowDate,
      });
      const fc2 = parseFc2Code(path.basename(entry.name, ext));
      const cat = fc2?.code ?? extractCatalogNumber(entry.name);
      acc.push({
        filename: entry.name,
        relativePath: rel,
        tempPath: fullPath,
        targetRelativePath: targetRel,
        fileSize: stat.size,
        mtimeIso: stat.mtime.toISOString(),
        catalogNumber: cat,
      });
    }
  }
}

/**
 * Pure async dry-run directory scan: reads ONLY directory entries and file `stat` (`size`/`mtime`),
 * never reads video file bytes and never writes to SQLite.
 */
export async function previewStagingPlan(options: {
  readonly stagingDir: string;
  readonly targetRootId: string;
  readonly targetSubdir: string;
  readonly autoDateSubdir?: boolean | undefined;
  readonly roots: readonly MediaRootConfig[];
  readonly timeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}): Promise<{
  readonly ok: boolean;
  readonly files: readonly StagingFileItem[];
  readonly targetRelativePaths: readonly string[];
  readonly error?: string | undefined;
}> {
  const stagingDir = options.stagingDir.trim();
  if (!stagingDir) {
    return { ok: false, files: [], targetRelativePaths: [], error: 'Staging directory is not configured.' };
  }

  const cleanSubdir = normalizeTargetSubdir(options.targetSubdir);
  const autoDateSubdir = options.autoDateSubdir ?? true;
  const nowDate = (options.now ?? (() => new Date()))();
  const timeoutMs = options.timeoutMs ?? 5000;

  try {
    const stat = await withTimeout(fsp.stat(stagingDir), timeoutMs, `stat(${stagingDir})`);
    if (!stat.isDirectory()) {
      return { ok: false, files: [], targetRelativePaths: [], error: `Staging path is not a directory: ${stagingDir}` };
    }

    const rawFiles: Array<{
      filename: string;
      relativePath: string;
      tempPath: string;
      targetRelativePath: string;
      fileSize: number;
      mtimeIso: string;
      catalogNumber: string | null;
    }> = [];
    await withTimeout(
      walkStagingVideosAsync(stagingDir, stagingDir, cleanSubdir, autoDateSubdir, nowDate, rawFiles),
      timeoutMs,
      `readdir(${stagingDir})`,
    );

    const targetRelativePaths: string[] = [];
    for (const f of rawFiles) {
      const check = resolveAllowlistedUncPath(options.roots, options.targetRootId, f.targetRelativePath);
      if (!check.ok) {
        return { ok: false, files: [], targetRelativePaths: [], error: check.message };
      }
      targetRelativePaths.push(f.targetRelativePath);
    }

    const files: StagingFileItem[] = rawFiles.map((f) => ({
      ...f,
      manifestId: null,
      state: null,
      reviewDecision: null,
    }));
    return { ok: true, files, targetRelativePaths };
  } catch (err) {
    return {
      ok: false,
      files: [],
      targetRelativePaths: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Scan `stagingDir` asynchronously without reading file content or writing `planned` rows to SQLite.
 * Joins discovered files in-memory against existing persisted manifests.
 */
export async function scanStagingDirectory(
  db: DatabaseSync,
  options: {
    readonly stagingDir: string;
    readonly targetRootId: string;
    readonly targetSubdir: string;
    readonly autoDateSubdir?: boolean | undefined;
    readonly roots: readonly MediaRootConfig[];
    readonly timeoutMs?: number | undefined;
    readonly fileOps?: IngestionFileOps | undefined;
    readonly now?: (() => Date) | undefined;
  },
): Promise<ScanStagingResult> {
  const started = Date.now();
  const fileOps = options.fileOps ?? defaultIngestionFileOps;
  const nowDate = (options.now ?? (() => new Date()))();
  const nowIso = nowDate.toISOString();
  const cleanSubdir = normalizeTargetSubdir(options.targetSubdir);
  const autoDateSubdir = options.autoDateSubdir ?? true;
  const initialManifests = listIngestionManifests(db);
  const preview = await previewStagingPlan({ ...options, autoDateSubdir, now: () => nowDate });

  if (!preview.ok) {
    return {
      ok: false,
      stagingDir: options.stagingDir,
      targetRootId: options.targetRootId,
      targetSubdir: cleanSubdir,
      autoDateSubdir,
      elapsedMs: Date.now() - started,
      files: [],
      manifests: initialManifests,
      error: preview.error,
    };
  }

  const frozenIds = new Set(listFrozenIngestionManifests(db).map((m) => m.id));
  const unindexedByTempPath = new Map<string, IngestionManifest>();
  const unindexedByFilename = new Map<string, IngestionManifest>();
  for (const m of initialManifests) {
    if (m.state === 'indexed') continue;
    const tempKey = m.tempPath.toLowerCase();
    if (!unindexedByTempPath.has(tempKey)) {
      unindexedByTempPath.set(tempKey, m);
    }
    const key = m.filename.toLowerCase();
    if (!unindexedByFilename.has(key)) {
      unindexedByFilename.set(key, m);
    }
  }
  const previewTempPaths = new Set(preview.files.map((f) => f.tempPath.toLowerCase()));

  const matchedManifestIds = new Set<number>();
  const files: StagingFileItem[] = [];

  for (const f of preview.files) {
    const tempKey = f.tempPath.toLowerCase();
    const filenameKey = f.filename.toLowerCase();
    let existing = unindexedByTempPath.get(tempKey);
    if (existing && matchedManifestIds.has(existing.id)) {
      existing = undefined;
    }
    if (!existing) {
      const byName = unindexedByFilename.get(filenameKey);
      // Only rebind by filename if not already claimed and no other scanned file owns its exact tempPath.
      if (byName && !matchedManifestIds.has(byName.id) && !previewTempPaths.has(byName.tempPath.toLowerCase())) {
        existing = byName;
      }
    }
    if (existing) {
      matchedManifestIds.add(existing.id);
      // Issue #69 B3 Freeze Invariant: once a manifest has entered 'moving' or 'failed',
      // never recalculate its persisted target_relative_path on rescan.
      const pathFrozen = existing.state === 'moving' || existing.state === 'failed';
      const effectiveTargetRel = pathFrozen
        ? existing.targetRelativePath
        : computeIngestionTargetRelativePath({
            filename: f.filename,
            targetSubdir: cleanSubdir,
            autoDateSubdir,
            mediaDate: existing.mediaDate ?? extractIsoDate(f.filename),
            now: nowDate,
          });
      const nextSourceId = `staging:${effectiveTargetRel.toLowerCase()}:${f.fileSize}`;
      const tempChanged = existing.tempPath.toLowerCase() !== f.tempPath.toLowerCase();
      const targetChanged =
        existing.targetRootId !== options.targetRootId ||
        existing.targetRelativePath !== effectiveTargetRel ||
        existing.fileSize !== f.fileSize ||
        existing.sourceId !== nextSourceId;

      if (!frozenIds.has(existing.id) && (tempChanged || targetChanged)) {
        const nextState: IngestionState =
          tempChanged && existing.state === 'failed'
            ? existing.reviewDecision === 'approved'
              ? 'reviewed'
              : 'planned'
            : existing.state;
        const nextError = tempChanged && existing.state === 'failed' ? null : existing.lastError;
        const sourceIdConflict = db
          .prepare('SELECT id FROM ingestion_manifests WHERE source_id = ? AND id <> ? LIMIT 1')
          .get(nextSourceId, existing.id) as { id: number } | undefined;
        const safeSourceId = sourceIdConflict ? `${nextSourceId}#${existing.id}` : nextSourceId;

        db.prepare(
          `UPDATE ingestion_manifests
           SET source_id = ?,
               temp_path = ?,
               target_root_id = ?,
               target_relative_path = ?,
               filename = ?,
               file_size = ?,
               state = ?,
               last_error = ?,
               updated_at = ?
           WHERE id = ? AND state = ?`,
        ).run(
          safeSourceId,
          f.tempPath,
          options.targetRootId,
          effectiveTargetRel,
          f.filename,
          f.fileSize,
          nextState,
          nextError,
          nowIso,
          existing.id,
          existing.state,
        );
        existing = getIngestionManifestById(db, existing.id) ?? existing;
        unindexedByFilename.set(filenameKey, existing);
      }
    }

    files.push({
      ...f,
      manifestId: existing?.id ?? null,
      state: existing?.state ?? null,
      reviewDecision: existing?.reviewDecision ?? null,
    });
  }

  // B2: Automatically delete stale unindexed manifests whose staged file is no longer in `stagingDir`,
  // preserving running/frozen manifests and approved `moving`/`failed` recovery candidates whose target file already exists.
  const scannedFilenameKeys = new Set(preview.files.map((f) => f.filename.toLowerCase()));
  for (const m of initialManifests) {
    if (m.state === 'indexed') continue;
    if (matchedManifestIds.has(m.id) || scannedFilenameKeys.has(m.filename.toLowerCase())) continue;
    if (frozenIds.has(m.id)) continue;

    if (m.reviewDecision === 'approved' && (m.state === 'moving' || m.state === 'failed')) {
      const resolution = resolveAllowlistedUncPath(options.roots, m.targetRootId, m.targetRelativePath);
      if (resolution.ok) {
        try {
          if (await fileOps.exists(resolution.resolvedUncPath)) {
            continue;
          }
        } catch {
          // If destination probe fails transiently, keep the recovery candidate rather than deleting it.
          continue;
        }
      }
    }

    db.prepare('DELETE FROM ingestion_manifests WHERE id = ? AND state <> ?').run(m.id, 'indexed');
  }

  const manifests = listIngestionManifests(db);

  return {
    ok: true,
    stagingDir: options.stagingDir,
    targetRootId: options.targetRootId,
    targetSubdir: cleanSubdir,
    autoDateSubdir,
    elapsedMs: Date.now() - started,
    files,
    manifests,
  };
}

/**
 * Resolve a client-supplied relative staging identifier strictly inside the Host-configured `stagingDir` (`Issue #29`).
 * Rejects empty input, NUL bytes, leading slashes, drive letters, traversal segments, and non-video extensions.
 */
export function resolveStagingRelativePath(stagingDir: string, relativePath: string): string {
  const cleanStaging = stagingDir?.trim() ?? '';
  if (!cleanStaging) {
    throw new Error('PATH_TRAVERSAL_REJECTED: Host staging directory is not configured; configure stagingDir and rescan.');
  }
  const rawRel = typeof relativePath === 'string' ? relativePath : '';
  const normalizedRel = rawRel.replace(/\\/g, '/');
  const segments = normalizedRel.split('/').filter(Boolean);
  if (
    !rawRel.trim() ||
    rawRel.includes('\0') ||
    rawRel.startsWith('/') ||
    rawRel.startsWith('\\') ||
    /^[a-zA-Z]:/.test(rawRel) ||
    segments.length === 0 ||
    segments.some((s) => s === '.' || s === '..')
  ) {
    throw new Error(`PATH_TRAVERSAL_REJECTED: Rejected staging relative path '${rawRel}': must be a relative video file inside stagingDir.`);
  }
  const isWinStyle = cleanStaging.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(cleanStaging);
  const api = isWinStyle ? path.win32 : path;
  const resolved = api.resolve(cleanStaging, ...segments);
  validateStagingPath(cleanStaging, resolved);
  return resolved;
}

/** Both paths are Host owned/validated before any external I/O. */
export function validateStagingPath(stagingDir: string, source: string): void {
  const cleanStaging = stagingDir?.trim() ?? '';
  if (!cleanStaging) {
    throw new Error('PATH_TRAVERSAL_REJECTED: Host staging directory is not configured; refusing file operation. Configure stagingDir and rescan.');
  }
  const api = cleanStaging.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(cleanStaging) ? path.win32 : path;
  const base = api.resolve(cleanStaging);
  const relative = api.relative(base, api.resolve(source));
  if (!relative || relative === '..' || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative) || source.includes('\0')
      || !VIDEO_EXTENSIONS.has(api.extname(source).toLowerCase())) {
    throw new Error('PATH_TRAVERSAL_REJECTED: source must be a video inside the Host staging directory. Re-scan staging or update stagingDir before retrying.');
  }
}

/** Compare at most three MiB per file; merge small/overlapping ranges. */
async function checkExistingTarget(fileOps: IngestionFileOps, source: string, destination: string, size: number): Promise<void> {
  try {
    if (await fileOps.statSize(source) !== size) throw new Error('Source size changed');
    const length = Math.min(1024 * 1024, size);
    const starts = [0, Math.floor((size - length) / 2), size - length];
    const ranges: Array<{ start: number; end: number }> = [];
    for (const start of starts) {
      const last = ranges.at(-1);
      if (last && start <= last.end) last.end = Math.max(last.end, start + length);
      else ranges.push({ start, end: start + length });
    }
    for (const { start, end } of ranges) {
      if (end === start) continue;
      const a = await fileOps.readRange(source, start, end - start);
      const b = await fileOps.readRange(destination, start, end - start);
      if (a.length !== end - start || b.length !== end - start || !a.equals(b)) throw new Error('Sample mismatch or short read');
    }
  } catch {
    throw new Error('EXISTING_TARGET_INCOMPLETE: quick check failed; source retained. Check the destination and recopy manually if needed.');
  }
}

function validateManifestPaths(manifest: IngestionManifest, stagingDir?: string, requireStagingDir = false): void {
  if (requireStagingDir || stagingDir !== undefined) {
    validateStagingPath(stagingDir ?? '', manifest.tempPath);
  }
  if (path.win32.basename(manifest.targetRelativePath) !== manifest.filename || path.win32.basename(manifest.tempPath) !== manifest.filename) {
    throw new Error('PATH_TRAVERSAL_REJECTED: recorded source and destination filenames must match.');
  }
}

/**
 * Lazily persist an `ingestion_manifests` row only when the user actually acts on a staged file
 * (fetch metadata or review/approve), using lightweight path + size identity.
 */
export async function ensureManifestForStagingFile(
  db: DatabaseSync,
  options: {
    readonly tempPath?: string | undefined;
    readonly relativePath?: string | undefined;
    readonly targetRootId: string;
    readonly targetSubdir: string;
    readonly autoDateSubdir?: boolean | undefined;
    readonly roots: readonly MediaRootConfig[];
    readonly stagingDir?: string | undefined;
    readonly fileOps?: IngestionFileOps | undefined;
    readonly now?: (() => Date) | undefined;
  },
): Promise<IngestionManifest> {
  const fileOps = options.fileOps ?? defaultIngestionFileOps;
  const nowDate = (options.now ?? (() => new Date()))();
  const now = nowDate.toISOString();
  let tempPath: string;
  if (options.relativePath !== undefined) {
    tempPath = resolveStagingRelativePath(options.stagingDir ?? '', options.relativePath);
  } else if (options.tempPath) {
    tempPath = options.tempPath;
    validateStagingPath(options.stagingDir ?? '', tempPath);
  } else {
    throw new Error('PATH_TRAVERSAL_REJECTED: Either relativePath or Host-resolved tempPath is required.');
  }
  const filename = path.win32.basename(tempPath);
  const cleanSubdir = normalizeTargetSubdir(options.targetSubdir);
  const autoDateSubdir = options.autoDateSubdir ?? true;
  const inferredDate = extractIsoDate(filename);
  const targetRel = computeIngestionTargetRelativePath({
    filename,
    targetSubdir: cleanSubdir,
    autoDateSubdir,
    mediaDate: inferredDate,
    now: nowDate,
  });

  const check = resolveAllowlistedUncPath(options.roots, options.targetRootId, targetRel);
  if (!check.ok) {
    throw new Error(check.message);
  }

  const activeRoot = options.roots.find((r) => r.rootId === options.targetRootId);
  if (activeRoot) {
    db.prepare(
      `INSERT OR IGNORE INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(activeRoot.rootId, activeRoot.label, activeRoot.canonicalUncRoot, activeRoot.enabled ? 1 : 0, now);
  }

  if (!(await fileOps.exists(tempPath))) {
    throw new Error(`Staging file not found: ${tempPath}`);
  }
  const fileSize = (await fileOps.statSize(tempPath));
  const sourceId = `staging:${targetRel.toLowerCase()}:${fileSize}`;

  // B1: Match existing unindexed manifest by exact temp_path first.
  // Only fall back to filename/source_id rebinding when the previously bound temp_path no longer exists on disk
  // (i.e. moved to a new stagingDir per Issue #45), so a live sibling in another subfolder is never stolen.
  let existingUnindexed = db
    .prepare(
      `SELECT * FROM ingestion_manifests
       WHERE state <> 'indexed' AND LOWER(temp_path) = LOWER(?)
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
    )
    .get(tempPath) as Record<string, unknown> | undefined;

  if (!existingUnindexed) {
    const candidates = db
      .prepare(
        `SELECT * FROM ingestion_manifests
         WHERE state <> 'indexed' AND (LOWER(filename) = LOWER(?) OR source_id = ?)
         ORDER BY CASE WHEN LOWER(filename) = LOWER(?) THEN 0 ELSE 1 END, updated_at DESC, id DESC`,
      )
      .all(filename, sourceId, filename) as Array<Record<string, unknown>>;
    for (const row of candidates) {
      const candidate = mapManifestRow(row);
      if (!(await fileOps.exists(candidate.tempPath))) {
        existingUnindexed = row;
        break;
      }
    }
  }

  if (existingUnindexed) {
    const mapped = mapManifestRow(existingUnindexed);
    const pathFrozen = mapped.state === 'moving' || mapped.state === 'failed';
    const effectiveTargetRel = pathFrozen
      ? mapped.targetRelativePath
      : computeIngestionTargetRelativePath({
          filename,
          targetSubdir: cleanSubdir,
          autoDateSubdir,
          mediaDate: mapped.mediaDate ?? inferredDate,
          now: nowDate,
        });
    const effectiveSourceId = `staging:${effectiveTargetRel.toLowerCase()}:${fileSize}`;
    const tempChanged = mapped.tempPath.toLowerCase() !== tempPath.toLowerCase();
    const targetChanged =
      mapped.targetRootId !== options.targetRootId ||
      mapped.targetRelativePath !== effectiveTargetRel ||
      mapped.fileSize !== fileSize ||
      mapped.sourceId !== effectiveSourceId;
    if ((tempChanged || targetChanged) && !findManifestTask(db, mapped.id)) {
      const nextState: IngestionState =
        tempChanged && mapped.state === 'failed'
          ? mapped.reviewDecision === 'approved'
            ? 'reviewed'
            : 'planned'
          : mapped.state;
      const nextError = tempChanged && mapped.state === 'failed' ? null : mapped.lastError;
      const sourceIdConflict = db
        .prepare('SELECT id FROM ingestion_manifests WHERE source_id = ? AND id <> ? LIMIT 1')
        .get(effectiveSourceId, mapped.id) as { id: number } | undefined;
      const safeSourceId = sourceIdConflict ? `${effectiveSourceId}#${mapped.id}` : effectiveSourceId;
      const updateInfo = db.prepare(
        `UPDATE ingestion_manifests
         SET source_id = ?,
             temp_path = ?,
             target_root_id = ?,
             target_relative_path = ?,
             filename = ?,
             file_size = ?,
             state = ?,
             last_error = ?,
             updated_at = ?
         WHERE id = ? AND temp_path = ?`,
      ).run(
        safeSourceId,
        tempPath,
        options.targetRootId,
        effectiveTargetRel,
        filename,
        fileSize,
        nextState,
        nextError,
        now,
        mapped.id,
        mapped.tempPath,
      );
      if (updateInfo.changes === 1) {
        return getIngestionManifestById(db, mapped.id)!;
      }
      // Concurrent caller already rebound this stale manifest to another live file; fall through to insert a fresh row.
    } else {
      return mapped;
    }
  }

  const existingIndexed = db
    .prepare('SELECT * FROM ingestion_manifests WHERE LOWER(temp_path) = LOWER(?) LIMIT 1')
    .get(tempPath) as Record<string, unknown> | undefined;
  if (existingIndexed) {
    return mapManifestRow(existingIndexed);
  }

  const existingSourceId = db
    .prepare('SELECT id FROM ingestion_manifests WHERE source_id = ? LIMIT 1')
    .get(sourceId) as { id: number } | undefined;
  const insertSourceId = existingSourceId ? `${sourceId}#${crypto.randomBytes(4).toString('hex')}` : sourceId;

  const ext = path.extname(filename);
  const fc2 = parseFc2Code(path.basename(filename, ext));
  const catalogNumber = fc2?.code ?? extractCatalogNumber(filename);

  const info = db
    .prepare(
      `INSERT INTO ingestion_manifests (
        source_id, temp_path, target_root_id, target_relative_path, filename,
        title, catalog_number, media_date, tags_json, metadata_source,
        checksum_sha256, file_size, state, review_decision, last_error,
        indexed_media_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, '[]', NULL, '', ?, 'planned', 'pending', NULL, NULL, ?, ?)`,
    )
    .run(insertSourceId, tempPath, options.targetRootId, targetRel, filename, catalogNumber, inferredDate, fileSize, now, now);

  return getIngestionManifestById(db, Number(info.lastInsertRowid))!;
}

/**
 * Fetch candidate metadata & tags from `FC2CMADB` / `FC2PPVDB` (for `FC2-PPV-*`) or `av-wiki.net`
 * (for standard maker product codes) for a staged file or manifest (`Issue #7 B3` / `Issue #67 B4`).
 */
export async function fetchMetadataForManifest(
  db: DatabaseSync,
  manifestId: number,
  fetcher: MetadataFetcher,
  now: () => Date = () => new Date(),
): Promise<FetchedMetadataCandidate> {
  const manifest = getIngestionManifestById(db, manifestId);
  if (!manifest) {
    return {
      ok: false,
      provider: null,
      category: 'client_error',
      reason: `Manifest #${manifestId} not found.`,
      sourceUrl: '',
      title: null,
      writer: null,
      actresses: [],
      mediaDate: null,
      candidateTags: [],
      manifest: null,
    };
  }

  const catalogRoute = resolveMetadataLookupRoute(manifest.catalogNumber);
  const filenameRoute = resolveMetadataLookupRoute(manifest.filename);
  const route =
    catalogRoute?.kind === 'avwiki' &&
    !catalogRoute.parsed.partSuffix &&
    filenameRoute?.kind === 'avwiki' &&
    filenameRoute.parsed.baseCode === catalogRoute.parsed.baseCode &&
    filenameRoute.parsed.partSuffix
      ? filenameRoute
      : (catalogRoute ?? filenameRoute);

  if (!route) {
    return {
      ok: false,
      provider: null,
      category: 'no_code',
      reason: 'No supported FC2-PPV or standard product code found in filename or catalogNumber.',
      sourceUrl: '',
      title: manifest.title,
      writer: null,
      actresses: [],
      mediaDate: manifest.mediaDate,
      candidateTags: [],
      manifest,
    };
  }

  const lookup = await fetcher.lookupByText(route.parsed.code);
  if (!lookup.metadata) {
    return {
      ok: false,
      provider: null,
      category: lookup.category,
      reason: lookup.reason,
      sourceUrl: lookup.sourceUrl,
      title: manifest.title,
      writer: null,
      actresses: [],
      mediaDate: manifest.mediaDate,
      candidateTags: [],
      manifest,
    };
  }

  const meta = lookup.metadata;
  const actressNormSet = new Set(meta.actresses.map((a) => normalizePerformerName(a)).filter(Boolean));
  const mergedActresses = [...new Set([...manifest.actresses, ...meta.actresses].map((a) => a.trim()).filter(Boolean))];
  const mergedTagNames = new Map<string, { tag: IngestionManifestTag; rank: number; order: number }>();
  const seenResolvedTagIds = new Set<number>();
  let order = 0;
  const rankForTag = (name: string): number => {
    const norm = normalizeLabel(name);
    if (!norm) return 2;
    const direct = db
      .prepare('SELECT 1 FROM tags WHERE normalized_name = ? AND archived_at IS NULL LIMIT 1')
      .get(norm);
    if (direct) return 0;
    const viaAlias = db
      .prepare(
        `SELECT 1
         FROM tag_aliases ta
         JOIN tags tg ON tg.id = ta.tag_id
         WHERE ta.normalized_alias = ? AND tg.archived_at IS NULL
         LIMIT 1`,
      )
      .get(norm);
    return viaAlias ? 1 : 2;
  };
  for (const t of manifest.tags) {
    const norm = normalizeLabel(t.name);
    if (!norm) continue;
    const existingTag =
      t.tagId !== undefined
        ? (db.prepare('SELECT id, name FROM tags WHERE id = ? AND archived_at IS NULL LIMIT 1').get(t.tagId) as
            | { id: number; name: string }
            | undefined)
        : resolveExistingTagByNameOrAlias(db, norm);
    const resolved: IngestionManifestTag = existingTag
      ? { tagId: Number(existingTag.id), name: String(existingTag.name) }
      : t;
    if (resolved.tagId !== undefined) {
      if (seenResolvedTagIds.has(resolved.tagId)) continue;
      seenResolvedTagIds.add(resolved.tagId);
    }
    const canonicalNorm = normalizeLabel(resolved.name);
    if (mergedTagNames.has(canonicalNorm)) continue;
    mergedTagNames.set(canonicalNorm, { tag: resolved, rank: rankForTag(t.name), order: order++ });
  }
  for (const name of meta.candidateTags) {
    // Route fetched performers through `performer_aliases` + `performer_review_queue` instead of auto-creating normal tags.
    if (actressNormSet.has(normalizePerformerName(name))) continue;
    const norm = normalizeLabel(name);
    if (!norm || mergedTagNames.has(norm)) continue;
    const existingTag = resolveExistingTagByNameOrAlias(db, norm);
    if (existingTag && seenResolvedTagIds.has(existingTag.id)) continue;
    const resolved: IngestionManifestTag = existingTag ? { tagId: existingTag.id, name: existingTag.name } : { name };
    const canonicalNorm = normalizeLabel(resolved.name);
    if (mergedTagNames.has(canonicalNorm)) continue;
    if (resolved.tagId !== undefined) {
      seenResolvedTagIds.add(resolved.tagId);
    }
    mergedTagNames.set(canonicalNorm, {
      tag: resolved,
      rank: existingTag ? (normalizeLabel(existingTag.name) === norm ? 0 : 1) : 2,
      order: order++,
    });
  }
  const sortedMergedTags = deduplicateManifestTags(
    [...mergedTagNames.values()]
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .map((entry) => entry.tag),
  );

  const ts = now().toISOString();
  db.prepare(
    `UPDATE ingestion_manifests
     SET title = COALESCE(NULLIF(?, ''), title),
         media_date = COALESCE(NULLIF(?, ''), media_date),
         actresses_json = ?,
         tags_json = ?,
         metadata_source = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    meta.title,
    meta.mediaDate ?? '',
    JSON.stringify(mergedActresses),
    JSON.stringify(sortedMergedTags),
    meta.sourceUrl,
    ts,
    manifest.id,
  );

  // Immediately evaluate performer aliases so review queue items are ready for human review (`Issue #8 B1`).
  evaluateManifestPerformers(db, manifest.id, { now });

  return {
    ok: true,
    provider: meta.provider,
    category: 'ok',
    reason: '',
    sourceUrl: meta.sourceUrl,
    title: meta.title,
    writer: meta.writer || null,
    actresses: meta.actresses,
    mediaDate: meta.mediaDate,
    candidateTags: meta.candidateTags,
    manifest: getIngestionManifestById(db, manifest.id),
  };
}

/**
 * Record human-review decision and confirmed tags (`B4`).
 */
export function reviewIngestionManifest(
  db: DatabaseSync,
  input: ReviewIngestionInput & { readonly manifestId: number },
  now: () => Date = () => new Date(),
  targetOptions?: {
    readonly targetSubdir?: string | undefined;
    readonly autoDateSubdir?: boolean | undefined;
    readonly roots?: readonly MediaRootConfig[] | undefined;
  },
): ReviewIngestionResult {
  const manifest = getIngestionManifestById(db, input.manifestId);
  if (!manifest) {
    return { ok: false, code: 'MANIFEST_NOT_FOUND', message: `Manifest #${input.manifestId} not found.` };
  }
  if (manifest.state === 'indexed') {
    return { ok: true, manifest };
  }

  const tagMap = new Map<string, IngestionManifestTag>();
  const seenTagIds = new Set<number>();
  for (const id of input.tagIds ?? []) {
    const row = db
      .prepare('SELECT id, name, archived_at FROM tags WHERE id = ?')
      .get(id) as { id: number; name: string; archived_at: string | null } | undefined;
    if (!row) {
      return { ok: false, code: 'TAG_NOT_FOUND', message: `Tag #${id} not found.` };
    }
    if (row.archived_at !== null) {
      return { ok: false, code: 'TAG_ARCHIVED', message: `Tag #${id} (${row.name}) is archived.` };
    }
    const tagId = Number(row.id);
    if (seenTagIds.has(tagId)) continue;
    seenTagIds.add(tagId);
    tagMap.set(normalizeLabel(String(row.name)), { tagId, name: String(row.name) });
  }

  for (const rawName of input.newTagNames ?? []) {
    const trimmed = rawName.trim();
    const norm = normalizeLabel(trimmed);
    if (!norm) continue;
    if (tagMap.has(norm)) continue;
    const existing = db
      .prepare('SELECT id, name, archived_at FROM tags WHERE normalized_name = ?')
      .get(norm) as { id: number; name: string; archived_at: string | null } | undefined;
    if (existing && existing.archived_at === null) {
      const tagId = Number(existing.id);
      if (seenTagIds.has(tagId)) continue;
      seenTagIds.add(tagId);
      tagMap.set(normalizeLabel(String(existing.name)), { tagId, name: String(existing.name) });
    } else if (existing && existing.archived_at !== null) {
      return { ok: false, code: 'TAG_ARCHIVED', message: `Tag "${existing.name}" is archived.` };
    } else {
      const viaAlias = resolveExistingTagByNameOrAlias(db, norm);
      if (viaAlias) {
        if (seenTagIds.has(viaAlias.id)) continue;
        seenTagIds.add(viaAlias.id);
        tagMap.set(normalizeLabel(viaAlias.name), { tagId: viaAlias.id, name: viaAlias.name });
      } else {
        tagMap.set(norm, { name: trimmed });
      }
    }
  }

  const nowDate = now();
  const ts = nowDate.toISOString();
  const nextTitle = input.title !== undefined ? input.title.trim() || null : manifest.title;
  const nextCatalog = input.catalogNumber !== undefined ? input.catalogNumber.trim() || null : manifest.catalogNumber;
  const nextDate = input.mediaDate !== undefined ? input.mediaDate.trim() || null : manifest.mediaDate;

  // Issue #69 B3 Freeze Invariant:
  // Once a manifest has entered 'moving' or 'failed', keep both its frozen state (on re-approval)
  // and its frozen target_relative_path so a retry/reconcile across month rollover never recalculates it.
  const pathFrozen = manifest.state === 'moving' || manifest.state === 'failed';
  const nextState: IngestionState = pathFrozen
    ? manifest.state
    : input.decision === 'approved'
      ? 'reviewed'
      : 'planned';

  let nextTargetRelativePath = manifest.targetRelativePath;
  if (
    !pathFrozen &&
    targetOptions &&
    targetOptions.roots &&
    (targetOptions.targetSubdir !== undefined || targetOptions.autoDateSubdir !== undefined)
  ) {
    const computed = computeIngestionTargetRelativePath({
      filename: manifest.filename,
      targetSubdir: targetOptions.targetSubdir ?? '',
      autoDateSubdir: targetOptions.autoDateSubdir ?? true,
      mediaDate: nextDate,
      now: nowDate,
    });
    const check = resolveAllowlistedUncPath(targetOptions.roots, manifest.targetRootId, computed);
    if (!check.ok) {
      return { ok: false, code: 'INVALID_INPUT', message: `${check.code}: ${check.message}` };
    }
    nextTargetRelativePath = computed;
  }

  db.prepare(
    `UPDATE ingestion_manifests
     SET title = ?,
         catalog_number = ?,
         media_date = ?,
         target_relative_path = ?,
         tags_json = ?,
         review_decision = ?,
         state = ?,
         last_error = NULL,
         updated_at = ?
     WHERE id = ?`,
  ).run(
    nextTitle,
    nextCatalog,
    nextDate,
    nextTargetRelativePath,
    JSON.stringify([...tagMap.values()]),
    input.decision,
    nextState,
    ts,
    manifest.id,
  );

  return { ok: true, manifest: getIngestionManifestById(db, manifest.id) };
}

function indexManifestIntoDatabase(
  db: DatabaseSync,
  manifest: IngestionManifest,
  ts: string,
): number {
  const outcome = runMutation<{ mediaId: number }>(
    db,
    'ingestion_commit',
    ({ db: conn }) => {
      const existingMedia = conn
        .prepare(
          `SELECT id FROM media_files
           WHERE (root_id = ? AND relative_path = ?)
              OR (source_key IS NOT NULL AND source_key <> '' AND source_key = ?)
           LIMIT 1`,
        )
        .get(manifest.targetRootId, manifest.targetRelativePath, manifest.sourceId) as
        | { id: number }
        | undefined;

      let mediaId: number;
      if (existingMedia) {
        mediaId = Number(existingMedia.id);
      } else {
        const ext = path.extname(manifest.filename).toLowerCase().replace(/^\./, '');
        const info = conn
          .prepare(
            `INSERT INTO media_files (
              root_id, relative_path, filename, extension, title,
              catalog_number, catalog_source, media_date, date_source,
              added_at, file_size, file_mtime, status, source_key, revision
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'indexed', ?, 1)`,
          )
          .run(
            manifest.targetRootId,
            manifest.targetRelativePath,
            manifest.filename,
            ext,
            manifest.title,
            manifest.catalogNumber,
            manifest.catalogNumber ? 'filename' : null,
            manifest.mediaDate,
            manifest.mediaDate ? 'manual' : null,
            ts,
            manifest.fileSize,
            ts,
            manifest.checksumSha256 || manifest.sourceId,
          );
        mediaId = Number(info.lastInsertRowid);
      }

      const performerPreview = evaluateManifestPerformers(conn, manifest.id, { now: () => new Date(ts) });
      if (performerPreview.pendingReview.length) throw new Error('PERFORMER_REVIEW_REQUIRED: performer tags changed during execution.');
      const normalTagIds: number[] = [];
      for (const tagEntry of manifest.tags) {
        let resolvedTagId = tagEntry.tagId;
        if (!resolvedTagId) {
          const norm = normalizeLabel(tagEntry.name);
          const existing = resolveExistingTagByNameOrAlias(conn, norm);
          if (existing) {
            resolvedTagId = existing.id;
          } else {
            const archived = conn
              .prepare('SELECT id FROM tags WHERE normalized_name = ? LIMIT 1')
              .get(norm) as { id: number } | undefined;
            if (archived) {
              resolvedTagId = Number(archived.id);
            } else {
              const tagInsert = conn
                .prepare(
                  `INSERT INTO tags (name, normalized_name, kind, created_at, updated_at, revision)
                   VALUES (?, ?, 'custom', ?, ?, 1)`,
                )
                .run(tagEntry.name.trim(), norm, ts, ts);
              resolvedTagId = Number(tagInsert.lastInsertRowid);
            }
          }
        }
        const activeTag = conn.prepare('SELECT id FROM tags WHERE id = ? AND archived_at IS NULL').get(resolvedTagId);
        if (!activeTag) throw new Error('TAG_ARCHIVED: reviewed tag is no longer active.');
        normalTagIds.push(resolvedTagId);
        conn
          .prepare(
            `INSERT OR IGNORE INTO media_tags (media_id, tag_id, source, created_at)
             VALUES (?, ?, 'ingestion', ?)`,
          )
          .run(mediaId, resolvedTagId, ts);
      }

      // Apply performer-alias associations (`Issue #8 B4` Option B):
      // - Auto-matched rules -> `source='performer-rule', confidence=1.0` (never overwriting `manual`).
      // - Human-resolved queue items -> `source='manual', confidence=NULL`.
      const autoPerformerTagIds: number[] = [];
      for (const entry of performerPreview.autoMatched) {
        autoPerformerTagIds.push(entry.tagId);
        conn
          .prepare(
            `INSERT OR IGNORE INTO media_tags (media_id, tag_id, source, confidence, created_at)
             VALUES (?, ?, 'performer-rule', 1.0, ?)`,
          )
          .run(mediaId, entry.tagId, ts);
      }
      const humanConfirmedPerformerTagIds: number[] = [];
      for (const entry of performerPreview.humanResolved) {
        humanConfirmedPerformerTagIds.push(entry.tagId);
        conn
          .prepare(
            `INSERT INTO media_tags (media_id, tag_id, source, confidence, created_at)
             VALUES (?, ?, 'manual', NULL, ?)
             ON CONFLICT(media_id, tag_id) DO UPDATE SET
               source = 'manual',
               confidence = NULL`,
          )
          .run(mediaId, entry.tagId, ts);
      }
      conn
        .prepare('UPDATE performer_review_queue SET media_id = ? WHERE manifest_id = ?')
        .run(mediaId, manifest.id);

      conn
        .prepare(
          `UPDATE ingestion_manifests
           SET state = 'indexed', indexed_media_id = ?, last_error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(mediaId, ts, manifest.id);

      return {
        payload: {
          manifestId: manifest.id,
          sourceId: manifest.sourceId,
          targetRelativePath: manifest.targetRelativePath,
          normalTagIds,
          autoPerformerTagIds,
          humanConfirmedPerformerTagIds,
        },
        result: { mediaId },
      };
    },
    { now: () => new Date(ts) },
  );
  if (!outcome.ok) {
    throw new Error(`${outcome.code}: ${outcome.message}`);
  }
  return outcome.mediaId;
}

/**
 * Execute reviewed ingestion manifest (`B4`, `B5`):
 * `reviewed -> moving -> same-share rename (or EXDEV copy+sha256 fallback) -> SQLite index -> indexed`.
 */
export async function commitIngestionManifest(
  db: DatabaseSync,
  options: {
    readonly manifestId: number;
    readonly roots: readonly MediaRootConfig[];
    readonly stagingDir?: string | undefined;
    readonly targetSubdir?: string | undefined;
    readonly autoDateSubdir?: boolean | undefined;
    readonly onPhase?: ((phase: IngestionPhase) => void) | undefined;
    readonly fileOps?: IngestionFileOps | undefined;
    readonly allowCrossDeviceCopy?: boolean | undefined;
    readonly now?: (() => Date) | undefined;
  },
): Promise<CommitIngestionResult> {
  const fileOps = options.fileOps ?? defaultIngestionFileOps;
  const nowFn = options.now ?? (() => new Date());
  const nowDate = nowFn();
  const ts = nowDate.toISOString();

  let manifest = getIngestionManifestById(db, options.manifestId);
  if (!manifest) {
    return {
      ok: false,
      code: 'MANIFEST_NOT_FOUND',
      message: `Manifest #${options.manifestId} not found.`,
    };
  }

  if (manifest.state === 'indexed' && manifest.indexedMediaId !== null) {
    return {
      ok: true,
      idempotentReplay: true,
      mediaId: manifest.indexedMediaId,
      message: `Manifest #${manifest.id} already indexed as media #${manifest.indexedMediaId}.`,
      manifest,
    };
  }

  if (manifest.reviewDecision !== 'approved') {
    return {
      ok: false,
      code: 'REVIEW_REQUIRED',
      message: `Manifest #${manifest.id} requires human approval before moving or indexing.`,
      manifest,
    };
  }

  // Policy 1 (`Issue #8`): block commit while any performer on this manifest awaits human review.
  const performerPreview = evaluateManifestPerformers(db, manifest.id, { now: nowFn });
  if (performerPreview.pendingReview.length > 0) {
    const names = performerPreview.pendingReview.map((p) => p.rawName).join(', ');
    return {
      ok: false,
      code: 'PERFORMER_REVIEW_REQUIRED',
      message: `Manifest #${manifest.id} has ${performerPreview.pendingReview.length} unresolved performer(s): ${names}. Resolve or skip them before moving & indexing.`,
      manifest,
    };
  }

  // Issue #69 B3 Freeze Invariant:
  // Compute & solidify target_relative_path strictly BEFORE transitioning to 'moving' (only when state is 'reviewed').
  // Once in 'moving' or 'failed', preserve the frozen target_relative_path across retries/reconcile.
  let finalTargetRelativePath = manifest.targetRelativePath;
  if (
    manifest.state === 'reviewed' &&
    (options.targetSubdir !== undefined || options.autoDateSubdir !== undefined)
  ) {
    finalTargetRelativePath = computeIngestionTargetRelativePath({
      filename: manifest.filename,
      targetSubdir: options.targetSubdir ?? '',
      autoDateSubdir: options.autoDateSubdir ?? true,
      mediaDate: manifest.mediaDate,
      now: nowDate,
    });
  }

  const resolution = resolveAllowlistedUncPath(
    options.roots,
    manifest.targetRootId,
    finalTargetRelativePath,
  );
  if (!resolution.ok) {
    db.prepare(`UPDATE ingestion_manifests SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?`).run(
      resolution.message,
      ts,
      manifest.id,
    );
    return {
      ok: false,
      code: resolution.code,
      message: resolution.message,
      manifest: getIngestionManifestById(db, manifest.id),
    };
  }

  if (finalTargetRelativePath !== manifest.targetRelativePath) {
    db.prepare(`UPDATE ingestion_manifests SET target_relative_path = ?, updated_at = ? WHERE id = ?`).run(
      finalTargetRelativePath,
      ts,
      manifest.id,
    );
    manifest = getIngestionManifestById(db, manifest.id) ?? manifest;
  }

  const preExisting = db
    .prepare('SELECT id FROM media_files WHERE (root_id = ? AND relative_path = ?) OR source_key = ? LIMIT 1')
    .get(manifest.targetRootId, manifest.targetRelativePath, manifest.sourceId) as { id: number } | undefined;
  if (preExisting) {
    const mediaId = Number(preExisting.id);
    db.prepare(
      `UPDATE ingestion_manifests
       SET state = 'indexed', indexed_media_id = ?, last_error = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(mediaId, ts, manifest.id);
    return {
      ok: true,
      idempotentReplay: true,
      mediaId,
      message: `Already indexed as media #${mediaId}; skipped duplicate move/index.`,
      manifest: getIngestionManifestById(db, manifest.id),
    };
  }

  db.prepare(`UPDATE ingestion_manifests SET state = 'moving', updated_at = ? WHERE id = ?`).run(ts, manifest.id);

  const destPath = resolution.resolvedUncPath;
  let usedCopyFallback = false;
  try {
    validateManifestPaths(manifest, options.stagingDir, true);
    options.onPhase?.('validation');
    const destAlreadyPresent = (await fileOps.exists(destPath)) && (await fileOps.statSize(destPath)) === manifest.fileSize;
    if (!destAlreadyPresent) {
      if (!(await fileOps.exists(manifest.tempPath))) {
        throw new Error(`Staging file missing: ${manifest.tempPath}`);
      }
      if ((await fileOps.exists(destPath))) {
        throw new Error(`Destination exists with different size: ${destPath}`);
      }
      if (await fileOps.statSize(manifest.tempPath) !== manifest.fileSize) throw new Error('Staging file size changed since review.');
      const destDir = destPath.startsWith('\\\\') ? path.win32.dirname(destPath) : path.dirname(destPath);
      await fileOps.ensureDir(destDir);

      try {
        // Attempt rename without claiming how the SMB server implements the operation.
        options.onPhase?.('rename');
        await fileOps.rename(manifest.tempPath, destPath);
      } catch (renameErr) {
        const errno = (renameErr as NodeJS.ErrnoException)?.code;
        if (errno !== 'EXDEV') {
          throw renameErr;
        }
        if (!options.allowCrossDeviceCopy) {
          throw new Error('Cross-device copy is disabled. Keep the source and enable Host allowCrossDeviceCopy only if copying is intended.');
        }
        // Cross-volume fallback: compute SHA-256, copy, verify size + SHA-256, then remove source after DB commit.
        usedCopyFallback = true;
        options.onPhase?.('hash');
        const srcHash = await fileOps.sha256(manifest.tempPath);
        options.onPhase?.('copy');
        await fileOps.copyFile(manifest.tempPath, destPath);
        options.onPhase?.('hash');
        const copiedSize = (await fileOps.statSize(destPath));
        const copiedHash = (await fileOps.sha256(destPath));
        if (copiedSize !== manifest.fileSize || copiedHash !== srcHash) {
          throw new Error(
            `CHECKSUM_MISMATCH: expected ${srcHash} (${manifest.fileSize}B), got ${copiedHash} (${copiedSize}B)`,
          );
        }
        db.prepare(`UPDATE ingestion_manifests SET checksum_sha256 = ? WHERE id = ?`).run(srcHash, manifest.id);
      }

      options.onPhase?.('validation');
      if (!(await fileOps.exists(destPath)) || (await fileOps.statSize(destPath)) !== manifest.fileSize) {
        throw new Error(`Destination verification failed after move: ${destPath}`);
      }
    } else if ((await fileOps.exists(manifest.tempPath))) {
      options.onPhase?.('quick_check');
      await checkExistingTarget(fileOps, manifest.tempPath, destPath, manifest.fileSize);
      usedCopyFallback = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg.startsWith('CHECKSUM_MISMATCH') ? 'CHECKSUM_MISMATCH' : 'MOVE_FAILED';
    db.prepare(`UPDATE ingestion_manifests SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?`).run(
      msg,
      nowFn().toISOString(),
      manifest.id,
    );
    return {
      ok: false,
      code,
      message: msg,
      manifest: getIngestionManifestById(db, manifest.id),
    };
  }

  let mediaId: number;
  try {
    options.onPhase?.('index');
    const freshManifest = getIngestionManifestById(db, manifest.id)!;
    mediaId = indexManifestIntoDatabase(db, freshManifest, nowFn().toISOString());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE ingestion_manifests SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?`).run(
      msg,
      nowFn().toISOString(),
      manifest.id,
    );
    return {
      ok: false,
      code: 'INDEX_FAILED',
      message: msg,
      manifest: getIngestionManifestById(db, manifest.id),
    };
  }

  let warning: string | null = null;
  if (usedCopyFallback) {
    options.onPhase?.('cleanup');
    try {
      validateManifestPaths(manifest, options.stagingDir, true);
      if (await fileOps.exists(manifest.tempPath)) await fileOps.removeFile(manifest.tempPath);
    } catch (rmErr) {
      warning = `copied-not-deleted: indexed media #${mediaId}, but failed to remove temp file (${rmErr instanceof Error ? rmErr.message : String(rmErr)})`;
      db.prepare(`UPDATE ingestion_manifests SET last_error = ?, updated_at = ? WHERE id = ?`).run(
        warning,
        nowFn().toISOString(),
        manifest.id,
      );
    }
  }

  return {
    ok: true,
    idempotentReplay: false,
    mediaId,
    warning,
    message: `Ingested media #${mediaId} to ${manifest.targetRelativePath}.`,
    manifest: getIngestionManifestById(db, manifest.id),
  };
}

/**
 * Reconcile crash points across `moving`, `failed`, and `indexed` manifests (`B5`):
 * - `copied-not-deleted`: indexed & verified destination exists -> delete remaining temp file.
 * - `moved-not-indexed`: verified destination exists without DB row -> finish DB indexing & delete temp.
 * - `indexed-but-missing`: indexed row whose destination file disappeared -> mark media `missing` and record error.
 */
function listPendingReconcileManifestPage(
  db: DatabaseSync,
  afterId: number,
  limit: number,
): IngestionManifest[] {
  const rows = db
    .prepare(
      `SELECT *
       FROM ingestion_manifests
       WHERE state IN ('moving', 'failed', 'indexed')
         AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
    )
    .all(afterId, limit) as Array<Record<string, unknown>>;
  return rows.map(mapManifestRow);
}

export async function reconcileIngestionManifests(
  db: DatabaseSync,
  options: {
    readonly roots: readonly MediaRootConfig[];
    readonly stagingDir?: string | undefined;
    readonly onPhase?: ((phase: IngestionPhase) => void) | undefined;
    readonly fileOps?: IngestionFileOps | undefined;
    readonly now?: (() => Date) | undefined;
    readonly pageSize?: number | undefined;
  },
): Promise<ReconcileIngestionResult> {
  const fileOps = options.fileOps ?? defaultIngestionFileOps;
  const nowFn = options.now ?? (() => new Date());
  const rawPageSize = Number(options.pageSize ?? 200);
  const pageSize = Number.isFinite(rawPageSize)
    ? Math.min(Math.max(Math.trunc(rawPageSize), 1), 500)
    : 200;

  let copiedNotDeletedFixed = 0;
  let movedNotIndexedFixed = 0;
  let indexedButMissingMarked = 0;
  const errors: string[] = [];

  let afterId = 0;
  for (;;) {
    const page = listPendingReconcileManifestPage(db, afterId, pageSize);
    if (page.length === 0) break;

    for (const m of page) {
      afterId = m.id;
      try {
        const resolution = resolveAllowlistedUncPath(options.roots, m.targetRootId, m.targetRelativePath);
        if (!resolution.ok) throw new Error(resolution.message);
        if (m.reviewDecision !== 'approved') throw new Error('REVIEW_REQUIRED: recovery requires human approval.');
        options.onPhase?.('validation');
        const destPath = resolution.resolvedUncPath;
        const destExists = await fileOps.exists(destPath);
        if (m.state === 'indexed' && m.indexedMediaId !== null && !destExists) {
          db.prepare(`UPDATE media_files SET status = 'missing' WHERE id = ?`).run(m.indexedMediaId);
          db.prepare(`UPDATE ingestion_manifests SET last_error = ?, updated_at = ? WHERE id = ?`).run(
            'INDEXED_BUT_MISSING: destination missing.', nowFn().toISOString(), m.id);
          indexedButMissingMarked += 1;
          continue;
        }
        validateManifestPaths(m, options.stagingDir, true);
        if (!destExists || await fileOps.statSize(destPath) !== m.fileSize) {
          throw new Error('Destination missing or size mismatched; recovery remains unresolved.');
        }
        const sourceExists = await fileOps.exists(m.tempPath);
        if (sourceExists) {
          options.onPhase?.('quick_check');
          await checkExistingTarget(fileOps, m.tempPath, destPath, m.fileSize);
        }
        // An absent source after an approved completed move needs only catalog registration.
        const alreadyIndexed = m.state === 'indexed' && m.indexedMediaId !== null;
        if (!alreadyIndexed) {
          options.onPhase?.('index');
          indexManifestIntoDatabase(db, m, nowFn().toISOString());
          movedNotIndexedFixed += 1;
        }
        if (sourceExists) {
          options.onPhase?.('cleanup');
          validateManifestPaths(m, options.stagingDir, true);
          await fileOps.removeFile(m.tempPath);
          db.prepare(`UPDATE ingestion_manifests SET last_error = NULL, updated_at = ? WHERE id = ?`).run(nowFn().toISOString(), m.id);
          if (alreadyIndexed) copiedNotDeletedFixed += 1;
        }
      } catch (err) {
        const message = `Manifest #${m.id}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(message);
        db.prepare('UPDATE ingestion_manifests SET last_error = ?, updated_at = ? WHERE id = ?').run(message, nowFn().toISOString(), m.id);
      }
    }

    if (page.length < pageSize) break;
  }

  return {
    ok: errors.length === 0,
    reconciledCount: copiedNotDeletedFixed + movedNotIndexedFixed + indexedButMissingMarked,
    copiedNotDeletedFixed,
    movedNotIndexedFixed,
    indexedButMissingMarked,
    errors,
    manifests: listIngestionManifests(db),
  };
}

export function listFrozenIngestionManifests(db: DatabaseSync): IngestionManifest[] {
  const rows = db.prepare(`SELECT m.* FROM ingestion_manifests m WHERE EXISTS (
    SELECT 1 FROM ingestion_tasks t WHERE t.status = 'running' AND
    (t.target_key = 'manifest:' || m.id OR (t.op = 'reconcile' AND m.state IN ('moving', 'failed', 'indexed'))))`)
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapManifestRow);
}

/** Locate the task that freezes this reviewed Manifest; unrelated preparation stays available. */
export function findManifestTask(db: DatabaseSync, manifestId: number): IngestionTask | null {
  const row = db.prepare(`SELECT * FROM ingestion_tasks WHERE status = 'running' AND
    (target_key = ? OR (op = 'reconcile' AND EXISTS
      (SELECT 1 FROM ingestion_manifests WHERE id = ? AND state IN ('moving', 'failed', 'indexed'))))
    ORDER BY id DESC LIMIT 1`).get(`manifest:${manifestId}`, manifestId) as Record<string, unknown> | undefined;
  return row ? mapTaskRow(row) : null;
}

export function updateIngestionPhase(db: DatabaseSync, taskId: number, phase: IngestionPhase, now: () => Date): void {
  db.prepare(`UPDATE ingestion_tasks SET phase = ?, phase_started_at = ?
    WHERE id = ? AND status = 'running' AND phase <> ?`).run(phase, now().toISOString(), taskId, phase);
}

function mapTaskRow(row: Record<string, unknown>, now = new Date()): IngestionTask {
  return {
    id: Number(row.id),
    phase: String(row.phase ?? 'validation') as IngestionPhase,
    phaseStartedAt: String(row.phase_started_at ?? row.started_at),
    waitingWarning: row.status === 'running' && now.getTime() - Date.parse(String(row.phase_started_at ?? row.started_at)) >= 30_000,
    targetKey: String(row.target_key),
    op: String(row.op) as IngestionTaskOp,
    status: String(row.status) as IngestionTaskStatus,
    message: String(row.message ?? ''),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at !== null && row.finished_at !== undefined ? String(row.finished_at) : null,
  };
}

export function listIngestionTasks(db: DatabaseSync, limit = 20, now: () => Date = () => new Date()): IngestionTask[] {
  const safeLimit = Math.min(Math.max(Number(limit), 1), 100);
  const rows = db
    .prepare('SELECT * FROM ingestion_tasks ORDER BY id DESC LIMIT ?')
    .all(safeLimit) as Array<Record<string, unknown>>;
  const tasks = rows.map(row => mapTaskRow(row, now()));
  // Active work must remain discoverable even after many newer preparation tasks.
  const active = db.prepare("SELECT * FROM ingestion_tasks WHERE status = 'running' ORDER BY id DESC").all() as Array<Record<string, unknown>>;
  return [...active.map(row => mapTaskRow(row, now())), ...tasks.filter(t => t.status !== 'running')];
}

export function markInterruptedIngestionTasks(
  db: DatabaseSync,
  now: () => Date = () => new Date(),
  liveTaskIds: readonly number[] = [],
): number {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ingestion_tasks'")
    .get();
  if (!exists) return 0;
  const ts = now().toISOString();
  const info = db
    .prepare(
      `UPDATE ingestion_tasks
       SET status = 'interrupted',
           message = CASE WHEN message = '' THEN 'Host restarted while task was running; run Reconcile.' ELSE message || ' (interrupted by Host restart)' END,
           finished_at = ?
       WHERE status = 'running'${liveTaskIds.length ? ` AND id NOT IN (${liveTaskIds.map(() => '?').join(',')})` : ''}`,
    )
    .run(ts, ...liveTaskIds);
  return Number(info.changes);
}

export function startIngestionTask(
  db: DatabaseSync,
  targetKey: string,
  op: IngestionTaskOp,
  message: string,
  now: () => Date = () => new Date(),
): { readonly acquired: true; readonly taskId: number } | { readonly acquired: false; readonly existing: IngestionTask } {
  const ts = now().toISOString();
  db.exec('BEGIN IMMEDIATE;');
  try {
    const running = db
      .prepare(`SELECT * FROM ingestion_tasks WHERE status = 'running' AND
        (target_key = ? OR (? IN ('commit', 'reconcile') AND op IN ('commit', 'reconcile'))
         OR (? = 'reconcile' AND op = 'fetch' AND target_key IN
             (SELECT 'manifest:' || id FROM ingestion_manifests WHERE state IN ('moving', 'failed', 'indexed')))
         OR (? = 'fetch' AND op = 'reconcile' AND ? IN
             (SELECT 'manifest:' || id FROM ingestion_manifests WHERE state IN ('moving', 'failed', 'indexed'))))
        ORDER BY id DESC LIMIT 1`)
      .get(targetKey, op, op, op, targetKey) as Record<string, unknown> | undefined;
    if (running) {
      db.exec('COMMIT;');
      return { acquired: false, existing: mapTaskRow(running, now()) };
    }
    const info = db
      .prepare(
        `INSERT INTO ingestion_tasks (target_key, op, status, message, started_at, finished_at, phase_started_at)
         VALUES (?, ?, 'running', ?, ?, NULL, ?)`,
      )
      .run(targetKey, op, message, ts, ts);
    db.exec('COMMIT;');
    return { acquired: true, taskId: Number(info.lastInsertRowid) };
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Ignore rollback error
    }
    throw err;
  }
}

export function finishIngestionTask(
  db: DatabaseSync,
  taskId: number,
  status: 'succeeded' | 'failed',
  message: string,
  now: () => Date = () => new Date(),
): void {
  db.prepare(
    `UPDATE ingestion_tasks SET status = ?, message = ?, finished_at = ? WHERE id = ?`,
  ).run(status, message, now().toISOString(), taskId);
}

function isWindowsStylePath(p: string): boolean {
  return p.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(p);
}

function normalizePathForCompare(p: string, winStyle: boolean): string {
  const resolved = winStyle ? path.win32.resolve(p) : path.resolve(p);
  return winStyle ? resolved.toLowerCase() : resolved;
}

async function verifyLocalFilesystemContainment(
  stagingDir: string,
  targetPath: string,
  expectFile: boolean,
): Promise<{ readonly ok: true; readonly fileSize?: number } | { readonly ok: false; readonly code: 'FILE_NOT_FOUND' | 'PATH_TRAVERSAL_REJECTED'; readonly message: string }> {
  let stagingReal: string;
  try {
    const stagingStat = await fsp.lstat(stagingDir);
    if (stagingStat.isSymbolicLink() || !stagingStat.isDirectory()) {
      return { ok: false, code: 'PATH_TRAVERSAL_REJECTED', message: 'Staging directory must be a real directory, not a symlink.' };
    }
    stagingReal = await fsp.realpath(stagingDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, code: 'FILE_NOT_FOUND', message: `Staging directory not found: ${stagingDir}` };
    }
    return { ok: false, code: 'PATH_TRAVERSAL_REJECTED', message: `Unable to validate staging directory: ${err instanceof Error ? err.message : String(err)}` };
  }

  const rel = path.relative(path.resolve(stagingDir), path.resolve(targetPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, code: 'PATH_TRAVERSAL_REJECTED', message: `Target escaped stagingDir: ${targetPath}` };
  }

  // Walk every path segment from stagingDir to targetPath with lstat to reject symlinks/junctions.
  const segments = rel.split(path.sep).filter(Boolean);
  let cursor = path.resolve(stagingDir);
  let leafSize: number | undefined;
  for (let i = 0; i < segments.length; i++) {
    cursor = path.join(cursor, segments[i]!);
    let st: fs.Stats;
    try {
      st = await fsp.lstat(cursor);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { ok: false, code: 'FILE_NOT_FOUND', message: `Staging file not found: ${targetPath}` };
      }
      return { ok: false, code: 'PATH_TRAVERSAL_REJECTED', message: `Cannot inspect path segment: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (st.isSymbolicLink()) {
      return { ok: false, code: 'PATH_TRAVERSAL_REJECTED', message: `Symlink/reparse point rejected inside stagingDir: ${segments[i]}` };
    }
    const isLast = i === segments.length - 1;
    if (isLast && expectFile) {
      if (!st.isFile()) {
        return { ok: false, code: 'PATH_TRAVERSAL_REJECTED', message: `Target must be a regular video file: ${targetPath}` };
      }
      leafSize = st.size;
    }
    if ((!isLast || !expectFile) && !st.isDirectory()) {
      return { ok: false, code: 'PATH_TRAVERSAL_REJECTED', message: `Expected directory segment inside stagingDir: ${segments[i]}` };
    }
  }

  const targetReal = await fsp.realpath(targetPath);
  const realRel = path.relative(stagingReal, targetReal);
  if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) {
    return { ok: false, code: 'PATH_TRAVERSAL_REJECTED', message: `Resolved realpath escaped stagingDir: ${targetPath}` };
  }
  return leafSize !== undefined ? { ok: true, fileSize: leafSize } : { ok: true };
}

/**
 * Move `srcPath` to `destPath` without overwriting any existing entry (including dangling symlinks).
 * On real filesystems, prefers atomic `link` + `unlink` (which fails with EEXIST on any collision),
 * falling back to `lstat(ENOENT)` + `rename` only when the filesystem does not support hardlinks.
 */
async function moveFileNoOverwrite(
  srcPath: string,
  destPath: string,
  fileOps: IngestionFileOps,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly collision: boolean; readonly error: unknown }> {
  if (fileOps !== defaultIngestionFileOps) {
    if (await fileOps.exists(destPath)) {
      return { ok: false, collision: true, error: new Error(`Destination already exists: ${destPath}`) };
    }
    try {
      await fileOps.rename(srcPath, destPath);
      return { ok: true };
    } catch (error) {
      return { ok: false, collision: false, error };
    }
  }

  try {
    await fsp.link(srcPath, destPath);
    try {
      await fsp.unlink(srcPath);
      return { ok: true };
    } catch (unlinkErr) {
      await fsp.unlink(destPath).catch(() => undefined);
      return { ok: false, collision: false, error: unlinkErr };
    }
  } catch (linkErr) {
    const code = (linkErr as NodeJS.ErrnoException)?.code ?? '';
    if (code === 'EEXIST') {
      return { ok: false, collision: true, error: linkErr };
    }
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS' && code !== 'EXDEV') {
      return { ok: false, collision: false, error: linkErr };
    }
    try {
      await fsp.lstat(destPath);
      return { ok: false, collision: true, error: new Error(`Destination already exists: ${destPath}`) };
    } catch (lstatErr) {
      if ((lstatErr as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        return { ok: false, collision: false, error: lstatErr };
      }
    }
    try {
      await fsp.rename(srcPath, destPath);
      return { ok: true };
    } catch (renameErr) {
      return { ok: false, collision: false, error: renameErr };
    }
  }
}

/**
 * Safely soft-delete an unindexed video file inside `stagingDir` into `<stagingDir>/.trash` (Issue #26).
 * Enforces selector agreement, filesystem containment, size confirmation binding, collision-proof
 * same-share `rename`, cascade removal of unindexed manifests, and `mutation_log` audit.
 */
export async function softDeleteStagingFile(
  db: DatabaseSync,
  options: DeleteStagingFileInput & {
    readonly stagingDir: string;
    readonly fileOps?: IngestionFileOps | undefined;
    readonly now?: (() => Date) | undefined;
  },
): Promise<DeleteStagingFileResult> {
  const fileOps = options.fileOps ?? defaultIngestionFileOps;
  const nowFn = options.now ?? (() => new Date());
  const stagingDir = options.stagingDir.trim();
  if (!stagingDir) {
    return { ok: false, code: 'INVALID_UNC_ROOT', message: 'Staging directory is not configured.' };
  }
  if (options.manifestId === undefined && options.relativePath === undefined) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Either manifestId or relativePath is required.' };
  }
  if (!Number.isInteger(options.expectedFileSize) || options.expectedFileSize < 0) {
    return { ok: false, code: 'INVALID_INPUT', message: 'expectedFileSize must be a non-negative integer.' };
  }

  const winStyle = isWindowsStylePath(stagingDir);
  let manifestFromId: IngestionManifest | null = null;
  let pathFromManifest: string | null = null;
  if (options.manifestId !== undefined) {
    if (!Number.isInteger(options.manifestId) || options.manifestId <= 0) {
      return { ok: false, code: 'INVALID_INPUT', message: 'manifestId must be a positive integer.' };
    }
    manifestFromId = getIngestionManifestById(db, options.manifestId);
    if (!manifestFromId) {
      return { ok: false, code: 'MANIFEST_NOT_FOUND', message: `Manifest #${options.manifestId} not found.` };
    }
    if (manifestFromId.state === 'indexed' || manifestFromId.indexedMediaId !== null) {
      return { ok: false, code: 'ALREADY_INDEXED', message: `Manifest #${manifestFromId.id} is already indexed and cannot be deleted from staging.` };
    }
    try {
      validateStagingPath(stagingDir, manifestFromId.tempPath);
    } catch (err) {
      return { ok: false, code: 'PATH_TRAVERSAL_REJECTED', message: err instanceof Error ? err.message : String(err) };
    }
    pathFromManifest = manifestFromId.tempPath;
  }

  let pathFromRelative: string | null = null;
  if (options.relativePath !== undefined) {
    try {
      pathFromRelative = resolveStagingRelativePath(stagingDir, options.relativePath);
    } catch (err) {
      return { ok: false, code: 'PATH_TRAVERSAL_REJECTED', message: err instanceof Error ? err.message : String(err) };
    }
  }

  if (pathFromManifest !== null && pathFromRelative !== null) {
    if (normalizePathForCompare(pathFromManifest, winStyle) !== normalizePathForCompare(pathFromRelative, winStyle)) {
      return {
        ok: false,
        code: 'PATH_MISMATCH',
        message: 'manifestId and relativePath refer to different staging files.',
      };
    }
  }

  const sourcePath = pathFromManifest ?? pathFromRelative!;
  const relFromStaging = (winStyle
    ? path.win32.relative(path.win32.resolve(stagingDir), path.win32.resolve(sourcePath))
    : path.relative(path.resolve(stagingDir), path.resolve(sourcePath))
  ).replace(/\\/g, '/');
  const relSegments = relFromStaging.split('/').filter(Boolean);
  if (relSegments.length === 0 || relSegments.some((seg) => seg.startsWith('.'))) {
    return {
      ok: false,
      code: 'PATH_TRAVERSAL_REJECTED',
      message: `Refused to delete hidden or .trash path inside stagingDir: ${relFromStaging}`,
    };
  }

  // Match all manifests for this exact filesystem path (never bare basename).
  const normalizedSource = normalizePathForCompare(sourcePath, winStyle);
  const allManifestRows = db.prepare('SELECT * FROM ingestion_manifests').all() as Array<Record<string, unknown>>;
  const matchingManifests = allManifestRows
    .map(mapManifestRow)
    .filter((m) => normalizePathForCompare(m.tempPath, winStyle) === normalizedSource);

  for (const m of matchingManifests) {
    if (m.state === 'indexed' || m.indexedMediaId !== null) {
      return { ok: false, code: 'ALREADY_INDEXED', message: `Manifest #${m.id} is already indexed and cannot be deleted.` };
    }
    const activeTask = findManifestTask(db, m.id);
    if (activeTask) {
      return { ok: false, code: 'IN_PROGRESS', message: `Task #${activeTask.id} currently freezes this staging file.` };
    }
  }

  // Check indexed media_files independently of manifest state.
  const mediaRows = db
    .prepare(
      `SELECT mf.id, mf.relative_path, mr.canonical_unc_root
       FROM media_files mf
       JOIN media_roots mr ON mr.id = mf.root_id`,
    )
    .all() as Array<{ id: number; relative_path: string; canonical_unc_root: string }>;
  for (const row of mediaRows) {
    const mediaAbs = isWindowsStylePath(row.canonical_unc_root)
      ? path.win32.resolve(row.canonical_unc_root, ...row.relative_path.replace(/\\/g, '/').split('/').filter(Boolean))
      : path.resolve(row.canonical_unc_root, ...row.relative_path.replace(/\\/g, '/').split('/').filter(Boolean));
    if (normalizePathForCompare(mediaAbs, winStyle) === normalizedSource) {
      return { ok: false, code: 'ALREADY_INDEXED', message: `File matches indexed library media #${row.id} and cannot be deleted from staging.` };
    }
  }

  // Prepare and validate .trash FIRST so source containment and size checks run immediately before the move.
  const trashDir = winStyle ? path.win32.join(stagingDir, '.trash') : path.join(stagingDir, '.trash');
  try {
    await fileOps.ensureDir(trashDir);
    if (fileOps === defaultIngestionFileOps) {
      const trashCheck = await verifyLocalFilesystemContainment(stagingDir, trashDir, false);
      if (!trashCheck.ok) {
        return { ok: false, code: trashCheck.code, message: trashCheck.message };
      }
    }
  } catch (err) {
    return {
      ok: false,
      code: 'TRASH_MOVE_FAILED',
      message: `Failed to prepare .trash directory: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Enforce real filesystem containment + exact size immediately before the move (minimizing TOCTOU window).
  let actualSize: number;
  if (fileOps === defaultIngestionFileOps) {
    const containment = await verifyLocalFilesystemContainment(stagingDir, sourcePath, true);
    if (!containment.ok) {
      return { ok: false, code: containment.code, message: containment.message };
    }
    actualSize = containment.fileSize ?? (await fileOps.statSize(sourcePath));
  } else {
    if (!(await fileOps.exists(sourcePath))) {
      return { ok: false, code: 'FILE_NOT_FOUND', message: `Staging file not found: ${relFromStaging}` };
    }
    actualSize = await fileOps.statSize(sourcePath);
  }

  if (actualSize !== options.expectedFileSize) {
    return {
      ok: false,
      code: 'FILE_CHANGED',
      message: `Staging file size changed since confirmation (expected ${options.expectedFileSize} bytes, found ${actualSize} bytes). Refresh and confirm again.`,
    };
  }

  const basename = winStyle ? path.win32.basename(sourcePath) : path.basename(sourcePath);
  const ext = path.extname(basename);
  const stem = basename.slice(0, basename.length - ext.length);
  const stamp = nowFn().toISOString().replace(/[:.]/g, '-');

  let trashPath = '';
  let trashRelativePath = '';
  let moved = false;
  let lastMoveError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const trashName = `${stem}.${stamp}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    trashPath = winStyle ? path.win32.join(trashDir, trashName) : path.join(trashDir, trashName);
    trashRelativePath = `.trash/${trashName}`;
    const moveRes = await moveFileNoOverwrite(sourcePath, trashPath, fileOps);
    if (moveRes.ok) {
      moved = true;
      break;
    }
    lastMoveError = moveRes.error;
    if (!moveRes.collision) {
      break;
    }
  }
  if (!moved) {
    return {
      ok: false,
      code: 'TRASH_MOVE_FAILED',
      message: `Failed to move staging file to .trash: ${lastMoveError instanceof Error ? lastMoveError.message : String(lastMoveError)}`,
    };
  }

  const manifestIds = matchingManifests.map((m) => m.id);
  const auditOutcome = runMutation(
    db,
    'staging.soft_delete',
    (env) => {
      for (const id of manifestIds) {
        env.db.prepare('DELETE FROM ingestion_manifests WHERE id = ?').run(id);
      }
      return {
        payload: {
          filename: basename,
          relativePath: relFromStaging,
          trashRelativePath,
          fileSize: actualSize,
          manifestIds,
        },
        result: { deletedManifestIds: manifestIds, trashRelativePath },
      };
    },
    { now: nowFn },
  );

  if (!auditOutcome.ok) {
    // Roll back the filesystem move so a DB failure never leaves an unaudited orphan in .trash.
    const rollback = await moveFileNoOverwrite(trashPath, sourcePath, fileOps);
    if (rollback.ok) {
      return {
        ok: false,
        code: 'TRASH_MOVE_FAILED',
        message: `DB cleanup/audit failed; rolled back file to original staging path: ${auditOutcome.message}`,
      };
    }
    return {
      ok: false,
      code: 'TRASH_MOVE_FAILED',
      message: `File moved to ${trashRelativePath}, DB cleanup/audit failed (${auditOutcome.message}), and rollback failed (${rollback.error instanceof Error ? rollback.error.message : String(rollback.error)}).`,
      trashRelativePath,
      fileSize: actualSize,
    };
  }

  return {
    ok: true,
    message: `Moved '${basename}' to ${trashRelativePath}.`,
    deletedManifestId: manifestFromId?.id ?? manifestIds[0] ?? null,
    trashRelativePath,
    fileSize: actualSize,
  };
}
