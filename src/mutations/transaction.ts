import type { DatabaseSync } from 'node:sqlite'
import { normalizeLookupKey } from '../inventory/tagstudio-inventory.ts'
import type { MutationError, MutationErrorCode, MutationItemFailure } from '../types.ts'

/** Hard upper bound for one `setMediaTags` request (`B3`, user-approved). */
export const MAX_BATCH_MEDIA = 200
export const MAX_BATCH_TAGS = 100
export const MAX_NAME_LENGTH = 200

/**
 * Thrown inside a mutation body to abort and roll back the whole transaction with a
 * structured, client-safe error. Anything else thrown is reported as `INTERNAL_ERROR`.
 */
export class MutationAbort extends Error {
  readonly code: MutationErrorCode
  readonly failures: readonly MutationItemFailure[]

  constructor(code: MutationErrorCode, message: string, failures: readonly MutationItemFailure[] = []) {
    super(message)
    this.name = 'MutationAbort'
    this.code = code
    this.failures = failures
  }
}

export function abort(
  code: MutationErrorCode,
  message: string,
  failures: readonly MutationItemFailure[] = [],
): never {
  throw new MutationAbort(code, message, failures)
}

export interface MutationBody<T extends object> {
  /** JSON-serialisable audit details persisted to `mutation_log.payload_json`. */
  readonly payload: unknown
  /** Success fields returned to the caller (`ok` and `mutationId` are added by the runner). */
  readonly result: T
}

export interface MutationEnv {
  readonly db: DatabaseSync
  /** ISO timestamp shared by every row written in this transaction. */
  readonly now: string
}

export interface RunMutationOptions {
  readonly now?: (() => Date) | undefined
}

export type MutationOutcome<T extends object> = (T & { readonly ok: true; readonly mutationId: number }) | MutationError

export function toMutationError(error: unknown): MutationError {
  if (error instanceof MutationAbort) {
    return { ok: false, code: error.code, message: error.message, failures: error.failures }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, code: 'INTERNAL_ERROR', message, failures: [] }
}

/**
 * The single write path (`B6`): `BEGIN IMMEDIATE`, run the body, append exactly one
 * `mutation_log` row, `COMMIT`. Any failure (validation abort, SQLite error, failing audit
 * insert) rolls back data and audit together, so failed changes leave no trace.
 * Foreign keys must stay enforced; this never relaxes them.
 */
export function runMutation<T extends object>(
  db: DatabaseSync,
  action: string,
  body: (env: MutationEnv) => MutationBody<T>,
  options?: RunMutationOptions,
): MutationOutcome<T> {
  if (db.isTransaction) {
    return toMutationError(new Error('Mutation requested inside an open transaction'))
  }
  const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined
  if (!fk || Number(fk.foreign_keys) !== 1) {
    return toMutationError(new Error('Refusing to write with foreign_keys disabled'))
  }
  const now = (options?.now ?? (() => new Date()))().toISOString()
  db.exec('BEGIN IMMEDIATE;')
  try {
    const { payload, result } = body({ db, now })
    const logged = db
      .prepare('INSERT INTO mutation_log (ts, action, payload_json, result) VALUES (?, ?, ?, ?)')
      .run(now, action, JSON.stringify(payload ?? {}), 'success')
    db.exec('COMMIT;')
    return { ...result, ok: true, mutationId: Number(logged.lastInsertRowid) }
  } catch (error) {
    try {
      db.exec('ROLLBACK;')
    } catch {
      // Transaction may already have been rolled back by SQLite.
    }
    return toMutationError(error)
  }
}

export interface TagRow {
  readonly id: number
  readonly name: string
  readonly normalized_name: string
  readonly revision: number
  readonly archived_at: string | null
  readonly merged_into_id: number | null
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function requireTag(db: DatabaseSync, tagId: unknown): TagRow {
  if (!isPositiveInteger(tagId)) {
    abort('INVALID_INPUT', `Invalid tag id: ${String(tagId)}`)
  }
  const row = db
    .prepare('SELECT id, name, normalized_name, revision, archived_at, merged_into_id FROM tags WHERE id = ?')
    .get(tagId) as TagRow | undefined
  if (!row) abort('TAG_NOT_FOUND', `Tag #${tagId} does not exist`)
  return row
}

export function assertTagRevision(tag: TagRow, expected: unknown): void {
  if (typeof expected !== 'number' || !Number.isSafeInteger(expected)) {
    abort('INVALID_INPUT', 'expectedRevision must be an integer')
  }
  if (Number(tag.revision) !== expected) {
    abort(
      'REVISION_CONFLICT',
      `Tag #${tag.id} changed (expected revision ${expected}, current ${tag.revision}); reload and retry`,
    )
  }
}

export function assertNotArchived(tag: TagRow): void {
  if (tag.archived_at !== null) abort('TAG_ARCHIVED', `Tag #${tag.id} "${tag.name}" is archived`)
}

/** Bump `revision` and `updated_at`; returns the new revision. */
export function bumpTagRevision(env: MutationEnv, tagId: number): number {
  env.db.prepare('UPDATE tags SET revision = revision + 1, updated_at = ? WHERE id = ?').run(env.now, tagId)
  const row = env.db.prepare('SELECT revision FROM tags WHERE id = ?').get(tagId) as { revision: number }
  return Number(row.revision)
}

/** Trim and validate a user-supplied tag or alias label; the text stays pure data. */
export function cleanLabel(raw: unknown, what: string): string {
  if (typeof raw !== 'string') abort('INVALID_INPUT', `${what} must be a string`)
  const trimmed = raw.trim()
  if (trimmed.length === 0) abort('INVALID_INPUT', `${what} must not be empty`)
  if (trimmed.length > MAX_NAME_LENGTH) abort('INVALID_INPUT', `${what} is longer than ${MAX_NAME_LENGTH} characters`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) abort('INVALID_INPUT', `${what} contains control characters`)
  return trimmed
}

export function normalizeLabel(label: string): string {
  return normalizeLookupKey(label)
}
