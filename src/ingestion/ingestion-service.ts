import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { extractCatalogNumber, extractIsoDate } from '../inventory/tagstudio-inventory.ts';
import { normalizeLabel, runMutation } from '../mutations/transaction.ts';
import type {
  CommitIngestionResult,
  FetchedMetadataCandidate,
  IngestionManifest,
  IngestionManifestTag,
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
import { type MetadataFetcher, parseFc2Code } from './metadata-fetcher.ts';

const VIDEO_EXTENSIONS = new Set(['.avi', '.mkv', '.mp4', '.mov', '.wmv', '.m4v', '.ts']);

export interface IngestionFileOps {
  exists(filePath: string): boolean;
  statSize(filePath: string): number;
  sha256(filePath: string): string;
  ensureDir(dirPath: string): void;
  rename(srcPath: string, destPath: string): void;
  copyFile(srcPath: string, destPath: string): void;
  removeFile(filePath: string): void;
}

export const defaultIngestionFileOps: IngestionFileOps = {
  exists: (p) => fs.existsSync(p),
  statSize: (p) => fs.statSync(p).size,
  sha256: (p) => {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.allocUnsafe(65536);
      let bytesRead = 0;
      while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        hash.update(buf.subarray(0, bytesRead));
      }
      return hash.digest('hex');
    } finally {
      fs.closeSync(fd);
    }
  },
  ensureDir: (d) => fs.mkdirSync(d, { recursive: true }),
  rename: (src, dest) => fs.renameSync(src, dest),
  copyFile: (src, dest) => fs.copyFileSync(src, dest),
  removeFile: (p) => fs.rmSync(p, { force: true }),
};

function mapManifestRow(row: Record<string, unknown>): IngestionManifest {
  let tags: IngestionManifestTag[] = [];
  try {
    const parsed = JSON.parse(String(row.tags_json ?? '[]'));
    if (Array.isArray(parsed)) {
      tags = parsed
        .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === 'object' && typeof (t as { name?: unknown }).name === 'string'))
        .map((t) => ({
          tagId: typeof t.tagId === 'number' ? Number(t.tagId) : undefined,
          name: String(t.name),
        }));
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
      await walkStagingVideosAsync(fullPath, baseDir, targetSubdir, acc);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(ext)) continue;
      const stat = await fsp.stat(fullPath);
      const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      const targetRel = targetSubdir ? `${targetSubdir}/${entry.name}` : entry.name;
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
  readonly roots: readonly MediaRootConfig[];
  readonly timeoutMs?: number | undefined;
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
    await withTimeout(walkStagingVideosAsync(stagingDir, stagingDir, cleanSubdir, rawFiles), timeoutMs, `readdir(${stagingDir})`);

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
    readonly roots: readonly MediaRootConfig[];
    readonly timeoutMs?: number | undefined;
  },
): Promise<ScanStagingResult> {
  const started = Date.now();
  const cleanSubdir = normalizeTargetSubdir(options.targetSubdir);
  const manifests = listIngestionManifests(db);
  const preview = await previewStagingPlan(options);

  if (!preview.ok) {
    return {
      ok: false,
      stagingDir: options.stagingDir,
      targetRootId: options.targetRootId,
      targetSubdir: cleanSubdir,
      elapsedMs: Date.now() - started,
      files: [],
      manifests,
      error: preview.error,
    };
  }

  const byTempPath = new Map<string, IngestionManifest>();
  for (const m of manifests) {
    byTempPath.set(m.tempPath.toLowerCase(), m);
  }

  const files: StagingFileItem[] = preview.files.map((f) => {
    const existing = byTempPath.get(f.tempPath.toLowerCase());
    return {
      ...f,
      manifestId: existing?.id ?? null,
      state: existing?.state ?? null,
      reviewDecision: existing?.reviewDecision ?? null,
    };
  });

  return {
    ok: true,
    stagingDir: options.stagingDir,
    targetRootId: options.targetRootId,
    targetSubdir: cleanSubdir,
    elapsedMs: Date.now() - started,
    files,
    manifests,
  };
}

