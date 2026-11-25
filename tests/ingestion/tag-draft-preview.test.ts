import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDraftTagRequestKey,
  parseDraftTagNames,
  removeTagPreviewEntriesByName,
  resolveDraftTagPills,
  TagPreviewRequestTracker,
  toPickedTagPreviewEntry,
  upsertTagPreviewEntry,
} from '../../src/client/tag-draft-preview.ts';
import {
  normalizeTagName,
  type IngestionManifestTag,
  type ManifestPerformerPreview,
  type NormalTagPreviewEntry,
  type TagSummary,
} from '../../src/types.ts';

function makePerformerPreview(
  manifestId: number,
  normalTags: readonly NormalTagPreviewEntry[],
): ManifestPerformerPreview {
  return {
    manifestId,
    canCommit: true,
    autoMatched: [],
    humanResolved: [],
    skipped: [],
    skippedEntries: [],
    pendingReview: [],
    normalTags,
  };
}

function makeTagSummary(overrides: Partial<TagSummary> & Pick<TagSummary, 'id' | 'name'>): TagSummary {
  return {
    id: overrides.id,
    name: overrides.name,
    normalizedName: overrides.normalizedName ?? normalizeTagName(overrides.name),
    shorthand: overrides.shorthand ?? null,
    aliases: overrides.aliases ?? [],
    mediaCount: overrides.mediaCount ?? 1,
    revision: overrides.revision ?? 1,
    archived: overrides.archived ?? false,
    mergedIntoId: overrides.mergedIntoId ?? null,
  };
}

/**
 * Exact pre-fix classification logic from `IngestionPanel.tsx` before Issue #71.
 * Used for the real Red-check demonstrating why manually added existing tags/aliases
 * were unconditionally labeled `'new'`.
 */
function legacyPreFixResolveTagPills(
  draftTagList: readonly string[],
  manifestTags: readonly IngestionManifestTag[],
  performerPreview: ManifestPerformerPreview | null,
): Array<{ tagName: string; matchedVia: 'name' | 'alias' | 'new'; matchedTagName: string | null }> {
  const previewTagByLower = new Map<string, { matchedVia: 'name' | 'alias' | 'new'; matchedTagName: string | null }>();
  for (const entry of performerPreview?.normalTags ?? []) {
    previewTagByLower.set(entry.rawName.toLowerCase(), {
      matchedVia: entry.matchedVia,
      matchedTagName: entry.matchedTagName,
    });
  }
  const manifestKnownTagLower = new Set<string>();
  for (const tag of manifestTags) {
    if (tag.tagId !== undefined) manifestKnownTagLower.add(tag.name.toLowerCase());
  }
  return draftTagList.map((tagName) => {
    const lower = tagName.toLowerCase();
    const info = previewTagByLower.get(lower);
    const matchedVia: 'name' | 'alias' | 'new' =
      info?.matchedVia ?? (manifestKnownTagLower.has(lower) ? 'name' : 'new');
    return {
      tagName,
      matchedVia,
      matchedTagName: info?.matchedTagName ?? null,
    };
  });
}

