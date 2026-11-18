import type { DatabaseSync } from 'node:sqlite';
import {
  abort,
  assertNotArchived,
  normalizeLabel,
  requireTag,
  runMutation,
  type RunMutationOptions,
} from '../mutations/transaction.ts';
import type {
  DeletePerformerAliasInput,
  DeletePerformerAliasResult,
  ListPerformerReviewInput,
  ManifestPerformerPreview,
  NormalTagPreviewEntry,
  PerformerAliasPolicy,
  PerformerAliasRecord,
  PerformerCandidateTag,
  PerformerPreviewEntry,
  PerformerResolutionMode,
  PerformerReviewItem,
  PerformerReviewReason,
  PerformerReviewStatus,
  PromotePerformerTagInput,
  PromotePerformerTagResult,
  ResolvePerformerReviewInput,
  ResolvePerformerReviewResult,
  UpsertPerformerAliasInput,
  UpsertPerformerAliasResult,
} from '../types.ts';

/**
 * Deterministic normalization for performer names (`Issue #8 B1`):
 * - NFKC (normalizes fullwidth/halfwidth Latin, halfwidth Katakana, composed/decomposed Unicode)
 * - Strips control characters, collapses all whitespace (including fullwidth U+3000), trims, and case-folds.
 */
export function normalizePerformerName(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
    .toLowerCase();
}

interface AliasRuleRow {
  readonly id: number;
  readonly normalized_name: string;
  readonly raw_alias: string;
  readonly tag_id: number;
  readonly policy: PerformerAliasPolicy;
  readonly note: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly tag_name: string;
  readonly tag_kind: string;
  readonly archived_at: string | null;
}

function queryAliasesByNormalized(db: DatabaseSync, normalizedName: string): AliasRuleRow[] {
  return db
    .prepare(
      `SELECT pa.id, pa.normalized_name, pa.raw_alias, pa.tag_id, pa.policy, pa.note, pa.created_at, pa.updated_at,
              t.name AS tag_name, t.kind AS tag_kind, t.archived_at
       FROM performer_aliases pa
       JOIN tags t ON t.id = pa.tag_id
       WHERE pa.normalized_name = ?
       ORDER BY pa.id ASC`,
    )
    .all(normalizedName) as unknown as AliasRuleRow[];
}