/**
 * Lazily persist an `ingestion_manifests` row only when the user actually acts on a staged file
 * (fetch metadata or review/approve), using lightweight path + size identity.
 */
export function ensureManifestForStagingFile(
  db: DatabaseSync,
  options: {
    readonly tempPath: string;
    readonly targetRootId: string;
    readonly targetSubdir: string;
    readonly roots: readonly MediaRootConfig[];
    readonly fileOps?: IngestionFileOps | undefined;
    readonly now?: (() => Date) | undefined;
  },
): IngestionManifest {
  const fileOps = options.fileOps ?? defaultIngestionFileOps;
  const now = (options.now ?? (() => new Date()))().toISOString();
  const tempPath = options.tempPath;
  const filename = path.win32.basename(tempPath);
  const cleanSubdir = normalizeTargetSubdir(options.targetSubdir);
  const targetRel = cleanSubdir ? `${cleanSubdir}/${filename}` : filename;

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

  if (!fileOps.exists(tempPath)) {
    throw new Error(`Staging file not found: ${tempPath}`);
  }
  const fileSize = fileOps.statSize(tempPath);
  const sourceId = `staging:${targetRel.toLowerCase()}:${fileSize}`;

  const existing = db
    .prepare('SELECT * FROM ingestion_manifests WHERE source_id = ? OR LOWER(temp_path) = LOWER(?) LIMIT 1')
    .get(sourceId, tempPath) as Record<string, unknown> | undefined;
  if (existing) {
    return mapManifestRow(existing);
  }

  const ext = path.extname(filename);
  const fc2 = parseFc2Code(path.basename(filename, ext));
  const catalogNumber = fc2?.code ?? extractCatalogNumber(filename);
  const inferredDate = extractIsoDate(filename);

  const info = db
    .prepare(
      `INSERT INTO ingestion_manifests (
        source_id, temp_path, target_root_id, target_relative_path, filename,
        title, catalog_number, media_date, tags_json, metadata_source,
        checksum_sha256, file_size, state, review_decision, last_error,
        indexed_media_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, '[]', NULL, '', ?, 'planned', 'pending', NULL, NULL, ?, ?)`,
    )
    .run(sourceId, tempPath, options.targetRootId, targetRel, filename, catalogNumber, inferredDate, fileSize, now, now);

  return getIngestionManifestById(db, Number(info.lastInsertRowid))!;
}

