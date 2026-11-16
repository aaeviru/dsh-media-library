import { useCallback, useEffect, useState } from 'react';
import type { MediaSearchItem, TagSummary } from '../types.ts';
import { buttonStyle, controlStyle, describeMutationError } from './TagManagementPanel.tsx';
import type { MediaLibraryKey } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';

type Translate = (key: MediaLibraryKey) => string;

export const MAX_BATCH_MEDIA = 200;

/**
 * Batch add/remove of one tag on the rows selected in the search results (`B3`/`B7`).
 * Sends only mediaIds, tagIds and the revisions the user saw; the Host validates everything.
 */
export function BatchTagBar({
  t,
  mediaLibrary,
  selectedItems,
  onClearSelection,
  onApplied,
}: {
  t: Translate;
  mediaLibrary: MediaLibraryNamespace;
  selectedItems: readonly MediaSearchItem[];
  onClearSelection: () => void;
  onApplied: () => void;
}) {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<readonly TagSummary[]>([]);
  const [tagId, setTagId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadCandidates = useCallback(async () => {
    try {
      const res = await mediaLibrary.listTags({ query: query.trim() || undefined, limit: 40 });
      if (res.ok) setCandidates(res.value.tags);
    } catch {
      // Non-fatal: the picker simply stays empty.
    }
  }, [mediaLibrary, query]);

  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);

  const count = selectedItems.length;
  const tooMany = count > MAX_BATCH_MEDIA;
  const disabled = busy || count === 0 || tooMany || tagId === null;

  const apply = async (mode: 'add' | 'remove') => {
    if (tagId === null) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await mediaLibrary.setMediaTags({
        mediaIds: selectedItems.map((item) => item.mediaId),
        addTagIds: mode === 'add' ? [tagId] : undefined,
        removeTagIds: mode === 'remove' ? [tagId] : undefined,
        expectedMediaRevisions: selectedItems.map((item) => ({ mediaId: item.mediaId, revision: item.revision })),
      });
      if (!res.ok) {
        setError(res.error.message || t('rpcError'));
      } else if (res.value.ok) {
        setMessage(
          `${t('batchDone')}: +${res.value.added} / −${res.value.removed} / =${res.value.unchanged}`,
        );
        onClearSelection();
        onApplied();
      } else {
        const failure = res.value;
        const detail = failure.failures
          .slice(0, 5)
          .map((f) => `#${f.mediaId ?? f.tagId ?? '?'}: ${f.code}`)
          .join('; ');
        setError(`${describeMutationError(t, failure)}${detail ? ` (${detail})` : ''}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="batch-tag-bar"
      style={{
        ...controlStyle,
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '10px 12px',
      }}
    >
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <strong data-testid="batch-selected-count">
          {count} {t('batchSelectedCount')}
        </strong>
        <input
          type="text"
          data-testid="batch-tag-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('batchTagPlaceholder')}
          style={{ ...controlStyle, flex: '1 1 180px' }}
        />
        <select
          data-testid="batch-tag-select"
          aria-label={t('batchPickTag')}
          value={tagId ?? ''}
          onChange={(e) => setTagId(e.target.value ? Number(e.target.value) : null)}
          style={{ ...controlStyle, flex: '1 1 180px' }}
        >
          <option value="">{t('batchPickTag')}</option>
          {candidates.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name} (#{tag.id})
            </option>
          ))}
        </select>
        <button type="button" data-testid="batch-add-btn" disabled={disabled} onClick={() => void apply('add')} style={buttonStyle}>
          {busy ? t('batchBusy') : t('batchAddBtn')}
        </button>
        <button type="button" data-testid="batch-remove-btn" disabled={disabled} onClick={() => void apply('remove')} style={buttonStyle}>
          {t('batchRemoveBtn')}
        </button>
        <button type="button" data-testid="batch-clear-btn" disabled={busy} onClick={onClearSelection} style={buttonStyle}>
          {t('batchClear')}
        </button>
      </div>
      {tooMany ? (
        <div role="alert" data-testid="batch-too-large" style={{ fontSize: '12px' }}>
          {t('errBatchTooLarge')} ({MAX_BATCH_MEDIA})
        </div>
      ) : null}
      {message ? (
        <div role="status" data-testid="batch-result-banner" style={{ fontSize: '12px' }}>
          {message}
        </div>
      ) : null}
      {error ? (
        <div role="alert" data-testid="batch-error-banner" style={{ fontSize: '12px', border: '1px solid rgba(239,68,68,0.5)', padding: '6px', borderRadius: '6px' }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
