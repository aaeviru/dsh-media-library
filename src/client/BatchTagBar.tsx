import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaSearchItem, TagSummary } from '../types.ts';
import { buttonStyle, controlStyle, describeMutationError } from './TagManagementPanel.tsx';
import type { MediaLibraryKey } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';

type Translate = (key: MediaLibraryKey) => string;

export const MAX_BATCH_MEDIA = 200;

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Batch add/remove of tags on the rows selected in search results (`B3`/`B7`).
 * Uses a unified combobox with explicit popover contrast, quick-add common tags,
 * one-click removal of assigned tags, and inline "Create & add" when no exact match exists.
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
  const [quickTags, setQuickTags] = useState<readonly TagSummary[]>([]);
  const [tagId, setTagId] = useState<number | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const comboboxRef = useRef<HTMLDivElement>(null);

  const loadCandidates = useCallback(async () => {
    try {
      const trimmed = query.trim();
      const res = await mediaLibrary.listTags({ query: trimmed || undefined, limit: 40 });
      if (res.ok) {
        const next = res.value.tags;
        setCandidates(next);
        // Never carry over a previous selection when the current filter no longer contains it.
        setTagId((prev) => (prev !== null && next.some((tag) => tag.id === prev) ? prev : null));
      }
    } catch {
      // Non-fatal: the picker simply stays empty.
    }
  }, [mediaLibrary, query]);

  const loadQuickTags = useCallback(async () => {
    try {
      const res = await mediaLibrary.listTags({ limit: 16 });
      if (res.ok) setQuickTags(res.value.tags);
    } catch {
      // Non-fatal.
    }
  }, [mediaLibrary]);

  useEffect(() => {
    void loadCandidates();
  }, [loadCandidates]);

  useEffect(() => {
    void loadQuickTags();
  }, [loadQuickTags]);

  useEffect(() => {
    if (!dropdownOpen) return;
    const handleOutsideClick = (ev: MouseEvent) => {
      if (comboboxRef.current && !comboboxRef.current.contains(ev.target as Node)) {
        setDropdownOpen(false);
      }
    };
    window.addEventListener('mousedown', handleOutsideClick);
    return () => window.removeEventListener('mousedown', handleOutsideClick);
  }, [dropdownOpen]);

  const count = selectedItems.length;
  const tooMany = count > MAX_BATCH_MEDIA;
  const canApply = !busy && count > 0 && !tooMany;

  const trimmedQuery = query.trim();
  const normalizedQuery = normalizeKey(trimmedQuery);
  const hasExactMatch = useMemo(() => {
    if (!normalizedQuery) return true;
    return candidates.some(
      (tag) =>
        tag.normalizedName === normalizedQuery ||
        tag.aliases.some((alias) => normalizeKey(alias) === normalizedQuery),
    );
  }, [candidates, normalizedQuery]);

  // Union of tags currently present on the selected rows for one-click removal.
  const assignedTags = useMemo(() => {
    const map = new Map<number, { id: number; name: string; itemCount: number }>();
    for (const item of selectedItems) {
      for (const tag of item.tags) {
        const existing = map.get(tag.id);
        if (existing) existing.itemCount += 1;
        else map.set(tag.id, { id: tag.id, name: tag.name, itemCount: 1 });
      }
    }
    return [...map.values()].sort((a, b) => b.itemCount - a.itemCount || a.name.localeCompare(b.name));
  }, [selectedItems]);

  const applyTagId = async (mode: 'add' | 'remove', targetTagId: number) => {
    if (busy || count === 0 || tooMany) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await mediaLibrary.setMediaTags({
        mediaIds: selectedItems.map((item) => item.mediaId),
        addTagIds: mode === 'add' ? [targetTagId] : undefined,
        removeTagIds: mode === 'remove' ? [targetTagId] : undefined,
        expectedMediaRevisions: selectedItems.map((item) => ({ mediaId: item.mediaId, revision: item.revision })),
      });
      if (!res.ok) {
        setError(res.error.message || t('rpcError'));
      } else if (res.value.ok) {
        setMessage(
          `${t('batchDone')}: +${res.value.added} / −${res.value.removed} / =${res.value.unchanged}`,
        );
        setDropdownOpen(false);
        onClearSelection();
        onApplied();
        void loadQuickTags();
        void loadCandidates();
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

  const handleCreateAndAdd = async () => {
    if (!trimmedQuery || busy) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const created = await mediaLibrary.createTag({ name: trimmedQuery });
      if (!created.ok) {
        setError(created.error.message || t('rpcError'));
        return;
      }
      if (!created.value.ok) {
        setError(describeMutationError(t, created.value));
        return;
      }
      const newTagId = created.value.tagId;
      setQuery('');
      setTagId(newTagId);
      setDropdownOpen(false);
      if (count > 0 && !tooMany) {
        const res = await mediaLibrary.setMediaTags({
          mediaIds: selectedItems.map((item) => item.mediaId),
          addTagIds: [newTagId],
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
          setError(describeMutationError(t, res.value));
        }
      } else {
        onApplied();
      }
      void loadQuickTags();
      void loadCandidates();
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

        <div ref={comboboxRef} style={{ position: 'relative', flex: '1 1 260px', minWidth: '220px' }}>
          <input
            type="text"
            role="combobox"
            aria-expanded={dropdownOpen}
            aria-autocomplete="list"
            data-testid="batch-tag-input"
            value={query}
            onFocus={() => setDropdownOpen(true)}
            onChange={(e) => {
              setQuery(e.target.value);
              setDropdownOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setDropdownOpen(false);
              } else if (e.key === 'Enter' && dropdownOpen) {
                e.preventDefault();
                if (trimmedQuery && !hasExactMatch) {
                  void handleCreateAndAdd();
                } else if (candidates.length > 0 && canApply) {
                  void applyTagId('add', candidates[0]!.id);
                }
              }
            }}
            placeholder={t('batchTagPlaceholder')}
            style={{ ...controlStyle, width: '100%', boxSizing: 'border-box' }}
          />
          {dropdownOpen ? (
            <div
              role="listbox"
              data-testid="batch-tag-dropdown"
              style={{
                position: 'absolute',
                top: 'calc(100% + 4px)',
                left: 0,
                right: 0,
                zIndex: 9998,
                maxHeight: '240px',
                overflowY: 'auto',
                borderRadius: '8px',
                border: '1px solid rgba(128,128,128,0.45)',
                background: '#1e1e22',
                color: '#f4f4f6',
                boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                padding: '4px',
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
              }}
            >
              {trimmedQuery && !hasExactMatch ? (
                <button
                  type="button"
                  role="option"
                  data-testid="batch-create-tag-option"
                  disabled={busy}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void handleCreateAndAdd()}
                  style={{
                    textAlign: 'left',
                    padding: '6px 8px',
                    borderRadius: '6px',
                    border: 'none',
                    background: 'rgba(59,130,246,0.22)',
                    color: '#93c5fd',
                    cursor: busy ? 'not-allowed' : 'pointer',
                    fontSize: '12px',
                    fontWeight: 600,
                  }}
                >
                  + {t('batchCreateAndAdd')} “{trimmedQuery}”
                </button>
              ) : null}

              {candidates.length === 0 && !trimmedQuery ? (
                <div style={{ padding: '6px 8px', fontSize: '12px', color: '#9ca3af' }}>
                  {t('batchNoMatch')}
                </div>
              ) : candidates.length === 0 && hasExactMatch ? (
                <div style={{ padding: '6px 8px', fontSize: '12px', color: '#9ca3af' }}>
                  {t('batchNoMatch')}
                </div>
              ) : (
                candidates.map((tag) => {
                  const isSelected = tag.id === tagId;
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-testid={`batch-tag-option-${tag.id}`}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setTagId(tag.id);
                        setQuery(tag.name);
                        if (canApply) {
                          void applyTagId('add', tag.id);
                        } else {
                          setDropdownOpen(false);
                        }
                      }}
                      style={{
                        textAlign: 'left',
                        padding: '6px 8px',
                        borderRadius: '6px',
                        border: 'none',
                        background: isSelected ? 'rgba(59,130,246,0.25)' : 'transparent',
                        color: '#f4f4f6',
                        cursor: 'pointer',
                        fontSize: '12px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: '8px',
                      }}
                    >
                      <span>
                        {tag.name}
                        {tag.aliases.length > 0 ? (
                          <span style={{ color: '#9ca3af', marginLeft: '6px' }}>
                            ({tag.aliases.join(', ')})
                          </span>
                        ) : null}
                      </span>
                      <span style={{ color: '#9ca3af', whiteSpace: 'nowrap' }}>[{tag.mediaCount}]</span>
                    </button>
                  );
                })
              )}
            </div>
          ) : null}
        </div>

        <button
          type="button"
          data-testid="batch-add-btn"
          disabled={!canApply || tagId === null}
          onClick={() => {
            if (tagId !== null) void applyTagId('add', tagId);
          }}
          style={buttonStyle}
        >
          {busy ? t('batchBusy') : t('batchAddBtn')}
        </button>
        <button
          type="button"
          data-testid="batch-remove-btn"
          disabled={!canApply || tagId === null}
          onClick={() => {
            if (tagId !== null) void applyTagId('remove', tagId);
          }}
          style={buttonStyle}
        >
          {t('batchRemoveBtn')}
        </button>
        <button
          type="button"
          data-testid="batch-clear-btn"
          disabled={busy || count === 0}
          onClick={onClearSelection}
          style={buttonStyle}
        >
          {t('batchClear')}
        </button>
      </div>

      {quickTags.length > 0 ? (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', opacity: 0.78 }}>{t('batchQuickTags')}</span>
          {quickTags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              data-testid={`batch-quick-tag-${tag.id}`}
              disabled={!canApply}
              onClick={() => void applyTagId('add', tag.id)}
              style={{
                padding: '2px 8px',
                borderRadius: '999px',
                border: '1px solid rgba(128,128,128,0.35)',
                background: 'transparent',
                color: 'inherit',
                cursor: canApply ? 'pointer' : 'not-allowed',
                opacity: canApply ? 1 : 0.55,
                fontSize: '11px',
              }}
            >
              + {tag.name} ({tag.mediaCount})
            </button>
          ))}
        </div>
      ) : null}

      {assignedTags.length > 0 ? (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', opacity: 0.78 }}>{t('batchAssignedTags')}</span>
          {assignedTags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              data-testid={`batch-assigned-tag-${tag.id}`}
              disabled={!canApply}
              onClick={() => void applyTagId('remove', tag.id)}
              style={{
                padding: '2px 8px',
                borderRadius: '999px',
                border: '1px solid rgba(239,68,68,0.45)',
                background: 'rgba(239,68,68,0.1)',
                color: 'inherit',
                cursor: canApply ? 'pointer' : 'not-allowed',
                fontSize: '11px',
              }}
            >
              {tag.name}
              {count > 1 ? ` (${tag.itemCount})` : ''} ×
            </button>
          ))}
        </div>
      ) : null}

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
