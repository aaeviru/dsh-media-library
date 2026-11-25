import {
  normalizeTagName,
  type IngestionManifestTag,
  type ManifestPerformerPreview,
  type NormalTagPreviewEntry,
  type TagSummary,
} from '../types.ts';

export type DraftTagMatchState = 'name' | 'alias' | 'new' | 'pending' | 'unavailable';

export type DraftTagResolutionState = 'idle' | 'pending' | 'ready' | 'unavailable';

export interface LiveTagPreviewStatus {
  readonly status: DraftTagResolutionState;
  readonly requestKey: string;
}

export interface LiveTagPreviewState extends LiveTagPreviewStatus {
  readonly entries: readonly NormalTagPreviewEntry[];
}

export const EMPTY_LIVE_TAG_PREVIEW_STATE: LiveTagPreviewState = {
  status: 'idle',
  requestKey: '',
  entries: [],
};

export interface DraftTagPreviewContext {
  readonly manifestTags?: readonly IngestionManifestTag[] | undefined;
  readonly performerPreview?: ManifestPerformerPreview | null | undefined;
  readonly selectedManifestId?: number | null | undefined;
  readonly pickedTagEntries?: readonly NormalTagPreviewEntry[] | undefined;
  readonly liveTagPreviewState: LiveTagPreviewState;
  readonly currentRequestKey: string;
  readonly tagDraftModified: boolean;
}

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
  readonly matchedVia: DraftTagMatchState;
}

export interface MergeTagPreviewSourcesInput {
  readonly manifestTags?: readonly IngestionManifestTag[] | undefined;
  readonly performerPreview?: ManifestPerformerPreview | null | undefined;
  readonly selectedManifestId?: number | null | undefined;
  readonly pickedTagEntries?: readonly NormalTagPreviewEntry[] | undefined;
  readonly liveTagPreviewEntries?: readonly NormalTagPreviewEntry[] | undefined;
  readonly unresolvedStatus?: 'pending' | 'unavailable' | undefined;
}

/**
 * Ordering priority for tag preview pills:
 * existing direct match -> alias match -> confirmed new tag -> pending -> unavailable.
 */
export function rankTagMatch(via: DraftTagMatchState): number {
  switch (via) {
    case 'name':
      return 0;
    case 'alias':
      return 1;
    case 'new':
      return 2;
    case 'pending':
      return 3;
    case 'unavailable':
      return 4;
  }
}

/**
 * Determine the display state for draft tags not yet present in any confirmed preview source.
 * Reserves `'new'` strictly for confirmed misses returned by Host preview endpoints.
 */
export function resolveUnresolvedTagStatus(
  liveState: LiveTagPreviewStatus,
  currentRequestKey: string,
): 'pending' | 'unavailable' {
  if (
    liveState.requestKey === currentRequestKey &&
    (liveState.status === 'unavailable' || liveState.status === 'ready')
  ) {
    return 'unavailable';
  }
  return 'pending';
}

/**
 * Return live preview entries ONLY when they belong to a confirmed `'ready'` response
 * for the exact `currentRequestKey`. Prevents stale entries from an earlier draft from
 * surviving across edits or failed lookups.
 */
export function selectScopedLiveTagPreviewEntries(
  liveState: LiveTagPreviewState,
  currentRequestKey: string,
): readonly NormalTagPreviewEntry[] {
  if (liveState.status === 'ready' && liveState.requestKey === currentRequestKey) {
    return liveState.entries;
  }
  return [];
}

/**
 * Scope badge preview sources to the current draft:
 * - Saved manifest previews (`manifestTags`, `performerPreview.normalTags`) are only eligible
 *   while the tag draft has not been edited/cleared and the current live lookup has not failed.
 *   (`serverFallback` sorting still passes saved manifest sources directly.)
 * - Live RPC entries are strictly scoped to `status === 'ready'` for the exact `currentRequestKey`.
 */
export function buildDraftTagPreviewSources(ctx: DraftTagPreviewContext): MergeTagPreviewSourcesInput {
  const unresolvedStatus = resolveUnresolvedTagStatus(ctx.liveTagPreviewState, ctx.currentRequestKey);
  const liveTagPreviewEntries = selectScopedLiveTagPreviewEntries(
    ctx.liveTagPreviewState,
    ctx.currentRequestKey,
  );
  const currentLookupFailed =
    ctx.liveTagPreviewState.status === 'unavailable' &&
    ctx.liveTagPreviewState.requestKey === ctx.currentRequestKey;
  const allowSavedManifestPreview = !ctx.tagDraftModified && !currentLookupFailed;

  return {
    manifestTags: allowSavedManifestPreview ? ctx.manifestTags : undefined,
    performerPreview: allowSavedManifestPreview ? ctx.performerPreview : null,
    selectedManifestId: ctx.selectedManifestId,
    pickedTagEntries: ctx.pickedTagEntries,
    liveTagPreviewEntries,
    unresolvedStatus,
  };
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
 * Keep only preview entries whose normalized name is still present in `activeNames`.
 * Returns `entries` unchanged when nothing was pruned to avoid redundant state updates.
 */
export function pruneTagPreviewEntries(
  entries: readonly NormalTagPreviewEntry[],
  activeNames: readonly string[],
): readonly NormalTagPreviewEntry[] {
  if (entries.length === 0) return entries;
  if (activeNames.length === 0) return [];
  const activeKeys = new Set<string>();
  for (const name of activeNames) {
    const key = normalizeTagName(name);
    if (key) activeKeys.add(key);
  }
  const next = entries.filter((item) => activeKeys.has(normalizeTagName(item.rawName)));
  return next.length === entries.length ? entries : next;
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
 * `'name'` -> `'alias'` -> `'new'` -> `'pending'` -> `'unavailable'`,
 * preserving original draft order within each group.
 * Names absent from all confirmed sources default to `unresolvedStatus` (`'pending'` by default),
 * reserving `'new'` strictly for confirmed misses.
 */
export function resolveDraftTagPills(
  draftTagNames: readonly string[],
  sources: MergeTagPreviewSourcesInput,
): DraftTagPill[] {
  const resolvedMap = buildResolvedTagPreviewMap(sources);
  const fallbackState: 'pending' | 'unavailable' = sources.unresolvedStatus ?? 'pending';
  return draftTagNames
    .map((tagName, idx) => {
      const key = normalizeTagName(tagName);
      const info = key ? resolvedMap.get(key) : undefined;
      const matchedVia: DraftTagMatchState = info?.matchedVia ?? fallbackState;
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
