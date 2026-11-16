import crypto from 'node:crypto';
import fs from 'node:fs';
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
  MediaRootConfig,
  ReconcileIngestionResult,
  ReviewIngestionInput,
  ReviewIngestionResult,
  ScanStagingResult,
  StagingFileItem,
} from '../types.ts';
import { resolveAllowlistedUncPath } from '../unc-path.ts';
import { type MetadataFetcher, parseFc2Code } from './metadata-fetcher.ts';

const VIDEO_EXTENSIONS = new Set(['.avi', '.mkv', '.mp4', '.mov', '.wmv', '.m4v', '.ts']);

export interface IngestionFileOps {
  exists(filePath: string): boolean;
  statSize(filePath: string): number;
  sha256(filePath: string): string;
  ensureDir(dirPath: string): void;
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

function walkStagingVideos(
  dir: string,
  baseDir: string,
  fileOps: IngestionFileOps,
  acc: StagingFileItem[],
): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkStagingVideos(fullPath, baseDir, fileOps, acc);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(ext)) continue;
      const rel = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      const fc2 = parseFc2Code(path.basename(entry.name, ext));
      const cat = fc2?.code ?? extractCatalogNumber(entry.name);
      acc.push({
        filename: entry.name,
        relativePath: rel,
        tempPath: fullPath,
        fileSize: fileOps.statSize(fullPath),
        checksumSha256: fileOps.sha256(fullPath),
        catalogNumber: cat,
      });
    }
  }
}

/**
 * Dry-run scanner (`B2`): inspects `stagingDir` without touching any file or writing to SQLite.
 */
export function previewStagingPlan(options: {
  readonly stagingDir: string;
  readonly targetRootId: string;
  readonly targetSubdir: string;
  readonly roots: readonly MediaRootConfig[];
  readonly fileOps?: IngestionFileOps | undefined;
}): {
  readonly ok: boolean;
  readonly files: readonly StagingFileItem[];
  readonly targetRelativePaths: readonly string[];
  readonly error?: string | undefined;
} {
  const fileOps = options.fileOps ?? defaultIngestionFileOps;
  if (!options.stagingDir.trim() || !fs.existsSync(options.stagingDir)) {
    return {
      ok: false,
      files: [],
      targetRelativePaths: [],
      error: `Staging directory not found: ${options.stagingDir || '(empty)'}`,
    };
  }
  const files: StagingFileItem[] = [];
  walkStagingVideos(options.stagingDir, options.stagingDir, fileOps, files);

  const cleanSubdir = normalizeTargetSubdir(options.targetSubdir);
  const targetRelativePaths: string[] = [];
  for (const f of files) {
    const relTarget = cleanSubdir ? `${cleanSubdir}/${f.filename}` : f.filename;
    const check = resolveAllowlistedUncPath(options.roots, options.targetRootId, relTarget);
    if (!check.ok) {
      return {
        ok: false,
        files,
        targetRelativePaths: [],
        error: check.message,
      };
    }
    targetRelativePaths.push(relTarget);
  }

  return { ok: true, files, targetRelativePaths };
}

/**
 * Scan `stagingDir` and upsert `planned` manifests in SQLite (idempotent on `source_id = sha256:size`).
 */
