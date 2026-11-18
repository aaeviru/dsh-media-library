import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  IngestionManifest,
  IngestionTask,
  ManifestPerformerPreview,
  PerformerAliasRecord,
  PerformerReviewItem,
  StagingFileItem,
} from '../types.ts';
import { PerformerDrawer, PerformerInlineCard } from './PerformerReviewSection.tsx';
import { buttonStyle, controlStyle } from './TagManagementPanel.tsx';
import type { MediaLibraryKey } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';

type Translate = (key: MediaLibraryKey) => string;

type BusyOp = null | 'scan' | 'reconcile' | 'fetch' | 'play' | 'approve' | 'reject' | 'commit';

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
 * Uses Host/SQLite `ingestion_tasks` for cross-switch progress visibility & concurrency locks,
 * and separates client `dirtyDrafts` from server manifest refreshes.
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
  const [busyOp, setBusyOp] = useState<BusyOp>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  }, []);

  const updateDraft = useCallback((key: string, patch: Partial<DraftFields>, fallback: DraftFields) => {
    setDirtyDrafts((prev) => {
      const current = prev[key] ?? fallback;
      const next = { ...prev, [key]: { ...current, ...patch } };
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
    () => tasks.find((task) => task.status === 'running') ?? null,
    [tasks],
  );
  const busy = busyOp !== null || runningHostTask !== null;

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

  // Poll Host task table while any task is still running across tab switches.
  useEffect(() => {
    if (!runningHostTask) return;
    const timer = setInterval(() => {
      void reloadServerState();
    }, 1200);
    return () => clearInterval(timer);
  }, [runningHostTask, reloadServerState]);

  const entries = useMemo<UnifiedStagingEntry[]>(() => {
    const byManifestId = new Map<number, IngestionManifest>();
    for (const m of manifests) byManifestId.set(m.id, m);

    // Show only files currently present in the temp staging folder (exclude already-moved history).
    const list: UnifiedStagingEntry[] = [];
    for (const file of stagedFiles) {
      const matched =
        (file.manifestId !== null ? byManifestId.get(file.manifestId) : undefined) ??
        manifests.find((m) => m.tempPath.toLowerCase() === file.tempPath.toLowerCase()) ??
        null;
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
    return list;
  }, [stagedFiles, manifests]);

  const selected = entries.find((e) => e.key === selectedKey) ?? null;
  const selectedManifestId = selected?.manifest?.id ?? null;

  const reloadSelectedPreview = useCallback(async () => {
    if (selectedManifestId === null) {
      setPerformerPreview(null);
      return;
    }
    try {
      const res = await mediaLibrary.previewManifestPerformers({ manifestId: selectedManifestId });
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

  const serverFallback: DraftFields = useMemo(
    () => ({
      title: selected?.manifest?.title ?? '',
      mediaDate: selected?.manifest?.mediaDate ?? '',
      tagsText: selected?.manifest?.tags.map((tag) => tag.name).join(', ') ?? '',
    }),
    [selected],
  );
  const activeDraft = selected ? dirtyDrafts[selected.key] ?? serverFallback : serverFallback;

  const draftTagList = useMemo(
    () =>
      activeDraft.tagsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    [activeDraft.tagsText],
  );

  const previewTagByLower = useMemo(() => {
    const map = new Map<string, { matchedVia: 'name' | 'alias' | 'new'; matchedTagName: string | null }>();
    for (const entry of performerPreview?.normalTags ?? []) {
      map.set(entry.rawName.toLowerCase(), {
        matchedVia: entry.matchedVia,
        matchedTagName: entry.matchedTagName,
      });
    }
    return map;
  }, [performerPreview]);

  const removeDraftTag = useCallback(
    (indexToRemove: number) => {
      if (!selected) return;
      const nextList = draftTagList.filter((_, i) => i !== indexToRemove);
      updateDraft(selected.key, { tagsText: nextList.join(', ') }, serverFallback);
    },
    [draftTagList, selected, serverFallback, updateDraft],
  );

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
  const commitBlockedByPerformer = Boolean(performerPreview && !performerPreview.canCommit);

  const handleReconcile = async () => {
    setBusyOp('reconcile');
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
      setBusyOp(null);
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
        entry.manifest ? { manifestId: entry.manifest.id } : { tempPath: entry.tempPath },
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
      if (res.value.ok) {
        setMessage(`Fetched from ${res.value.provider}: ${res.value.title ?? ''}`);
      } else {
        setError(`[${res.value.category}] ${res.value.reason}`);
      }
      await reloadServerState();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyOp(null);
    }
  };

  const handleMoveAndIndex = async (entry: UnifiedStagingEntry) => {
    setBusyOp('commit');
    setMessage(null);
    setError(null);
    try {
      const tagNames = activeDraft.tagsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const reviewRes = await mediaLibrary.reviewIngestion({
        manifestId: entry.manifest?.id,
        tempPath: entry.manifest ? undefined : entry.tempPath,
        decision: 'approved',
        title: activeDraft.title,
        mediaDate: activeDraft.mediaDate,
        newTagNames: tagNames,
      });
      if (!reviewRes.ok) {
        setError(reviewRes.error.message || t('rpcError'));
        return;
      }
      if (!reviewRes.value.ok || !reviewRes.value.manifest) {
        setError(reviewRes.value.message ?? reviewRes.value.code ?? 'Review failed');
        await reloadServerState();
        return;
      }

      const approvedManifest = reviewRes.value.manifest;
      clearDraft(entry.key);
      clearDraft(`m:${approvedManifest.id}`);
      setSelectedKey(`m:${approvedManifest.id}`);

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
      setBusyOp(null);
    }
  };

  const busyBannerText =
    busyOp === 'scan'
      ? t('ingestionScanningBtn')
      : busyOp === 'reconcile'
        ? t('ingestionReconcilingBtn')
        : busyOp === 'fetch'
          ? t('ingestionFetchingBtn')
          : busyOp === 'approve'
            ? t('ingestionApprovingBtn')
            : busyOp === 'commit'
              ? t('ingestionCommittingBtn')
              : busyOp === 'reject'
                ? t('ingestionRejectBtn')
                : runningHostTask
                  ? runningHostTask.message || `${runningHostTask.op} running...`
                  : null;

  return (
    <section
      data-testid="ingestion-panel"
      style={{
        padding: '14px 16px',
        borderRadius: '8px',
        border: '1px solid rgba(128,128,128,0.28)',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        fontSize: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <strong style={{ fontSize: '14px' }}>{t('ingestionHeading')}</strong>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            data-testid="performer-drawer-btn"
            onClick={togglePerformerDrawer}
            style={{
              ...buttonStyle,
              borderColor:
                pendingQueue.length > 0 || remediationCount > 0 ? 'rgba(245,158,11,0.7)' : undefined,
            }}
          >
            {t('performerDrawerBtn')} ({pendingQueue.length}
            {remediationCount > 0 ? ` / ⚠${remediationCount}` : ''})
          </button>
          <button
            type="button"
            data-testid="ingestion-scan-btn"
            disabled={busy || degraded}
            onClick={() => void runScan(false)}
            style={buttonStyle}
          >
            {busyOp === 'scan' ? t('ingestionScanningBtn') : t('ingestionScanBtn')}
          </button>
          <button
            type="button"
            data-testid="ingestion-reconcile-btn"
            disabled={busy || degraded}
            onClick={() => void handleReconcile()}
            style={buttonStyle}
          >
            {busyOp === 'reconcile' ? t('ingestionReconcilingBtn') : t('ingestionReconcileBtn')}
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
          onChanged={handlePerformerChanged}
          onError={setError}
        />
      ) : null}

      {busyBannerText ? (
        <div role="status" data-testid="ingestion-busy" style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(59,130,246,0.5)', background: 'rgba(59,130,246,0.12)' }}>
          {busyBannerText}
        </div>
      ) : null}

      {message ? (
        <div role="status" data-testid="ingestion-message" style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.3)' }}>
          {message}
        </div>
      ) : null}
      {error ? (
        <div role="alert" data-testid="ingestion-error" style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(239,68,68,0.5)' }}>
          {error}
        </div>
      ) : null}

      {entries.length === 0 ? (
        <div data-testid="ingestion-empty" style={{ opacity: 0.75, padding: '12px', border: '1px dashed rgba(128,128,128,0.3)', borderRadius: '8px' }}>
          {t('ingestionEmpty')}
        </div>
      ) : (
        <ul data-testid="ingestion-manifest-list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '200px', overflowY: 'auto' }}>
          {entries.map((entry) => (
            <li key={entry.key}>
              <button
                type="button"
                data-testid={entry.manifest ? `ingestion-row-${entry.manifest.id}` : `ingestion-file-${entry.filename}`}
                onClick={() => setSelectedKey(entry.key)}
                style={{
                  ...controlStyle,
                  width: '100%',
                  textAlign: 'left',
                  cursor: 'pointer',
                  background: entry.key === selectedKey ? 'rgba(59,130,246,0.16)' : 'transparent',
                }}
              >
                <strong>{entry.filename}</strong> ·{' '}
                <code>{entry.manifest?.state ?? 'temp'}</code>
                {entry.manifest ? (
                  <span>
                    {' '}
                    / <code>{entry.manifest.reviewDecision}</code>
                  </span>
                ) : null}
                {entry.catalogNumber ? <span> · {entry.catalogNumber}</span> : null}
                <span> · {Math.round(entry.fileSize / (1024 * 1024))} MB</span>
                {entry.manifest?.indexedMediaId !== null && entry.manifest?.indexedMediaId !== undefined ? (
                  <span> · media #{entry.manifest.indexedMediaId}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <div data-testid="ingestion-detail" style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '8px', borderTop: '1px solid rgba(128,128,128,0.25)' }}>
          <div>
            <strong>{t('ingestionTargetLabel')}:</strong> <code>{selected.targetRelativePath}</code>
            {selected.manifest?.metadataSource ? (
              <span style={{ marginLeft: '10px', opacity: 0.78 }}>({selected.manifest.metadataSource})</span>
            ) : null}
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span>{t('ingestionTitleLabel')}</span>
            <input
              type="text"
              data-testid="ingestion-title-input"
              value={activeDraft.title}
              onChange={(e) => updateDraft(selected.key, { title: e.target.value }, serverFallback)}
              style={controlStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span>{t('ingestionDateLabel')}</span>
            <input
              type="text"
              data-testid="ingestion-date-input"
              placeholder="YYYY-MM-DD"
              value={activeDraft.mediaDate}
              onChange={(e) => updateDraft(selected.key, { mediaDate: e.target.value }, serverFallback)}
              style={controlStyle}
            />
          </label>
          {performerPreview ? (
            <PerformerInlineCard
              t={t}
              preview={performerPreview}
              mediaLibrary={mediaLibrary}
              disabled={busy || degraded || selected.manifest?.state === 'indexed'}
              onChanged={handlePerformerChanged}
              onError={setError}
            />
          ) : null}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span>{t('ingestionTagsLabel')}</span>
            {draftTagList.length > 0 ? (
              <div data-testid="ingestion-tag-preview" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {draftTagList.map((tagName, idx) => {
                  const info = previewTagByLower.get(tagName.toLowerCase());
                  const matchedVia = info?.matchedVia ?? 'new';
                  const badgeText =
                    matchedVia === 'name'
                      ? t('tagPreviewExisting')
                      : matchedVia === 'alias'
                        ? `${t('tagPreviewAlias')}→${info?.matchedTagName ?? ''}`
                        : `+ ${t('tagPreviewNew')}`;
                  return (
                    <span
                      key={`${tagName}-${idx}`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '2px 8px',
                        borderRadius: '999px',
                        border:
                          matchedVia === 'new'
                            ? '1px dashed rgba(245,158,11,0.65)'
                            : '1px solid rgba(34,197,94,0.55)',
                        background:
                          matchedVia === 'new' ? 'rgba(245,158,11,0.1)' : 'rgba(34,197,94,0.1)',
                      }}
                    >
                      <span>{tagName}</span>
                      <span style={{ opacity: 0.72, fontSize: '11px' }}>({badgeText})</span>
                      {selected.manifest?.state !== 'indexed' ? (
                        <button
                          type="button"
                          aria-label={`Remove ${tagName}`}
                          onClick={() => removeDraftTag(idx)}
                          style={{
                            border: 'none',
                            background: 'transparent',
                            color: 'inherit',
                            cursor: 'pointer',
                            padding: '0 2px',
                            fontWeight: 700,
                          }}
                        >
                          ×
                        </button>
                      ) : null}
                    </span>
                  );
                })}
              </div>
            ) : null}
            <input
              type="text"
              data-testid="ingestion-tags-input"
              value={activeDraft.tagsText}
              onChange={(e) => updateDraft(selected.key, { tagsText: e.target.value }, serverFallback)}
              style={controlStyle}
            />
          </div>
          {commitBlockedByPerformer ? (
            <div
              role="status"
              data-testid="performer-commit-gate"
              style={{
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(245,158,11,0.6)',
                background: 'rgba(245,158,11,0.12)',
              }}
            >
              ⚠ {t('performerCommitGateHint')}
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              type="button"
              data-testid="ingestion-play-btn"
              disabled={busy}
              onClick={() => void handlePlay(selected)}
              style={buttonStyle}
            >
              {busyOp === 'play' ? t('ingestionPlayingBtn') : t('ingestionPlayBtn')}
            </button>
            <button
              type="button"
              data-testid="ingestion-fetch-btn"
              disabled={busy || degraded || selected.manifest?.state === 'indexed'}
              onClick={() => void handleFetch(selected)}
              style={buttonStyle}
            >
              {busyOp === 'fetch' ? t('ingestionFetchingBtn') : t('ingestionFetchBtn')}
            </button>
            <button
              type="button"
              data-testid="ingestion-commit-btn"
              disabled={busy || degraded || commitBlockedByPerformer || selected.manifest?.state === 'indexed'}
              onClick={() => void handleMoveAndIndex(selected)}
              style={buttonStyle}
            >
              {busyOp === 'commit' ? t('ingestionCommittingBtn') : t('ingestionCommitBtn')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