export function listPerformerAliases(db: DatabaseSync): PerformerAliasRecord[] {
  const rows = db
    .prepare(
      `SELECT pa.id, pa.normalized_name, pa.raw_alias, pa.tag_id, pa.policy, pa.note, pa.created_at, pa.updated_at,
              t.name AS tag_name, t.kind AS tag_kind, t.archived_at
       FROM performer_aliases pa
       JOIN tags t ON t.id = pa.tag_id
       ORDER BY pa.normalized_name ASC, pa.id ASC`,
    )
    .all() as unknown as AliasRuleRow[];

  const activeCountByNorm = new Map<string, number>();
  for (const r of rows) {
    if (!r.archived_at) {
      activeCountByNorm.set(r.normalized_name, (activeCountByNorm.get(r.normalized_name) ?? 0) + 1);
    }
  }

  return rows.map((r) => {
    const targetArchived = r.archived_at !== null && r.archived_at !== undefined;
    const activeCount = activeCountByNorm.get(r.normalized_name) ?? 0;
    return {
      id: Number(r.id),
      normalizedName: String(r.normalized_name),
      rawAlias: String(r.raw_alias),
      tagId: Number(r.tag_id),
      tagName: String(r.tag_name),
      tagKind: String(r.tag_kind),
      targetArchived,
      needsRemediation: targetArchived,
      policy: r.policy === 'always_ask' ? 'always_ask' : 'auto',
      isAmbiguous: !targetArchived && (activeCount >= 2 || r.policy === 'always_ask'),
      note: String(r.note ?? ''),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  });
}

export function upsertPerformerAlias(
  db: DatabaseSync,
  input: UpsertPerformerAliasInput,
  options?: RunMutationOptions,
): UpsertPerformerAliasResult {
  const rawAlias = (input.rawAlias ?? '').trim();
  const normalizedName = normalizePerformerName(rawAlias);
  if (!normalizedName) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Performer alias cannot be empty.' };
  }
  const policy: PerformerAliasPolicy = input.policy === 'always_ask' ? 'always_ask' : 'auto';
  const note = (input.note ?? '').trim();

  const outcome = runMutation(
    db,
    'performer_alias.upsert',
    (env) => {
      const tag = requireTag(env.db, input.tagId);
      assertNotArchived(tag);

      env.db
        .prepare(
          `INSERT INTO performer_aliases (normalized_name, raw_alias, tag_id, policy, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(normalized_name, tag_id) DO UPDATE SET
             raw_alias = excluded.raw_alias,
             policy = excluded.policy,
             note = excluded.note,
             updated_at = excluded.updated_at`,
        )
        .run(normalizedName, rawAlias, tag.id, policy, note, env.now, env.now);

      const saved = env.db
        .prepare(
          `SELECT id FROM performer_aliases WHERE normalized_name = ? AND tag_id = ? LIMIT 1`,
        )
        .get(normalizedName, tag.id) as { id: number };

      return {
        payload: {
          aliasId: Number(saved.id),
          normalizedName,
          rawAlias,
          tagId: tag.id,
          tagName: tag.name,
          policy,
          note,
        },
        result: { aliasId: Number(saved.id) },
      };
    },
    options,
  );

  if (!outcome.ok) {
    return { ok: false, code: outcome.code, message: outcome.message };
  }
  const alias = listPerformerAliases(db).find((a) => a.id === outcome.aliasId) ?? null;
  return { ok: true, alias };
}

export function deletePerformerAlias(
  db: DatabaseSync,
  input: DeletePerformerAliasInput,
  options?: RunMutationOptions,
): DeletePerformerAliasResult {
  if (!Number.isInteger(input.aliasId) || input.aliasId <= 0) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Invalid performer alias id.' };
  }
  const outcome = runMutation(
    db,
    'performer_alias.delete',
    (env) => {
      const existing = env.db
        .prepare('SELECT id, normalized_name, raw_alias, tag_id FROM performer_aliases WHERE id = ?')
        .get(input.aliasId) as
        | { id: number; normalized_name: string; raw_alias: string; tag_id: number }
        | undefined;
      if (!existing) {
        abort('TAG_NOT_FOUND', `Performer alias #${input.aliasId} not found.`);
      }
      env.db.prepare('DELETE FROM performer_aliases WHERE id = ?').run(input.aliasId);
      return {
        payload: {
          aliasId: Number(existing.id),
          normalizedName: String(existing.normalized_name),
          rawAlias: String(existing.raw_alias),
          tagId: Number(existing.tag_id),
        },
        result: { deleted: true },
      };
    },
    options,
  );

  if (!outcome.ok) {
    return { ok: false, code: outcome.code, message: outcome.message };
  }
  return { ok: true };
}

