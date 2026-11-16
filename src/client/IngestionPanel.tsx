import { useCallback, useEffect, useState } from 'react';
import type { IngestionManifest } from '../types.ts';
import { buttonStyle, controlStyle } from './TagManagementPanel.tsx';
import type { MediaLibraryKey } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';

type Translate = (key: MediaLibraryKey) => string;

/**
 * Per-file staging review & recoverable ingestion panel (`B6`).
 * Allows scanning `temp`, fetching candidate metadata from FC2CMADB/FC2PPVDB,
 * manually editing/selecting tags, approving review, and moving + indexing safely.
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
  const [manifests, setManifests] = useState<readonly IngestionManifest[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editTitle, setEditTitle] = useState('');
  const [editTagsText, setEditTagsText] = useState('');

  const selected = manifests.find((m) => m.id === selectedId) ?? null;

  const reload = useCallback(async () => {
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
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!selected) {
      setEditTitle('');
      setEditTagsText('');
      return;
    }
    setEditTitle(selected.title ?? '');
    setEditTagsText(selected.tags.map((tag) => tag.name).join(', '));
  }, [selected]);

  const handleScan = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await mediaLibrary.scanStagingFiles();
      if (!res.ok) {
        setError(res.error.message || t('rpcError'));
        return;
      }
      setManifests(res.value.manifests);
      if (res.value.ok) {
        setMessage(`Scanned ${res.value.files.length} file(s) from ${res.value.stagingDir}`);
      } else {
        setError(res.value.error ?? 'Scan failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleReconcile = async () => {
    setBusy(true);
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
      setBusy(false);
    }
  };

  const handleFetch = async (manifestId: number) => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await mediaLibrary.fetchIngestionMetadata({ manifestId });
      if (!res.ok) {
        setError(res.error.message || t('rpcError'));
        return;
      }
      if (res.value.ok) {
        setMessage(`Fetched from ${res.value.provider}: ${res.value.title ?? ''}`);
      } else {
        setError(`[${res.value.category}] ${res.value.reason}`);
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleReview = async (manifestId: number, decision: 'approved' | 'rejected') => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const tagNames = editTagsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await mediaLibrary.reviewIngestion({
        manifestId,
        decision,
        title: editTitle,
        newTagNames: tagNames,
      });
      if (!res.ok) {
        setError(res.error.message || t('rpcError'));
        return;
      }
      if (res.value.ok) {
        setMessage(decision === 'approved' ? 'Review approved (ready to move & index).' : 'Kept in temp.');
      } else {
        setError(res.value.message ?? res.value.code ?? 'Review failed');
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCommit = async (manifestId: number) => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await mediaLibrary.commitIngestion({ manifestId });
      if (!res.ok) {
        setError(res.error.message || t('rpcError'));
        return;
      }
      if (res.value.ok) {
        setMessage(res.value.message + (res.value.warning ? ` (${res.value.warning})` : ''));
        onCommitted();
      } else {
        setError(`[${res.value.code ?? 'ERROR'}] ${res.value.message}`);
      }
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

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
            {t('ingestionScanBtn')}
          </button>
          <button
            type="button"
            data-testid="ingestion-reconcile-btn"
            disabled={busy || degraded}
            onClick={() => void handleReconcile()}
            style={buttonStyle}
          >
            {t('ingestionReconcileBtn')}
          </button>
        </div>
      </div>

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

      {manifests.length === 0 ? (
        <div data-testid="ingestion-empty" style={{ opacity: 0.75, padding: '12px', border: '1px dashed rgba(128,128,128,0.3)', borderRadius: '8px' }}>
          {t('ingestionEmpty')}
        </div>
      ) : (
        <ul data-testid="ingestion-manifest-list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '180px', overflowY: 'auto' }}>
          {manifests.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                data-testid={`ingestion-row-${m.id}`}
                onClick={() => setSelectedId(m.id)}
                style={{
                  ...controlStyle,
                  width: '100%',
                  textAlign: 'left',
                  cursor: 'pointer',
                  background: m.id === selectedId ? 'rgba(59,130,246,0.16)' : 'transparent',
                }}
              >
                <strong>{m.filename}</strong> · <code>{m.state}</code> / <code>{m.reviewDecision}</code>
                {m.catalogNumber ? <span> · {m.catalogNumber}</span> : null}
                {m.indexedMediaId !== null ? <span> · media #{m.indexedMediaId}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <div data-testid="ingestion-detail" style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '8px', borderTop: '1px solid rgba(128,128,128,0.25)' }}>
          <div>
            <strong>{t('ingestionTargetLabel')}:</strong> <code>{selected.targetRelativePath}</code>
            {selected.metadataSource ? (
              <span style={{ marginLeft: '10px', opacity: 0.78 }}>({selected.metadataSource})</span>
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
              disabled={busy || degraded || selected.state === 'indexed'}
              onClick={() => void handleFetch(selected.id)}
              style={buttonStyle}
            >
              {t('ingestionFetchBtn')}
            </button>
            <button
              type="button"
              data-testid="ingestion-approve-btn"
              disabled={busy || degraded || selected.state === 'indexed'}
              onClick={() => void handleReview(selected.id, 'approved')}
              style={buttonStyle}
            >
              {t('ingestionApproveBtn')}
            </button>
            <button
              type="button"
              data-testid="ingestion-reject-btn"
              disabled={busy || degraded || selected.state === 'indexed'}
              onClick={() => void handleReview(selected.id, 'rejected')}
              style={buttonStyle}
            >
              {t('ingestionRejectBtn')}
            </button>
            <button
              type="button"
              data-testid="ingestion-commit-btn"
              disabled={busy || degraded}
              onClick={() => void handleCommit(selected.id)}
              style={buttonStyle}
            >
              {t('ingestionCommitBtn')}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
