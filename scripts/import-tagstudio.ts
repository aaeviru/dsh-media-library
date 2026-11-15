import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabaseBackup, restoreDatabaseFromBackup } from '../src/db/backup.ts'
import {
  importTagStudioDatabase,
  type TagStudioImportReport,
} from '../src/import/tagstudio-importer.ts'

export function formatImportReportSummary(report: TagStudioImportReport): string {
  const r = report.reconciliation
  const lines: string[] = [
    `# TagStudio Import Report (${report.mode.toUpperCase()} — ${report.status})`,
    `- Source SHA-256 Before: ${report.source.sha256Before}`,
    `- Source SHA-256 After:  ${report.source.sha256After} (unchanged=${report.source.unchanged})`,
    `- Root: ${report.rootId} -> ${report.canonicalUncRoot}`,
    `- All Reconciled: ${r.allReconciled}`,
    `- Entries:     imported=${r.entries.importedEntries} + skippedSidecar=${r.entries.skippedSidecarEntries} + unmapped=${r.entries.unmappedEntries} + dupPath=${r.entries.duplicatePathEntries} == source=${r.entries.sourceEntries} (reconciled=${r.entries.reconciled})`,
    `- Tags:        imported=${r.tags.importedTags} + mergedDuplicate=${r.tags.mergedDuplicateTags} == source=${r.tags.sourceTags} (reconciled=${r.tags.reconciled})`,
    `- TagAliases:  imported=${r.tagAliases.importedTagAliases} + dedup=${r.tagAliases.deduplicatedTagAliases} + orphaned=${r.tagAliases.orphanedTagAliases} == source=${r.tagAliases.sourceTagAliases} (reconciled=${r.tagAliases.reconciled})`,
    `- TagParents:  imported=${r.tagParents.importedTagParents} + dedup=${r.tagParents.deduplicatedTagParents} + selfLoop=${r.tagParents.selfLoopTagParents} + orphaned=${r.tagParents.orphanedTagParents} == source=${r.tagParents.sourceTagParents} (reconciled=${r.tagParents.reconciled})`,
    `- TagEntries:  imported=${r.tagEntries.importedMediaTags} + dedupMerge=${r.tagEntries.deduplicatedAfterTagMerge} + skippedSidecar=${r.tagEntries.skippedSidecarTagEntries} + orphaned=${r.tagEntries.orphanedTagEntries} == source=${r.tagEntries.sourceTagEntries} (reconciled=${r.tagEntries.reconciled})`,
    `- TextFields:  imported=${r.textFields.importedTextFields} + skippedOrOrphan=${r.textFields.skippedOrOrphanedTextFields} == source=${r.textFields.sourceTextFields} (reconciled=${r.textFields.reconciled})`,
    `- Health:      ok=${report.targetHealth.ok} (fkErrors=${report.targetHealth.foreignKeyErrors.length}, integrity=${report.targetHealth.integrityCheck.join(',')})`,
  ]
  return lines.join('\n')
}

export async function runImportCli(argv: readonly string[]): Promise<number> {
  let mode: 'dry-run' | 'import' | 'backup' | 'restore-check' = 'dry-run'
  let sourceDbPath = ''
  let targetDbPath: string | undefined
  let rootId = 'nas-main'
  let canonicalUncRoot = '\\\\NAS\\Media'
  let mediaRootDir: string | undefined
  let force = false
  let sanitize = false
  let jsonOut = ''
  let backupOut = ''
  let restoreTo = ''

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--dry-run') {
      mode = 'dry-run'
    } else if (arg === '--import') {
      mode = 'import'
    } else if (arg === '--backup') {
      mode = 'backup'
    } else if (arg === '--restore-check') {
      mode = 'restore-check'
    } else if (arg === '--source' && argv[i + 1]) {
      sourceDbPath = argv[++i]!
    } else if (arg === '--target' && argv[i + 1]) {
      targetDbPath = argv[++i]!
    } else if (arg === '--root-id' && argv[i + 1]) {
      rootId = argv[++i]!
    } else if (arg === '--unc-root' && argv[i + 1]) {
      canonicalUncRoot = argv[++i]!
    } else if (arg === '--media-root-dir' && argv[i + 1]) {
      mediaRootDir = argv[++i]!
    } else if (arg === '--force') {
      force = true
    } else if (arg === '--sanitize') {
      sanitize = true
    } else if (arg === '--json' && argv[i + 1]) {
      jsonOut = argv[++i]!
    } else if (arg === '--out' && argv[i + 1]) {
      backupOut = argv[++i]!
    } else if (arg === '--backup-file' && argv[i + 1]) {
      backupOut = argv[++i]!
    } else if (arg === '--restore-to' && argv[i + 1]) {
      restoreTo = argv[++i]!
    }
  }

  if (mode === 'backup') {
    if (!targetDbPath || !backupOut) {
      console.error('Usage: --backup --target <db-path> --out <backup-path>')
      return 1
    }
    const res = await createDatabaseBackup(targetDbPath, backupOut)
    console.log(JSON.stringify(res, null, 2))
    return 0
  }

  if (mode === 'restore-check') {
    if (!backupOut || !restoreTo) {
      console.error('Usage: --restore-check --backup-file <backup-path> --restore-to <db-path>')
      return 1
    }
    const res = await restoreDatabaseFromBackup(backupOut, restoreTo)
    console.log(JSON.stringify(res, null, 2))
    return res.countsMatch && res.health.ok ? 0 : 1
  }

  if (!sourceDbPath) {
    console.error('Usage: --dry-run | --import --source <ts_library.sqlite> [--target <library.sqlite3>]')
    return 1
  }

  const report = await importTagStudioDatabase({
    sourceDbPath,
    targetDbPath,
    mode,
    rootId,
    canonicalUncRoot,
    mediaRootDir,
    force,
    sanitizeReport: sanitize,
  })

  if (jsonOut) {
    const resolvedJson = path.resolve(jsonOut)
    mkdirSync(path.dirname(resolvedJson), { recursive: true })
    writeFileSync(resolvedJson, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  }

  console.log(formatImportReportSummary(report))
  return report.reconciliation.allReconciled && report.targetHealth.ok ? 0 : 1
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  runImportCli(process.argv.slice(2))
    .then(code => {
      process.exitCode = code
    })
    .catch(err => {
      console.error(err)
      process.exitCode = 1
    })
}
