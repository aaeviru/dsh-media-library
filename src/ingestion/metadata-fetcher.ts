import {
  IGNORED_CATALOG_PREFIXES,
  UNCENSORED_STUDIO_PREFIXES,
  UNCENSORED_STUDIO_REGEX,
} from '../inventory/tagstudio-inventory.ts';
import type { FetchedMetadataCandidate } from '../types.ts';

export interface ParsedFc2Code {
  readonly videoId: string;
  readonly suffix: string;
  readonly code: string;
}

export interface ParsedStandardProductCode {
  readonly prefix: string;
  readonly number: string;
  readonly partSuffix: string;
  readonly baseCode: string;
  readonly code: string;
  readonly baseSlug: string;
  readonly slug: string;
}

export type MetadataLookupRoute =
  | { readonly kind: 'fc2'; readonly parsed: ParsedFc2Code }
  | { readonly kind: 'avwiki'; readonly parsed: ParsedStandardProductCode };

export interface ProviderMetadata {
  readonly videoId: string;
  readonly title: string;
  readonly writer: string;
  readonly actresses: readonly string[];
  readonly mediaDate: string | null;
  readonly candidateTags: readonly string[];
  readonly sourceUrl: string;
  readonly provider: 'FC2CMADB' | 'FC2PPVDB' | 'AVWIKI';
}

export interface ProviderLookupResult {
  readonly metadata: ProviderMetadata | null;
  readonly category: FetchedMetadataCandidate['category'];
  readonly reason: string;
  readonly sourceUrl: string;
}

const FC2_RE = /(?<![A-Z0-9])FC2[-_ ]?PPV[-_ ]?(\d{5,9})(?:[-_](?:pt)?(\d{1,3}))?(?![A-Z0-9])/i;
const FC2_ANY_RE = /(?<![A-Za-z0-9])FC2[\s-_]*(?:PPV[\s-_]*)?(\d{5,9})(?![A-Za-z0-9])/i;
const STANDARD_PRODUCT_CODE_RE =
  /(?<![A-Za-z0-9])(\d{0,3}[A-Za-z]{1,6}\d{0,2})[-_]([A-Za-z]{0,2})(\d{1,6})(?:[-_](?:(?:pt|part|cd|disc|disk)[-_]?)?(\d{1,2}))?(?![A-Za-z0-9])/gi;

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

/**
 * Parse a standard maker product code for `av-wiki.net` routing:
 * - Zero-pads the numeric part to >= 3 digits (e.g. `ABP-76` -> `ABP-076` / slug `abp-076`)
 * - Preserves optional part suffix (e.g. `ABP-576-1` -> slug `abp-576-1`, baseSlug `abp-576`)
 * - Rejects FC2 codes, uncensored studio date codes, and `IGNORED_CATALOG_PREFIXES`
 */
export function parseStandardProductCode(text: string | null | undefined): ParsedStandardProductCode | null {
  if (!text || !text.trim()) return null;
  if (FC2_ANY_RE.test(text) || UNCENSORED_STUDIO_REGEX.test(text)) {
    return null;
  }

  for (const match of text.matchAll(STANDARD_PRODUCT_CODE_RE)) {
    const prefix = match[1]!.toUpperCase();
    const numPrefix = (match[2] ?? '').toUpperCase();
    const rawDigits = match[3]!;
    const partSuffix = match[4] ?? '';

    if (
      !/[A-Z]/.test(prefix) ||
      IGNORED_CATALOG_PREFIXES.has(prefix) ||
      UNCENSORED_STUDIO_PREFIXES.has(prefix)
    ) {
      continue;
    }
    if (prefix.length === 1 && numPrefix.length === 0 && rawDigits.length < 4) {
      continue;
    }

    const paddedDigits = rawDigits.length < 3 ? rawDigits.padStart(3, '0') : rawDigits;
    const number = `${numPrefix}${paddedDigits}`;
    const baseCode = `${prefix}-${number}`;
    const code = partSuffix ? `${baseCode}-${partSuffix}` : baseCode;
    const baseSlug = baseCode.toLowerCase();
    const slug = code.toLowerCase();

    return {
      prefix,
      number,
      partSuffix,
      baseCode,
      code,
      baseSlug,
      slug,
    };
  }

  return null;
}

