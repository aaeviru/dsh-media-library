import type { DatabaseSync } from 'node:sqlite'
import type { MutationItemFailure, SetMediaTagsInput, SetMediaTagsResult } from '../types.ts'
import {
  abort,
  isPositiveInteger,
  MAX_BATCH_MEDIA,
  MAX_BATCH_TAGS,
  MutationAbort,
  runMutation,
  toMutationError,
  type RunMutationOptions,
} from './transaction.ts'

function parseMediaId(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null
  const n = Number(raw.trim())
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

function parseTagIds(raw: unknown, what: string): number[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) abort('INVALID_INPUT', `${what} must be an array`)
  if (raw.length > MAX_BATCH_TAGS) abort('INVALID_INPUT', `${what} has more than ${MAX_BATCH_TAGS} entries`)
  const ids: number[] = []
  for (const id of raw) {
    if (!isPositiveInteger(id)) abort('INVALID_INPUT', `${what} contains an invalid tag id: ${String(id)}`)
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * `B3`: add and/or remove tags on up to `MAX_BATCH_MEDIA` media items in ONE transaction.
 * Any failing item (unknown media, unknown/archived tag to add, media revision conflict) rolls the
 * whole batch back and is reported per item. New associations use `source='manual'`; adding an
 * existing association is an idempotent no-op that keeps its original source; removal works for any
 * source because this is the explicit user path (automation uses `removeAutomatedMediaTags`).
 */
export function setMediaTags(
  db: DatabaseSync,
  input: SetMediaTagsInput,
  options?: RunMutationOptions,
): SetMediaTagsResult {
  // Size guard runs before opening a transaction: oversize requests never touch the database.
  if (Array.isArray(input?.mediaIds) && input.mediaIds.length > MAX_BATCH_MEDIA) {
    return toMutationError(
      new MutationAbort('BATCH_TOO_LARGE', `At most ${MAX_BATCH_MEDIA} media items per request (got ${input.mediaIds.length})`),
    )
  }
  return runMutation(
    db,
    'media_tags.set',
    (env) => {
      if (!Array.isArray(input?.mediaIds) || input.mediaIds.length === 0) {
        abort('INVALID_INPUT', 'mediaIds must be a non-empty array')
      }
      const addTagIds = parseTagIds(input.addTagIds, 'addTagIds')
      const removeTagIds = parseTagIds(input.removeTagIds, 'removeTagIds')
      if (addTagIds.length + removeTagIds.length === 0) abort('INVALID_INPUT', 'Nothing to add or remove')
      if (addTagIds.some(id => removeTagIds.includes(id))) {
        abort('INVALID_INPUT', 'A tag cannot be added and removed in the same request')
      }

      const failures: MutationItemFailure[] = []
      const mediaIds: number[] = []
      for (const raw of input.mediaIds) {
        const id = parseMediaId(raw)
        if (id === null) {
          failures.push({ mediaId: String(raw), tagId: null, code: 'INVALID_INPUT', message: `Invalid media id "${String(raw)}"` })
        } else if (!mediaIds.includes(id)) {
          mediaIds.push(id)
        }
      }

      const expectedRevisions = new Map<number, number>()
      for (const exp of input.expectedMediaRevisions ?? []) {
        const id = parseMediaId(exp?.mediaId)
        if (id === null || !Number.isSafeInteger(exp.revision)) {
          abort('INVALID_INPUT', 'expectedMediaRevisions entries need a media id and integer revision')
        }
        expectedRevisions.set(id, exp.revision)
      }

      const mediaStmt = env.db.prepare('SELECT id, revision FROM media_files WHERE id = ?')
      for (const id of mediaIds) {
        const row = mediaStmt.get(id) as { id: number; revision: number } | undefined
        if (!row) {
          failures.push({ mediaId: String(id), tagId: null, code: 'MEDIA_NOT_FOUND', message: `Media #${id} does not exist` })
          continue
        }
        const expected = expectedRevisions.get(id)
        if (expected !== undefined && Number(row.revision) !== expected) {
          failures.push({
            mediaId: String(id),
            tagId: null,
            code: 'REVISION_CONFLICT',
            message: `Media #${id} changed (expected revision ${expected}, current ${row.revision})`,
          })
        }
      }

      const tagStmt = env.db.prepare('SELECT id, name, archived_at FROM tags WHERE id = ?')
      for (const tagId of [...addTagIds, ...removeTagIds]) {
        const row = tagStmt.get(tagId) as { id: number; name: string; archived_at: string | null } | undefined
        if (!row) {
          failures.push({ mediaId: null, tagId, code: 'TAG_NOT_FOUND', message: `Tag #${tagId} does not exist` })
        } else if (row.archived_at !== null && addTagIds.includes(tagId)) {
          failures.push({ mediaId: null, tagId, code: 'TAG_ARCHIVED', message: `Tag #${tagId} "${row.name}" is archived` })
        }
      }

      if (failures.length > 0) {
        abort(failures[0]!.code, `Batch rejected, nothing was changed (${failures.length} problem(s))`, failures)
      }

      const insert = env.db.prepare(
        `INSERT OR IGNORE INTO media_tags (media_id, tag_id, source, created_at) VALUES (?, ?, 'manual', ?)`,
      )
      const remove = env.db.prepare('DELETE FROM media_tags WHERE media_id = ? AND tag_id = ?')
      const touch = env.db.prepare('UPDATE media_files SET revision = revision + 1 WHERE id = ?')
      let added = 0
      let removed = 0
      let unchanged = 0
      for (const mediaId of mediaIds) {
        let changed = false
        for (const tagId of addTagIds) {
          if (Number(insert.run(mediaId, tagId, env.now).changes) > 0) {
            added++
            changed = true
          } else unchanged++
        }
        for (const tagId of removeTagIds) {
          if (Number(remove.run(mediaId, tagId).changes) > 0) {
            removed++
            changed = true
          } else unchanged++
        }
        if (changed) touch.run(mediaId)
      }

      return {
        payload: { mediaIds, addTagIds, removeTagIds, added, removed, unchanged },
        result: { mediaCount: mediaIds.length, added, removed, unchanged },
      }
    },
    options,
  )
}

export type AutomatedActor = 'ingestion' | 'performer-rule'

export interface RemoveAutomatedMediaTagsInput {
  readonly actor: AutomatedActor
  readonly mediaIds: readonly number[]
  readonly tagIds: readonly number[]
}

/**
 * API-layer guard for automation (`B3`): ingestion / performer-rule flows may only delete the
 * associations they created themselves (`source = actor`). `manual` (and every other) source is
 * left untouched and counted in `skipped`.
 */
export function removeAutomatedMediaTags(
  db: DatabaseSync,
  input: RemoveAutomatedMediaTagsInput,
  options?: RunMutationOptions,
) {
  return runMutation(
    db,
    'media_tags.automated_remove',
    (env) => {
      if (input.actor !== 'ingestion' && input.actor !== 'performer-rule') {
        abort('INVALID_INPUT', `Unknown automation actor "${String(input.actor)}"`)
      }
      if (input.mediaIds.length > MAX_BATCH_MEDIA) {
        abort('BATCH_TOO_LARGE', `At most ${MAX_BATCH_MEDIA} media items per request`)
      }
      const del = env.db.prepare('DELETE FROM media_tags WHERE media_id = ? AND tag_id = ? AND source = ?')
      const present = env.db.prepare('SELECT 1 AS x FROM media_tags WHERE media_id = ? AND tag_id = ?')
      let removed = 0
      let skipped = 0
      for (const mediaId of input.mediaIds) {
        for (const tagId of input.tagIds) {
          if (Number(del.run(mediaId, tagId, input.actor).changes) > 0) {
            removed++
            env.db.prepare('UPDATE media_files SET revision = revision + 1 WHERE id = ?').run(mediaId)
          } else if (present.get(mediaId, tagId)) {
            skipped++
          }
        }
      }
      return {
        payload: { actor: input.actor, mediaIds: input.mediaIds, tagIds: input.tagIds, removed, skipped },
        result: { removed, skipped },
      }
    },
    options,
  )
}
