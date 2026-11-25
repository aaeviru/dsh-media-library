import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  normalizeTagName,
  type IngestionManifest,
  type IngestionTask,
  type ManifestPerformerPreview,
  type NormalTagPreviewEntry,
  type PerformerAliasRecord,
  type PerformerReviewItem,
  type StagingFileItem,
  type TagSummary,
} from '../types.ts';
import { PerformerDrawer, PerformerInlineCard } from './PerformerReviewSection.tsx';
import type { MediaLibraryKey } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';
import {
  buildDraftTagRequestKey,
  parseDraftTagNames,
  pruneTagPreviewEntries,
  removeTagPreviewEntriesByName,
  resolveDraftTagPills,
  resolveUnresolvedTagStatus,
  TagPreviewRequestTracker,
  toPickedTagPreviewEntry,
  upsertTagPreviewEntry,
  type LiveTagPreviewStatus,
} from './tag-draft-preview.ts';
import { TagPicker } from './ui/TagPicker.tsx';
import { cx } from './ui/primitives.ts';
import css from './ui/styles.module.css';

type Translate = (key: MediaLibraryKey) => string;

type BusyOp = null | 'scan' | 'fetch' | 'play' | 'approve' | 'delete';

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface DraftFields {
  title: string;
  mediaDate: string;
  tagsText: string;
}

// Module-level session cache so switching away from the panel or sidebar never drops
// scanned temp files, selected row, or unsubmitted title/tag drafts.
const sessionCache: {
  stagedFiles: readonly StagingFileItem[];
  hasScannedOnce: boolean;
  selectedKey: string | null;
  dirtyDrafts: Record<string, DraftFields>;
  lastSeenTaskId: number;
  showPerformerDrawer: boolean;
} = {
  stagedFiles: [],
  hasScannedOnce: false,
  selectedKey: null,
  dirtyDrafts: {},
  lastSeenTaskId: 0,
  showPerformerDrawer: false,
};

interface UnifiedStagingEntry {
  readonly key: string;
  readonly filename: string;
  readonly relativePath: string;
  readonly tempPath: string;
  readonly targetRelativePath: string;
  readonly catalogNumber: string | null;
  readonly fileSize: number;
  readonly manifest: IngestionManifest | null;
}

/**
 * Per-file staging review & recoverable ingestion panel (`B6`).
 * Stage 3 (Issue #49): responsive Master-Detail workbench with sticky action footer
 * and searchable TagPicker autocomplete synced with the comma-separated tag draft.
 */