/**
 * Deterministic metadata lookup router:
 * - `FC2-PPV-*` always routes exclusively to FC2 providers and never falls back to `av-wiki.net`.
 * - Standard maker product codes route to `AVWIKI`.
 */
export function resolveMetadataLookupRoute(text: string | null | undefined): MetadataLookupRoute | null {
  if (!text || !text.trim()) return null;
  const fc2 = parseFc2Code(text);
  if (fc2) {
    return { kind: 'fc2', parsed: fc2 };
  }
  const standard = parseStandardProductCode(text);
  if (standard) {
    return { kind: 'avwiki', parsed: standard };
  }
  return null;
}

function safeFromCodePoint(codePoint: number): string {
  if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
    return '';
  }
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
    return '';
  }
  return String.fromCodePoint(codePoint);
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
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeFromCodePoint(Number.parseInt(hex, 16)));
}

function cleanPreservingPunctuation(text: string | null | undefined): string {
  if (!text) return '';
  return decodeHtmlEntities(text)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[ \t\r\n\f]+/g, ' ')
    .trim();
}

export function cleanMetadataText(text: string | null | undefined): string {
  if (!text) return '';
  return decodeHtmlEntities(text)
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractIsoDateFromText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = /\b(20\d{2}|19\d{2})[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b/.exec(raw);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function extractEntityNames(raw: unknown, depth = 0): string[] {
  if (depth > 3 || raw === null || raw === undefined) return [];
  if (typeof raw === 'string') {
    const cleaned = cleanMetadataText(raw);
    return cleaned ? [cleaned] : [];
  }
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const item of raw) {
      out.push(...extractEntityNames(item, depth + 1));
    }
    return out;
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const out: string[] = [];
    for (const key of ['name', 'actress_name', 'label', 'title'] as const) {
      if (typeof obj[key] === 'string') {
        const cleaned = cleanMetadataText(obj[key]);
        if (cleaned) out.push(cleaned);
      }
    }
    if (obj.actress && typeof obj.actress === 'object') {
      out.push(...extractEntityNames(obj.actress, depth + 1));
    }
    return out;
  }
  return [];
}

export function extractCmadbActressUrls(html: string, baseUrl: string): string[] {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const seen = new Set<string>();
  const addId = (id: string) => {
    if (!/^\d+$/.test(id)) return;
    seen.add(`${cleanBase}/actresses/${id}`);
  };

  const scriptMatch =
    /<script\b[^>]*data-page=["']app["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i.exec(html) ??
    /<script\b[^>]*type=["']application\/json["'][^>]*data-page=["']app["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (scriptMatch) {
    try {
      const payload = JSON.parse(decodeHtmlEntities(scriptMatch[1]!)) as {
        props?: {
          article?: { comments?: Array<{ body?: unknown }> };
          comments?: { data?: Array<{ body?: unknown }> };
        };
      };
      const commentLists = [payload?.props?.article?.comments, payload?.props?.comments?.data];
      for (const list of commentLists) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          if (typeof item?.body !== 'string') continue;
          for (const m of item.body.matchAll(/\/actresses\/(\d+)/g)) {
            addId(m[1]!);
          }
        }
      }
    } catch {
      // Ignore malformed JSON; HTML scan below still runs.
    }
  }

  for (const m of html.matchAll(/\/actresses\/(\d+)/g)) {
    addId(m[1]!);
  }
  return [...seen].slice(0, 5);
}

