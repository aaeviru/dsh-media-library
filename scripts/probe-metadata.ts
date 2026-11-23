#!/usr/bin/env node
/**
 * Read-only metadata probe CLI for comparing raw HTTP responses vs parsed output
 * (anonymous vs cookie-authenticated) from FC2CMADB and FC2PPVDB without touching
 * any local SQLite database (Issue #27).
 *
 * Usage:
 *   node --experimental-strip-types scripts/probe-metadata.ts <videoId> [--cmadb-cookie=...] [--ppvdb-cookie=...] [--raw-limit=2000]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseCmadbHtml, parsePpvdbHtml } from '../src/ingestion/metadata-fetcher.ts';

interface ProviderProbeResult {
  readonly url: string;
  readonly authenticated: boolean;
  readonly httpStatus: number | null;
  readonly rawLength: number;
  readonly rawSnippet: string;
  readonly parsed: unknown;
  readonly error: string | null;
}

function parseArgs(argv: readonly string[]): {
  readonly videoId: string;
  readonly cmadbCookie: string;
  readonly ppvdbCookie: string;
  readonly rawLimit: number;
} {
  let videoId = '';
  let cmadbCookie = process.env.DSH_CMADB_COOKIE ?? '';
  let ppvdbCookie = process.env.DSH_PPVDB_COOKIE ?? '';
  let rawLimit = 2000;
  for (const arg of argv) {
    if (arg.startsWith('--cmadb-cookie=')) {
      cmadbCookie = arg.slice('--cmadb-cookie='.length);
    } else if (arg.startsWith('--ppvdb-cookie=')) {
      ppvdbCookie = arg.slice('--ppvdb-cookie='.length);
    } else if (arg.startsWith('--raw-limit=')) {
      const n = Number(arg.slice('--raw-limit='.length));
      if (Number.isFinite(n) && n >= 0) rawLimit = Math.trunc(n);
    } else if (!arg.startsWith('-') && !videoId) {
      videoId = arg.trim();
    }
  }
  return { videoId, cmadbCookie, ppvdbCookie, rawLimit };
}

async function probeUrl(
  url: string,
  cookie: string,
  parse: (html: string) => unknown,
  rawLimit: number,
): Promise<ProviderProbeResult> {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-media-library-probe',
    Accept: 'text/html,application/xhtml+xml',
  };
  if (cookie) headers.Cookie = cookie;
  try {
    const res = await fetch(url, { headers, redirect: 'follow' });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = parse(text);
    } catch (parseErr) {
      parsed = { parseError: parseErr instanceof Error ? parseErr.message : String(parseErr) };
    }
    return {
      url,
      authenticated: Boolean(cookie),
      httpStatus: res.status,
      rawLength: text.length,
      rawSnippet: rawLimit > 0 ? text.slice(0, rawLimit) : '',
      parsed,
      error: null,
    };
  } catch (err) {
    return {
      url,
      authenticated: Boolean(cookie),
      httpStatus: null,
      rawLength: 0,
      rawSnippet: '',
      parsed: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const { videoId, cmadbCookie, ppvdbCookie, rawLimit } = parseArgs(process.argv.slice(2));
  if (!videoId) {
    console.error(
      'Usage: node --experimental-strip-types scripts/probe-metadata.ts <videoId> [--cmadb-cookie=...] [--ppvdb-cookie=...] [--raw-limit=2000]',
    );
    process.exit(1);
  }

  const encoded = encodeURIComponent(videoId);
  const cmadbUrl = `https://fc2cmadb.com/articles/${encoded}`;
  const ppvdbUrl = `https://fc2ppvdb.com/articles/${encoded}`;

  const output: Record<string, unknown> = {
    videoId,
    fc2cmadb: {
      anonymous: await probeUrl(cmadbUrl, '', (html) => parseCmadbHtml(html, videoId, cmadbUrl), rawLimit),
      ...(cmadbCookie
        ? { authenticated: await probeUrl(cmadbUrl, cmadbCookie, (html) => parseCmadbHtml(html, videoId, cmadbUrl), rawLimit) }
        : {}),
    },
    fc2ppvdb: {
      anonymous: await probeUrl(ppvdbUrl, '', (html) => parsePpvdbHtml(html, videoId, ppvdbUrl), rawLimit),
      ...(ppvdbCookie
        ? { authenticated: await probeUrl(ppvdbUrl, ppvdbCookie, (html) => parsePpvdbHtml(html, videoId, ppvdbUrl), rawLimit) }
        : {}),
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main();
}
