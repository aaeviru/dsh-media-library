import {
  normalizeTagName,
  type IngestionManifestTag,
  type ManifestPerformerPreview,
  type NormalTagPreviewEntry,
  type TagSummary,
} from '../types.ts';

export interface ResolvedTagMatch {
  readonly matchedTagId: number | null;
  readonly matchedTagName: string | null;
  readonly matchedVia: 'name' | 'alias' | 'new';
}

export interface DraftTagPill {
  readonly tagName: string;
  readonly idx: number;
  readonly matchedTagId: number | null;
  readonly matchedTagName: string | null;
  readonly matchedVia: 'name' | 'alias' | 'new';
}

export interface MergeTagPreviewSourcesInput {
  readonly manifestTags?: readonly IngestionManifestTag[] | undefined;
  readonly performerPreview?: ManifestPerformerPreview | null | undefined;
  readonly selectedManifestId?: number | null | undefined;
  readonly pickedTagEntries?: readonly NormalTagPreviewEntry[] | undefined;
  readonly liveTagPreviewEntries?: readonly NormalTagPreviewEntry[] | undefined;
}

/**
 * Ordering priority for tag preview pills: existing direct match -> alias match -> new tag.
 */
export function rankTagMatch(via: NormalTagPreviewEntry['matchedVia']): number {
  return via === 'name' ? 0 : via === 'alias' ? 1 : 2;
}

/**
 * Parse a comma-separated tag draft string into trimmed non-empty tag names.
 */
export function parseDraftTagNames(tagsText: string): string[] {
  return tagsText
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build a stable, deduplicated request key for a list of draft tag names using `normalizeTagName`.
 * Used as an effect dependency so polling refreshes with identical tags never re-trigger `previewTagNames`.
 */
export function buildDraftTagRequestKey(names: readonly string[]): string {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const raw of names) {
    const norm = normalizeTagName(raw);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    keys.push(norm);
  }
  return JSON.stringify(keys);
}

/**
 * Convert an active `TagSummary` selected in `TagPicker` into an immediate zero-flicker preview entry.
 * Returns `null` for archived or blank tags.
 */
export function toPickedTagPreviewEntry(tag: TagSummary): NormalTagPreviewEntry | null {
  if (tag.archived) return null;
  const cleanName = tag.name.trim();
  if (!cleanName || !normalizeTagName(cleanName)) return null;
  return {
    rawName: cleanName,
    matchedTagId: tag.id,
    matchedTagName: cleanName,
    matchedVia: 'name',
  };
}

/**
 * Immutably upsert a preview entry keyed by `normalizeTagName(entry.rawName)`.
 */
export function upsertTagPreviewEntry(
  entries: readonly NormalTagPreviewEntry[],
  entry: NormalTagPreviewEntry,
): NormalTagPreviewEntry[] {
  const targetKey = normalizeTagName(entry.rawName);
  if (!targetKey) return [...entries];
  const next = entries.filter((item) => normalizeTagName(item.rawName) !== targetKey);
  next.push(entry);
  return next;
}

/**
 * Immutably remove any preview entries matching `normalizeTagName(rawName)`.
 */
export function removeTagPreviewEntriesByName(
  entries: readonly NormalTagPreviewEntry[],
  rawName: string,
): NormalTagPreviewEntry[] {
  const targetKey = normalizeTagName(rawName);
  if (!targetKey) return [...entries];
  return entries.filter((item) => normalizeTagName(item.rawName) !== targetKey);
}

/**
 * Merge preview sources with strict precedence (low -> high):
 * 1. `manifestTags` (only entries with `tagId !== undefined`)
 * 2. `performerPreview.normalTags` (gated on `performerPreview.manifestId === selectedManifestId`)
 * 3. `pickedTagEntries` (immediate zero-flicker `TagPicker` active tag selections)
 * 4. `liveTagPreviewEntries` (debounced authoritative `previewTagNames` response)
 */
export function buildResolvedTagPreviewMap(
  sources: MergeTagPreviewSourcesInput,
): Map<string, ResolvedTagMatch> {
  const map = new Map<string, ResolvedTagMatch>();

  for (const tag of sources.manifestTags ?? []) {
    if (tag.tagId === undefined) continue;
    const cleanName = tag.name.trim();
    const key = normalizeTagName(cleanName);
    if (!key) continue;
    map.set(key, {
      matchedTagId: tag.tagId,
      matchedTagName: cleanName,
      matchedVia: 'name',
    });
  }

  const preview = sources.performerPreview;
  if (
    preview &&
    sources.selectedManifestId !== null &&
    sources.selectedManifestId !== undefined &&
    preview.manifestId === sources.selectedManifestId
  ) {
    for (const entry of preview.normalTags) {
      const key = normalizeTagName(entry.rawName);
      if (!key) continue;
      map.set(key, {
        matchedTagId: entry.matchedTagId,
        matchedTagName: entry.matchedTagName,
        matchedVia: entry.matchedVia,
      });
    }
  }

  for (const entry of sources.pickedTagEntries ?? []) {
    const key = normalizeTagName(entry.rawName);
    if (!key) continue;
    map.set(key, {
      matchedTagId: entry.matchedTagId,
      matchedTagName: entry.matchedTagName,
      matchedVia: entry.matchedVia,
    });
  }

  for (const entry of sources.liveTagPreviewEntries ?? []) {
    const key = normalizeTagName(entry.rawName);
    if (!key) continue;
    map.set(key, {
      matchedTagId: entry.matchedTagId,
      matchedTagName: entry.matchedTagName,
      matchedVia: entry.matchedVia,
    });
  }

  return map;
}

/**
 * Resolve each draft tag name against merged preview sources and sort stably:
 * `'name'` -> `'alias'` -> `'new'`, preserving original draft order within each group.
 */
export function resolveDraftTagPills(
  draftTagNames: readonly string[],
  sources: MergeTagPreviewSourcesInput,
): DraftTagPill[] {
  const resolvedMap = buildResolvedTagPreviewMap(sources);
  return draftTagNames
    .map((tagName, idx) => {
      const key = normalizeTagName(tagName);
      const info = key ? resolvedMap.get(key) : undefined;
      const matchedVia: 'name' | 'alias' | 'new' = info?.matchedVia ?? 'new';
      return {
        tagName,
        idx,
        matchedTagId: info?.matchedTagId ?? null,
        matchedTagName: info?.matchedTagName ?? null,
        matchedVia,
      };
    })
    .sort((a, b) => rankTagMatch(a.matchedVia) - rankTagMatch(b.matchedVia) || a.idx - b.idx);
}

/**
 * Monotonic sequence tracker to discard stale async preview responses across selection
 * switches or superseded in-flight requests.
 */
export class TagPreviewRequestTracker {
  private latestSeq = 0;

  next(): number {
    this.latestSeq += 1;
    return this.latestSeq;
  }

  invalidate(): void {
    this.latestSeq += 1;
  }

  isCurrent(seq: number): boolean {
    return seq === this.latestSeq;
  }
}
