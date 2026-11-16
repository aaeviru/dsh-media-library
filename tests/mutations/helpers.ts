import { DatabaseSync } from 'node:sqlite'
import { migrateDatabase, openMediaLibraryDatabase } from '../../src/db/schema.ts'

export interface Seeded {
  readonly db: DatabaseSync
  tag(name: string): number
  media(count: number): number[]
  assoc(mediaId: number, tagId: number, source?: string): void
  alias(tagId: number, alias: string): void
  edge(tagId: number, parentId: number): void
  snapshot(): string
  logCount(): number
}

/** In-memory, fully migrated (v3) database with foreign keys ON. */
export async function openSeededDb(): Promise<Seeded> {
  const { db } = openMediaLibraryDatabase({ dbPath: ':memory:' })
  await migrateDatabase(db)
  db.exec(
    `INSERT INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
     VALUES ('nas-main', 'NAS', '\\\\NAS\\Media', 1, '2026-11-15T00:00:00Z')`,
  )
  let nextMedia = 1
  return {
    db,
    tag(name) {
      const norm = name.trim().toLowerCase()
      const res = db
        .prepare(
          `INSERT INTO tags (name, normalized_name, created_at, updated_at) VALUES (?, ?, 'now', 'now')`,
        )
        .run(name, norm)
      return Number(res.lastInsertRowid)
    },
    media(count) {
      const ids: number[] = []
      for (let i = 0; i < count; i++) {
        const id = nextMedia++
        db.prepare(
          `INSERT INTO media_files (id, root_id, relative_path, filename, extension, media_date)
           VALUES (?, 'nas-main', ?, ?, 'mkv', '2026-01-01')`,
        ).run(id, `m${id}.mkv`, `m${id}.mkv`)
        ids.push(id)
      }
      return ids
    },
    assoc(mediaId, tagId, source = 'tagstudio-import') {
      db.prepare('INSERT INTO media_tags (media_id, tag_id, source, created_at) VALUES (?, ?, ?, ?)').run(
        mediaId,
        tagId,
        source,
        'now',
      )
    },
    alias(tagId, alias) {
      db.prepare('INSERT INTO tag_aliases (tag_id, alias, normalized_alias) VALUES (?, ?, ?)').run(
        tagId,
        alias,
        alias.trim().toLowerCase(),
      )
    },
    edge(tagId, parentId) {
      db.prepare('INSERT INTO tag_parents (tag_id, parent_tag_id) VALUES (?, ?)').run(tagId, parentId)
    },
    snapshot() {
      const tables = ['tags', 'tag_aliases', 'tag_parents', 'media_tags', 'media_files', 'mutation_log']
      return JSON.stringify(tables.map(t => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()))
    },
    logCount() {
      return Number((db.prepare('SELECT COUNT(*) AS c FROM mutation_log').get() as { c: number }).c)
    },
  }
}

export function tagRow(db: DatabaseSync, id: number) {
  return db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as {
    id: number
    name: string
    normalized_name: string
    revision: number
    archived_at: string | null
    merged_into_id: number | null
  }
}