/**
 * Fetch candidate metadata & tags from `FC2CMADB` / `FC2PPVDB` for a staged file or manifest (`B3`).
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

  const parsed = parseFc2Code(manifest.catalogNumber ?? manifest.filename);
  if (!parsed) {
    return {
      ok: false,
      provider: null,
      category: 'no_code',
      reason: 'No FC2-PPV code found in filename or catalogNumber.',
      sourceUrl: '',
      title: manifest.title,
      writer: null,
      actresses: [],
      mediaDate: manifest.mediaDate,
      candidateTags: [],
      manifest,
    };
  }

  const lookup = await fetcher.lookup(parsed.videoId);
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
  const mergedTagNames = new Map<string, IngestionManifestTag>();
  for (const t of manifest.tags) {
    mergedTagNames.set(normalizeLabel(t.name), t);
  }
  for (const name of meta.candidateTags) {
    // Route fetched performers through `performer_aliases` + `performer_review_queue` instead of auto-creating normal tags.
    if (actressNormSet.has(normalizePerformerName(name))) continue;
    const norm = normalizeLabel(name);
    if (!norm || mergedTagNames.has(norm)) continue;
    const existingTag = resolveExistingTagByNameOrAlias(db, norm);
    mergedTagNames.set(
      norm,
      existingTag ? { tagId: existingTag.id, name: existingTag.name } : { name },
    );
  }

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
    JSON.stringify([...mergedTagNames.values()]),
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
): ReviewIngestionResult {
  const manifest = getIngestionManifestById(db, input.manifestId);
  if (!manifest) {
    return { ok: false, code: 'MANIFEST_NOT_FOUND', message: `Manifest #${input.manifestId} not found.` };
  }
  if (manifest.state === 'indexed') {
    return { ok: true, manifest };
  }

  const tagMap = new Map<string, IngestionManifestTag>();
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
    tagMap.set(normalizeLabel(String(row.name)), { tagId: Number(row.id), name: String(row.name) });
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
      tagMap.set(norm, { tagId: Number(existing.id), name: String(existing.name) });
    } else if (!existing) {
      tagMap.set(norm, { name: trimmed });
    } else {
      return { ok: false, code: 'TAG_ARCHIVED', message: `Tag "${existing.name}" is archived.` };
    }
  }

  const ts = now().toISOString();
  const nextTitle = input.title !== undefined ? input.title.trim() || null : manifest.title;
  const nextCatalog = input.catalogNumber !== undefined ? input.catalogNumber.trim() || null : manifest.catalogNumber;
  const nextDate = input.mediaDate !== undefined ? input.mediaDate.trim() || null : manifest.mediaDate;
  const nextState: IngestionState = input.decision === 'approved' ? 'reviewed' : 'planned';

  db.prepare(
    `UPDATE ingestion_manifests
     SET title = ?,
         catalog_number = ?,
         media_date = ?,
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
      const performerPreview = evaluateManifestPerformers(conn, manifest.id, { now: () => new Date(ts) });
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
export function commitIngestionManifest(
  db: DatabaseSync,
  options: {
    readonly manifestId: number;
    readonly roots: readonly MediaRootConfig[];
    readonly fileOps?: IngestionFileOps | undefined;
    readonly now?: (() => Date) | undefined;
  },
): CommitIngestionResult {
  const fileOps = options.fileOps ?? defaultIngestionFileOps;
  const nowFn = options.now ?? (() => new Date());
  const ts = nowFn().toISOString();

  const manifest = getIngestionManifestById(db, options.manifestId);
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

  const resolution = resolveAllowlistedUncPath(
    options.roots,
    manifest.targetRootId,
    manifest.targetRelativePath,
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
    const destAlreadyPresent = fileOps.exists(destPath) && fileOps.statSize(destPath) === manifest.fileSize;
    if (!destAlreadyPresent) {
      if (!fileOps.exists(manifest.tempPath)) {
        throw new Error(`Staging file missing: ${manifest.tempPath}`);
      }
      if (fileOps.exists(destPath)) {
        throw new Error(`Destination exists with different size: ${destPath}`);
      }
      const destDir = destPath.startsWith('\\\\') ? path.win32.dirname(destPath) : path.dirname(destPath);
      fileOps.ensureDir(destDir);

      try {
        // Prefer same-NAS server-side rename (instantaneous, zero desktop NIC round-trip).
        fileOps.rename(manifest.tempPath, destPath);
      } catch (renameErr) {
        const errno = (renameErr as NodeJS.ErrnoException)?.code;
        if (errno !== 'EXDEV') {
          throw renameErr;
        }
        // Cross-volume fallback: compute SHA-256, copy, verify size + SHA-256, then remove source after DB commit.
        usedCopyFallback = true;
        const srcHash = manifest.checksumSha256 || fileOps.sha256(manifest.tempPath);
        fileOps.copyFile(manifest.tempPath, destPath);
        const copiedSize = fileOps.statSize(destPath);
        const copiedHash = fileOps.sha256(destPath);
        if (copiedSize !== manifest.fileSize || copiedHash !== srcHash) {
          throw new Error(
            `CHECKSUM_MISMATCH: expected ${srcHash} (${manifest.fileSize}B), got ${copiedHash} (${copiedSize}B)`,
          );
        }
        db.prepare(`UPDATE ingestion_manifests SET checksum_sha256 = ? WHERE id = ?`).run(srcHash, manifest.id);
      }

      if (!fileOps.exists(destPath) || fileOps.statSize(destPath) !== manifest.fileSize) {
        throw new Error(`Destination verification failed after move: ${destPath}`);
      }
    } else if (fileOps.exists(manifest.tempPath)) {
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
  if (usedCopyFallback && fileOps.exists(manifest.tempPath)) {
    try {
      fileOps.removeFile(manifest.tempPath);
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
export function reconcileIngestionManifests(
  db: DatabaseSync,
  options: {
    readonly roots: readonly MediaRootConfig[];
    readonly fileOps?: IngestionFileOps | undefined;
    readonly now?: (() => Date) | undefined;
  },
): ReconcileIngestionResult {
  const fileOps = options.fileOps ?? defaultIngestionFileOps;
  const nowFn = options.now ?? (() => new Date());
  const candidates = listIngestionManifests(db, { limit: 500 }).filter(
    (m) => m.state === 'moving' || m.state === 'failed' || m.state === 'indexed',
  );

  let copiedNotDeletedFixed = 0;
  let movedNotIndexedFixed = 0;
  let indexedButMissingMarked = 0;
  const errors: string[] = [];

  for (const m of candidates) {
    const resolution = resolveAllowlistedUncPath(options.roots, m.targetRootId, m.targetRelativePath);
    if (!resolution.ok) {
      errors.push(`Manifest #${m.id}: ${resolution.message}`);
      continue;
    }
    const destPath = resolution.resolvedUncPath;
    const destExists = fileOps.exists(destPath);
    const destValid =
      destExists &&
      fileOps.statSize(destPath) === m.fileSize &&
      (!m.checksumSha256 || fileOps.sha256(destPath) === m.checksumSha256);

    if (m.state === 'indexed' && m.indexedMediaId !== null) {
      if (!destExists) {
        db.prepare(`UPDATE media_files SET status = 'missing' WHERE id = ?`).run(m.indexedMediaId);
        db.prepare(`UPDATE ingestion_manifests SET last_error = ?, updated_at = ? WHERE id = ?`).run(
          `INDEXED_BUT_MISSING: destination missing at ${m.targetRelativePath}`,
          nowFn().toISOString(),
          m.id,
        );
        indexedButMissingMarked += 1;
      } else if (destValid && fileOps.exists(m.tempPath)) {
        try {
          fileOps.removeFile(m.tempPath);
          db.prepare(`UPDATE ingestion_manifests SET last_error = NULL, updated_at = ? WHERE id = ?`).run(
            nowFn().toISOString(),
            m.id,
          );
          copiedNotDeletedFixed += 1;
        } catch (err) {
          errors.push(`Manifest #${m.id} cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      continue;
    }

    if ((m.state === 'moving' || m.state === 'failed') && m.reviewDecision === 'approved' && destValid) {
      try {
        indexManifestIntoDatabase(db, m, nowFn().toISOString());
        if (fileOps.exists(m.tempPath)) {
          fileOps.removeFile(m.tempPath);
        }
        movedNotIndexedFixed += 1;
      } catch (err) {
        errors.push(`Manifest #${m.id} index recovery failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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

function mapTaskRow(row: Record<string, unknown>): IngestionTask {
  return {
    id: Number(row.id),
    targetKey: String(row.target_key),
    op: String(row.op) as IngestionTaskOp,
    status: String(row.status) as IngestionTaskStatus,
    message: String(row.message ?? ''),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at !== null && row.finished_at !== undefined ? String(row.finished_at) : null,
  };
}

export function listIngestionTasks(db: DatabaseSync, limit = 20): IngestionTask[] {
  const safeLimit = Math.min(Math.max(Number(limit), 1), 100);
  const rows = db
    .prepare('SELECT * FROM ingestion_tasks ORDER BY id DESC LIMIT ?')
    .all(safeLimit) as Array<Record<string, unknown>>;
  return rows.map(mapTaskRow);
}

export function markInterruptedIngestionTasks(
  db: DatabaseSync,
  now: () => Date = () => new Date(),
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
       WHERE status = 'running'`,
    )
    .run(ts);
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
      .prepare("SELECT * FROM ingestion_tasks WHERE target_key = ? AND status = 'running' ORDER BY id DESC LIMIT 1")
      .get(targetKey) as Record<string, unknown> | undefined;
    if (running) {
      db.exec('COMMIT;');
      return { acquired: false, existing: mapTaskRow(running) };
    }
    const info = db
      .prepare(
        `INSERT INTO ingestion_tasks (target_key, op, status, message, started_at, finished_at)
         VALUES (?, ?, 'running', ?, ?, NULL)`,
      )
      .run(targetKey, op, message, ts);
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
