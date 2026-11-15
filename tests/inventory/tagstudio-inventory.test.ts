import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { runCli } from '../../scripts/inventory-tagstudio.ts'
import { createMultiCandidateFixtureSet } from '../../src/inventory/fixture-builder.ts'
import {
  compareTagStudioCandidates,
  extractCatalogNumber,
  extractIsoDate,
  inventoryTagStudioDatabase,
  normalizeRelativeMediaPath,
  snapshotFileFingerprint,
} from '../../src/inventory/tagstudio-inventory.ts'

describe('TagStudio Read-Only Inventory & Multi-Candidate Comparator (Issue #2)', () => {
  let tempRoot: string
  let fixtures: ReturnType<typeof createMultiCandidateFixtureSet>

  before(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), 'dsh-media-inv-test-'))
    fixtures = createMultiCandidateFixtureSet(tempRoot)
  })

  after(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it('B1 & B2: identifies the primary database among multiple candidates with identical mtime without changing any source bytes', () => {
    const beforeSnapshots = [
      fixtures.primaryPath,
      fixtures.duplicatePath,
      fixtures.olderBackupPath,
      fixtures.emptyInitPath,
    ].map(p => snapshotFileFingerprint(p))

    // Verify all 4 candidates start with the exact same mtime
    const distinctMtimes = new Set(beforeSnapshots.map(s => s.mtimeIso))
    assert.equal(distinctMtimes.size, 1, 'All candidates in fixture must share identical mtime')

    const report = compareTagStudioCandidates([tempRoot])
    assert.equal(report.totalCandidates, 4)
    assert.equal(report.uniqueSha256Count, 3)
    assert.equal(report.recommendedPrimaryPath, fixtures.primaryPath)
    assert.equal(report.duplicateGroups.length, 1)
    assert.deepEqual(
      new Set(report.duplicateGroups[0]?.paths),
      new Set([fixtures.primaryPath, fixtures.duplicatePath]),
    )

    const byPath = new Map(report.candidates.map(c => [c.path, c]))
    assert.equal(byPath.get(fixtures.primaryPath)?.classification, 'PRIMARY_CANDIDATE')
    assert.equal(byPath.get(fixtures.duplicatePath)?.classification, 'DUPLICATE_OF_PRIMARY')
    assert.equal(byPath.get(fixtures.olderBackupPath)?.classification, 'OLDER_OR_SMALLER_SNAPSHOT')
    assert.equal(byPath.get(fixtures.emptyInitPath)?.classification, 'EMPTY_OR_SEED_ONLY')

    // Verify byte-for-byte + mtime immutability after comparison
    const afterSnapshots = [
      fixtures.primaryPath,
      fixtures.duplicatePath,
      fixtures.olderBackupPath,
      fixtures.emptyInitPath,
    ].map(p => snapshotFileFingerprint(p))
    assert.deepEqual(afterSnapshots, beforeSnapshots)
  })

  it('B1 & B3: inventories entities, fields, versions, and all orphan categories while preserving SHA-256', () => {
    const before = snapshotFileFingerprint(fixtures.primaryPath)
    const report = inventoryTagStudioDatabase(fixtures.primaryPath, {
      rootId: 'nas-main',
      mediaRootDir: fixtures.mediaRootDir,
    })
    const after = snapshotFileFingerprint(fixtures.primaryPath)

    assert.equal(report.source.unchanged, true)
    assert.equal(report.source.sha256Before, before.sha256)
    assert.equal(report.source.sha256After, after.sha256)
    assert.equal(before.mtimeMs, after.mtimeMs)
    assert.equal(report.source.dbVersion.current, 400)
    assert.equal(report.source.dbVersion.initial, 200)
    assert.equal(report.source.dbVersion.source, 'versions')

    assert.equal(report.counts.entries, 6)
    assert.equal(report.counts.tags, 7)
    assert.equal(report.counts.customTags, 5)
    assert.equal(report.counts.tagAliases, 5)
    assert.equal(report.counts.tagEntries, 8)
    assert.equal(report.counts.tagParents, 3)
    assert.equal(report.counts.textFields, 6)
    assert.equal(report.counts.datetimeFields, 3)

    // Orphans
    assert.equal(report.orphans.tagEntriesMissingEntry.length, 1)
    assert.equal(report.orphans.tagEntriesMissingEntry[0]?.entryId, 99999)
    assert.equal(report.orphans.tagEntriesMissingTag.length, 1)
    assert.equal(report.orphans.tagEntriesMissingTag[0]?.tagId, 88888)
    assert.equal(report.orphans.tagAliasesMissingTag.length, 1)
    assert.equal(report.orphans.tagParentsMissingParent.length, 1)
    assert.equal(report.orphans.tagParentsSelfLoop.length, 1)
    assert.equal(report.orphans.textFieldsMissingEntry.length, 1)
    assert.equal(report.orphans.datetimeFieldsMissingEntry.length, 1)
    assert.equal(report.orphans.tagsMissingDisambiguation.length, 1)
  })

  it('B4: discovers catalog number and media date sources, conflicts, and multi-file catalog numbers', () => {
    const report = inventoryTagStudioDatabase(fixtures.primaryPath)
    const cat = report.catalogAndDateDiscovery.catalogSources
    const dt = report.catalogAndDateDiscovery.dateSources

    assert.equal(cat.inTextFields, 3) // entries 1, 2, 4
    assert.deepEqual(cat.textFieldNamesWithCatalog, ['Catalog'])
    assert.equal(cat.inTagNamesOrAliases, 1) // entry 5 via tag CAT-777
    assert.equal(cat.inFilename, 4) // entries 1, 2, 3, 4
    assert.equal(cat.inDirectoryPath, 2) // entries 1, 2 (in 2026/11/LIB-101)
    assert.equal(cat.entriesWithAnyCatalogCandidate, 5) // entries 1..5
    assert.equal(cat.entriesWithoutCatalogCandidate, 1) // entry 6

    // Conflict on entry 4: field says SSIS-999, filename says SSIS-002
    assert.equal(cat.conflictingCatalogEntries.length, 1)
    assert.equal(cat.conflictingCatalogEntries[0]?.entryId, 4)
    assert.equal(cat.conflictingCatalogEntries[0]?.fieldCatalog, 'SSIS-999')
    assert.equal(cat.conflictingCatalogEntries[0]?.pathCatalog, 'SSIS-002')

    // Multi-file catalog LIB-101 across entries 1 and 2
    assert.equal(cat.multiFileCatalogs.length, 1)
    assert.equal(cat.multiFileCatalogs[0]?.catalogNumber, 'LIB-101')
    assert.deepEqual(cat.multiFileCatalogs[0]?.entryIds, [1, 2])

    // Date sources
    assert.equal(dt.inDatetimeFields, 2) // entries 1, 2
    assert.equal(dt.inTextFields, 1) // entry 5 ('Released on 2026-08-10')
    assert.equal(dt.inFilenameOrPath, 1) // entry 3 ('2026-10-15_ABP-909 特辑.mp4')
    assert.equal(dt.inEntryTimestampsOnly, 1) // entry 4
    assert.equal(dt.entriesWithoutSemanticDate, 2) // entries 4 and 6
  })

  it('B5: detects duplicate tag names, shared aliases, alias collisions, invalid paths, and missing files', () => {
    const report = inventoryTagStudioDatabase(fixtures.primaryPath, {
      rootId: 'nas-main',
      mediaRootDir: fixtures.mediaRootDir,
    })

    // Case-folded duplicate tags: Studio Alpha (1001) vs studio alpha (1002)
    assert.equal(report.tagAndAliasAnomalies.duplicateTagNamesCaseFolded.length, 1)
    assert.equal(report.tagAndAliasAnomalies.duplicateTagNamesCaseFolded[0]?.normalizedName, 'studio alpha')

    // Shared alias: 'alpha' on 1001 and 1002
    assert.equal(report.tagAndAliasAnomalies.sharedAliases.length, 1)
    assert.equal(report.tagAndAliasAnomalies.sharedAliases[0]?.normalizedAlias, 'alpha')

    // Alias colliding with another tag's name: 'performer a' on tag 1003 colliding with tag 1000
    assert.equal(report.tagAndAliasAnomalies.aliasTagNameCollisions.length, 1)
    assert.equal(report.tagAndAliasAnomalies.aliasTagNameCollisions[0]?.collidingTagId, 1000)

    // Path mapping & traversal rejection
    assert.equal(report.pathMapping.validRelativePaths, 5)
    assert.equal(report.pathMapping.unmappedOrInvalidPaths.length, 1)
    assert.equal(report.pathMapping.unmappedOrInvalidPaths[0]?.entryId, 6)
    assert.equal(report.pathMapping.unmappedOrInvalidPaths[0]?.reason, 'PARENT_TRAVERSAL_SEGMENT')

    // Disk check against mock_nas_media
    assert.equal(report.pathMapping.diskCheck.checked, true)
    assert.equal(report.pathMapping.diskCheck.existingFiles, 2)
    assert.equal(report.pathMapping.diskCheck.missingFiles, 3)
  })

  it('B5 & B6: supports sanitized output and CLI --auto mode', () => {
    const jsonOut = path.join(tempRoot, 'out', 'auto-report.json')
    const mdOut = path.join(tempRoot, 'out', 'auto-report.md')

    const exitCode = runCli([
      '--auto',
      tempRoot,
      '--sanitize',
      '--json',
      jsonOut,
      '--markdown',
      mdOut,
    ])
    assert.equal(exitCode, 0)

    const parsed = JSON.parse(readFileSync(jsonOut, 'utf8')) as {
      comparison: { recommendedPrimaryPath: string }
      inventory: { sanitized: boolean; pathMapping: { sampleMappings: Array<{ filename: string }> } }
    }
    assert.equal(parsed.comparison.recommendedPrimaryPath, fixtures.primaryPath)
    assert.equal(parsed.inventory.sanitized, true)
    // Ensure sanitized filenames do not leak original titles like 'ABP-909 特辑'
    const markdownText = readFileSync(mdOut, 'utf8')
    assert.equal(markdownText.includes('特辑'), false)
    assert.equal(markdownText.includes('TagStudio Read-Only Inventory Report'), true)
  })

  it('unit helpers: normalizeRelativeMediaPath, extractCatalogNumber, extractIsoDate handle edge cases', () => {
    assert.equal(extractCatalogNumber('fc2 ppv 1234567'), 'FC2-PPV-1234567')
    assert.equal(extractCatalogNumber('2026-10-15_abp_909a.mp4'), 'ABP-909A')
    assert.equal(extractCatalogNumber('UTF-8 text SHA-256'), null)

    assert.equal(extractIsoDate('2026.11.05'), '2026-11-05')
    assert.equal(extractIsoDate('release_20261105_cut.mkv'), '2026-11-05')

    assert.equal(normalizeRelativeMediaPath('C:\\Users\\test\\a.mp4').ok, false)
    assert.equal(normalizeRelativeMediaPath('\\\\NAS\\Share\\a.mp4').ok, false)
    assert.equal(normalizeRelativeMediaPath('a/b/../../escape.mp4').ok, false)
    const valid = normalizeRelativeMediaPath('2026/11/LIB-101/part 1, a.mkv')
    assert.equal(valid.ok, true)
    assert.equal(valid.relativeWin32Path, '2026\\11\\LIB-101\\part 1, a.mkv')
  })
})
