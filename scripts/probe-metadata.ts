#!/usr/bin/env node
/**
 * Read-only metadata probe CLI for comparing anonymous vs cookie-authenticated
 * responses from FC2CMADB / FC2PPVDB without touching any local SQLite database (Issue #27).
 *
 * Usage:
 *   node --experimental-strip-types scripts/probe-metadata.ts <videoId> [--cmadb-cookie=...] [--ppvdb-cookie=...]
 */
import { MetadataFetcher } from '../src/ingestion/metadata-fetcher.ts';

function parseArgs(argv: readonly string[]): {
  readonly videoId: string;
  readonly cmadbCookie: string;
  readonly ppvdbCookie: string;
} {
  let videoId = '';
  let cmadbCookie = process.env.DSH_CMADB_COOKIE ?? '';
  let ppvdbCookie = process.env.DSH_PPVDB_COOKIE ?? '';
  for (const arg of argv) {
    if (arg.startsWith('--cmadb-cookie=')) {
      cmadbCookie = arg.slice('--cmadb-cookie='.length);
    } else if (arg.startsWith('--ppvdb-cookie=')) {
      ppvdbCookie = arg.slice('--ppvdb-cookie='.length);
    } else if (!arg.startsWith('-') && !videoId) {
      videoId = arg.trim();
    }
  }
  return { videoId, cmadbCookie, ppvdbCookie };
}

async function main(): Promise<void> {
  const { videoId, cmadbCookie, ppvdbCookie } = parseArgs(process.argv.slice(2));
  if (!videoId) {
    console.error('Usage: node --experimental-strip-types scripts/probe-metadata.ts <videoId> [--cmadb-cookie=...] [--ppvdb-cookie=...]');
    process.exit(1);
  }

  const anonFetcher = new MetadataFetcher({});
  const anonRes = await anonFetcher.lookup(videoId);
  const summary: Record<string, unknown> = {
    videoId,
    anonymous: anonRes,
  };

  if (cmadbCookie || ppvdbCookie) {
    const authFetcher = new MetadataFetcher({ cmadbCookie, ppvdbCookie });
    summary.authenticated = await authFetcher.lookup(videoId);
  }

  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
