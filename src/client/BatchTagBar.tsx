import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MediaSearchItem, TagSummary } from '../types.ts';
import { describeMutationError } from './TagManagementPanel.tsx';
import type { MediaLibraryKey } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';
import { TagPicker } from './ui/TagPicker.tsx';
import { cx } from './ui/primitives.ts';
import css from './ui/styles.module.css';

type Translate = (key: MediaLibraryKey) => string;

export const MAX_BATCH_MEDIA = 200;

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Batch add/remove of tags on the rows selected in search results (`B3`/`B7`).
 * Keeps row selection after applying or removing tags (Issue #47 B1) and awaits
 * `onApplied()` before releasing `busy` so consecutive batch actions always carry
 * fresh optimistic-concurrency `revision` values.
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
  onApplied: () => Promise<void> | void;
}) {
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<readonly TagSummary[]>([]);
  const [quickTags, setQuickTags] = useState<readonly TagSummary[]>([]);
  const [tagId, setTagId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        // Issue #47 B1: preserve selected rows and await fresh revisions before unlocking busy.
        await Promise.all([Promise.resolve(onApplied()), loadQuickTags(), loadCandidates()]);
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
          await Promise.all([Promise.resolve(onApplied()), loadQuickTags(), loadCandidates()]);
        } else {
          setError(describeMutationError(t, res.value));
        }
      } else {
        await Promise.all([Promise.resolve(onApplied()), loadQuickTags(), loadCandidates()]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (count === 0) {
    return (
      <div data-testid="batch-tag-bar" className={css.stackSm}>
        <div data-testid="batch-tag-bar-compact" className={css.batchBarCompact}>
          <span className={css.muted}>{t('batchCompactHint')}</span>
          <strong data-testid="batch-selected-count" className={css.mutedSm}>
            0 {t('batchSelectedCount')}
          </strong>
        </div>
        {message ? (
          <div role="status" data-testid="batch-result-banner" className={cx(css.banner, css.bannerSuccess)}>
            {message}
          </div>
        ) : null}
        {error ? (
          <div role="alert" data-testid="batch-error-banner" className={cx(css.banner, css.bannerDanger)}>
            {error}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div data-testid="batch-tag-bar" className={cx(css.panelCompact, css.batchBarActive)}>
      <div className={css.row}>
        <strong data-testid="batch-selected-count">
          {count} {t('batchSelectedCount')}
        </strong>

        <TagPicker
          query={query}
          onQueryChange={setQuery}
          candidates={candidates}
          selectedTagId={tagId}
          onSelectTag={(tag) => {
            setTagId(tag.id);
            setQuery(tag.name);
            if (canApply) {
              void applyTagId('add', tag.id);
            }
          }}
          showCreateOption={Boolean(trimmedQuery && !hasExactMatch)}
          createOptionText={`+ ${t('batchCreateAndAdd')} “${trimmedQuery}”`}
          onCreateTag={() => void handleCreateAndAdd()}
          placeholder={t('batchTagPlaceholder')}
          noMatchText={t('batchNoMatch')}
          disabled={busy}
          inputTestId="batch-tag-input"
          dropdownTestId="batch-tag-dropdown"
          optionTestIdPrefix="batch-tag-option-"
          createOptionTestId="batch-create-tag-option"
        />

        <button
          type="button"
          data-testid="batch-add-btn"
          disabled={!canApply || tagId === null}
          onClick={() => {
            if (tagId !== null) void applyTagId('add', tagId);
          }}
          className={cx(css.btn, css.btnPrimary)}
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
          className={css.btn}
        >
          {t('batchRemoveBtn')}
        </button>
        <button
          type="button"
          data-testid="batch-clear-btn"
          disabled={busy || count === 0}
          onClick={onClearSelection}
          className={css.btn}
        >
          {t('batchClear')}
        </button>
      </div>

      {quickTags.length > 0 ? (
        <div className={css.rowTight}>
          <span className={css.mutedSm}>{t('batchQuickTags')}</span>
          {quickTags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              data-testid={`batch-quick-tag-${tag.id}`}
              disabled={!canApply}
              onClick={() => void applyTagId('add', tag.id)}
              className={css.pillChip}
            >
              + {tag.name} ({tag.mediaCount})
            </button>
          ))}
        </div>
      ) : null}

      {assignedTags.length > 0 ? (
        <div className={css.rowTight}>
          <span className={css.mutedSm}>{t('batchAssignedTags')}</span>
          {assignedTags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              data-testid={`batch-assigned-tag-${tag.id}`}
              disabled={!canApply}
              onClick={() => void applyTagId('remove', tag.id)}
              className={cx(css.pillChip, css.pillChipDanger)}
            >
              {tag.name}
              {count > 1 ? ` (${tag.itemCount})` : ''} ×
            </button>
          ))}
        </div>
      ) : null}

      {tooMany ? (
        <div role="alert" data-testid="batch-too-large" className={cx(css.banner, css.bannerDanger)}>
          {t('errBatchTooLarge')} ({MAX_BATCH_MEDIA})
        </div>
      ) : null}
      {message ? (
        <div role="status" data-testid="batch-result-banner" className={cx(css.banner, css.bannerSuccess)}>
          {message}
        </div>
      ) : null}
      {error ? (
        <div role="alert" data-testid="batch-error-banner" className={cx(css.banner, css.bannerDanger)}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