export function parseCmadbActressPageHtml(html: string): string | null {
  const scriptMatch =
    /<script\b[^>]*data-page=["']app["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i.exec(html) ??
    /<script\b[^>]*type=["']application\/json["'][^>]*data-page=["']app["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!scriptMatch) return null;
  try {
    const payload = JSON.parse(decodeHtmlEntities(scriptMatch[1]!)) as {
      props?: { actress?: { name?: unknown } };
    };
    const rawName = payload?.props?.actress?.name;
    return typeof rawName === 'string' ? cleanMetadataText(rawName) || null : null;
  } catch {
    return null;
  }
}

function extractActressAnchorsFromHtml(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["'][^"']*\/actress(?:es)?\/[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const cleaned = cleanMetadataText(m[1]!.replace(/<[^>]+>/g, ''));
    if (cleaned) out.push(cleaned);
  }
  return out;
}

function extractAnchorOrTextValues(cellHtml: string): string[] {
  const anchors = [...cellHtml.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => cleanMetadataText(m[1]!.replace(/<[^>]+>/g, '')))
    .filter(Boolean);
  if (anchors.length > 0) return anchors;
  const plain = cleanMetadataText(cellHtml.replace(/<[^>]+>/g, ' '));
  return plain
    .split(/[,、/]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseTableMetadataRows(html: string): {
  writer: string;
  actresses: string[];
  mediaDate: string | null;
  tags: string[];
} {
  let writer = '';
  const actresses: string[] = [];
  let mediaDate: string | null = null;
  const tags: string[] = [];

  for (const rowMatch of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = rowMatch[1]!;
    const thMatch = /<th\b[^>]*>([\s\S]*?)<\/th>/i.exec(rowHtml);
    const tdMatch = /<td\b[^>]*>([\s\S]*?)<\/td>/i.exec(rowHtml);
    if (!thMatch || !tdMatch) continue;
    const label = cleanMetadataText(thMatch[1]!.replace(/<[^>]+>/g, '')).replace(/[:：]+$/, '');
    const cellHtml = tdMatch[1]!;

    if (label === '販売者' && !writer) {
      writer = extractAnchorOrTextValues(cellHtml)[0] ?? '';
    } else if (label === '女優') {
      actresses.push(...extractAnchorOrTextValues(cellHtml));
    } else if ((label === '販売日' || label === '公開日' || label === '配信日') && !mediaDate) {
      mediaDate = extractIsoDateFromText(cleanMetadataText(cellHtml.replace(/<[^>]+>/g, ' ')));
    } else if (label === 'タグ') {
      tags.push(...extractAnchorOrTextValues(cellHtml));
    }
  }

  return { writer, actresses, mediaDate, tags };
}

/**
 * Parse FC2CMADB HTML (`<script data-page="app" type="application/json">` + rendered metadata `<table>`).
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

  let props: Record<string, unknown> | undefined;
  let article: Record<string, unknown> | undefined;
  try {
    const rawJson = decodeHtmlEntities(scriptMatch[1]!);
    const payload = JSON.parse(rawJson) as { props?: Record<string, unknown> };
    props = payload?.props;
    const rawArticle = props?.article;
    article = rawArticle && typeof rawArticle === 'object' ? (rawArticle as Record<string, unknown>) : undefined;
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

  const tableInfo = parseTableMetadataRows(html);

  const title = cleanMetadataText(typeof article.title === 'string' ? article.title : '');
  const writerObj = article.writer as Record<string, unknown> | undefined;
  let writer =
    (writerObj && typeof writerObj === 'object' && typeof writerObj.name === 'string'
      ? cleanMetadataText(writerObj.name)
      : '') || tableInfo.writer;
  if (writer.toLowerCase() === 'fc2cmadb') writer = '';

  const actressSet = new Set<string>([...tableInfo.actresses, ...extractActressAnchorsFromHtml(html)]);
  const actressKeys = [
    'actress',
    'actresses',
    'actor',
    'actors',
    'performer',
    'performers',
    'cast',
    'casts',
    'girl',
    'girls',
    'model',
    'models',
    'av_actress',
    'av_actresses',
  ] as const;
  for (const container of [article, props]) {
    if (!container) continue;
    for (const field of actressKeys) {
      for (const name of extractEntityNames(container[field])) {
        actressSet.add(name);
      }
    }
  }

  const mediaDate =
    extractIsoDateFromText(article.release_date) ??
    extractIsoDateFromText(article.published_at) ??
    extractIsoDateFromText(article.sale_date) ??
    extractIsoDateFromText(article.date) ??
    tableInfo.mediaDate;

  const candidateTags = new Set<string>();
  for (const actress of actressSet) candidateTags.add(actress);
  if (writer) candidateTags.add(writer);
  for (const tag of tableInfo.tags) candidateTags.add(tag);

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
      actresses: [...actressSet],
      mediaDate,
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

  const tableInfo = parseTableMetadataRows(html);
  const idTokenRe = new RegExp(`(?<!\\d)${escapedId}(?!\\d)`);
  for (const candidate of candidates) {
    if (candidate && idTokenRe.test(candidate)) {
      const title = stripSiteTitle(candidate, videoId);
      if (title) {
        const candidateTags = [...new Set([...tableInfo.actresses, ...(tableInfo.writer ? [tableInfo.writer] : []), ...tableInfo.tags])];
        return {
          metadata: {
            videoId,
            title,
            writer: tableInfo.writer,
            actresses: tableInfo.actresses,
            mediaDate: tableInfo.mediaDate,
            candidateTags,
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractOgTitle(html: string): string {
  const patterns = [
    /<meta\b[^>]*property=["']og:title["'][^>]*content="([^"]*)"/i,
    /<meta\b[^>]*property=["']og:title["'][^>]*content='([^']*)'/i,
    /<meta\b[^>]*content="([^"]*)"[^>]*property=["']og:title["']/i,
    /<meta\b[^>]*content='([^']*)'[^>]*property=["']og:title["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m?.[1]) return m[1];
  }
  return '';
}

function buildAvWikiCodePattern(productCode: string): string {
  const normalized = cleanMetadataText(productCode).toUpperCase();
  const parsed = /^([A-Z0-9]+)-([A-Z]{0,2})(\d+)(?:-(\d+))?$/.exec(normalized);
  if (!parsed) {
    return escapeRegExp(normalized);
  }
  const prefix = escapeRegExp(parsed[1]!);
  const numPrefix = escapeRegExp(parsed[2] ?? '');
  const unpaddedDigits = parsed[3]!.replace(/^0+/, '') || '0';
  const suffix = parsed[4] ? `(?:[-_ ]?${escapeRegExp(parsed[4])})?` : '';
  return `${prefix}[-_ ]?${numPrefix}0*${escapeRegExp(unpaddedDigits)}${suffix}`;
}

function stripAvWikiTitle(raw: string, productCode: string): string {
  let value = cleanPreservingPunctuation(raw);
  if (!value) return '';

  value = value.replace(/\s*に出てるAV女優[\s\S]*$/i, '').trim();
  value = value.replace(/\s*[|｜\-–—]\s*AV[- ]?WIKI(?:\s*[|｜\-–—][\s\S]*)?$/i, '').trim();

  const codePattern = buildAvWikiCodePattern(productCode);
  if (codePattern) {
    value = value.replace(new RegExp(`^(?:【\\s*)?${codePattern}(?:\\s*】)?\\s*[:：]\\s*`, 'i'), '');
    value = value.replace(new RegExp(`^【\\s*${codePattern}\\s*】\\s*`, 'i'), '');
  }

  value = value.replace(/[ \t\r\n\f]+/g, ' ').trim();
  if (!value || /^AV[- ]?WIKI$/i.test(value)) {
    return '';
  }
  if (codePattern && new RegExp(`^(?:【\\s*)?${codePattern}(?:\\s*】)?$`, 'i').test(value)) {
    return '';
  }
  return value;
}

function extractAvWikiIsoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const strict = extractIsoDateFromText(raw);
  if (strict) return strict;

  const cleaned = cleanMetadataText(raw);
  const flexible = /(?<!\d)(20\d{2}|19\d{2})\s*(?:[-/.]|年)\s*(\d{1,2})\s*(?:[-/.]|月)\s*(\d{1,2})(?:\s*日)?(?!\d)/.exec(
    cleaned,
  );
  if (!flexible) return null;
  const year = flexible[1]!;
  const month = Number(flexible[2]!);
  const day = Number(flexible[3]!);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function splitAvWikiActressText(raw: string): string[] {
  return cleanMetadataText(raw)
    .split(/[,、/・\s]+/)
    .map((s) => s.trim())
    .filter((s) => Boolean(s) && !/^[-—–_]+$/.test(s));
}

function extractAvWikiActressValues(ddBlocks: readonly string[]): string[] {
  const out: string[] = [];
  const anchorRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  for (const block of ddBlocks) {
    let lastIndex = 0;
    for (const m of block.matchAll(anchorRe)) {
      const idx = m.index ?? 0;
      if (idx > lastIndex) {
        const before = block.slice(lastIndex, idx).replace(/<[^>]+>/g, ' ');
        out.push(...splitAvWikiActressText(before));
      }
      const anchorText = cleanMetadataText(m[1]!.replace(/<[^>]+>/g, ''));
      if (anchorText && !/^[-—–_]+$/.test(anchorText)) {
        out.push(anchorText);
      }
      lastIndex = idx + m[0].length;
    }
    if (lastIndex < block.length) {
      const tail = block.slice(lastIndex).replace(/<[^>]+>/g, ' ');
      out.push(...splitAvWikiActressText(tail));
    }
  }
  return out;
}

function isAvWikiChallengePage(html: string, rawTitle: string): boolean {
  const loweredTitle = cleanMetadataText(rawTitle).toLowerCase();
  if (
    loweredTitle === 'just a moment...' ||
    loweredTitle.startsWith('just a moment') ||
    loweredTitle.includes('attention required! | cloudflare') ||
    loweredTitle.includes('access denied')
  ) {
    return true;
  }
  return /cf-browser-verification|\/cdn-cgi\/challenge-platform|__cf_chl_/i.test(html);
}

/**
 * Parse `av-wiki.net` HTML pages for standard maker product codes (`Issue #67 B3`).
 * Extracts clean title (preserving original punctuation), actresses, release/distribution date,
 * and maker/studio without scraping noisy page tags.
 */
export function parseAvWikiHtml(html: string, productCode: string, sourceUrl: string): ProviderLookupResult {
  const normalizedCode = cleanMetadataText(productCode).toUpperCase();

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const rawTitle = titleMatch?.[1] ?? '';
  const rawOgTitle = extractOgTitle(html);

  if (isAvWikiChallengePage(html, rawTitle)) {
    return {
      metadata: null,
      category: 'auth_or_blocked',
      reason: 'Challenge or blocked interstitial returned by AV-WIKI.',
      sourceUrl,
    };
  }

  const title = stripAvWikiTitle(rawTitle, normalizedCode) || stripAvWikiTitle(rawOgTitle, normalizedCode);
  if (!title) {
    return {
      metadata: null,
      category: 'parse_error',
      reason: 'Article title not found in AV-WIKI page.',
      sourceUrl,
    };
  }

  const actressSet = new Set<string>();
  let maker = '';
  let mediaDate: string | null = null;
  let hasActressDlField = false;
  let hasRecognizedDlField = false;

  const dlPairRe = /<dt\b[^>]*>([\s\S]*?)<\/dt>((?:\s*<dd\b[^>]*>[\s\S]*?<\/dd>)+)/gi;
  for (const pairMatch of html.matchAll(dlPairRe)) {
    const label = cleanMetadataText(pairMatch[1]!.replace(/<[^>]+>/g, '')).replace(/[:：]+$/, '');
    const ddBlocks = [...pairMatch[2]!.matchAll(/<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)].map((m) => m[1]!);
    if (ddBlocks.length === 0) continue;

    if (label === 'AV女優名' || label === 'AV女優' || label === '女優名') {
      hasActressDlField = true;
      hasRecognizedDlField = true;
      for (const name of extractAvWikiActressValues(ddBlocks)) {
        actressSet.add(name);
      }
    } else if (label === 'メーカー品番') {
      hasRecognizedDlField = true;
    } else if (label === 'メーカー') {
      hasRecognizedDlField = true;
      if (!maker) {
        const anchors = ddBlocks.flatMap((block) =>
          [...block.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
            .map((m) => cleanMetadataText(m[1]!.replace(/<[^>]+>/g, '')))
            .filter((s) => Boolean(s) && !/^[-—–_]+$/.test(s)),
        );
        if (anchors.length > 0) {
          maker = anchors[0]!;
        } else {
          const plainMaker = cleanMetadataText(ddBlocks.map((b) => b.replace(/<[^>]+>/g, ' ')).join(' '));
          if (plainMaker && !/^[-—–_]+$/.test(plainMaker)) {
            maker = plainMaker;
          }
        }
      }
    } else if (label === '配信日' || label === '配信開始日' || label === '発売日' || label === '公開日') {
      hasRecognizedDlField = true;
      if (!mediaDate) {
        for (const block of ddBlocks) {
          const foundDate = extractAvWikiIsoDate(block.replace(/<[^>]+>/g, ' '));
          if (foundDate) {
            mediaDate = foundDate;
            break;
          }
        }
      }
    }
  }

  const bodyHtml = html
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<title\b[\s\S]*?<\/title>/gi, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  const bodyPlainText = cleanMetadataText(bodyHtml.replace(/<[^>]+>/g, ' '));

  const codePattern = buildAvWikiCodePattern(normalizedCode);
  const titleHeaderText = `${cleanPreservingPunctuation(rawTitle)} ${cleanPreservingPunctuation(rawOgTitle)}`;
  const hasCodeInTitle = Boolean(codePattern && new RegExp(codePattern, 'i').test(titleHeaderText));
  const hasAvWikiTitleMarker = /に出てるAV女優|AV[- ]?WIKI/i.test(titleHeaderText);
  const hasBodyArticleMarker = /(?:AV女優名|メーカー品番)\s*[:：]?/i.test(bodyPlainText);
  if (!hasRecognizedDlField && !hasCodeInTitle && !hasAvWikiTitleMarker && !hasBodyArticleMarker) {
    return {
      metadata: null,
      category: 'parse_error',
      reason: 'Response does not match an AV-WIKI article page.',
      sourceUrl,
    };
  }

  if ((!hasActressDlField && actressSet.size === 0) || !mediaDate) {
    if (!hasActressDlField && actressSet.size === 0) {
      const plainActressMatch =
        /AV女優名\s*(?:[:：]\s*|\s+)(?!まとめ)(.+?)(?=\s*(?:メーカー品番|メーカー|配信開始日|配信日|発売日|公開日|FANZA|MGS動画)|$)/i.exec(
          bodyPlainText,
        );
      const captured = plainActressMatch?.[1]?.trim() ?? '';
      if (captured && !/^(?:メーカー品番|メーカー|配信開始日|配信日|発売日|公開日|FANZA|MGS動画)\b/i.test(captured)) {
        for (const name of splitAvWikiActressText(captured)) {
          actressSet.add(name);
        }
      }
    }

    if (!mediaDate) {
      const plainDateMatch = /(?:配信開始日|配信日|発売日|公開日)\s*[:：]?\s*([^\s].{0,24})/.exec(bodyPlainText);
      if (plainDateMatch?.[1]) {
        mediaDate = extractAvWikiIsoDate(plainDateMatch[1]);
      }
    }
  }

  const actresses = [...actressSet];
  const candidateTags = [...new Set([...actresses, ...(maker ? [maker] : [])])];

  return {
    metadata: {
      videoId: normalizedCode,
      title,
      writer: maker,
      actresses,
      mediaDate,
      candidateTags,
      sourceUrl,
      provider: 'AVWIKI',
    },
    category: 'ok',
    reason: '',
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
  readonly avWikiBaseUrl?: string | (() => string) | undefined;
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
  private readonly avWikiBaseUrlOption: string | (() => string) | undefined;
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
    this.avWikiBaseUrlOption = options.avWikiBaseUrl;
    this.cmadbCookie = (options.cmadbCookie ?? '').trim();
    this.ppvdbCookie = (options.ppvdbCookie ?? '').trim();
    this.retries = Math.max(1, options.retries ?? 2);
    this.timeoutMs = Math.max(500, options.timeoutMs ?? 15000);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);
    this.requestDelayMs = Math.max(0, options.requestDelayMs ?? 250);
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  private resolveAvWikiBaseUrl(): string {
    const raw =
      typeof this.avWikiBaseUrlOption === 'function' ? this.avWikiBaseUrlOption() : this.avWikiBaseUrlOption;
    return (raw?.trim() || 'https://av-wiki.net').replace(/\/+$/, '');
  }

  private async fetchTextWithHeaders(
    url: string,
    cookieHeader: string,
    extraHeaders?: Record<string, string>,
  ): Promise<
    { ok: true; status: number; body: string } | { ok: false; status: number | null; category: ProviderLookupResult['category']; reason: string }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.8,en;q=0.6',
        ...extraHeaders,
      };
      if (cookieHeader) headers.Cookie = cookieHeader;

      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          category: classifyHttpStatus(res.status),
          reason: `HTTP ${res.status}`,
        };
      }
      return { ok: true, status: res.status, body: await res.text() };
    } catch (err) {
      return {
        ok: false,
        status: null,
        category: 'transient_network',
        reason: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async resolveCmadbDeferredActresses(sourceUrl: string, articleHtml: string): Promise<string[]> {
    const scriptMatch =
      /<script\b[^>]*data-page=["']app["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i.exec(
        articleHtml,
      ) ??
      /<script\b[^>]*type=["']application\/json["'][^>]*data-page=["']app["'][^>]*>([\s\S]*?)<\/script>/i.exec(
        articleHtml,
      );
    if (!scriptMatch) return [];

    let component = '';
    let version = '';
    let partialKey = '';
    try {
      const payload = JSON.parse(decodeHtmlEntities(scriptMatch[1]!)) as {
        component?: unknown;
        version?: unknown;
        deferredProps?: Record<string, unknown>;
      };
      component = typeof payload.component === 'string' ? payload.component : '';
      version = typeof payload.version === 'string' ? payload.version : '';
      if (payload.deferredProps && typeof payload.deferredProps === 'object') {
        for (const group of Object.values(payload.deferredProps)) {
          if (!Array.isArray(group)) continue;
          const found = group.find((k) => k === 'actresses' || k === 'actress');
          if (typeof found === 'string') {
            partialKey = found;
            break;
          }
        }
      }
    } catch {
      return [];
    }

    if (!component || !version || !partialKey) return [];
    if (this.requestDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.requestDelayMs));
    }

    const res = await this.fetchTextWithHeaders(sourceUrl, this.cmadbCookie, {
      Accept: 'application/json',
      'X-Inertia': 'true',
      'X-Inertia-Version': version,
      'X-Inertia-Partial-Component': component,
      'X-Inertia-Partial-Data': partialKey,
    });
    if (!res.ok) return [];

    try {
      const partial = JSON.parse(res.body) as { props?: Record<string, unknown> };
      const names = new Set<string>();
      for (const key of [partialKey, 'actresses', 'actress']) {
        for (const name of extractEntityNames(partial.props?.[key])) {
          names.add(name);
        }
      }
      return [...names];
    } catch {
      return [];
    }
  }

  private async resolveCmadbCommentActresses(articleHtml: string): Promise<string[]> {
    if (!this.cmadbCookie) return [];
    const urls = extractCmadbActressUrls(articleHtml, this.cmadbBaseUrl);
    if (urls.length === 0) return [];
    const names: string[] = [];
    for (const url of urls) {
      if (this.requestDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.requestDelayMs));
      }
      const res = await this.fetchTextWithHeaders(url, this.cmadbCookie);
      if (!res.ok) continue;
      const name = parseCmadbActressPageHtml(res.body);
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  }

  private async fetchAndParseWithRetry(
    resolveUrl: string | (() => string),
    cookieHeader: string,
    parser: (html: string, sourceUrl: string) => ProviderLookupResult,
  ): Promise<ProviderLookupResult & { rawHtml?: string }> {
    const getUrl = typeof resolveUrl === 'function' ? resolveUrl : () => resolveUrl;
    let last: ProviderLookupResult & { rawHtml?: string } = {
      metadata: null,
      category: 'transient_network',
      reason: 'No request made.',
      sourceUrl: '',
    };

    for (let attempt = 1; attempt <= this.retries; attempt++) {
      const sourceUrl = getUrl();
      const res = await this.fetchTextWithHeaders(sourceUrl, cookieHeader);
      const status = res.status;
      if (!res.ok) {
        last = { metadata: null, category: res.category, reason: res.reason, sourceUrl };
      } else {
        try {
          const parsed = parser(res.body, sourceUrl);
          last = parsed.metadata ? { ...parsed, rawHtml: res.body } : parsed;
        } catch (err) {
          last = {
            metadata: null,
            category: 'parse_error',
            reason: err instanceof Error ? err.message : String(err),
            sourceUrl,
          };
        }
      }

      if (last.metadata) break;
      const shouldRetry =
        last.category === 'transient_network' ||
        last.category === 'transient_http' ||
        last.category === 'rate_limited' ||
        (status !== null && RETRYABLE_STATUS.has(status));

      if (!shouldRetry || attempt >= this.retries) break;
      const retryWaitMs = Math.max(this.requestDelayMs, this.retryDelayMs * attempt);
      if (retryWaitMs > 0) {
        await new Promise((r) => setTimeout(r, retryWaitMs));
      }
    }

    if (this.requestDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.requestDelayMs));
    }
    return last;
  }

  private async lookupProvider(
    baseUrl: string,
    cookieHeader: string,
    parser: (html: string, videoId: string, sourceUrl: string) => ProviderLookupResult,
    videoId: string,
  ): Promise<ProviderLookupResult & { rawHtml?: string }> {
    const sourceUrl = `${baseUrl}/articles/${videoId}`;
    return this.fetchAndParseWithRetry(sourceUrl, cookieHeader, (html, url) => parser(html, videoId, url));
  }

  async lookupAvWiki(codeOrParsed: ParsedStandardProductCode | string): Promise<ProviderLookupResult> {
    const parsed = typeof codeOrParsed === 'string' ? parseStandardProductCode(codeOrParsed) : codeOrParsed;
    if (!parsed) {
      return {
        metadata: null,
        category: 'no_code',
        reason: 'No standard product code found.',
        sourceUrl: '',
      };
    }

    const primary = await this.fetchAndParseWithRetry(
      () => `${this.resolveAvWikiBaseUrl()}/${parsed.slug}/`,
      '',
      (html, url) => parseAvWikiHtml(html, parsed.code, url),
    );
    if (primary.metadata) {
      return {
        metadata: primary.metadata,
        category: primary.category,
        reason: primary.reason,
        sourceUrl: primary.sourceUrl,
      };
    }

    if (parsed.slug !== parsed.baseSlug && primary.category === 'not_found') {
      const fallback = await this.fetchAndParseWithRetry(
        () => `${this.resolveAvWikiBaseUrl()}/${parsed.baseSlug}/`,
        '',
        (html, url) => parseAvWikiHtml(html, parsed.baseCode, url),
      );
      return {
        metadata: fallback.metadata,
        category: fallback.category,
        reason: fallback.reason,
        sourceUrl: fallback.sourceUrl,
      };
    }

    return {
      metadata: null,
      category: primary.category,
      reason: primary.reason,
      sourceUrl: primary.sourceUrl,
    };
  }

  async lookupByText(text: string): Promise<ProviderLookupResult> {
    const route = resolveMetadataLookupRoute(text);
    if (!route) {
      return {
        metadata: null,
        category: 'no_code',
        reason: 'No supported FC2-PPV or standard product code found.',
        sourceUrl: '',
      };
    }
    if (route.kind === 'fc2') {
      return this.lookup(route.parsed.videoId);
    }
    return this.lookupAvWiki(route.parsed);
  }

  async lookup(videoId: string): Promise<ProviderLookupResult> {
    const primary = await this.lookupProvider(this.cmadbBaseUrl, this.cmadbCookie, parseCmadbHtml, videoId);
    if (primary.metadata) {
      let metadata = primary.metadata;
      if (metadata.actresses.length === 0 && primary.rawHtml) {
        let resolvedActresses = await this.resolveCmadbDeferredActresses(primary.sourceUrl, primary.rawHtml);
        if (resolvedActresses.length === 0) {
          resolvedActresses = await this.resolveCmadbCommentActresses(primary.rawHtml);
        }
        if (resolvedActresses.length > 0) {
          const mergedTags = [...new Set([...resolvedActresses, ...metadata.candidateTags])];
          metadata = {
            ...metadata,
            actresses: resolvedActresses,
            candidateTags: mergedTags,
          };
        }
      }
      return {
        metadata,
        category: primary.category,
        reason: primary.reason,
        sourceUrl: primary.sourceUrl,
      };
    }

    const fallback = await this.lookupProvider(this.ppvdbBaseUrl, this.ppvdbCookie, parsePpvdbHtml, videoId);
    if (fallback.metadata) {
      return {
        metadata: fallback.metadata,
        category: fallback.category,
        reason: fallback.reason,
        sourceUrl: fallback.sourceUrl,
      };
    }

    return {
      metadata: null,
      category: fallback.category,
      reason: `FC2CMADB: ${primary.reason} | FC2PPVDB: ${fallback.reason}`,
      sourceUrl: fallback.sourceUrl,
    };
  }
}
