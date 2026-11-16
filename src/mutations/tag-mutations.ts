import type { DatabaseSync } from 'node:sqlite'
import type {
  AliasInput,
  CreateTagInput,
  RenameTagInput,
  TagMutationResult,
  TagRevisionInput,
} from '../types.ts'
import {
  abort,
  assertNotArchived,
  assertTagRevision,
  bumpTagRevision,
  cleanLabel,
  normalizeLabel,
  requireTag,
  runMutation,
  type RunMutationOptions,
} from './transaction.ts'

/** `B1`: create a custom tag; `normalized_name` collisions return `TAG_NAME_CONFLICT`. */
export function createTag(db: DatabaseSync, input: CreateTagInput, options?: RunMutationOptions): TagMutationResult {
  return runMutation(
    db,
    'tag.create',
    ({ db: conn, now }) => {
      const name = cleanLabel(input?.name, 'Tag name')
      const normalized = normalizeLabel(name)
      const clash = conn.prepare('SELECT id FROM tags WHERE normalized_name = ?').get(normalized) as
        | { id: number }
        | undefined
      if (clash) abort('TAG_NAME_CONFLICT', `A tag named "${name}" already exists (#${clash.id})`)
      const res = conn
        .prepare(
          `INSERT INTO tags (name, normalized_name, kind, created_at, updated_at, revision)
           VALUES (?, ?, 'custom', ?, ?, 1)`,
        )
        .run(name, normalized, now, now)
      const tagId = Number(res.lastInsertRowid)
      return { payload: { tagId, name, normalizedName: normalized }, result: { tagId, revision: 1 } }
    },
    options,
  )
}

/** `B1`: rename with optimistic `expectedRevision`. */
export function renameTag(db: DatabaseSync, input: RenameTagInput, options?: RunMutationOptions): TagMutationResult {
  return runMutation(
    db,
    'tag.rename',
    (env) => {
      const tag = requireTag(env.db, input?.tagId)
      assertTagRevision(tag, input.expectedRevision)
      assertNotArchived(tag)
      const name = cleanLabel(input.name, 'Tag name')
      const normalized = normalizeLabel(name)
      const clash = env.db.prepare('SELECT id FROM tags WHERE normalized_name = ? AND id <> ?').get(normalized, tag.id) as
        | { id: number }
        | undefined
      if (clash) abort('TAG_NAME_CONFLICT', `A tag named "${name}" already exists (#${clash.id})`)
      env.db
        .prepare('UPDATE tags SET name = ?, normalized_name = ? WHERE id = ?')
        .run(name, normalized, tag.id)
      const revision = bumpTagRevision(env, tag.id)
      return {
        payload: { tagId: tag.id, from: tag.name, to: name, revision },
        result: { tagId: tag.id, revision },
      }
    },
    options,
  )
}

/**
 * `B2`: add an alias. Rejected (`ALIAS_CONFLICT`) if, normalised, it equals any *other* tag's name or
 * alias, or already exists on this tag. Pre-existing shared aliases are never touched.
 */
export function addAlias(db: DatabaseSync, input: AliasInput, options?: RunMutationOptions): TagMutationResult {
  return runMutation(
    db,
    'alias.add',
    (env) => {
      const tag = requireTag(env.db, input?.tagId)
      assertTagRevision(tag, input.expectedRevision)
      assertNotArchived(tag)
      const alias = cleanLabel(input.alias, 'Alias')
      const normalized = normalizeLabel(alias)
      const otherName = env.db
        .prepare('SELECT id, name FROM tags WHERE normalized_name = ? AND id <> ?')
        .get(normalized, tag.id) as { id: number; name: string } | undefined
      if (otherName) abort('ALIAS_CONFLICT', `Alias "${alias}" is the name of tag #${otherName.id}`)
      const otherAlias = env.db
        .prepare('SELECT tag_id FROM tag_aliases WHERE normalized_alias = ? AND tag_id <> ?')
        .get(normalized, tag.id) as { tag_id: number } | undefined
      if (otherAlias) abort('ALIAS_CONFLICT', `Alias "${alias}" already belongs to tag #${otherAlias.tag_id}`)
      if (tag.normalized_name === normalized) abort('ALIAS_CONFLICT', `Alias "${alias}" equals the tag's own name`)
      const own = env.db
        .prepare('SELECT id FROM tag_aliases WHERE tag_id = ? AND normalized_alias = ?')
        .get(tag.id, normalized)
      if (own) abort('ALIAS_CONFLICT', `Alias "${alias}" already exists on this tag`)
      env.db
        .prepare('INSERT INTO tag_aliases (tag_id, alias, normalized_alias) VALUES (?, ?, ?)')
        .run(tag.id, alias, normalized)
      const revision = bumpTagRevision(env, tag.id)
      return { payload: { tagId: tag.id, alias, revision }, result: { tagId: tag.id, revision } }
    },
    options,
  )
}