function hydrateCandidateTags(db: DatabaseSync, rawJson: string): PerformerCandidateTag[] {
  let ids: number[] = [];
  try {
    const parsed = JSON.parse(rawJson);
    if (Array.isArray(parsed)) {
      ids = parsed.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0);
    }
  } catch {
    ids = [];
  }
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT id, name, kind FROM tags WHERE id IN (${placeholders}) AND archived_at IS NULL ORDER BY id ASC`)
    .all(...ids) as Array<{ id: number; name: string; kind: string }>;
  return rows.map((r) => ({ id: Number(r.id), name: String(r.name), kind: String(r.kind) }));
}

function mapReviewRow(db: DatabaseSync, row: Record<string, unknown>): PerformerReviewItem {
  return {
    id: Number(row.id),
    manifestId: row.manifest_id !== null && row.manifest_id !== undefined ? Number(row.manifest_id) : null,
    manifestFilename:
      row.manifest_filename !== null && row.manifest_filename !== undefined ? String(row.manifest_filename) : null,
    mediaId: row.media_id !== null && row.media_id !== undefined ? Number(row.media_id) : null,
    rawName: String(row.raw_name),
    normalizedName: String(row.normalized_name),
    reason: String(row.reason) as PerformerReviewReason,
    candidateTags: hydrateCandidateTags(db, String(row.candidate_tag_ids_json ?? '[]')),
    status: String(row.status) as PerformerReviewStatus,
    resolutionMode:
      row.resolution_mode !== null && row.resolution_mode !== undefined
        ? (String(row.resolution_mode) as PerformerResolutionMode)
        : null,
    resolvedTagId:
      row.resolved_tag_id !== null && row.resolved_tag_id !== undefined ? Number(row.resolved_tag_id) : null,
    resolvedTagName:
      row.resolved_tag_name !== null && row.resolved_tag_name !== undefined ? String(row.resolved_tag_name) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function getPerformerReviewItemById(db: DatabaseSync, reviewId: number): PerformerReviewItem | null {
  const row = db
    .prepare(
      `SELECT q.*, m.filename AS manifest_filename, t.name AS resolved_tag_name
       FROM performer_review_queue q
       LEFT JOIN ingestion_manifests m ON m.id = q.manifest_id
       LEFT JOIN tags t ON t.id = q.resolved_tag_id
       WHERE q.id = ?`,
    )
    .get(reviewId) as Record<string, unknown> | undefined;
  return row ? mapReviewRow(db, row) : null;
}

export function listPerformerReviewQueue(
  db: DatabaseSync,
  input?: ListPerformerReviewInput,
): PerformerReviewItem[] {
  const status = input?.status ?? 'pending';
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (status !== 'all') {
    where.push('q.status = ?');
    params.push(status);
  }
  if (input?.manifestId !== undefined) {
    where.push('q.manifest_id = ?');
    params.push(input.manifestId);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT q.*, m.filename AS manifest_filename, t.name AS resolved_tag_name
       FROM performer_review_queue q
       LEFT JOIN ingestion_manifests m ON m.id = q.manifest_id
       LEFT JOIN tags t ON t.id = q.resolved_tag_id
       ${whereClause}
       ORDER BY q.updated_at DESC, q.id DESC`,
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map((r) => mapReviewRow(db, r));
}

function buildNormalTagPreview(db: DatabaseSync, rawTagsJson: string): NormalTagPreviewEntry[] {
  let tagNames: Array<{ tagId?: number; name: string }> = [];
  try {
    const parsed = JSON.parse(rawTagsJson);
    if (Array.isArray(parsed)) {
      tagNames = parsed.filter((t): t is { tagId?: number; name: string } => Boolean(t && typeof t.name === 'string'));
    }
  } catch {
    tagNames = [];
  }

  const out: NormalTagPreviewEntry[] = [];
  for (const t of tagNames) {
    const cleanName = t.name.trim();
    if (!cleanName) continue;
    const norm = normalizeLabel(cleanName);
    const direct = db
      .prepare('SELECT id, name FROM tags WHERE normalized_name = ? AND archived_at IS NULL LIMIT 1')
      .get(norm) as { id: number; name: string } | undefined;
    if (direct) {
      out.push({
        rawName: cleanName,
        matchedTagId: Number(direct.id),
        matchedTagName: String(direct.name),
        matchedVia: 'name',
      });
      continue;
    }
    const viaAlias = db
      .prepare(
        `SELECT tg.id, tg.name
         FROM tag_aliases ta
         JOIN tags tg ON tg.id = ta.tag_id
         WHERE ta.normalized_alias = ? AND tg.archived_at IS NULL
         ORDER BY tg.id ASC
         LIMIT 1`,
      )
      .get(norm) as { id: number; name: string } | undefined;
    if (viaAlias) {
      out.push({
        rawName: cleanName,
        matchedTagId: Number(viaAlias.id),
        matchedTagName: String(viaAlias.name),
        matchedVia: 'alias',
      });
      continue;
    }
    out.push({
      rawName: cleanName,
      matchedTagId: null,
      matchedTagName: null,
      matchedVia: 'new',
    });
  }
  return out;
}

