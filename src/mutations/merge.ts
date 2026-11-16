import type { DatabaseSync } from 'node:sqlite'
import type {
  MergePreviewResult,
  MergePreviewSuccess,
  MergeTagsInput,
  MergeTagsResult,
  PreviewMergeInput,
} from '../types.ts'
import {
  abort,
  assertNotArchived,
  assertTagRevision,
  bumpTagRevision,
  requireTag,
  runMutation,
  toMutationError,
  type RunMutationOptions,
  type TagRow,
} from './transaction.ts'

interface MergePlan {
  readonly target: TagRow
  readonly source: TagRow
  readonly affectedMedia: number
  readonly dedupedMedia: number
  readonly aliasesToMigrate: ReadonlyArray<{ id: number; alias: string }>
  readonly aliasesConflicting: ReadonlyArray<{ id: number; alias: string }>
  /** Distinct edges to create on the target (after replacing B with A and dropping duplicates). */
  readonly newEdges: ReadonlyArray<{ tagId: number; parentId: number }>
  readonly edgesDeduped: number
  readonly wouldCreateCycle: boolean
}

function count(db: DatabaseSync, sql: string, ...params: number[]): number {
  return Number((db.prepare(sql).get(...params) as { c: number }).c)
}

/** Read-only analysis shared by `previewMerge` and `mergeTags` (`B4`). */
function planMerge(db: DatabaseSync, input: PreviewMergeInput): MergePlan {
  const target = requireTag(db, input?.targetTagId)
  const source = requireTag(db, input?.sourceTagId)
  if (target.id === source.id) abort('INVALID_INPUT', 'Cannot merge a tag into itself')
  assertNotArchived(target)
  assertNotArchived(source)

  const affectedMedia = count(db, 'SELECT COUNT(*) AS c FROM media_tags WHERE tag_id = ?', source.id)
  const dedupedMedia = count(
    db,
    `SELECT COUNT(*) AS c FROM media_tags b
     WHERE b.tag_id = ? AND EXISTS (SELECT 1 FROM media_tags a WHERE a.media_id = b.media_id AND a.tag_id = ?)`,
    source.id,
    target.id,
  )

  const sourceAliases = db
    .prepare('SELECT id, alias, normalized_alias FROM tag_aliases WHERE tag_id = ? ORDER BY id')
    .all(source.id) as Array<{ id: number; alias: string; normalized_alias: string }>
  const targetAliasNorms = new Set(
    (db.prepare('SELECT normalized_alias FROM tag_aliases WHERE tag_id = ?').all(target.id) as Array<{
      normalized_alias: string
    }>).map(r => r.normalized_alias),
  )
  const aliasesToMigrate: Array<{ id: number; alias: string }> = []
  const aliasesConflicting: Array<{ id: number; alias: string }> = []
  for (const a of sourceAliases) {
    if (a.normalized_alias === target.normalized_name || targetAliasNorms.has(a.normalized_alias)) {
      aliasesConflicting.push({ id: Number(a.id), alias: a.alias })
    } else {
      aliasesToMigrate.push({ id: Number(a.id), alias: a.alias })
    }
  }

  // Parent edges: child --> parent. Replace B with A, dedupe, then look for a cycle through A.
  const allEdges = db.prepare('SELECT tag_id, parent_tag_id FROM tag_parents').all() as Array<{
    tag_id: number
    parent_tag_id: number
  }>
  const keep: Array<{ tagId: number; parentId: number }> = []
  const involvingSource: Array<{ tagId: number; parentId: number }> = []
  for (const e of allEdges) {
    const edge = { tagId: Number(e.tag_id), parentId: Number(e.parent_tag_id) }
    if (edge.tagId === source.id || edge.parentId === source.id) involvingSource.push(edge)
    else keep.push(edge)
  }
  const key = (e: { tagId: number; parentId: number }): string => `${e.tagId}>${e.parentId}`
  const existing = new Set(keep.map(key))
  const newEdges: Array<{ tagId: number; parentId: number }> = []
  let edgesDeduped = 0
  let selfLoop = false
  for (const e of involvingSource) {
    const mapped = {
      tagId: e.tagId === source.id ? target.id : e.tagId,
      parentId: e.parentId === source.id ? target.id : e.parentId,
    }
    if (mapped.tagId === mapped.parentId) {
      selfLoop = true
      continue
    }
    if (existing.has(key(mapped))) {
      edgesDeduped++
      continue
    }
    existing.add(key(mapped))
    newEdges.push(mapped)
  }

  let wouldCreateCycle = selfLoop
  if (!wouldCreateCycle) {
    const parents = new Map<number, number[]>()
    for (const e of [...keep, ...newEdges]) {
      const list = parents.get(e.tagId) ?? []
      list.push(e.parentId)
      parents.set(e.tagId, list)
    }
    // Cycle through A exists iff A is reachable from itself following child -> parent edges.
    const seen = new Set<number>()
    const stack = [...(parents.get(target.id) ?? [])]
    while (stack.length > 0) {
      const id = stack.pop()!
      if (id === target.id) {
        wouldCreateCycle = true
        break
      }
      if (seen.has(id)) continue
      seen.add(id)
      stack.push(...(parents.get(id) ?? []))
    }
  }

  return { target, source, affectedMedia, dedupedMedia, aliasesToMigrate, aliasesConflicting, newEdges, edgesDeduped, wouldCreateCycle }
}