/** `B2`: remove an alias (matched by normalised text) with optimistic `expectedRevision`. */
export function removeAlias(db: DatabaseSync, input: AliasInput, options?: RunMutationOptions): TagMutationResult {
  return runMutation(
    db,
    'alias.remove',
    (env) => {
      const tag = requireTag(env.db, input?.tagId)
      assertTagRevision(tag, input.expectedRevision)
      const alias = cleanLabel(input.alias, 'Alias')
      const normalized = normalizeLabel(alias)
      const res = env.db
        .prepare('DELETE FROM tag_aliases WHERE tag_id = ? AND normalized_alias = ?')
        .run(tag.id, normalized)
      if (Number(res.changes) === 0) abort('ALIAS_NOT_FOUND', `Tag #${tag.id} has no alias "${alias}"`)
      const revision = bumpTagRevision(env, tag.id)
      return { payload: { tagId: tag.id, alias, revision }, result: { tagId: tag.id, revision } }
    },
    options,
  )
}

/** `B5`: non-destructive archive; associations and aliases are kept. */
export function archiveTag(db: DatabaseSync, input: TagRevisionInput, options?: RunMutationOptions): TagMutationResult {
  return runMutation(
    db,
    'tag.archive',
    (env) => {
      const tag = requireTag(env.db, input?.tagId)
      assertTagRevision(tag, input.expectedRevision)
      assertNotArchived(tag)
      env.db.prepare('UPDATE tags SET archived_at = ? WHERE id = ?').run(env.now, tag.id)
      const revision = bumpTagRevision(env, tag.id)
      return { payload: { tagId: tag.id, revision }, result: { tagId: tag.id, revision } }
    },
    options,
  )
}

/**
 * `B5`: restore an archived tag. Restoring a tag that was archived by a merge clears its
 * `merged_into_id` (its associations stay with the merge target); the audit row records both.
 */
export function restoreTag(db: DatabaseSync, input: TagRevisionInput, options?: RunMutationOptions): TagMutationResult {
  return runMutation(
    db,
    'tag.restore',
    (env) => {
      const tag = requireTag(env.db, input?.tagId)
      assertTagRevision(tag, input.expectedRevision)
      if (tag.archived_at === null) abort('TAG_NOT_ARCHIVED', `Tag #${tag.id} is not archived`)
      env.db.prepare('UPDATE tags SET archived_at = NULL, merged_into_id = NULL WHERE id = ?').run(tag.id)
      const revision = bumpTagRevision(env, tag.id)
      return {
        payload: { tagId: tag.id, revision, previousMergedIntoId: tag.merged_into_id },
        result: { tagId: tag.id, revision },
      }
    },
    options,
  )
}

/**
 * `B5`: there is intentionally no hard-delete. A deletion request for a referenced tag (media
 * associations, parent edges, or merge provenance) returns `TAG_IN_USE`; an unreferenced tag is
 * archived instead of removed, so nothing is ever physically deleted.
 */
export function requestTagDeletion(
  db: DatabaseSync,
  input: TagRevisionInput,
  options?: RunMutationOptions,
): TagMutationResult {
  return runMutation(
    db,
    'tag.delete_request',
    (env) => {
      const tag = requireTag(env.db, input?.tagId)
      assertTagRevision(tag, input.expectedRevision)
      const media = Number((env.db.prepare('SELECT COUNT(*) AS c FROM media_tags WHERE tag_id = ?').get(tag.id) as { c: number }).c)
      const edges = Number(
        (
          env.db
            .prepare('SELECT COUNT(*) AS c FROM tag_parents WHERE tag_id = ? OR parent_tag_id = ?')
            .get(tag.id, tag.id) as { c: number }
        ).c,
      )
      const mergedFrom = Number(
        (env.db.prepare('SELECT COUNT(*) AS c FROM tags WHERE merged_into_id = ?').get(tag.id) as { c: number }).c,
      )
      if (media + edges + mergedFrom > 0) {
        abort(
          'TAG_IN_USE',
          `Tag #${tag.id} is in use (${media} media, ${edges} parent edges, ${mergedFrom} merged tags); archive it instead`,
        )
      }
      if (tag.archived_at === null) {
        env.db.prepare('UPDATE tags SET archived_at = ? WHERE id = ?').run(env.now, tag.id)
      }
      const revision = bumpTagRevision(env, tag.id)
      return { payload: { tagId: tag.id, revision, archivedInsteadOfDeleted: true }, result: { tagId: tag.id, revision } }
    },
    options,
  )
}