describe('Client tag-draft-preview helper (Issue #71 B1..B3)', () => {
  it('Red-check: proves pre-fix logic misclassified manually added existing tags and aliases as new, while fixed resolver classifies them accurately', () => {
    const manifestTags: IngestionManifestTag[] = [{ tagId: 1, name: 'FetchedExisting' }];
    const performerPreview = makePerformerPreview(10, [
      { rawName: 'FetchedExisting', matchedTagId: 1, matchedTagName: 'FetchedExisting', matchedVia: 'name' },
    ]);
    // User manually adds existing tag "ManualExisting" and existing alias "ManualAlias" (for "CanonicalTag")
    const draftTags = ['FetchedExisting', 'ManualExisting', 'ManualAlias', 'TrulyNew'];

    // Pre-fix behavior (RED): both manually added existing tags are misclassified as 'new'
    const legacy = legacyPreFixResolveTagPills(draftTags, manifestTags, performerPreview);
    assert.equal(legacy.find((p) => p.tagName === 'ManualExisting')?.matchedVia, 'new');
    assert.equal(legacy.find((p) => p.tagName === 'ManualAlias')?.matchedVia, 'new');

    // Fixed behavior (GREEN):
    // 1. Immediate via TagPicker selection (B1)
    const picked = toPickedTagPreviewEntry(makeTagSummary({ id: 42, name: 'ManualExisting' }));
    assert.ok(picked);
    const immediatePills = resolveDraftTagPills(draftTags, {
      manifestTags,
      performerPreview,
      selectedManifestId: 10,
      pickedTagEntries: [picked],
    });
    assert.equal(immediatePills.find((p) => p.tagName === 'ManualExisting')?.matchedVia, 'name');

    // 2. Authoritative via debounced previewTagNames (B2)
    const livePills = resolveDraftTagPills(draftTags, {
      manifestTags,
      performerPreview,
      selectedManifestId: 10,
      pickedTagEntries: [picked],
      liveTagPreviewEntries: [
        { rawName: 'FetchedExisting', matchedTagId: 1, matchedTagName: 'FetchedExisting', matchedVia: 'name' },
        { rawName: 'ManualExisting', matchedTagId: 42, matchedTagName: 'ManualExisting', matchedVia: 'name' },
        { rawName: 'ManualAlias', matchedTagId: 99, matchedTagName: 'CanonicalTag', matchedVia: 'alias' },
        { rawName: 'TrulyNew', matchedTagId: null, matchedTagName: null, matchedVia: 'new' },
      ],
    });
    assert.deepEqual(
      livePills.map((p) => ({
        tagName: p.tagName,
        matchedVia: p.matchedVia,
        matchedTagName: p.matchedTagName,
        matchedTagId: p.matchedTagId,
      })),
      [
        { tagName: 'FetchedExisting', matchedVia: 'name', matchedTagName: 'FetchedExisting', matchedTagId: 1 },
        { tagName: 'ManualExisting', matchedVia: 'name', matchedTagName: 'ManualExisting', matchedTagId: 42 },
        { tagName: 'ManualAlias', matchedVia: 'alias', matchedTagName: 'CanonicalTag', matchedTagId: 99 },
        { tagName: 'TrulyNew', matchedVia: 'new', matchedTagName: null, matchedTagId: null },
      ],
    );
  });

  it('B1: TagPicker selection yields immediate zero-flicker name match, ignores archived TagSummary, and clears stale live entry on re-pick', () => {
    const activeEntry = toPickedTagPreviewEntry(makeTagSummary({ id: 7, name: '  Outdoor  ', archived: false }));
    assert.deepEqual(activeEntry, {
      rawName: 'Outdoor',
      matchedTagId: 7,
      matchedTagName: 'Outdoor',
      matchedVia: 'name',
    });

    const archivedEntry = toPickedTagPreviewEntry(makeTagSummary({ id: 8, name: 'OldTag', archived: true }));
    assert.equal(archivedEntry, null);

    // Even with no manifest yet (selectedManifestId === null), picked tag immediately renders as 'name'
    const noManifestPills = resolveDraftTagPills(['Outdoor', 'BrandNew'], {
      selectedManifestId: null,
      pickedTagEntries: activeEntry ? [activeEntry] : [],
    });
    assert.equal(noManifestPills[0]?.tagName, 'Outdoor');
    assert.equal(noManifestPills[0]?.matchedVia, 'name');
    assert.equal(noManifestPills[1]?.tagName, 'BrandNew');
    assert.equal(noManifestPills[1]?.matchedVia, 'new');

    // Re-picking a tag that was previously cached as 'new' in liveTagPreviewEntries
    const staleLive: NormalTagPreviewEntry[] = [
      { rawName: 'outdoor', matchedTagId: null, matchedTagName: null, matchedVia: 'new' },
      { rawName: 'Other', matchedTagId: 9, matchedTagName: 'Other', matchedVia: 'name' },
    ];
    const updatedPicked = upsertTagPreviewEntry([], activeEntry!);
    const cleanedLive = removeTagPreviewEntriesByName(staleLive, 'Outdoor');
    assert.equal(cleanedLive.length, 1);
    assert.equal(cleanedLive[0]?.rawName, 'Other');

    const repickedPills = resolveDraftTagPills(['Outdoor', 'Other'], {
      pickedTagEntries: updatedPicked,
      liveTagPreviewEntries: cleanedLive,
    });
    assert.equal(repickedPills.find((p) => p.tagName === 'Outdoor')?.matchedVia, 'name');
    assert.equal(repickedPills.find((p) => p.tagName === 'Other')?.matchedVia, 'name');
  });

  it('B2: enforces strict merge precedence and gates performerPreview.normalTags on selectedManifestId', () => {
    const manifestTags: IngestionManifestTag[] = [
      { tagId: 1, name: 'TagA' },
      { tagId: 2, name: 'TagB' },
      { tagId: 3, name: 'TagC' },
    ];

    // Mismatched manifestId must NOT leak performerPreview.normalTags into the current selection
    const wrongManifestPreview = makePerformerPreview(999, [
      { rawName: 'TagA', matchedTagId: null, matchedTagName: null, matchedVia: 'new' },
      { rawName: 'ForeignOnly', matchedTagId: 50, matchedTagName: 'ForeignOnly', matchedVia: 'name' },
    ]);
    const gatedPills = resolveDraftTagPills(['TagA', 'ForeignOnly'], {
      manifestTags,
      performerPreview: wrongManifestPreview,
      selectedManifestId: 10,
    });
    assert.equal(gatedPills.find((p) => p.tagName === 'TagA')?.matchedVia, 'name');
    assert.equal(gatedPills.find((p) => p.tagName === 'ForeignOnly')?.matchedVia, 'new');

    // Matching manifestId: Tier 1 (manifest.tags) < Tier 2 (performerPreview) < Tier 3 (picked) < Tier 4 (live)
    const matchingPreview = makePerformerPreview(10, [
      { rawName: 'TagA', matchedTagId: null, matchedTagName: null, matchedVia: 'new' },
      { rawName: 'TagB', matchedTagId: null, matchedTagName: null, matchedVia: 'new' },
      { rawName: 'TagC', matchedTagId: 30, matchedTagName: 'CanonicalC', matchedVia: 'alias' },
    ]);
    const pickedEntries: NormalTagPreviewEntry[] = [
      { rawName: 'TagB', matchedTagId: 2, matchedTagName: 'TagB', matchedVia: 'name' },
      { rawName: 'TagC', matchedTagId: 3, matchedTagName: 'TagC', matchedVia: 'name' },
    ];
    const liveEntries: NormalTagPreviewEntry[] = [
      // Live says TagC was actually archived -> overrides pickedTagEntries!
      { rawName: 'tagc', matchedTagId: null, matchedTagName: null, matchedVia: 'new' },
      // Live resolves whitespace-variant typed tag as alias
      { rawName: 'High   Res', matchedTagId: 77, matchedTagName: 'High Resolution', matchedVia: 'alias' },
    ];

    const merged = resolveDraftTagPills(['TagA', 'TagB', 'TagC', 'high res'], {
      manifestTags,
      performerPreview: matchingPreview,
      selectedManifestId: 10,
      pickedTagEntries: pickedEntries,
      liveTagPreviewEntries: liveEntries,
    });

    // TagB: picked (tier 3) overrides performerPreview (tier 2) -> 'name'
    assert.equal(merged.find((p) => p.tagName === 'TagB')?.matchedVia, 'name');
    // high res: live (tier 4) matches normalized key 'high res' -> 'alias'
    assert.deepEqual(
      merged.find((p) => p.tagName === 'high res'),
      {
        tagName: 'high res',
        idx: 3,
        matchedTagId: 77,
        matchedTagName: 'High Resolution',
        matchedVia: 'alias',
      },
    );
    // TagA: performerPreview (tier 2) overrides manifest.tags (tier 1) -> 'new'
    assert.equal(merged.find((p) => p.tagName === 'TagA')?.matchedVia, 'new');
    // TagC: live (tier 4) overrides picked (tier 3) -> 'new'
    assert.equal(merged.find((p) => p.tagName === 'TagC')?.matchedVia, 'new');
  });

  it('B3: sorts pills stably (name -> alias -> new) while preserving original draft idx and builds stable request keys', () => {
    const draft = parseDraftTagNames(' NewOne , AliasOne , NameOne , NewTwo , AliasTwo , NameTwo , ');
    assert.deepEqual(draft, ['NewOne', 'AliasOne', 'NameOne', 'NewTwo', 'AliasTwo', 'NameTwo']);

    const pills = resolveDraftTagPills(draft, {
      liveTagPreviewEntries: [
        { rawName: 'NameOne', matchedTagId: 1, matchedTagName: 'NameOne', matchedVia: 'name' },
        { rawName: 'NameTwo', matchedTagId: 2, matchedTagName: 'NameTwo', matchedVia: 'name' },
        { rawName: 'AliasOne', matchedTagId: 11, matchedTagName: 'Canon1', matchedVia: 'alias' },
        { rawName: 'AliasTwo', matchedTagId: 12, matchedTagName: 'Canon2', matchedVia: 'alias' },
      ],
    });

    assert.deepEqual(
      pills.map((p) => ({ tagName: p.tagName, idx: p.idx, matchedVia: p.matchedVia })),
      [
        { tagName: 'NameOne', idx: 2, matchedVia: 'name' },
        { tagName: 'NameTwo', idx: 5, matchedVia: 'name' },
        { tagName: 'AliasOne', idx: 1, matchedVia: 'alias' },
        { tagName: 'AliasTwo', idx: 4, matchedVia: 'alias' },
        { tagName: 'NewOne', idx: 0, matchedVia: 'new' },
        { tagName: 'NewTwo', idx: 3, matchedVia: 'new' },
      ],
    );

    // normalizeTagName & buildDraftTagRequestKey match Host normalizeLabel semantics
    assert.equal(normalizeTagName('  High   Res  '), 'high res');
    assert.equal(
      buildDraftTagRequestKey(['High   Res', 'outdoor', 'HIGH RES', '   ']),
      buildDraftTagRequestKey(['high res', 'OUTDOOR']),
    );
  });

  it('TagPreviewRequestTracker monotonically invalidates superseded and switched requests', () => {
    const tracker = new TagPreviewRequestTracker();
    const seq1 = tracker.next();
    assert.equal(tracker.isCurrent(seq1), true);

    const seq2 = tracker.next();
    assert.equal(tracker.isCurrent(seq1), false, 'older in-flight request must be rejected');
    assert.equal(tracker.isCurrent(seq2), true);

    // Switching selected file/manifest invalidates all in-flight requests
    tracker.invalidate();
    assert.equal(tracker.isCurrent(seq2), false, 'invalidated request must be rejected');

    const seq3 = tracker.next();
    assert.equal(tracker.isCurrent(seq3), true);
    assert.equal(seq3 > seq2 && seq2 > seq1, true);
  });
});
