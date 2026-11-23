#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  compareTagStudioCandidates,
  formatComparisonMarkdown,
  formatInventoryMarkdown,
  inventoryTagStudioDatabase,
} from '../src/inventory/tagstudio-inventory.ts'

function printUsage(): void {
  console.log(`Usage:
  1. Compare multiple candidate ts_library.sqlite files (or directories containing them):
     node scripts/inventory-tagstudio.ts --compare <path-or-dir-1> [path-or-dir-2 ...] [--sanitize] [--json <out.json>] [--markdown <out.md>]

  2. Auto-compare candidates and run full read-only inventory on the best primary candidate:
     node scripts/inventory-tagstudio.ts --auto <path-or-dir-1> [path-or-dir-2 ...] [--root-id <id>] [--media-root <dir>] [--sanitize] [--json <out.json>] [--markdown <out.md>]

  3. Inventory a single read-only TagStudio SQLite copy:
     node scripts/inventory-tagstudio.ts <path-to-ts_library.sqlite> [--root-id <id>] [--media-root <dir>] [--sanitize] [--json <out.json>] [--markdown <out.md>]
`)
}

function writeOutputFile(targetPath: string, content: string): void {
  const resolved = path.resolve(targetPath)
  mkdirSync(path.dirname(resolved), { recursive: true })
  writeFileSync(resolved, content, 'utf8')
}

export function runCli(argv: readonly string[]): number {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    printUsage()
    return 0
  }

  let mode: 'single' | 'compare' | 'auto' = 'single'
  let sanitize = false
  let rootId = 'nas-main'
  let mediaRootDir: string | undefined
  let jsonOut: string | undefined
  let markdownOut: string | undefined
  const positional: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--compare') {
      mode = 'compare'
    } else if (arg === '--auto') {
      mode = 'auto'
    } else if (arg === '--sanitize') {
      sanitize = true
    } else if (arg === '--root-id') {
      rootId = argv[++i] ?? rootId
    } else if (arg === '--media-root') {
      mediaRootDir = argv[++i]
    } else if (arg === '--json') {
      jsonOut = argv[++i]
    } else if (arg === '--markdown') {
      markdownOut = argv[++i]
    } else if (arg.startsWith('--')) {
      console.error(`Unknown flag: ${arg}`)
      printUsage()
      return 1
    } else {
      positional.push(arg)
    }
  }

  if (positional.length === 0) {
    console.error('Error: At least one path argument is required.')
    printUsage()
    return 1
  }

  if (mode === 'compare') {
    const compReport = compareTagStudioCandidates(positional, { sanitize })
    const md = formatComparisonMarkdown(compReport)
    console.log(md)
    if (jsonOut) writeOutputFile(jsonOut, JSON.stringify(compReport, null, 2) + '\n')
    if (markdownOut) writeOutputFile(markdownOut, md)
    return 0
  }

  if (mode === 'auto') {
    const compReport = compareTagStudioCandidates(positional, { sanitize })
    const compMd = formatComparisonMarkdown(compReport)
    console.log(compMd)
    if (!compReport.recommendedPrimaryPath) {
      console.error('Error: No valid non-empty TagStudio candidate database found.')
      return 2
    }
    const invReport = inventoryTagStudioDatabase(compReport.recommendedPrimaryPath, {
      rootId,
      ...(mediaRootDir !== undefined ? { mediaRootDir } : {}),
      sanitize,
    })
    const invMd = formatInventoryMarkdown(invReport)
    console.log('\n---\n\n' + invMd)
    if (jsonOut) {
      writeOutputFile(
        jsonOut,
        JSON.stringify({ comparison: compReport, inventory: invReport }, null, 2) + '\n',
      )
    }
    if (markdownOut) {
      writeOutputFile(markdownOut, `${compMd}\n---\n\n${invMd}`)
    }
    return 0
  }

  // Single DB inventory mode (if multiple positional paths are given without --compare, hint or use --auto)
  if (positional.length > 1) {
    console.error('Error: Multiple paths provided without --compare or --auto.')
    return 1
  }

  const invReport = inventoryTagStudioDatabase(positional[0]!, {
    rootId,
    ...(mediaRootDir !== undefined ? { mediaRootDir } : {}),
    sanitize,
  })
  const invMd = formatInventoryMarkdown(invReport)
  console.log(invMd)
  if (jsonOut) writeOutputFile(jsonOut, JSON.stringify(invReport, null, 2) + '\n')
  if (markdownOut) writeOutputFile(markdownOut, invMd)
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = runCli(process.argv.slice(2))
  process.exit(code)
}
