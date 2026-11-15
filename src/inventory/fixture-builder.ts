import { copyFileSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Create a realistic, anonymized TagStudio v400 SQLite database fixture containing:
 * - Built-in tags (0=Archived, 1=Favorite) + custom tags
 * - Case-folded duplicate tag names (`Studio Alpha` vs `studio alpha`)
 * - Shared/ambiguous alias (`alpha` mapped to two tags, and alias colliding with tag name)
 * - Parent-child tag hierarchy + self-loop & broken parent orphans
 * - Entries covering:
 *   - Non-ASCII (Chinese/Japanese), spaces, commas in relative paths
 *   - Multi-file catalog numbers (`LIB-101` part 1 & part 2)
 *   - Catalog number in `text_fields` vs `filename` vs `directory` vs `tag`, plus 1 conflict
 *   - Dates in `datetime_fields` vs `text_fields` vs `path` vs `timestamps only`
 *   - Invalid/unmapped paths (`../escape.mkv`, `C:\\abs\\video.mp4`)
 *   - Orphaned rows in `tag_entries`, `tag_aliases`, `text_fields`, `datetime_fields`
 */
export function createAnonymizedTagStudioV400Fixture(dbFilePath: string): void {
  mkdirSync(path.dirname(path.resolve(dbFilePath)), { recursive: true })
  const db = new DatabaseSync(dbFilePath)
  try {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE versions (
        key VARCHAR PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO versions (key, value) VALUES ('INITIAL', 200), ('CURRENT', 400);

      CREATE TABLE namespaces (
        namespace VARCHAR PRIMARY KEY NOT NULL,
        name VARCHAR NOT NULL
      );
      INSERT INTO namespaces (namespace, name) VALUES ('tagstudio-standard', 'TagStudio Standard');

      CREATE TABLE tag_colors (
        slug VARCHAR NOT NULL,
        namespace VARCHAR NOT NULL REFERENCES namespaces(namespace),
        name VARCHAR,
        "primary" VARCHAR NOT NULL,
        secondary VARCHAR,
        color_border BOOLEAN NOT NULL DEFAULT 0,
        PRIMARY KEY (slug, namespace)
      );
      INSERT INTO tag_colors (slug, namespace, name, "primary", secondary, color_border)
      VALUES ('blue', 'tagstudio-standard', 'Blue', '#1d76db', NULL, 0);

      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR NOT NULL,
        shorthand VARCHAR,
        color_namespace VARCHAR,
        color_slug VARCHAR,
        is_category BOOLEAN DEFAULT 0,
        is_hidden BOOLEAN DEFAULT 0,
        icon VARCHAR,
        disambiguation_id INTEGER
      );

      CREATE TABLE tag_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR NOT NULL,
        tag_id INTEGER NOT NULL REFERENCES tags(id)
      );

      CREATE TABLE tag_parents (
        parent_id INTEGER NOT NULL REFERENCES tags(id),
        child_id INTEGER NOT NULL REFERENCES tags(id),
        PRIMARY KEY (parent_id, child_id)
      );

      CREATE TABLE category_exclusions (
        tag_id INTEGER NOT NULL REFERENCES tags(id),
        category_id INTEGER NOT NULL REFERENCES tags(id),
        PRIMARY KEY (tag_id, category_id)
      );

      CREATE TABLE entries (
        id INTEGER PRIMARY KEY,
        path VARCHAR NOT NULL UNIQUE,
        filename TEXT NOT NULL DEFAULT '',
        suffix VARCHAR NOT NULL,
        date_created DATETIME,
        date_modified DATETIME,
        date_added DATETIME
      );

      CREATE TABLE tag_entries (
        tag_id INTEGER NOT NULL,
        entry_id INTEGER NOT NULL,
        PRIMARY KEY (tag_id, entry_id)
      );

      CREATE TABLE text_field_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR NOT NULL,
        is_multiline BOOLEAN NOT NULL DEFAULT 0
      );
      INSERT INTO text_field_templates (name, is_multiline)
      VALUES ('Title', 0), ('Catalog', 0), ('Notes', 1);

      CREATE TABLE datetime_field_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR NOT NULL
      );
      INSERT INTO datetime_field_templates (name) VALUES ('Date'), ('Date Released');

      CREATE TABLE text_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR NOT NULL,
        entry_id INTEGER NOT NULL,
        value VARCHAR,
        is_multiline BOOLEAN NOT NULL DEFAULT 0
      );

      CREATE TABLE datetime_fields (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR NOT NULL,
        entry_id INTEGER NOT NULL,
        value VARCHAR
      );
    `)

    // Built-in tags (0 and 1) + custom tags (1000..1005)
    db.exec(`
      INSERT INTO tags (id, name, shorthand, is_category, is_hidden, disambiguation_id) VALUES
        (0, 'Archived', NULL, 0, 1, NULL),
        (1, 'Favorite', 'fav', 0, 0, NULL),
        (1000, 'Performer A', 'PA', 0, 0, NULL),
        (1001, 'Studio Alpha', 'SA', 1, 0, NULL),
        (1002, 'studio alpha', NULL, 0, 0, NULL),
        (1003, 'Performer B', 'PB', 0, 0, 99999),
        (1004, 'CAT-777', NULL, 0, 0, NULL);
    `)

    // Tag aliases:
    // - 'alpha' shared between 1001 and 1002
    // - 'Performer A' alias on 1003 colliding with tag 1000's name
    // - orphan alias referencing missing tag 88888
    db.exec(`
      INSERT INTO tag_aliases (id, name, tag_id) VALUES
        (1, 'alpha', 1001),
        (2, 'ALPHA', 1002),
        (3, 'performer a', 1003),
        (4, 'Actor_A_Alias', 1000),
        (5, 'OrphanAlias', 88888);
    `)

    // Tag parents: valid (1001 -> 1000), self-loop (1002 -> 1002), orphan parent (77777 -> 1000)
    db.exec(`
      INSERT INTO tag_parents (parent_id, child_id) VALUES
        (1001, 1000),
        (1002, 1002),
        (77777, 1000);
    `)

    // Entries covering edge cases
    db.exec(`
      INSERT INTO entries (id, path, filename, suffix, date_created, date_modified, date_added) VALUES
        (1, '2026/11/LIB-101/LIB-101_part1.mkv', 'LIB-101_part1.mkv', 'mkv', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'),
        (2, '2026/11/LIB-101/LIB-101_part2, special.mkv', 'LIB-101_part2, special.mkv', 'mkv', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'),
        (3, '中文目录/2026-10-15_ABP-909 特辑.mp4', '2026-10-15_ABP-909 特辑.mp4', 'mp4', '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z', '2026-10-16T00:00:00Z'),
        (4, 'archive/conflict_entry/SSIS-002.mkv', 'SSIS-002.mkv', 'mkv', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z'),
        (5, 'misc/untagged_clip.mp4', 'untagged_clip.mp4', 'mp4', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z'),
        (6, '../outside_escape.mkv', 'outside_escape.mkv', 'mkv', NULL, NULL, NULL);
    `)

    // Tag entries + orphans
    db.exec(`
      INSERT INTO tag_entries (tag_id, entry_id) VALUES
        (1, 1),
        (1000, 1),
        (1001, 1),
        (1000, 2),
        (1003, 3),
        (1004, 5),
        (1000, 99999),
        (88888, 1);
    `)

    // Text fields + datetime fields + orphans
    db.exec(`
      INSERT INTO text_fields (name, entry_id, value, is_multiline) VALUES
        ('Catalog', 1, 'lib-101', 0),
        ('Title', 1, 'Library Item 101 Part 1', 0),
        ('Catalog', 2, 'LIB-101', 0),
        ('Catalog', 4, 'SSIS-999', 0),
        ('Notes', 5, 'Released on 2026-08-10', 1),
        ('Title', 99999, 'Orphan Text Field', 0);

      INSERT INTO datetime_fields (name, entry_id, value) VALUES
        ('Date Released', 1, '2026-11-01'),
        ('Date Released', 2, '2026-11-01'),
        ('Date', 99999, '2026-01-01');
    `)
  } finally {
    db.close()
  }
}

/**
 * Create a suite of multiple candidate `.sqlite` files sharing identical `mtime`
 * to test Multi-Candidate Identification & Comparison (`B2`):
 * - `primary/.TagStudio/ts_library.sqlite`: Full v400 database (6 entries)
 * - `copy_of_primary/ts_library.sqlite`: Byte-for-byte duplicate of primary
 * - `older_backup/ts_library.sqlite`: Older v201 database with only 2 entries
 * - `accidental_empty/.TagStudio/ts_library.sqlite`: Newly initialized TagStudio DB with 0 entries
 */
export function createMultiCandidateFixtureSet(baseDir: string): {
  readonly primaryPath: string
  readonly duplicatePath: string
  readonly olderBackupPath: string
  readonly emptyInitPath: string
  readonly mediaRootDir: string
} {
  const primaryPath = path.join(baseDir, 'cand_a_primary', '.TagStudio', 'ts_library.sqlite')
  const duplicatePath = path.join(baseDir, 'cand_b_copy', '.TagStudio', 'ts_library.sqlite')
  const olderBackupPath = path.join(baseDir, 'cand_c_backup', 'ts_library.sqlite')
  const emptyInitPath = path.join(baseDir, 'cand_d_empty_subdir', '.TagStudio', 'ts_library.sqlite')
  const mediaRootDir = path.join(baseDir, 'mock_nas_media')

  createAnonymizedTagStudioV400Fixture(primaryPath)
  mkdirSync(path.dirname(duplicatePath), { recursive: true })
  copyFileSync(primaryPath, duplicatePath)

  // Create older snapshot (2 entries)
  mkdirSync(path.dirname(olderBackupPath), { recursive: true })
  const olderDb = new DatabaseSync(olderBackupPath)
  try {
    olderDb.exec(`
      CREATE TABLE versions (key VARCHAR PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO versions (key, value) VALUES ('INITIAL', 200), ('CURRENT', 300);
      CREATE TABLE tags (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL, shorthand VARCHAR);
      INSERT INTO tags (id, name, shorthand) VALUES (0, 'Archived', NULL), (1, 'Favorite', 'fav'), (1000, 'Performer A', 'PA');
      CREATE TABLE entries (id INTEGER PRIMARY KEY, path VARCHAR NOT NULL UNIQUE, filename TEXT NOT NULL DEFAULT '', suffix VARCHAR NOT NULL);
      INSERT INTO entries (id, path, filename, suffix) VALUES
        (1, '2026/11/LIB-101/LIB-101_part1.mkv', 'LIB-101_part1.mkv', 'mkv'),
        (2, '2026/11/LIB-101/LIB-101_part2, special.mkv', 'LIB-101_part2, special.mkv', 'mkv');
      CREATE TABLE tag_entries (tag_id INTEGER NOT NULL, entry_id INTEGER NOT NULL, PRIMARY KEY (tag_id, entry_id));
      INSERT INTO tag_entries (tag_id, entry_id) VALUES (1000, 1);
    `)
  } finally {
    olderDb.close()
  }

  // Create empty initialized TagStudio DB (0 entries, only seed tags 0 & 1)
  mkdirSync(path.dirname(emptyInitPath), { recursive: true })
  const emptyDb = new DatabaseSync(emptyInitPath)
  try {
    emptyDb.exec(`
      CREATE TABLE versions (key VARCHAR PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO versions (key, value) VALUES ('INITIAL', 400), ('CURRENT', 400);
      CREATE TABLE tags (id INTEGER PRIMARY KEY, name VARCHAR NOT NULL);
      INSERT INTO tags (id, name) VALUES (0, 'Archived'), (1, 'Favorite');
      CREATE TABLE entries (id INTEGER PRIMARY KEY, path VARCHAR NOT NULL UNIQUE, filename TEXT NOT NULL DEFAULT '', suffix VARCHAR NOT NULL);
      CREATE TABLE tag_entries (tag_id INTEGER NOT NULL, entry_id INTEGER NOT NULL, PRIMARY KEY (tag_id, entry_id));
    `)
  } finally {
    emptyDb.close()
  }

  // Force identical mtime across all 4 candidate files to simulate batch copy
  const fixedTime = new Date('2026-11-10T12:00:00.000Z')
  for (const p of [primaryPath, duplicatePath, olderBackupPath, emptyInitPath]) {
    utimesSync(p, fixedTime, fixedTime)
  }

  // Create mock media files on disk for entries 1 and 3 (leaving 2, 4, 5 missing to test diskCheck)
  const file1 = path.join(mediaRootDir, '2026', '11', 'LIB-101', 'LIB-101_part1.mkv')
  const file3 = path.join(mediaRootDir, '中文目录', '2026-10-15_ABP-909 特辑.mp4')
  mkdirSync(path.dirname(file1), { recursive: true })
  mkdirSync(path.dirname(file3), { recursive: true })
  writeFileSync(file1, 'mock-video-1')
  writeFileSync(file3, 'mock-video-3')

  return {
    primaryPath,
    duplicatePath,
    olderBackupPath,
    emptyInitPath,
    mediaRootDir,
  }
}

/**
 * Create an extended anonymized TagStudio v400 fixture specifically exercising all M2 import rules (`D2.1..D2.5`):
 * - All entries/tags/aliases/orphans from `createAnonymizedTagStudioV400Fixture`
 * - Entry 7 (`Thumbs.db`) & Entry 8 (`.vsmeta`) with tag associations -> exercises `D2.5` sidecar filtering + `D2.1` `skippedSidecarTagEntries`
 * - Entry 9 (`2026/11/FC2-1476760/video.mp4`) tagged with both duplicate tags `1001` (`Studio Alpha`) and `1002` (`studio alpha`) -> exercises `D2.2` parent-dir catalog normalization (`FC2-PPV-1476760`) and `D2.4` `deduplicatedAfterTagMerge`
 * - Tag `1005` (`Performer C`) sharing alias `Actor_A_Alias` with Tag `1000` -> exercises shared/ambiguous alias reporting across distinct tags
 */
export function createM2ImportTagStudioFixture(dbFilePath: string): void {
  createAnonymizedTagStudioV400Fixture(dbFilePath)
  const db = new DatabaseSync(dbFilePath)
  try {
    db.exec(`
      INSERT INTO tags (id, name, shorthand, is_category, is_hidden, disambiguation_id) VALUES
        (1005, 'Performer C', 'PC', 0, 0, NULL);

      INSERT INTO tag_aliases (id, name, tag_id) VALUES
        (6, 'actor_a_alias', 1005);

      INSERT INTO entries (id, path, filename, suffix, date_created, date_modified, date_added) VALUES
        (7, '2026/11/LIB-101/Thumbs.db', 'Thumbs.db', 'db', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'),
        (8, '2026/11/LIB-101/LIB-101_part1.mkv.vsmeta', 'LIB-101_part1.mkv.vsmeta', 'vsmeta', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'),
        (9, '2026/11/FC2-1476760/video.mp4', 'video.mp4', 'mp4', '2026-11-03T00:00:00Z', '2026-11-03T00:00:00Z', '2026-11-04T00:00:00Z');

      INSERT INTO tag_entries (tag_id, entry_id) VALUES
        (1000, 7),
        (1001, 8),
        (1001, 9),
        (1002, 9);
    `)
  } finally {
    db.close()
  }
}