/** `B4`: read-only merge impact preview. Never writes, never audits. */
export function previewMerge(db: DatabaseSync, input: PreviewMergeInput): MergePreviewResult {
  try {
    const plan = planMerge(db, input)
    const preview: MergePreviewSuccess = {
      ok: true,
      targetTagId: plan.target.id,
      sourceTagId: plan.source.id,
      targetRevision: Number(plan.target.revision),
      sourceRevision: Number(plan.source.revision),
      affectedMedia: plan.affectedMedia,
      dedupedMedia: plan.dedupedMedia,
      aliasesMigrated: plan.aliasesToMigrate.length,
      aliasesConflicting: plan.aliasesConflicting.length,
      parentEdgesMigrated: plan.newEdges.length,
      parentEdgesDeduped: plan.edgesDeduped,
      wouldCreateCycle: plan.wouldCreateCycle,
    }
    return preview
  } catch (error) {
    return toMutationError(error)
  }
}

/**
 * `B4`: merge tag B (`sourceTagId`) into tag A (`targetTagId`) in one transaction.
 * - media associations move to A, deduplicated; `manual` source wins over any other on conflict;
 * - aliases move to A, those clashing with A are dropped (listed in the audit row);
 * - parent edges move to A, deduplicated; a resulting cycle rejects the whole merge;
 * - B is archived with `merged_into_id = A` (never physically deleted).
 */
export function mergeTags(db: DatabaseSync, input: MergeTagsInput, options?: RunMutationOptions): MergeTagsResult {
  return runMutation(
    db,
    'tag.merge',
    (env) => {
      const plan = planMerge(env.db, input)
      assertTagRevision(plan.target, input.expectedTargetRevision)
      assertTagRevision(plan.source, input.expectedSourceRevision)
      if (plan.wouldCreateCycle) {
        abort('MERGE_WOULD_CREATE_CYCLE', `Merging #${plan.source.id} into #${plan.target.id} would create a parent cycle`)
      }
      const A = plan.target.id
      const B = plan.source.id

      env.db
        .prepare('UPDATE media_files SET revision = revision + 1 WHERE id IN (SELECT media_id FROM media_tags WHERE tag_id = ?)')
        .run(B)
      // manual wins: promote A's association when B's was manual and A's was not.
      env.db
        .prepare(
          `UPDATE media_tags SET source = 'manual'
           WHERE tag_id = ? AND source <> 'manual'
             AND media_id IN (SELECT media_id FROM media_tags WHERE tag_id = ? AND source = 'manual')`,
        )
        .run(A, B)
      env.db
        .prepare('DELETE FROM media_tags WHERE tag_id = ? AND media_id IN (SELECT media_id FROM media_tags WHERE tag_id = ?)')
        .run(B, A)
      const moved = env.db.prepare('UPDATE media_tags SET tag_id = ? WHERE tag_id = ?').run(A, B)

      for (const alias of plan.aliasesToMigrate) {
        env.db.prepare('UPDATE tag_aliases SET tag_id = ? WHERE id = ?').run(A, alias.id)
      }
      for (const alias of plan.aliasesConflicting) {
        env.db.prepare('DELETE FROM tag_aliases WHERE id = ?').run(alias.id)
      }

      env.db.prepare('DELETE FROM tag_parents WHERE tag_id = ? OR parent_tag_id = ?').run(B, B)
      for (const edge of plan.newEdges) {
        env.db.prepare('INSERT INTO tag_parents (tag_id, parent_tag_id) VALUES (?, ?)').run(edge.tagId, edge.parentId)
      }

      env.db.prepare('UPDATE tags SET archived_at = ?, merged_into_id = ? WHERE id = ?').run(env.now, A, B)
      const sourceRevision = bumpTagRevision(env, B)
      const targetRevision = bumpTagRevision(env, A)

      const result = {
        targetTagId: A,
        targetRevision,
        sourceTagId: B,
        sourceRevision,
        migratedMediaTags: Number(moved.changes),
        dedupedMediaTags: plan.dedupedMedia,
        aliasesMigrated: plan.aliasesToMigrate.length,
        aliasesDropped: plan.aliasesConflicting.length,
        parentEdgesMigrated: plan.newEdges.length,
      }
      return {
        payload: {
          ...result,
          sourceName: plan.source.name,
          targetName: plan.target.name,
          droppedAliases: plan.aliasesConflicting.map(a => a.alias),
          migratedAliases: plan.aliasesToMigrate.map(a => a.alias),
          parentEdgesDeduped: plan.edgesDeduped,
        },
        result,
      }
    },
    options,
  )
}
