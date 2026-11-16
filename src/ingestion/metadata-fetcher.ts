import type { FetchedMetadataCandidate } from '../types.ts';

export interface ParsedFc2Code {
  readonly videoId: string;
  readonly suffix: string;
  readonly code: string;
}

export interface ProviderMetadata {
  readonly videoId: string;
  readonly title: string;
  readonly writer: string;
  readonly candidateTags: readonly string[];
  readonly sourceUrl: string;
  readonly provider: 'FC2CMADB' | 'FC2PPVDB';
}

export interface ProviderLookupResult {
  readonly metadata: ProviderMetadata | null;
  readonly category: FetchedMetadataCandidate['category'];
  readonly reason: string;
  readonly sourceUrl: string;
}

const FC2_RE = /(?<![A-Z0-9])FC2[-_ ]?PPV[-_ ]?(\d{5,9})(?:[-_](?:pt)?(\d{1,3}))?(?![A-Z0-9])/i;

export function parseFc2Code(text: string): ParsedFc2Code | null {
  const match = FC2_RE.exec(text);
  if (!match) return null;
  const videoId = match[1]!;
  const suffix = match[2] ?? '';
  return {
    videoId,
    suffix,
    code: `FC2-PPV-${videoId}${suffix ? `-${suffix}` : ''}`,
  };
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

export function cleanMetadataText(text: string | null | undefined): string {
  if (!text) return '';
  return decodeHtmlEntities(text)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse FC2CMADB HTML (`<script data-page="app" type="application/json">...`).
 * Does not bypass login pages; reports `auth_or_blocked` cleanly.
 */
export function parseCmadbHtml(html: string, videoId: string, sourceUrl: string): ProviderLookupResult {
  const scriptMatch =
    /<script\b[^>]*data-page=["']app["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i.exec(
      html,
    ) ??
    /<script\b[^>]*type=["']application\/json["'][^>]*data-page=["']app["'][^>]*>([\s\S]*?)<\/script>/i.exec(
      html,
    );

  if (!scriptMatch) {
    const lowered = html.toLowerCase();
    if (html.includes('メールアドレス') || lowered.includes('/login')) {
      return {
        metadata: null,
        category: 'auth_or_blocked',
        reason: 'Article JSON missing; login page returned (requires user session/cookie).',
        sourceUrl,
      };
    }
    return {
      metadata: null,
      category: 'parse_error',
      reason: 'data-page="app" application/json block not found.',
      sourceUrl,
    };
  }

  let article: Record<string, unknown> | undefined;
  try {
    const rawJson = decodeHtmlEntities(scriptMatch[1]!);
    const payload = JSON.parse(rawJson) as { props?: { article?: Record<string, unknown> } };
    article = payload?.props?.article;
  } catch (err) {
    return {
      metadata: null,
      category: 'parse_error',
      reason: `Invalid data-page JSON: ${err instanceof Error ? err.message : String(err)}`,
      sourceUrl,
    };
  }

  if (!article || typeof article !== 'object') {
    return { metadata: null, category: 'not_found', reason: 'Article object missing.', sourceUrl };
  }

  const returnedId = article.video_id;
  if (returnedId !== undefined && returnedId !== null && String(returnedId) !== videoId) {
    return {
      metadata: null,
      category: 'parse_error',
      reason: `Response video_id ${String(returnedId)} does not match ${videoId}.`,
      sourceUrl,
    };
  }

  const title = cleanMetadataText(typeof article.title === 'string' ? article.title : '');
  const writerObj = article.writer as Record<string, unknown> | undefined;
  let writer =
    writerObj && typeof writerObj === 'object' && typeof writerObj.name === 'string'
      ? cleanMetadataText(writerObj.name)
      : '';
  if (writer.toLowerCase() === 'fc2cmadb') writer = '';

  const candidateTags = new Set<string>();
  if (writer) candidateTags.add(writer);
  const rawTags = article.tags;
  if (Array.isArray(rawTags)) {
    for (const entry of rawTags) {
      if (typeof entry === 'string') {
        const cleaned = cleanMetadataText(entry);
        if (cleaned) candidateTags.add(cleaned);
      } else if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
        const cleaned = cleanMetadataText((entry as { name: string }).name);
        if (cleaned) candidateTags.add(cleaned);
      }
    }
  }

  if (!title) {
    return { metadata: null, category: 'parse_error', reason: 'Article title is empty.', sourceUrl };
  }

  return {
    metadata: {
      videoId,
      title,
      writer,
      candidateTags: [...candidateTags],
      sourceUrl,
      provider: 'FC2CMADB',
    },
    category: 'ok',
    reason: '',
    sourceUrl,
  };
}

function stripSiteTitle(candidate: string, videoId: string): string {
  const escapedId = videoId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let value = candidate.replace(new RegExp(`^.*?FC2[- ]?PPV[- ]?${escapedId}\\s*[-:：]?\\s*`, 'i'), '');
  value = value.split(/\s+(?:ID|販売者|女優)\s*[:：]/)[0] ?? value;
  value = value.replace(/\s*[-|｜]\s*FC2.*$/i, '');
  return cleanMetadataText(value);
}

/**
 * Fallback parser for FC2PPVDB HTML pages (`og:title`, `<title>`, body text).
 */
export function parsePpvdbHtml(html: string, videoId: string, sourceUrl: string): ProviderLookupResult {
  if (html.includes('メールアドレス') || /(?:href|action)=["'][^"']*\/login/i.test(html)) {
    return {
      metadata: null,
      category: 'auth_or_blocked',
      reason: 'Login page returned (requires user session/cookie).',
      sourceUrl,
    };
  }

  const ogMatch =
    /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']*)["']/i.exec(html) ??
    /<meta\b[^>]*content=["']([^"']*)["'][^>]*property=["']og:title["']/i.exec(html);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);

  const plainText = cleanMetadataText(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );

  const candidates: string[] = [];
  if (ogMatch?.[1]) candidates.push(cleanMetadataText(ogMatch[1]));
  if (titleMatch?.[1]) candidates.push(cleanMetadataText(titleMatch[1]));

  const escapedId = videoId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const bodyMatch = new RegExp(
    `FC2[- ]?PPV[- ]?${escapedId}\\s+(.+?)(?=\\s+(?:ID|販売者|女優)\\s*[:：]|$)`,
    'i',
  ).exec(plainText);
  if (bodyMatch?.[0]) candidates.push(bodyMatch[0]);

  const idTokenRe = new RegExp(`(?<!\\d)${escapedId}(?!\\d)`);
  for (const candidate of candidates) {
    if (candidate && idTokenRe.test(candidate)) {
      const title = stripSiteTitle(candidate, videoId);
      if (title) {
        return {
          metadata: {
            videoId,
            title,
            writer: '',
            candidateTags: [],
            sourceUrl,
            provider: 'FC2PPVDB',
          },
          category: 'ok',
          reason: '',
          sourceUrl,
        };
      }
    }
  }

  return {
    metadata: null,
    category: 'parse_error',
    reason: 'Article title not found in fallback page.',
    sourceUrl,
  };
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ status: number; ok: boolean; text: () => Promise<string> }>;

export interface MetadataFetcherOptions {
  readonly cmadbBaseUrl?: string | undefined;
  readonly ppvdbBaseUrl?: string | undefined;
  readonly cmadbCookie?: string | undefined;
  readonly ppvdbCookie?: string | undefined;
  readonly retries?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly retryDelayMs?: number | undefined;
  readonly requestDelayMs?: number | undefined;
  readonly fetchImpl?: FetchLike | undefined;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 520, 522, 524, 526]);

function classifyHttpStatus(status: number): FetchedMetadataCandidate['category'] {
  if (status === 404) return 'not_found';
  if (status === 401 || status === 403) return 'auth_or_blocked';
  if (status === 429) return 'rate_limited';
  if (RETRYABLE_STATUS.has(status) || (status >= 500 && status <= 599)) return 'transient_http';
  return 'client_error';
}

export class MetadataFetcher {
  private readonly cmadbBaseUrl: string;
  private readonly ppvdbBaseUrl: string;
  private readonly cmadbCookie: string;
  private readonly ppvdbCookie: string;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly requestDelayMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: MetadataFetcherOptions = {}) {
    this.cmadbBaseUrl = (options.cmadbBaseUrl ?? 'https://fc2cmadb.com').replace(/\/+$/, '');
    this.ppvdbBaseUrl = (options.ppvdbBaseUrl ?? 'https://fc2ppvdb.com').replace(/\/+$/, '');
    this.cmadbCookie = (options.cmadbCookie ?? '').trim();
    this.ppvdbCookie = (options.ppvdbCookie ?? '').trim();
    this.retries = Math.max(1, options.retries ?? 2);
    this.timeoutMs = Math.max(500, options.timeoutMs ?? 15000);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);
    this.requestDelayMs = Math.max(0, options.requestDelayMs ?? 250);
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  private async lookupProvider(
    baseUrl: string,
    cookieHeader: string,
    parser: (html: string, videoId: string, sourceUrl: string) => ProviderLookupResult,
    videoId: string,
  ): Promise<ProviderLookupResult> {
    const sourceUrl = `${baseUrl}/articles/${videoId}`;
    let last: ProviderLookupResult = {
      metadata: null,
      category: 'transient_network',
      reason: 'No request made.',
      sourceUrl,
    };

    for (let attempt = 1; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let status: number | null = null;
      try {
        const headers: Record<string, string> = {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ja,en-US;q=0.8,en;q=0.6',
        };
        if (cookieHeader) headers.Cookie = cookieHeader;

        const res = await this.fetchImpl(sourceUrl, {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
        status = res.status;
        if (!res.ok) {
          const category = classifyHttpStatus(status);
          last = { metadata: null, category, reason: `HTTP ${status}`, sourceUrl };
        } else {
          const body = await res.text();
          last = parser(body, videoId, sourceUrl);
        }
      } catch (err) {
        last = {
          metadata: null,
          category: 'transient_network',
          reason: err instanceof Error ? err.message : String(err),
          sourceUrl,
        };
      } finally {
        clearTimeout(timer);
      }

      if (last.metadata) return last;
      const shouldRetry =
        last.category === 'transient_network' ||
        last.category === 'transient_http' ||
        last.category === 'rate_limited' ||
        (status !== null && RETRYABLE_STATUS.has(status));

      if (!shouldRetry || attempt >= this.retries) break;
      if (this.retryDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.retryDelayMs * attempt));
      }
    }

    if (this.requestDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.requestDelayMs));
    }
    return last;
  }

  async lookup(videoId: string): Promise<ProviderLookupResult> {
    const primary = await this.lookupProvider(this.cmadbBaseUrl, this.cmadbCookie, parseCmadbHtml, videoId);
    if (primary.metadata) return primary;

    const fallback = await this.lookupProvider(this.ppvdbBaseUrl, this.ppvdbCookie, parsePpvdbHtml, videoId);
    if (fallback.metadata) return fallback;

    return {
      metadata: null,
      category: fallback.category,
      reason: `FC2CMADB: ${primary.reason} | FC2PPVDB: ${fallback.reason}`,
      sourceUrl: fallback.sourceUrl,
    };
  }
}