/**
 * Evaluate performer aliases for a manifest idempotently (`B1`, `B2`).
 * - Unique active `auto` rule -> `autoMatched` (`performer-rule`, confidence 1.0).
 * - Unknown / ambiguous (`>=2` active tags or `always_ask`) / `archived_target` -> upserted into `performer_review_queue` as `pending`.
 * - Existing human `resolved` (with active tag) and `skipped` queue decisions are preserved across re-evaluations.
 */
export function evaluateManifestPerformers(
  db: DatabaseSync,
  manifestId: number,
  options?: { readonly now?: (() => Date) | undefined },
): ManifestPerformerPreview {
  const manifestRow = db
    .prepare('SELECT id, actresses_json, tags_json, indexed_media_id FROM ingestion_manifests WHERE id = ?')
    .get(manifestId) as
    | { id: number; actresses_json: string; tags_json: string; indexed_media_id: number | null }
    | undefined;

  if (!manifestRow) {
    return {
      manifestId,
      canCommit: false,
      autoMatched: [],
      humanResolved: [],
      skipped: [],
      pendingReview: [],
      normalTags: [],
    };
  }

  let rawActresses: string[] = [];
  try {
    const parsed = JSON.parse(manifestRow.actresses_json || '[]');
    if (Array.isArray(parsed)) {
      rawActresses = parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
    }
  } catch {
    rawActresses = [];
  }

  const ts = (options?.now ? options.now() : new Date()).toISOString();
  const indexedMediaId =
    manifestRow.indexed_media_id !== null && manifestRow.indexed_media_id !== undefined
      ? Number(manifestRow.indexed_media_id)
      : null;

  const isAlreadyManualOnMedia = (tagId: number): boolean => {
    if (indexedMediaId === null) return false;
    const row = db
      .prepare(`SELECT source FROM media_tags WHERE media_id = ? AND tag_id = ? LIMIT 1`)
      .get(indexedMediaId, tagId) as { source: string } | undefined;
    return row?.source === 'manual';
  };

  const seenNorms = new Set<string>();
  const autoMatched: PerformerPreviewEntry[] = [];
  const humanResolved: PerformerPreviewEntry[] = [];
  const skipped: string[] = [];

  for (const rawName of rawActresses) {
    const trimmed = rawName.trim();
    const norm = normalizePerformerName(trimmed);
    if (!norm || seenNorms.has(norm)) continue;
    seenNorms.add(norm);

    const existingQueue = db
      .prepare(
        `SELECT q.*, t.name AS resolved_tag_name, t.archived_at AS resolved_tag_archived
         FROM performer_review_queue q
         LEFT JOIN tags t ON t.id = q.resolved_tag_id
         WHERE q.manifest_id = ? AND q.normalized_name = ?
         LIMIT 1`,
      )
      .get(manifestId, norm) as
      | (Record<string, unknown> & { resolved_tag_name?: string | null; resolved_tag_archived?: string | null })
      | undefined;

    if (existingQueue) {
      const qStatus = String(existingQueue.status) as PerformerReviewStatus;
      if (qStatus === 'skipped') {
        skipped.push(trimmed);
        continue;
      }
      if (qStatus === 'resolved' && existingQueue.resolved_tag_id !== null && existingQueue.resolved_tag_id !== undefined) {
        if (!existingQueue.resolved_tag_archived && existingQueue.resolved_tag_name) {
          const tagId = Number(existingQueue.resolved_tag_id);
          humanResolved.push({
            rawName: trimmed,
            normalizedName: norm,
            tagId,
            tagName: String(existingQueue.resolved_tag_name),
            source: 'manual',
            confidence: null,
            resolutionMode:
              existingQueue.resolution_mode !== null && existingQueue.resolution_mode !== undefined
                ? (String(existingQueue.resolution_mode) as PerformerResolutionMode)
                : 'bind_existing',
            alreadyManual: isAlreadyManualOnMedia(tagId),
          });
          continue;
        }
        // Previously resolved tag was archived -> reopen as pending remediation.
        db.prepare(
          `UPDATE performer_review_queue
           SET status = 'pending', reason = 'archived_target', candidate_tag_ids_json = '[]',
               resolution_mode = NULL, resolved_tag_id = NULL, updated_at = ?
           WHERE id = ?`,
        ).run(ts, Number(existingQueue.id));
        continue;
      }
    }

    // Evaluate deterministic performer_aliases rules.
    const rules = queryAliasesByNormalized(db, norm);
    const activeRules = rules.filter((r) => !r.archived_at);
    const archivedRules = rules.filter((r) => Boolean(r.archived_at));

    if (activeRules.length === 1 && activeRules[0]!.policy === 'auto' && archivedRules.length === 0) {
      const match = activeRules[0]!;
      // If a pending queue entry existed previously before the rule was added, clear it automatically.
      if (existingQueue && String(existingQueue.status) === 'pending') {
        db.prepare('DELETE FROM performer_review_queue WHERE id = ?').run(Number(existingQueue.id));
      }
      autoMatched.push({
        rawName: trimmed,
        normalizedName: norm,
        tagId: Number(match.tag_id),
        tagName: String(match.tag_name),
        source: 'performer-rule',
        confidence: 1.0,
        resolutionMode: null,
        alreadyManual: isAlreadyManualOnMedia(Number(match.tag_id)),
      });
      continue;
    }

    let reason: PerformerReviewReason = 'unknown';
    let candidateIds: number[] = [];
    if (activeRules.length >= 2 || (activeRules.length === 1 && activeRules[0]!.policy === 'always_ask')) {
      reason = 'ambiguous';
      candidateIds = activeRules.map((r) => Number(r.tag_id));
    } else if (activeRules.length === 0 && archivedRules.length > 0) {
      reason = 'archived_target';
      candidateIds = [];
    } else if (activeRules.length === 1 && archivedRules.length > 0) {
      reason = 'ambiguous';
      candidateIds = activeRules.map((r) => Number(r.tag_id));
    }

    db.prepare(
      `INSERT INTO performer_review_queue
         (manifest_id, media_id, raw_name, normalized_name, reason, candidate_tag_ids_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(manifest_id, normalized_name) DO UPDATE SET
         raw_name = excluded.raw_name,
         reason = excluded.reason,
         candidate_tag_ids_json = excluded.candidate_tag_ids_json,
         status = 'pending',
         updated_at = excluded.updated_at`,
    ).run(manifestId, indexedMediaId, trimmed, norm, reason, JSON.stringify(candidateIds), ts, ts);
  }

  const pendingReview = listPerformerReviewQueue(db, { status: 'pending', manifestId });
  const normalTags = buildNormalTagPreview(db, manifestRow.tags_json);

  return {
    manifestId,
    canCommit: pendingReview.length === 0,
    autoMatched,
    humanResolved,
    skipped,
    pendingReview,
    normalTags,
  };
}