export function scanAndPlanStagingFiles(
  db: DatabaseSync,
  options: {
    readonly stagingDir: string;
    readonly targetRootId: string;
    readonly targetSubdir: string;
    readonly roots: readonly MediaRootConfig[];
    readonly fileOps?: IngestionFileOps | undefined;
    readonly now?: (() => Date) | undefined;
  },
): ScanStagingResult {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const cleanSubdir = normalizeTargetSubdir(options.targetSubdir);
  const preview = previewStagingPlan(options);
  if (!preview.ok) {
    return {
      ok: false,
      stagingDir: options.stagingDir,
      targetRootId: options.targetRootId,
      targetSubdir: cleanSubdir,
      files: [],
      manifests: listIngestionManifests(db),
      error: preview.error,
    };
  }

  // Ensure target root row exists in media_roots so FK on ingestion_manifests is satisfied.
  const activeRoot = options.roots.find((r) => r.rootId === options.targetRootId);
  if (activeRoot) {
    db.prepare(
      `INSERT OR IGNORE INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(activeRoot.rootId, activeRoot.label, activeRoot.canonicalUncRoot, activeRoot.enabled ? 1 : 0, now);
  }

  for (let i = 0; i < preview.files.length; i++) {
    const file = preview.files[i]!;
    const targetRel = preview.targetRelativePaths[i]!;
    const sourceId = `${file.checksumSha256}:${file.fileSize}`;
    const existing = db
      .prepare('SELECT id, state FROM ingestion_manifests WHERE source_id = ?')
      .get(sourceId) as { id: number; state: string } | undefined;

    if (!existing) {
      const inferredDate = extractIsoDate(file.filename);
      db.prepare(
        `INSERT INTO ingestion_manifests (
          source_id, temp_path, target_root_id, target_relative_path, filename,
          title, catalog_number, media_date, tags_json, metadata_source,
          checksum_sha256, file_size, state, review_decision, last_error,
          indexed_media_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, '[]', NULL, ?, ?, 'planned', 'pending', NULL, NULL, ?, ?)`,
      ).run(
        sourceId,
        file.tempPath,
        options.targetRootId,
        targetRel,
        file.filename,
        file.catalogNumber,
        inferredDate,
        file.checksumSha256,
        file.fileSize,
        now,
        now,
      );
    } else if (existing.state === 'planned') {
      db.prepare(
        `UPDATE ingestion_manifests
         SET temp_path = ?, target_root_id = ?, target_relative_path = ?, updated_at = ?
         WHERE id = ?`,
      ).run(file.tempPath, options.targetRootId, targetRel, now, existing.id);
    }
  }

  return {
    ok: true,
    stagingDir: options.stagingDir,
    targetRootId: options.targetRootId,
    targetSubdir: cleanSubdir,
    files: preview.files,
    manifests: listIngestionManifests(db),
  };
}

/**
 * Fetch candidate metadata & tags from `FC2CMADB` / `FC2PPVDB` for a staged manifest (`B3`).
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
      candidateTags: [],
      manifest,
    };
  }

  const meta = lookup.metadata;
  const mergedTagNames = new Map<string, IngestionManifestTag>();
  for (const t of manifest.tags) {
    mergedTagNames.set(normalizeLabel(t.name), t);
  }
  for (const name of meta.candidateTags) {
    const norm = normalizeLabel(name);
    if (!norm || mergedTagNames.has(norm)) continue;
    const existingTag = db
      .prepare('SELECT id, name FROM tags WHERE normalized_name = ? AND archived_at IS NULL')
      .get(norm) as { id: number; name: string } | undefined;
    mergedTagNames.set(
      norm,
      existingTag ? { tagId: Number(existingTag.id), name: String(existingTag.name) } : { name },
    );
  }

  const ts = now().toISOString();
  db.prepare(
    `UPDATE ingestion_manifests
     SET title = COALESCE(NULLIF(?, ''), title),
         tags_json = ?,
         metadata_source = ?,
         updated_at = ?
     WHERE id = ?`,
  ).run(meta.title, JSON.stringify([...mergedTagNames.values()]), meta.sourceUrl, ts, manifest.id);

  return {
    ok: true,
    provider: meta.provider,
    category: 'ok',
    reason: '',
    sourceUrl: meta.sourceUrl,
    title: meta.title,
    writer: meta.writer || null,
    candidateTags: meta.candidateTags,
    manifest: getIngestionManifestById(db, manifest.id),
  };
}

/**
 * Record human-review decision and confirmed tags (`B4`).
 */
export function reviewIngestionManifest(
  db: DatabaseSync,
  input: ReviewIngestionInput,
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
      // Idempotency check inside the transaction by target path or checksum source_key.
      const existingMedia = conn
        .prepare(
          `SELECT id FROM media_files
           WHERE (root_id = ? AND relative_path = ?) OR source_key = ?
           LIMIT 1`,
        )
        .get(manifest.targetRootId, manifest.targetRelativePath, manifest.checksumSha256) as
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
            manifest.mediaDate ? 'filename_or_path' : null,
            ts,
            manifest.fileSize,
            ts,
            manifest.checksumSha256,
          );
        mediaId = Number(info.lastInsertRowid);
      }

      for (const tagEntry of manifest.tags) {
        let resolvedTagId = tagEntry.tagId;
        if (!resolvedTagId) {
          const norm = normalizeLabel(tagEntry.name);
          const existingTag = conn
            .prepare('SELECT id FROM tags WHERE normalized_name = ?')
            .get(norm) as { id: number } | undefined;
          if (existingTag) {
            resolvedTagId = Number(existingTag.id);
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
        conn
          .prepare(
            `INSERT OR IGNORE INTO media_tags (media_id, tag_id, source, created_at)
             VALUES (?, ?, 'ingestion', ?)`,
          )
          .run(mediaId, resolvedTagId, ts);
      }

      conn
        .prepare(
          `UPDATE ingestion_manifests
           SET state = 'indexed', indexed_media_id = ?, last_error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(mediaId, ts, manifest.id);

      return {
        payload: { manifestId: manifest.id, sourceId: manifest.sourceId, targetRelativePath: manifest.targetRelativePath },
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
 * `reviewed -> moving -> copy & verify -> SQLite index (source='ingestion') -> indexed -> conservative temp delete`.
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

  // Idempotent replay for already indexed manifests (`B5`).
  if (manifest.state === 'indexed' && manifest.indexedMediaId !== null) {
    return {
      ok: true,
      idempotentReplay: true,
      mediaId: manifest.indexedMediaId,
      message: `Manifest #${manifest.id} already indexed as media #${manifest.indexedMediaId}.`,
      manifest,
    };
  }

  // Human review gate (`B4`).
  if (manifest.reviewDecision !== 'approved') {
    return {
      ok: false,
      code: 'REVIEW_REQUIRED',
      message: `Manifest #${manifest.id} requires human approval before moving or indexing.`,
      manifest,
    };
  }

  // Validate target containment.
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

  // Re-check checksum idempotency in media_files in case a different manifest already indexed the exact file.
  const preExisting = db
    .prepare('SELECT id FROM media_files WHERE source_key = ? LIMIT 1')
    .get(manifest.checksumSha256) as { id: number } | undefined;
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
      message: `Duplicate checksum already indexed as media #${mediaId}; skipped duplicate move/index.`,
      manifest: getIngestionManifestById(db, manifest.id),
    };
  }

  db.prepare(`UPDATE ingestion_manifests SET state = 'moving', updated_at = ? WHERE id = ?`).run(ts, manifest.id);

  const destPath = resolution.resolvedUncPath;
  try {
    const destAlreadyValid =
      fileOps.exists(destPath) &&
      fileOps.statSize(destPath) === manifest.fileSize &&
      fileOps.sha256(destPath) === manifest.checksumSha256;

    if (!destAlreadyValid) {
      if (!fileOps.exists(manifest.tempPath)) {
        throw new Error(`Staging file missing: ${manifest.tempPath}`);
      }
      if (fileOps.exists(destPath)) {
        throw new Error(`Destination exists with different content: ${destPath}`);
      }
      const destDir = destPath.startsWith('\\\\') ? path.win32.dirname(destPath) : path.dirname(destPath);
      fileOps.ensureDir(destDir);
      fileOps.copyFile(manifest.tempPath, destPath);
      const copiedSize = fileOps.statSize(destPath);
      const copiedHash = fileOps.sha256(destPath);
      if (copiedSize !== manifest.fileSize || copiedHash !== manifest.checksumSha256) {
        throw new Error(
          `CHECKSUM_MISMATCH: expected ${manifest.checksumSha256} (${manifest.fileSize}B), got ${copiedHash} (${copiedSize}B)`,
        );
      }
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
    mediaId = indexManifestIntoDatabase(db, manifest, nowFn().toISOString());
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

  // Conservative source cleanup only AFTER DB commit succeeds.
  let warning: string | null = null;
  if (fileOps.exists(manifest.tempPath)) {
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
      fileOps.sha256(destPath) === m.checksumSha256;

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

    // `moving` or `failed`: check if destination already arrived cleanly (`moved-not-indexed`).
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
