import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IngestionManifest, StagingFileItem } from '../types.ts';
import { buttonStyle, controlStyle } from './TagManagementPanel.tsx';
import type { MediaLibraryKey } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';

type Translate = (key: MediaLibraryKey) => string;

type BusyOp = null | 'scan' | 'reconcile' | 'fetch' | 'approve' | 'reject' | 'commit';

interface UnifiedStagingEntry {
  readonly key: string;
  readonly filename: string;
  readonly tempPath: string;
  readonly targetRelativePath: string;
  readonly catalogNumber: string | null;
  readonly fileSize: number;
  readonly manifest: IngestionManifest | null;
}

/**
 * Per-file staging review & recoverable ingestion panel (`B6`).
 * Scans `temp` asynchronously (zero hashing, zero DB writes), lazily persists a manifest
 * only when the user fetches metadata or reviews a file, and shows explicit busy progress.
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
  const [stagedFiles, setStagedFiles] = useState<readonly StagingFileItem[]>([]);
  const [manifests, setManifests] = useState<readonly IngestionManifest[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [busyOp, setBusyOp] = useState<BusyOp>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editTitle, setEditTitle] = useState('');
  const [editTagsText, setEditTagsText] = useState('');

  const busy = busyOp !== null;

  const reloadManifests = useCallback(async () => {
    try {
      const res = await mediaLibrary.listIngestionManifests();
      if (res.ok) {
        setManifests(res.value);
      } else {
        setError(res.error.message || t('rpcError'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [mediaLibrary, t]);

  useEffect(() => {
    void reloadManifests();
  }, [reloadManifests]);

  const entries = useMemo<UnifiedStagingEntry[]>(() => {
    const byManifestId = new Map<number, IngestionManifest>();
    for (const m of manifests) byManifestId.set(m.id, m);

    const seenManifestIds = new Set<number>();
    const list: UnifiedStagingEntry[] = [];

    for (const file of stagedFiles) {
      const matched =
        (file.manifestId !== null ? byManifestId.get(file.manifestId) : undefined) ??
        manifests.find((m) => m.tempPath.toLowerCase() === file.tempPath.toLowerCase()) ??
        null;
      if (matched) seenManifestIds.add(matched.id);
      list.push({
        key: matched ? `m:${matched.id}` : `f:${file.tempPath}`,
        filename: file.filename,
        tempPath: file.tempPath,
        targetRelativePath: matched?.targetRelativePath ?? file.targetRelativePath,
        catalogNumber: matched?.catalogNumber ?? file.catalogNumber,
        fileSize: file.fileSize,
        manifest: matched,
      });
    }

    for (const m of manifests) {
      if (seenManifestIds.has(m.id)) continue;
      list.push({
        key: `m:${m.id}`,
        filename: m.filename,
        tempPath: m.tempPath,
        targetRelativePath: m.targetRelativePath,
        catalogNumber: m.catalogNumber,
        fileSize: m.fileSize,
        manifest: m,
      });
    }
    return list;
  }, [stagedFiles, manifests]);

  const selected = entries.find((e) => e.key === selectedKey) ?? null;

  useEffect(() => {
    if (!selected) {
      setEditTitle('');
      setEditTagsText('');
      return;
    }
    setEditTitle(selected.manifest?.title ?? '');
    setEditTagsText(selected.manifest?.tags.map((tag) => tag.name).join(', ') ?? '');
  }, [selected]);

  const handleScan = async () => {
    setBusyOp('scan');
    setMessage(null);
    setError(null);
    try {
      const res = await mediaLibrary.scanStagingFiles();
      if (!res.ok) {
        setError(res.error.message || t('rpcError'));
        return;
      }
      setManifests(res.value.manifests);
      setStagedFiles(res.value.files);
      if (res.value.ok) {
        setMessage(`Scanned ${res.value.files.length} file(s) in ${res.value.elapsedMs} ms (${res.value.stagingDir})`);
      } else {
        setError(res.value.error ?? 'Scan failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyOp(null);
    }
  };

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
      if (res.value.manifest) {
        setSelectedKey(`m:${res.value.manifest.id}`);
      }
      if (res.value.ok) {
        setMessage(`Fetched from ${res.value.provider}: ${res.value.title ?? ''}`);
      } else {
        setError(`[${res.value.category}] ${res.value.reason}`);
      }
      await reloadManifests();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyOp(null);
    }
  };

  const handleReview = async (entry: UnifiedStagingEntry, decision: 'approved' | 'rejected') => {
    setBusyOp(decision === 'approved' ? 'approve' : 'reject');
    setMessage(null);
    setError(null);
    try {
      const tagNames = editTagsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await mediaLibrary.reviewIngestion({
        manifestId: entry.manifest?.id,
        tempPath: entry.manifest ? undefined : entry.tempPath,
        decision,
        title: editTitle,
        newTagNames: tagNames,
      });
      if (!res.ok) {
        setError(res.error.message || t('rpcError'));
        return;
      }
      if (res.value.manifest) {
        setSelectedKey(`m:${res.value.manifest.id}`);
      }
      if (res.value.ok) {
        setMessage(decision === 'approved' ? 'Review approved (ready to move & index).' : 'Kept in temp.');
      } else {
        setError(res.value.message ?? res.value.code ?? 'Review failed');
      }
      await reloadManifests();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyOp(null);
    }
  };

  const handleCommit = async (manifest: IngestionManifest) => {
    setBusyOp('commit');
    setMessage(null);
    setError(null);
    try {
      const res = await mediaLibrary.commitIngestion({ manifestId: manifest.id });
      if (!res.ok) {
        setError(res.error.message || t('rpcError'));
        return;
      }
      if (res.value.ok) {
        setMessage(res.value.message + (res.value.warning ? ` (${res.value.warning})` : ''));
        setStagedFiles((prev) => prev.filter((f) => f.tempPath.toLowerCase() !== manifest.tempPath.toLowerCase()));
        onCommitted();
      } else {
        setError(`[${res.value.code ?? 'ERROR'}] ${res.value.message}`);
      }
      await reloadManifests();
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
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            type="button"
            data-testid="ingestion-scan-btn"
            disabled={busy || degraded}
            onClick={() => void handleScan()}
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
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              style={controlStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <span>{t('ingestionTagsLabel')}</span>
            <input
              type="text"
              data-testid="ingestion-tags-input"
              value={editTagsText}
              onChange={(e) => setEditTagsText(e.target.value)}
              style={controlStyle}
            />
          </label>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
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
              data-testid="ingestion-approve-btn"
              disabled={busy || degraded || selected.manifest?.state === 'indexed'}
              onClick={() => void handleReview(selected, 'approved')}
              style={buttonStyle}
            >
              {busyOp === 'approve' ? t('ingestionApprovingBtn') : t('ingestionApproveBtn')}
            </button>
            <button
              type="button"
              data-testid="ingestion-reject-btn"
              disabled={busy || degraded || selected.manifest?.state === 'indexed'}
              onClick={() => void handleReview(selected, 'rejected')}
              style={buttonStyle}
            >
              {t('ingestionRejectBtn')}
            </button>
            <button
              type="button"
              data-testid="ingestion-commit-btn"
              disabled={busy || degraded || !selected.manifest}
              onClick={() => {
                if (selected.manifest) void handleCommit(selected.manifest);
              }}
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