/**
 * Resolve a performer review queue item (`B3`, `B4` Option B):
 * - `bind_existing`: bind to an existing active tag, optionally persisting `performer_aliases` (`auto` or `always_ask`).
 * - `create_performer_tag`: create a new tag with `kind = 'performer'` (or reuse active normalized match) and optionally save rule.
 * - `skip`: skip performer tagging for this manifest.
 * - If already linked to an indexed media item, writes `media_tags(source='manual', confidence=NULL)` immediately.
 */
export function resolvePerformerReview(
  db: DatabaseSync,
  input: ResolvePerformerReviewInput,
  options?: RunMutationOptions,
): ResolvePerformerReviewResult {
  if (!Number.isInteger(input.reviewId) || input.reviewId <= 0) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Invalid reviewId.' };
  }

  const existingCheck = db
    .prepare('SELECT id FROM performer_review_queue WHERE id = ?')
    .get(input.reviewId) as { id: number } | undefined;
  if (!existingCheck) {
    return { ok: false, code: 'REVIEW_NOT_FOUND', message: `Performer review item #${input.reviewId} not found.` };
  }

  const outcome = runMutation(
    db,
    'performer_review.resolve',
    (env) => {
      const row = env.db
        .prepare(
          `SELECT q.*, m.indexed_media_id AS manifest_indexed_media_id
           FROM performer_review_queue q
           LEFT JOIN ingestion_manifests m ON m.id = q.manifest_id
           WHERE q.id = ?`,
        )
        .get(input.reviewId) as Record<string, unknown> | undefined;
      if (!row) {
        abort('TAG_NOT_FOUND', `Performer review item #${input.reviewId} not found.`);
      }

      const rawName = String(row.raw_name);
      const normalizedName = String(row.normalized_name);
      const manifestId = row.manifest_id !== null && row.manifest_id !== undefined ? Number(row.manifest_id) : null;
      const targetMediaId =
        row.media_id !== null && row.media_id !== undefined
          ? Number(row.media_id)
          : row.manifest_indexed_media_id !== null && row.manifest_indexed_media_id !== undefined
            ? Number(row.manifest_indexed_media_id)
            : null;

      let resolvedTagId: number | null = null;
      let createdTagId: number | null = null;
      const rememberRule = input.rememberRule ?? input.mode !== 'skip';
      const rulePolicy: PerformerAliasPolicy = input.rulePolicy === 'always_ask' ? 'always_ask' : 'auto';

      if (input.mode === 'skip') {
        env.db
          .prepare(
            `UPDATE performer_review_queue
             SET status = 'skipped', resolution_mode = 'skip', resolved_tag_id = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(env.now, input.reviewId);
      } else if (input.mode === 'bind_existing') {
        if (!Number.isInteger(input.tagId) || (input.tagId ?? 0) <= 0) {
          abort('INVALID_INPUT', 'tagId is required for bind_existing.');
        }
        const tag = requireTag(env.db, input.tagId!);
        assertNotArchived(tag);
        resolvedTagId = tag.id;

        if (rememberRule) {
          env.db
            .prepare(
              `INSERT INTO performer_aliases (normalized_name, raw_alias, tag_id, policy, note, created_at, updated_at)
               VALUES (?, ?, ?, ?, '', ?, ?)
               ON CONFLICT(normalized_name, tag_id) DO UPDATE SET
                 raw_alias = excluded.raw_alias,
                 policy = excluded.policy,
                 updated_at = excluded.updated_at`,
            )
            .run(normalizedName, rawName, resolvedTagId, rulePolicy, env.now, env.now);
        }

        env.db
          .prepare(
            `UPDATE performer_review_queue
             SET status = 'resolved', resolution_mode = 'bind_existing', resolved_tag_id = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(resolvedTagId, env.now, input.reviewId);
      } else if (input.mode === 'create_performer_tag') {
        const tagName = (input.newTagName ?? rawName).trim();
        const tagNorm = normalizeLabel(tagName);
        if (!tagNorm) {
          abort('INVALID_INPUT', 'Performer tag name cannot be empty.');
        }
        const existingTag = env.db
          .prepare('SELECT id, archived_at FROM tags WHERE normalized_name = ? LIMIT 1')
          .get(tagNorm) as { id: number; archived_at: string | null } | undefined;
        if (existingTag) {
          if (existingTag.archived_at) {
            abort('TAG_NAME_CONFLICT', `Tag "${tagName}" exists as an archived tag; restore or bind another tag.`);
          }
          resolvedTagId = Number(existingTag.id);
        } else {
          const ins = env.db
            .prepare(
              `INSERT INTO tags (name, normalized_name, kind, created_at, updated_at, revision)
               VALUES (?, ?, 'performer', ?, ?, 1)`,
            )
            .run(tagName, tagNorm, env.now, env.now);
          createdTagId = Number(ins.lastInsertRowid);
          resolvedTagId = createdTagId;
        }

        if (rememberRule) {
          env.db
            .prepare(
              `INSERT INTO performer_aliases (normalized_name, raw_alias, tag_id, policy, note, created_at, updated_at)
               VALUES (?, ?, ?, ?, '', ?, ?)
               ON CONFLICT(normalized_name, tag_id) DO UPDATE SET
                 raw_alias = excluded.raw_alias,
                 policy = excluded.policy,
                 updated_at = excluded.updated_at`,
            )
            .run(normalizedName, rawName, resolvedTagId, rulePolicy, env.now, env.now);
        }

        env.db
          .prepare(
            `UPDATE performer_review_queue
             SET status = 'resolved', resolution_mode = 'create_performer_tag', resolved_tag_id = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(resolvedTagId, env.now, input.reviewId);
      } else {
        abort('INVALID_INPUT', `Unsupported resolution mode "${String(input.mode)}".`);
      }

      // Option B: human-confirmed performer resolution writes `source='manual'` when media is already indexed.
      if (targetMediaId !== null && resolvedTagId !== null) {
        env.db
          .prepare(
            `INSERT INTO media_tags (media_id, tag_id, source, confidence, created_at)
             VALUES (?, ?, 'manual', NULL, ?)
             ON CONFLICT(media_id, tag_id) DO UPDATE SET
               source = 'manual',
               confidence = NULL`,
          )
          .run(targetMediaId, resolvedTagId, env.now);
        env.db.prepare('UPDATE media_files SET revision = revision + 1 WHERE id = ?').run(targetMediaId);
      }

      return {
        payload: {
          reviewId: input.reviewId,
          manifestId,
          mediaId: targetMediaId,
          rawName,
          normalizedName,
          mode: input.mode,
          resolvedTagId,
          createdTagId,
          rememberRule,
          rulePolicy,
          confirmedByHuman: true,
          resultingSource: resolvedTagId !== null ? 'manual' : null,
        },
        result: { createdTagId },
      };
    },
    options,
  );

  if (!outcome.ok) {
    return { ok: false, code: outcome.code, message: outcome.message };
  }
  return {
    ok: true,
    item: getPerformerReviewItemById(db, input.reviewId),
    createdTagId: outcome.createdTagId,
  };
}

/**
 * Promote an auto-applied `performer-rule` association on a media item to `manual` (`B4`).
 */
export function promotePerformerTagToManual(
  db: DatabaseSync,
  input: PromotePerformerTagInput,
  options?: RunMutationOptions,
): PromotePerformerTagResult {
  const mediaId = Number.parseInt(String(input.mediaId), 10);
  if (!Number.isInteger(mediaId) || mediaId <= 0 || !Number.isInteger(input.tagId) || input.tagId <= 0) {
    return { ok: false, code: 'INVALID_INPUT', message: 'Invalid mediaId or tagId.' };
  }

  const outcome = runMutation(
    db,
    'media_tags.promote_to_manual',
    (env) => {
      const res = env.db
        .prepare(
          `UPDATE media_tags
           SET source = 'manual', confidence = NULL
           WHERE media_id = ? AND tag_id = ? AND source = 'performer-rule'`,
        )
        .run(mediaId, input.tagId);
      const promoted = Number(res.changes) > 0;
      if (promoted) {
        env.db.prepare('UPDATE media_files SET revision = revision + 1 WHERE id = ?').run(mediaId);
      }
      return {
        payload: { mediaId, tagId: input.tagId, promoted, confirmedByHuman: true },
        result: { promoted },
      };
    },
    options,
  );

  if (!outcome.ok) {
    return { ok: false, code: outcome.code, message: outcome.message };
  }
  return { ok: true, promoted: outcome.promoted };
}