export function IngestionPanel({
  t,
  mediaLibrary,
  degraded,
  onCommitted,
}: {
  t: Translate;
  mediaLibrary: MediaLibraryNamespace;
  degraded: boolean;
  onCommitted: () => void;
}) {
  const [stagedFiles, setStagedFiles] = useState<readonly StagingFileItem[]>(() => sessionCache.stagedFiles);
  const [manifests, setManifests] = useState<readonly IngestionManifest[]>([]);
  const [tasks, setTasks] = useState<readonly IngestionTask[]>([]);
  const [performerAliases, setPerformerAliases] = useState<readonly PerformerAliasRecord[]>([]);
  const [pendingQueue, setPendingQueue] = useState<readonly PerformerReviewItem[]>([]);
  const [performerPreview, setPerformerPreview] = useState<ManifestPerformerPreview | null>(null);
  const [showPerformerDrawer, setShowPerformerDrawerState] = useState<boolean>(() => sessionCache.showPerformerDrawer);
  const [selectedKey, setSelectedKeyState] = useState<string | null>(() => sessionCache.selectedKey);
  const [dirtyDrafts, setDirtyDrafts] = useState<Record<string, DraftFields>>(() => ({ ...sessionCache.dirtyDrafts }));
  const [executing, setExecuting] = useState<{ op: 'commit' | 'reconcile'; key: string | null } | null>(null);
  const [busyOp, setBusyOp] = useState<BusyOp>(null);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tagPickerQuery, setTagPickerQuery] = useState('');
  const [tagCandidates, setTagCandidates] = useState<readonly TagSummary[]>([]);
  const [liveTagPreviewEntries, setLiveTagPreviewEntries] = useState<readonly NormalTagPreviewEntry[]>([]);
  const [pickedTagEntries, setPickedTagEntries] = useState<readonly NormalTagPreviewEntry[]>([]);
  const [liveTagPreviewState, setLiveTagPreviewState] = useState<LiveTagPreviewStatus>({
    status: 'idle',
    requestKey: '',
  });
  const [tagPreviewRefreshTick, setTagPreviewRefreshTick] = useState(0);
  const tagPreviewTrackerRef = useRef<TagPreviewRequestTracker | null>(null);
  if (tagPreviewTrackerRef.current === null) {
    tagPreviewTrackerRef.current = new TagPreviewRequestTracker();
  }
  const performerPreviewTrackerRef = useRef<TagPreviewRequestTracker | null>(null);
  if (performerPreviewTrackerRef.current === null) {
    performerPreviewTrackerRef.current = new TagPreviewRequestTracker();
  }

  const togglePerformerDrawer = useCallback(() => {
    setShowPerformerDrawerState((prev) => {
      const next = !prev;
      sessionCache.showPerformerDrawer = next;
      return next;
    });
  }, []);

  const setSelectedKey = useCallback((next: string | null) => {
    sessionCache.selectedKey = next;
    setSelectedKeyState(next);
    setConfirmDeleteKey(null);
  }, []);

  const updateDraft = useCallback((key: string, patch: Partial<DraftFields>, fallback: DraftFields) => {
    setDirtyDrafts((prev) => {
      const current = prev[key] ?? fallback;
      const nextDraft = { ...current, ...patch };
      if (
        nextDraft.title === fallback.title &&
        nextDraft.mediaDate === fallback.mediaDate &&
        nextDraft.tagsText === fallback.tagsText
      ) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        sessionCache.dirtyDrafts = next;
        return next;
      }
      const next = { ...prev, [key]: nextDraft };
      sessionCache.dirtyDrafts = next;
      return next;
    });
  }, []);

  const clearDraft = useCallback((key: string) => {
    setDirtyDrafts((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      sessionCache.dirtyDrafts = next;
      return next;
    });
  }, []);

  const runningHostTask = useMemo(
    () => tasks.find(task => task.status === 'running' && task.op !== 'fetch') ?? tasks.find(task => task.status === 'running') ?? null,
    [tasks],
  );
  const busy = busyOp !== null;
  const executionBusy = executing !== null || tasks.some(task => task.status === 'running' && task.op !== 'fetch');
  const frozenManifests = manifests.filter(m => tasks.some(task => task.status === 'running' &&
    (task.targetKey === `manifest:${m.id}` || (task.op === 'reconcile' && ['moving', 'failed', 'indexed'].includes(m.state)))));
  const frozenManifestIds = frozenManifests.map(m => m.id);
  const frozenPerformerNames = frozenManifests.flatMap(m => m.actresses);

  const reloadServerState = useCallback(async () => {
    try {
      const [mRes, tRes, paRes, pqRes] = await Promise.all([
        mediaLibrary.listIngestionManifests(),
        mediaLibrary.listIngestionTasks(),
        mediaLibrary.listPerformerAliases(),
        mediaLibrary.listPerformerReviewQueue({ status: 'pending' }),
      ]);
      if (mRes.ok) {
        setManifests(mRes.value);
      } else {
        setError(mRes.error.message || t('rpcError'));
      }
      if (paRes.ok) {
        setPerformerAliases(paRes.value);
      }
      if (pqRes.ok) {
        setPendingQueue(pqRes.value);
      }
      if (tRes.ok) {
        setTasks(tRes.value);
        const latest = tRes.value[0];
        if (latest && latest.status !== 'running' && latest.id > sessionCache.lastSeenTaskId) {
          sessionCache.lastSeenTaskId = latest.id;
          if (latest.status === 'succeeded') {
            setMessage(latest.message);
          } else {
            setError(latest.message);
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [mediaLibrary, t]);

  useEffect(() => {
    let active = true;
    const trimmed = tagPickerQuery.trim();
    void mediaLibrary
      .listTags({ query: trimmed || undefined, limit: 30 })
      .then((res) => {
        if (!active || !res.ok) return;
        setTagCandidates(res.value.tags);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [mediaLibrary, tagPickerQuery, manifests]);

  const runScan = useCallback(
    async (silent: boolean) => {
      if (!silent) {
        setBusyOp('scan');
        setMessage(null);
        setError(null);
      }
      try {
        const res = await mediaLibrary.scanStagingFiles();
        if (!res.ok) {
          if (!silent) setError(res.error.message || t('rpcError'));
          return;
        }
        setManifests(res.value.manifests);
        if (res.value.ok) {
          sessionCache.stagedFiles = res.value.files;
          sessionCache.hasScannedOnce = true;
          setStagedFiles(res.value.files);
          if (!silent) {
            setMessage(`Scanned ${res.value.files.length} file(s) in ${res.value.elapsedMs} ms (${res.value.stagingDir})`);
          }
        } else if (!silent) {
          setError(res.value.error ?? 'Scan failed');
        }
      } catch (err) {
        if (!silent) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!silent) setBusyOp(null);
      }
    },
    [mediaLibrary, t],
  );

  useEffect(() => {
    void reloadServerState();
    if (sessionCache.hasScannedOnce) {
      void runScan(true);
    }
  }, [reloadServerState, runScan]);

  // Discover tasks started here or in another connection, including before the long RPC returns.
  useEffect(() => {
    const timer = setInterval(() => {
      void reloadServerState();
    }, 1200);
    return () => clearInterval(timer);
  }, [reloadServerState]);

  const entries = useMemo<UnifiedStagingEntry[]>(() => {
    const byManifestId = new Map<number, IngestionManifest>();
    const unindexedByFilename = new Map<string, IngestionManifest>();
    for (const m of manifests) {
      byManifestId.set(m.id, m);
      if (m.state !== 'indexed') {
        const key = m.filename.toLowerCase();
        if (!unindexedByFilename.has(key)) {
          unindexedByFilename.set(key, m);
        }
      }
    }

    // Show only files currently present in the temp staging folder (exclude already-moved history).
    // Never assign the same manifest ID to two different same-named files in distinct subfolders.
    const stagedTempPaths = new Set(stagedFiles.map((f) => f.tempPath.toLowerCase()));
    const claimedManifestIds = new Set<number>();
    const list: UnifiedStagingEntry[] = [];
    for (const file of stagedFiles) {
      let matched: IngestionManifest | null = null;
      if (file.manifestId !== null && !claimedManifestIds.has(file.manifestId)) {
        matched = byManifestId.get(file.manifestId) ?? null;
      }
      if (!matched) {
        matched =
          manifests.find(
            (m) => !claimedManifestIds.has(m.id) && m.tempPath.toLowerCase() === file.tempPath.toLowerCase(),
          ) ?? null;
      }
      if (!matched) {
        const byName = unindexedByFilename.get(file.filename.toLowerCase());
        if (byName && !claimedManifestIds.has(byName.id) && !stagedTempPaths.has(byName.tempPath.toLowerCase())) {
          matched = byName;
        }
      }
      if (matched) {
        claimedManifestIds.add(matched.id);
      }
      list.push({
        key: matched ? `m:${matched.id}` : `f:${file.tempPath}`,
        filename: file.filename,
        relativePath: file.relativePath,
        tempPath: file.tempPath,
        targetRelativePath: matched?.targetRelativePath ?? file.targetRelativePath,
        catalogNumber: matched?.catalogNumber ?? file.catalogNumber,
        fileSize: file.fileSize,
        manifest: matched,
      });
    }
    for (const m of frozenManifests) {
      if (!list.some(entry => entry.manifest?.id === m.id)) list.push({
        key: `m:${m.id}`, filename: m.filename, relativePath: m.filename,
        tempPath: m.tempPath, targetRelativePath: m.targetRelativePath,
        catalogNumber: m.catalogNumber, fileSize: m.fileSize, manifest: m,
      });
    }
    return list;
  }, [stagedFiles, manifests, tasks]);

  const selected = useMemo(() => {
    if (!selectedKey) return null;
    const exact = entries.find((e) => e.key === selectedKey);
    if (exact) return exact;
    if (selectedKey.startsWith('f:')) {
      const targetTempLower = selectedKey.slice(2).toLowerCase();
      const byTemp = entries.find((e) => e.tempPath.toLowerCase() === targetTempLower);
      if (byTemp) return byTemp;
      const baseName = targetTempLower.split(/[\\/]/).pop() ?? '';
      if (baseName) {
        return entries.find((e) => e.filename.toLowerCase() === baseName) ?? null;
      }
    }
    return null;
  }, [entries, selectedKey]);
  const selectedManifestId = selected?.manifest?.id ?? null;
  const selectedEntryKey = selected?.key ?? null;

  // Smoothly migrate selection and any unsubmitted draft when a staged file gains a manifest ID
  // (e.g., after Fetch completes while the user switched away from the panel).
  useEffect(() => {
    if (!selected || !selectedKey || selected.key === selectedKey) return;
    const oldKey = selectedKey;
    const nextKey = selected.key;
    setSelectedKey(nextKey);
    setDirtyDrafts((prev) => {
      if (!(oldKey in prev) || nextKey in prev) return prev;
      const next = { ...prev, [nextKey]: prev[oldKey]! };
      delete next[oldKey];
      sessionCache.dirtyDrafts = next;
      return next;
    });
  }, [selected, selectedKey, setSelectedKey]);

  const reloadSelectedPreview = useCallback(async () => {
    const tracker = performerPreviewTrackerRef.current!;
    if (selectedManifestId === null) {
      tracker.invalidate();
      setPerformerPreview(null);
      return;
    }
    const seq = tracker.next();
    try {
      const res = await mediaLibrary.previewManifestPerformers({ manifestId: selectedManifestId });
      if (!tracker.isCurrent(seq)) return;
      if (res.ok) {
        setPerformerPreview(res.value);
      }
    } catch {
      // Ignore transient preview error; commit still enforces server-side gate.
    }
  }, [mediaLibrary, selectedManifestId]);

  useEffect(() => {
    void reloadSelectedPreview();
  }, [reloadSelectedPreview, manifests, performerAliases, pendingQueue]);

  const resetTagPreviewCaches = useCallback((scheduleRefresh = false) => {
    tagPreviewTrackerRef.current?.invalidate();
    setLiveTagPreviewEntries([]);
    setPickedTagEntries([]);
    setLiveTagPreviewState({ status: 'idle', requestKey: '' });
    if (scheduleRefresh) {
      setTagPreviewRefreshTick((tick) => tick + 1);
    }
  }, []);

  useEffect(() => {
    resetTagPreviewCaches(false);
  }, [selectedEntryKey, resetTagPreviewCaches]);

  const serverFallback: DraftFields = useMemo(() => {
    const manifestTags = selected?.manifest?.tags ?? [];
    const orderedTags = resolveDraftTagPills(
      manifestTags.map((tag) => tag.name),
      {
        manifestTags,
        performerPreview,
        selectedManifestId,
      },
    ).map((entry) => entry.tagName);
    return {
      title: selected?.manifest?.title ?? '',
      mediaDate: selected?.manifest?.mediaDate ?? '',
      tagsText: orderedTags.join(', '),
    };
  }, [selected, performerPreview, selectedManifestId]);
  const selectedFrozen = Boolean(selected && (executing?.key === selected.key ||
    (selected.manifest && frozenManifestIds.includes(selected.manifest.id))));
  const activeDraft = selected
    ? dirtyDrafts[selected.key] ?? (selectedKey ? dirtyDrafts[selectedKey] : undefined) ?? serverFallback
    : serverFallback;

  const draftTagList = useMemo(
    () => parseDraftTagNames(activeDraft.tagsText),
    [activeDraft.tagsText],
  );
  const draftTagRequestKey = useMemo(
    () => buildDraftTagRequestKey(draftTagList),
    [draftTagList],
  );
  const draftTagListRef = useRef<readonly string[]>(draftTagList);
  draftTagListRef.current = draftTagList;

  useEffect(() => {
    const tracker = tagPreviewTrackerRef.current!;
    if (!selectedEntryKey) {
      tracker.invalidate();
      setLiveTagPreviewEntries([]);
      setPickedTagEntries([]);
      setLiveTagPreviewState({ status: 'idle', requestKey: '' });
      return;
    }
    const names = draftTagListRef.current;
    if (names.length === 0) {
      tracker.invalidate();
      setLiveTagPreviewEntries([]);
      setPickedTagEntries([]);
      setLiveTagPreviewState({ status: 'idle', requestKey: '' });
      return;
    }
    setPickedTagEntries((prev) => pruneTagPreviewEntries(prev, names));
    setLiveTagPreviewEntries((prev) => pruneTagPreviewEntries(prev, names));
    let cancelled = false;
    const seq = tracker.next();
    setLiveTagPreviewState({ status: 'pending', requestKey: draftTagRequestKey });
    const timer = setTimeout(() => {
      void mediaLibrary
        .previewTagNames({ names })
        .then((res) => {
          if (cancelled || !tracker.isCurrent(seq)) return;
          if (!res.ok) {
            setLiveTagPreviewState({ status: 'unavailable', requestKey: draftTagRequestKey });
            return;
          }
          setLiveTagPreviewEntries(res.value);
          setLiveTagPreviewState({ status: 'ready', requestKey: draftTagRequestKey });
        })
        .catch(() => {
          if (cancelled || !tracker.isCurrent(seq)) return;
          setLiveTagPreviewState({ status: 'unavailable', requestKey: draftTagRequestKey });
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mediaLibrary, selectedEntryKey, draftTagRequestKey, tagPreviewRefreshTick]);

  const unresolvedTagStatus = useMemo(
    () => resolveUnresolvedTagStatus(liveTagPreviewState, draftTagRequestKey),
    [liveTagPreviewState, draftTagRequestKey],
  );

  const sortedTagPills = useMemo(
    () =>
      resolveDraftTagPills(draftTagList, {
        manifestTags: selected?.manifest?.tags,
        performerPreview,
        selectedManifestId,
        pickedTagEntries,
        liveTagPreviewEntries,
        unresolvedStatus: unresolvedTagStatus,
      }),
    [
      draftTagList,
      selected,
      performerPreview,
      selectedManifestId,
      pickedTagEntries,
      liveTagPreviewEntries,
      unresolvedTagStatus,
    ],
  );

  const removeDraftTag = useCallback(
    (indexToRemove: number) => {
      if (!selected) return;
      const removedName = draftTagList[indexToRemove];
      const nextList = draftTagList.filter((_, i) => i !== indexToRemove);
      if (removedName !== undefined) {
        const removedNorm = normalizeTagName(removedName);
        if (!nextList.some((item) => normalizeTagName(item) === removedNorm)) {
          setPickedTagEntries((prev) => removeTagPreviewEntriesByName(prev, removedName));
        }
      }
      updateDraft(selected.key, { tagsText: nextList.join(', ') }, serverFallback);
    },
    [draftTagList, selected, serverFallback, updateDraft],
  );

  const appendDraftTag = useCallback(
    (rawTagName: string) => {
      const trimmed = rawTagName.trim();
      if (!trimmed || !selected) return;
      const norm = normalizeTagName(trimmed);
      const alreadyPresent = draftTagList.some((existing) => normalizeTagName(existing) === norm);
      if (!alreadyPresent) {
        const nextList = [...draftTagList, trimmed];
        updateDraft(selected.key, { tagsText: nextList.join(', ') }, serverFallback);
      }
      setTagPickerQuery('');
    },
    [draftTagList, selected, serverFallback, updateDraft],
  );

  const selectPickerTag = useCallback(
    (tag: TagSummary) => {
      const trimmed = tag.name.trim();
      if (!trimmed || !selected) return;
      const norm = normalizeTagName(trimmed);
      const alreadyPresent = draftTagList.some((existing) => normalizeTagName(existing) === norm);
      const pickedEntry = toPickedTagPreviewEntry(tag);
      if (pickedEntry) {
        setPickedTagEntries((prev) => upsertTagPreviewEntry(prev, pickedEntry));
        setLiveTagPreviewEntries((prev) => removeTagPreviewEntriesByName(prev, trimmed));
      }
      if (!alreadyPresent) {
        const nextList = [...draftTagList, trimmed];
        updateDraft(selected.key, { tagsText: nextList.join(', ') }, serverFallback);
      } else if (pickedEntry) {
        setTagPreviewRefreshTick((tick) => tick + 1);
      }
      setTagPickerQuery('');
    },
    [draftTagList, selected, serverFallback, updateDraft],
  );

  const trimmedPickerQuery = tagPickerQuery.trim();
  const hasExactPickerMatch = useMemo(() => {
    if (!trimmedPickerQuery) return true;
    const norm = normalizeTagName(trimmedPickerQuery);
    return tagCandidates.some(
      (tag) =>
        normalizeTagName(tag.name) === norm ||
        tag.aliases.some((alias) => normalizeTagName(alias) === norm),
    );
  }, [tagCandidates, trimmedPickerQuery]);

  const handlePerformerChanged = useCallback(
    (msg: string) => {
      setError(null);
      setMessage(msg);
      void reloadServerState().then(() => reloadSelectedPreview());
    },
    [reloadSelectedPreview, reloadServerState],
  );

  const remediationCount = useMemo(
    () => performerAliases.filter((a) => a.needsRemediation).length,
    [performerAliases],
  );
  const activePerformerPreview =
    performerPreview && selectedManifestId !== null && performerPreview.manifestId === selectedManifestId
      ? performerPreview
      : null;
  const commitBlockedByPerformer = Boolean(activePerformerPreview && !activePerformerPreview.canCommit);

  const handleReconcile = async () => {
    setExecuting({ op: 'reconcile', key: null });
    setMessage(null);
    setError(null);
    try {
      const res = await mediaLibrary.reconcileIngestion();
      if (!res.ok) {
        setError(res.error.message || t('rpcError'));
        return;
      }
      setManifests(res.value.manifests);
      if (res.value.ok) {
        setMessage(
          `Reconciled ${res.value.reconciledCount} manifest(s) (cleanup=${res.value.copiedNotDeletedFixed}, index=${res.value.movedNotIndexedFixed}, missing=${res.value.indexedButMissingMarked})`,
        );
        onCommitted();
      } else {
        setError(res.value.errors.join('; '));
      }
      await reloadServerState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(null);
    }
  };

  const handlePlay = async (entry: UnifiedStagingEntry) => {
    setBusyOp('play');
    setMessage(null);
    setError(null);
    try {
      const res =
        entry.manifest?.state === 'indexed' && entry.manifest.indexedMediaId !== null
          ? await mediaLibrary.openMedia(String(entry.manifest.indexedMediaId))
          : await mediaLibrary.openStagingFile({ relativePath: entry.relativePath });
      if (!res.ok) {
        setError(res.error.message || t('rpcError'));
        return;
      }
      if (res.value.ok) {
        setMessage(`Opened ${entry.filename}`);
      } else {
        setError(`[${res.value.code}] ${res.value.message}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyOp(null);
    }
  };

  const handleFetch = async (entry: UnifiedStagingEntry) => {
    setBusyOp('fetch');
    setMessage(null);
    setError(null);
    try {
      const res = await mediaLibrary.fetchIngestionMetadata(
        entry.manifest ? { manifestId: entry.manifest.id } : { relativePath: entry.relativePath },
      );
      if (!res.ok) {
        setError(res.error.message || t('rpcError'));
        return;
      }
      clearDraft(entry.key);
      if (res.value.manifest) {
        clearDraft(`m:${res.value.manifest.id}`);
        setSelectedKey(`m:${res.value.manifest.id}`);
      }
      resetTagPreviewCaches(false);
      performerPreviewTrackerRef.current?.invalidate();
      setPerformerPreview(null);
      if (res.value.ok) {
        setMessage(`Fetched from ${res.value.provider}: ${res.value.title ?? ''}`);
      } else {
        setError(`[${res.value.category}] ${res.value.reason}`);
      }
      await reloadServerState();
      setTagPreviewRefreshTick((tick) => tick + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyOp(null);
    }
  };

  const approveEntry = async (entry: UnifiedStagingEntry): Promise<IngestionManifest | null> => {
    const result = await mediaLibrary.reviewIngestion({
      manifestId: entry.manifest?.id, relativePath: entry.manifest ? undefined : entry.relativePath,
      decision: 'approved', title: activeDraft.title, mediaDate: activeDraft.mediaDate,
      newTagNames: activeDraft.tagsText.split(',').map(s => s.trim()).filter(Boolean),
    });
    if (!result.ok) {
      setError(result.error.message || t('rpcError'));
      return null;
    }
    const manifest = result.value.manifest;
    if (!result.value.ok || !manifest) {
      setError(result.value.message ?? result.value.code ?? 'Review failed');
      return null;
    }
    clearDraft(entry.key);
    clearDraft(`m:${manifest.id}`);
    resetTagPreviewCaches(true);
    setSelectedKey(`m:${manifest.id}`);
    return manifest;
  };

  const handleApprove = async (entry: UnifiedStagingEntry) => {
    setBusyOp('approve');
    setError(null);
    try {
      if (await approveEntry(entry)) setMessage(t('ingestionApproveBtn'));
      await reloadServerState();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusyOp(null); }
  };

  const handleMoveAndIndex = async (entry: UnifiedStagingEntry) => {
    setExecuting({ op: 'commit', key: entry.key });
    setMessage(null);
    setError(null);
    try {
      const approvedManifest = await approveEntry(entry);
      if (!approvedManifest) {
        await reloadServerState();
        return;
      }
      setExecuting({ op: 'commit', key: `m:${approvedManifest.id}` });

      const commitRes = await mediaLibrary.commitIngestion({ manifestId: approvedManifest.id });
      if (!commitRes.ok) {
        setError(commitRes.error.message || t('rpcError'));
        await reloadServerState();
        return;
      }
      if (commitRes.value.ok) {
        clearDraft(`m:${approvedManifest.id}`);
        setMessage(commitRes.value.message + (commitRes.value.warning ? ` (${commitRes.value.warning})` : ''));
        onCommitted();
      } else {
        setError(`[${commitRes.value.code ?? 'ERROR'}] ${commitRes.value.message}`);
      }
      await reloadServerState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExecuting(null);
    }
  };

  const handleDeleteStagingFile = async (entry: UnifiedStagingEntry) => {
    setBusyOp('delete');
    setMessage(null);
    setError(null);
    try {
      const res = await mediaLibrary.deleteStagingFile({
        manifestId: entry.manifest?.id,
        relativePath: entry.relativePath,
        expectedFileSize: entry.fileSize,
      });
      if (!res.ok) {
        setError(res.error.message || t('rpcError'));
        return;
      }
      if (!res.value.ok) {
        setError(`[${res.value.code ?? 'ERROR'}] ${res.value.message}`);
        setConfirmDeleteKey(null);
        await Promise.all([reloadServerState(), runScan(true)]);
        return;
      }
      clearDraft(entry.key);
      if (entry.manifest) clearDraft(`m:${entry.manifest.id}`);
      setConfirmDeleteKey(null);
      setSelectedKey(null);
      const nextStaged = stagedFiles.filter((f) => f.relativePath !== entry.relativePath);
      sessionCache.stagedFiles = nextStaged;
      setStagedFiles(nextStaged);
      setMessage(res.value.message);
      await Promise.all([reloadServerState(), runScan(true)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyOp(null);
    }
  };

  const busyBannerText = runningHostTask
    ? `#${runningHostTask.id} · ${t(`ingestionPhase_${runningHostTask.phase}`)} · ${runningHostTask.message}`
    : executing ? t(executing.op === 'commit' ? 'ingestionCommittingBtn' : 'ingestionReconcilingBtn')
      : busyOp === 'scan' ? t('ingestionScanningBtn')
        : busyOp === 'fetch' ? t('ingestionFetchingBtn')
          : busyOp === 'approve' ? t('ingestionApprovingBtn')
            : busyOp === 'delete' ? t('ingestionDeletingBtn') : null;

  return (
    <section data-testid="ingestion-panel" className={css.panel}>
      <div className={css.rowBetween}>
        <strong className={css.sectionTitle}>{t('ingestionHeading')}</strong>
        <div className={css.row}>
          <button
            type="button"
            data-testid="performer-drawer-btn"
            onClick={togglePerformerDrawer}
            className={cx(
              css.btn,
              (pendingQueue.length > 0 || remediationCount > 0) && css.btnWarnBorder,
            )}
          >
            {t('performerDrawerBtn')} ({pendingQueue.length}
            {remediationCount > 0 ? ` / ⚠${remediationCount}` : ''})
          </button>
          <button
            type="button"
            data-testid="ingestion-scan-btn"
            disabled={busy || degraded}
            onClick={() => void runScan(false)}
            className={css.btn}
          >
            {busyOp === 'scan' ? t('ingestionScanningBtn') : t('ingestionScanBtn')}
          </button>
          <button
            type="button"
            data-testid="ingestion-reconcile-btn"
            disabled={busy || executionBusy || degraded}
            onClick={() => void handleReconcile()}
            className={css.btn}
          >
            {executing?.op === 'reconcile' ? t('ingestionReconcilingBtn') : t('ingestionReconcileBtn')}
          </button>
        </div>
      </div>

      {showPerformerDrawer ? (
        <PerformerDrawer
          t={t}
          mediaLibrary={mediaLibrary}
          aliases={performerAliases}
          pendingQueue={pendingQueue}
          disabled={busy || degraded}
          frozenManifestIds={frozenManifestIds}
          frozenPerformerNames={frozenPerformerNames}
          onChanged={handlePerformerChanged}
          onError={setError}
        />
      ) : null}

      {busyBannerText ? (
        <div role="status" data-testid="ingestion-busy" className={cx(css.banner, css.bannerInfo)}>
          {busyBannerText}
        </div>
      ) : null}

      {runningHostTask?.waitingWarning ? (
        <div role="status" data-testid="ingestion-waiting-warning" className={cx(css.banner, css.bannerWarn)}>
          {t('ingestionWaitingWarning')}
        </div>
      ) : null}

      {message ? (
        <div role="status" data-testid="ingestion-message" className={css.banner}>
          {message}
        </div>
      ) : null}
      {error ? (
        <div role="alert" data-testid="ingestion-error" className={cx(css.banner, css.bannerDanger)}>
          {error}
        </div>
      ) : null}

      {entries.length === 0 ? (
        <div data-testid="ingestion-empty" className={css.emptyBox}>
          {t('ingestionEmpty')}
        </div>
      ) : (
        <div data-testid="ingestion-workbench" className={css.ingestionWorkbench}>
          {/* Left Master Column: Staged File & Manifest Queue */}
          <div className={css.ingestionMasterCol}>
            <div className={css.rowBetween}>
              <span className={css.fieldLabel}>
                {t('ingestionQueueListHeading')} ({entries.length})
              </span>
            </div>
            <ul data-testid="ingestion-manifest-list" className={css.ingestionQueueList}>
              {entries.map((entry) => (
                <li key={entry.key}>
                  <button
                    type="button"
                    data-testid={entry.manifest ? `ingestion-row-${entry.manifest.id}` : `ingestion-file-${entry.filename}`}
                    onClick={() => setSelectedKey(entry.key)}
                    className={cx(css.listRowBtn, entry.key === selected?.key && css.listRowBtnSelected)}
                  >
                    <div>
                      <strong>{entry.filename}</strong>
                    </div>
                    <div className={css.ingestionQueueMeta}>
                      <code>{entry.manifest?.state ?? 'temp'}</code>
                      {entry.manifest ? (
                        <span>
                          / <code>{entry.manifest.reviewDecision}</code>
                        </span>
                      ) : null}
                      {entry.catalogNumber ? <span>· {entry.catalogNumber}</span> : null}
                      <span>· {Math.round(entry.fileSize / (1024 * 1024))} MB</span>
                      {entry.manifest?.indexedMediaId !== null && entry.manifest?.indexedMediaId !== undefined ? (
                        <span>· media #{entry.manifest.indexedMediaId}</span>
                      ) : null}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {/* Right Detail Column: Selected File Metadata, Performer Review, TagPicker & Sticky Actions */}
          {selected ? (
            <div data-testid="ingestion-detail" className={css.ingestionDetailCard}>
              <div className={css.ingestionDetailBody}>
                <div className={css.rowBetween}>
                  <div>
                    <strong>{t('ingestionTargetLabel')}:</strong>{' '}
                    <code>{selected.targetRelativePath}</code>
                  </div>
                  {selected.manifest?.metadataSource ? (
                    <span className={css.mutedSm}>({selected.manifest.metadataSource})</span>
                  ) : null}
                </div>

                <div className={css.ingestionMetaGrid}>
                  <label className={css.stackSm}>
                    <span className={css.fieldLabel}>{t('ingestionTitleLabel')}</span>
                    <input
                      type="text"
                      data-testid="ingestion-title-input"
                      disabled={selectedFrozen || degraded}
                      value={activeDraft.title}
                      onChange={(e) => updateDraft(selected.key, { title: e.target.value }, serverFallback)}
                      className={css.control}
                    />
                  </label>
                  <label className={css.stackSm}>
                    <span className={css.fieldLabel}>{t('ingestionDateLabel')}</span>
                    <input
                      type="text"
                      data-testid="ingestion-date-input"
                      disabled={selectedFrozen || degraded}
                      placeholder="YYYY-MM-DD"
                      value={activeDraft.mediaDate}
                      onChange={(e) => updateDraft(selected.key, { mediaDate: e.target.value }, serverFallback)}
                      className={css.control}
                    />
                  </label>
                </div>

                {activePerformerPreview ? (
                  <PerformerInlineCard
                    t={t}
                    preview={activePerformerPreview}
                    mediaLibrary={mediaLibrary}
                    disabled={busy || selectedFrozen || degraded || selected.manifest?.state === 'indexed'}
                    onChanged={handlePerformerChanged}
                    onError={setError}
                  />
                ) : null}

                <div className={css.stackSm}>
                  <span className={css.fieldLabel}>{t('ingestionTagsLabel')}</span>
                  {sortedTagPills.length > 0 ? (
                    <div data-testid="ingestion-tag-preview" className={css.rowTight}>
                      {sortedTagPills.map(({ tagName, idx, matchedVia, matchedTagName }) => {
                        const badgeText =
                          matchedVia === 'name'
                            ? t('tagPreviewExisting')
                            : matchedVia === 'alias'
                              ? `${t('tagPreviewAlias')}→${matchedTagName ?? ''}`
                              : matchedVia === 'new'
                                ? `+ ${t('tagPreviewNew')}`
                                : matchedVia === 'unavailable'
                                  ? t('tagPreviewUnavailable')
                                  : t('tagPreviewPending');
                        const pillToneClass =
                          matchedVia === 'name' || matchedVia === 'alias'
                            ? css.pillChipSuccess
                            : matchedVia === 'new'
                              ? css.pillChipWarnDashed
                              : undefined;
                        return (
                          <span
                            key={`${tagName}-${idx}`}
                            data-tag-name={tagName}
                            data-match-state={matchedVia}
                            className={cx(
                              css.pillChip,
                              css.pillChipStatic,
                              pillToneClass,
                            )}
                          >
                            <span>{tagName}</span>
                            <span className={css.mutedSm}>({badgeText})</span>
                            {selected.manifest?.state !== 'indexed' ? (
                              <button
                                type="button"
                                disabled={selectedFrozen || degraded}
                                aria-label={`Remove ${tagName}`}
                                onClick={() => removeDraftTag(idx)}
                                className={css.chipRemoveBtn}
                              >
                                ×
                              </button>
                            ) : null}
                          </span>
                        );
                      })}
                    </div>
                  ) : null}

                  <TagPicker
                    query={tagPickerQuery}
                    onQueryChange={setTagPickerQuery}
                    candidates={tagCandidates}
                    selectedTagId={null}
                    onSelectTag={selectPickerTag}
                    showCreateOption={Boolean(trimmedPickerQuery && !hasExactPickerMatch)}
                    createOptionText={`+ ${t('batchCreateAndAdd')} “${trimmedPickerQuery}”`}
                    onCreateTag={() => appendDraftTag(trimmedPickerQuery)}
                    placeholder={t('ingestionTagPickerPlaceholder')}
                    noMatchText={t('batchNoMatch')}
                    disabled={selectedFrozen || degraded || selected.manifest?.state === 'indexed'}
                    inputTestId="ingestion-tag-picker-input"
                    dropdownTestId="ingestion-tag-picker-dropdown"
                    optionTestIdPrefix="ingestion-tag-picker-option-"
                    createOptionTestId="ingestion-tag-picker-create"
                  />

                  <input
                    type="text"
                    data-testid="ingestion-tags-input"
                    disabled={selectedFrozen || degraded}
                    value={activeDraft.tagsText}
                    onChange={(e) => updateDraft(selected.key, { tagsText: e.target.value }, serverFallback)}
                    className={css.control}
                  />
                </div>

                {commitBlockedByPerformer ? (
                  <div role="status" data-testid="performer-commit-gate" className={cx(css.banner, css.bannerWarn)}>
                    ⚠ {t('performerCommitGateHint')}
                  </div>
                ) : null}

                {confirmDeleteKey === selected.relativePath && selected.manifest?.state !== 'indexed' ? (
                  <div role="alert" data-testid="ingestion-delete-confirm-bar" className={cx(css.banner, css.bannerDanger)}>
                    <div>
                      <strong>{selected.filename}</strong> ({formatFileSize(selected.fileSize)}) — {t('ingestionDeleteConfirmPrompt')}
                    </div>
                    <div className={css.rowTight}>
                      <button
                        type="button"
                        data-testid="ingestion-delete-confirm-btn"
                        disabled={busy || executionBusy || selectedFrozen || degraded}
                        onClick={() => void handleDeleteStagingFile(selected)}
                        className={css.btn}
                      >
                        {busyOp === 'delete' ? t('ingestionDeletingBtn') : t('ingestionDeleteConfirmBtn')}
                      </button>
                      <button
                        type="button"
                        data-testid="ingestion-delete-cancel-btn"
                        disabled={busy}
                        onClick={() => setConfirmDeleteKey(null)}
                        className={css.btn}
                      >
                        {t('ingestionDeleteCancelBtn')}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className={css.ingestionDetailFooter}>
                <div className={css.rowTight}>
                  <button
                    type="button"
                    data-testid="ingestion-play-btn"
                    disabled={busy || selectedFrozen}
                    onClick={() => void handlePlay(selected)}
                    className={css.btn}
                  >
                    {busyOp === 'play' ? t('ingestionPlayingBtn') : t('ingestionPlayBtn')}
                  </button>
                  <button
                    type="button"
                    data-testid="ingestion-fetch-btn"
                    disabled={busy || selectedFrozen || degraded || selected.manifest?.state === 'indexed'}
                    onClick={() => void handleFetch(selected)}
                    className={css.btn}
                  >
                    {busyOp === 'fetch' ? t('ingestionFetchingBtn') : t('ingestionFetchBtn')}
                  </button>
                  {selected.manifest?.state !== 'indexed' ? (
                    <button
                      type="button"
                      data-testid="ingestion-delete-btn"
                      disabled={busy || executionBusy || selectedFrozen || degraded}
                      onClick={() => setConfirmDeleteKey(selected.relativePath)}
                      className={css.btn}
                    >
                      {t('ingestionDeleteBtn')}
                    </button>
                  ) : null}
                </div>
                <div className={css.rowTight}>
                  <button
                    type="button"
                    data-testid="ingestion-approve-btn"
                    disabled={busy || selectedFrozen || degraded || selected.manifest?.state === 'indexed'}
                    onClick={() => void handleApprove(selected)}
                    className={css.btn}
                  >
                    {t('ingestionApproveBtn')}
                  </button>
                  <button
                    type="button"
                    data-testid="ingestion-commit-btn"
                    disabled={busy || executionBusy || selectedFrozen || degraded || commitBlockedByPerformer || selected.manifest?.state === 'indexed'}
                    onClick={() => void handleMoveAndIndex(selected)}
                    className={cx(css.btn, css.btnPrimary)}
                  >
                    {executing?.op === 'commit' ? t('ingestionCommittingBtn') : t('ingestionCommitBtn')}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div data-testid="ingestion-no-selection" className={css.emptyBox}>
              {t('ingestionSelectPrompt')}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
