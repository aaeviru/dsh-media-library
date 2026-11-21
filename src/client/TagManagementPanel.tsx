import { useCallback, useEffect, useState } from 'react';
import type {
  MergePreviewSuccess,
  MutationError,
  MutationErrorCode,
  TagSummary,
} from '../types.ts';
import type { MediaLibraryKey } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';
import { cx } from './ui/primitives.ts';
import css from './ui/styles.module.css';

type Translate = (key: MediaLibraryKey) => string;

const ERROR_KEYS: Partial<Record<MutationErrorCode, MediaLibraryKey>> = {
  REVISION_CONFLICT: 'errRevisionConflict',
  TAG_NAME_CONFLICT: 'errTagNameConflict',
  ALIAS_CONFLICT: 'errAliasConflict',
  BATCH_TOO_LARGE: 'errBatchTooLarge',
  TAG_IN_USE: 'errTagInUse',
  MERGE_WOULD_CREATE_CYCLE: 'errMergeCycle',
  TAG_ARCHIVED: 'errTagArchived',
  READ_ONLY_DEGRADED: 'errReadOnlyDegraded',
};

/** Shared by the tag panel and the batch bar. All values are rendered as React text (never HTML). */
export function describeMutationError(t: Translate, error: MutationError): string {
  const key = ERROR_KEYS[error.code];
  const label = key ? t(key) : t('errGeneric');
  return `[${error.code}] ${label} — ${error.message}`;
}

export function TagManagementPanel({
  t,
  mediaLibrary,
  onChanged,
}: {
  t: Translate;
  mediaLibrary: MediaLibraryNamespace;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [tags, setTags] = useState<readonly TagSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [createName, setCreateName] = useState('');
  const [renameValue, setRenameValue] = useState('');
  const [aliasValue, setAliasValue] = useState('');
  const [mergeSourceId, setMergeSourceId] = useState<number | null>(null);
  const [preview, setPreview] = useState<MergePreviewSuccess | null>(null);

  const selected = tags.find((tag) => tag.id === selectedId) ?? null;

  const reload = useCallback(async () => {
    try {
      const res = await mediaLibrary.listTags({
        query: query.trim() || undefined,
        limit: 200,
        includeArchived: showArchived,
      });
      if (res.ok) {
        setTags(res.value.tags);
      } else {
        setError(res.error.message || t('rpcError'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, [mediaLibrary, query, showArchived, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setRenameValue(selected?.name ?? '');
    setAliasValue('');
    setPreview(null);
    setMergeSourceId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  /** Run one Host write; surfaces structured errors and refreshes on conflict. */
  const run = useCallback(
    async (
      call: () => Promise<
        | { ok: true; value: { ok: true } | MutationError }
        | { ok: false; error: { message: string } }
      >,
      successMessage: string,
      after?: (value: Record<string, unknown>) => void,
    ) => {
      setBusy(true);
      setMessage(null);
      setError(null);
      try {
        const res = await call();
        if (!res.ok) {
          setError(res.error.message || t('rpcError'));
          return;
        }
        const value = res.value;
        if (value.ok) {
          setMessage(successMessage);
          after?.(value as unknown as Record<string, unknown>);
          onChanged();
        } else {
          setError(describeMutationError(t, value));
        }
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [onChanged, reload, t],
  );

  const handleCreate = () =>
    run(
      () => mediaLibrary.createTag({ name: createName }),
      t('tagMgmtSaved'),
      (value) => {
        setCreateName('');
        if (typeof value.tagId === 'number') setSelectedId(value.tagId);
      },
    );

  const handleRename = () => {
    if (!selected) return;
    return run(
      () => mediaLibrary.renameTag({ tagId: selected.id, name: renameValue, expectedRevision: selected.revision }),
      t('tagMgmtSaved'),
    );
  };

  const handleAddAlias = () => {
    if (!selected) return;
    return run(
      () => mediaLibrary.addAlias({ tagId: selected.id, alias: aliasValue, expectedRevision: selected.revision }),
      t('tagMgmtSaved'),
      () => setAliasValue(''),
    );
  };

  const handleRemoveAlias = (alias: string) => {
    if (!selected) return;
    return run(
      () => mediaLibrary.removeAlias({ tagId: selected.id, alias, expectedRevision: selected.revision }),
      t('tagMgmtSaved'),
    );
  };

  const handleArchive = () => {
    if (!selected) return;
    return run(
      () => mediaLibrary.archiveTag({ tagId: selected.id, expectedRevision: selected.revision }),
      t('tagMgmtSaved'),
    );
  };

  const handleRestore = () => {
    if (!selected) return;
    return run(
      () => mediaLibrary.restoreTag({ tagId: selected.id, expectedRevision: selected.revision }),
      t('tagMgmtSaved'),
    );
  };

  const handlePreview = async () => {
    if (!selected || mergeSourceId === null) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    setPreview(null);
    try {
      const res = await mediaLibrary.previewMerge({ targetTagId: selected.id, sourceTagId: mergeSourceId });
      if (!res.ok) setError(res.error.message || t('rpcError'));
      else if (res.value.ok) setPreview(res.value);
      else setError(describeMutationError(t, res.value));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleMergeConfirm = () => {
    if (!preview) return;
    return run(
      () =>
        mediaLibrary.mergeTags({
          targetTagId: preview.targetTagId,
          sourceTagId: preview.sourceTagId,
          expectedTargetRevision: preview.targetRevision,
          expectedSourceRevision: preview.sourceRevision,
        }),
      t('tagMgmtMergeDone'),
      () => {
        setPreview(null);
        setMergeSourceId(null);
      },
    );
  };

  const mergeCandidates = tags.filter((tag) => !tag.archived && tag.id !== selectedId);

  return (
    <section data-testid="tag-management-panel" className={css.panel}>
      <h3 className={css.sectionTitle}>{t('tagMgmtHeading')}</h3>

      <div className={css.row}>
        <input
          type="text"
          data-testid="tagmgmt-create-input"
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) void handleCreate();
          }}
          placeholder={t('tagMgmtCreatePlaceholder')}
          className={cx(css.control, css.controlFlex)}
        />
        <button
          type="button"
          data-testid="tagmgmt-create-btn"
          disabled={busy || !createName.trim()}
          onClick={() => void handleCreate()}
          className={cx(css.btn, css.btnPrimary)}
        >
          {t('tagMgmtCreateBtn')}
        </button>
      </div>

      {busy ? (
        <div data-testid="tagmgmt-busy" className={css.muted}>
          {t('tagMgmtBusy')}
        </div>
      ) : null}
      {message ? (
        <div role="status" data-testid="tagmgmt-message" className={cx(css.banner, css.bannerSuccess)}>
          {message}
        </div>
      ) : null}
      {error ? (
        <div role="alert" data-testid="tagmgmt-error" className={cx(css.banner, css.bannerDanger)}>
          {error}
        </div>
      ) : null}

      <div className={css.row}>
        <input
          type="text"
          data-testid="tagmgmt-filter-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('tagMgmtFilterPlaceholder')}
          className={cx(css.control, css.controlFlex)}
        />
        <label className={css.checkboxLabel}>
          <input
            type="checkbox"
            data-testid="tagmgmt-show-archived"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          {t('tagMgmtShowArchived')}
        </label>
      </div>

      {!loaded ? (
        <div data-testid="tagmgmt-loading" className={css.muted}>
          {t('tagMgmtLoading')}
        </div>
      ) : tags.length === 0 ? (
        <div data-testid="tagmgmt-empty" className={css.emptyBox}>
          {t('tagMgmtEmpty')}
        </div>
      ) : (
        <ul data-testid="tagmgmt-list" className={css.scrollList}>
          {tags.map((tag) => (
            <li key={tag.id}>
              <button
                type="button"
                data-testid={`tagmgmt-row-${tag.id}`}
                aria-pressed={tag.id === selectedId}
                onClick={() => setSelectedId(tag.id)}
                className={cx(
                  css.listRowBtn,
                  tag.id === selectedId && css.listRowBtnSelected,
                  tag.archived && css.listRowArchived,
                )}
              >
                <strong>{tag.name}</strong>
                {tag.aliases.length > 0 ? <span> ({tag.aliases.join(', ')})</span> : null}{' '}
                <span className={css.mutedSm}>
                  [{tag.mediaCount}] · r{tag.revision}
                </span>
                {tag.archived ? (
                  <span data-testid={`tagmgmt-archived-badge-${tag.id}`} className={css.mutedSm}>
                    {' '}{t('tagMgmtArchivedBadge')}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <div data-testid="tagmgmt-detail" className={cx(css.stackMd, css.dividerTop)}>
          <div>
            <strong>{t('tagMgmtSelectedHeading')}:</strong>{' '}
            <span data-testid="tagmgmt-selected-name">{selected.name}</span>{' '}
            <code data-testid="tagmgmt-selected-revision">r{selected.revision}</code>
          </div>

          <div className={css.row}>
            <input
              type="text"
              data-testid="tagmgmt-rename-input"
              value={renameValue}
              disabled={selected.archived}
              onChange={(e) => setRenameValue(e.target.value)}
              className={cx(css.control, css.controlFlex)}
            />
            <button
              type="button"
              data-testid="tagmgmt-rename-btn"
              disabled={busy || selected.archived || !renameValue.trim()}
              onClick={() => void handleRename()}
              className={css.btn}
            >
              {t('tagMgmtRenameBtn')}
            </button>
            {selected.archived ? (
              <button
                type="button"
                data-testid="tagmgmt-restore-btn"
                disabled={busy}
                onClick={() => void handleRestore()}
                className={css.btn}
              >
                {t('tagMgmtRestoreBtn')}
              </button>
            ) : (
              <button
                type="button"
                data-testid="tagmgmt-archive-btn"
                disabled={busy}
                onClick={() => void handleArchive()}
                className={css.btn}
              >
                {t('tagMgmtArchiveBtn')}
              </button>
            )}
          </div>

          <div className={css.rowTight}>
            {selected.aliases.length === 0 ? (
              <span className={css.muted}>{t('tagMgmtNoAliases')}</span>
            ) : (
              selected.aliases.map((alias, index) => (
                <span
                  key={`${alias}-${index}`}
                  data-testid={`tagmgmt-alias-${index}`}
                  className={cx(css.pillChip, css.pillChipStatic)}
                >
                  {alias}{' '}
                  <button
                    type="button"
                    aria-label={`${t('tagMgmtRemoveAliasBtn')}: ${alias}`}
                    data-testid={`tagmgmt-alias-remove-${index}`}
                    disabled={busy}
                    onClick={() => void handleRemoveAlias(alias)}
                    className={css.chipRemoveBtn}
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
          <div className={css.row}>
            <input
              type="text"
              data-testid="tagmgmt-alias-input"
              value={aliasValue}
              disabled={selected.archived}
              onChange={(e) => setAliasValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy && aliasValue.trim()) void handleAddAlias();
              }}
              placeholder={t('tagMgmtAliasPlaceholder')}
              className={cx(css.control, css.controlFlex)}
            />
            <button
              type="button"
              data-testid="tagmgmt-alias-add-btn"
              disabled={busy || selected.archived || !aliasValue.trim()}
              onClick={() => void handleAddAlias()}
              className={css.btn}
            >
              {t('tagMgmtAddAliasBtn')}
            </button>
          </div>

          {!selected.archived ? (
            <div className={css.stack}>
              <strong>{t('tagMgmtMergeHeading')}</strong>
              <div className={css.row}>
                {/* Legacy merge source <select> scheduled for TagPicker replacement in Stage 2 (Issue #42 B6) */}
                <select
                  data-testid="tagmgmt-merge-source-select"
                  aria-label={t('tagMgmtMergeSourceLabel')}
                  value={mergeSourceId ?? ''}
                  onChange={(e) => {
                    setMergeSourceId(e.target.value ? Number(e.target.value) : null);
                    setPreview(null);
                  }}
                  className={cx(css.control, css.controlFlex)}
                >
                  <option value="">{t('tagMgmtMergePickSource')}</option>
                  {mergeCandidates.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name} (#{tag.id})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid="tagmgmt-merge-preview-btn"
                  disabled={busy || mergeSourceId === null}
                  onClick={() => void handlePreview()}
                  className={css.btn}
                >
                  {t('tagMgmtMergePreviewBtn')}
                </button>
              </div>
              {preview ? (
                <div data-testid="tagmgmt-merge-preview" className={cx(css.panelCompact, css.stackSm)}>
                  <div>
                    {t('tagMgmtPreviewAffected')}: <code data-testid="preview-affected">{preview.affectedMedia}</code>
                  </div>
                  <div>
                    {t('tagMgmtPreviewDeduped')}: <code data-testid="preview-deduped">{preview.dedupedMedia}</code>
                  </div>
                  <div>
                    {t('tagMgmtPreviewAliasesMigrated')}:{' '}
                    <code data-testid="preview-aliases-migrated">{preview.aliasesMigrated}</code>
                  </div>
                  <div>
                    {t('tagMgmtPreviewAliasesConflicting')}:{' '}
                    <code data-testid="preview-aliases-conflicting">{preview.aliasesConflicting}</code>
                  </div>
                  <div>
                    {t('tagMgmtPreviewEdges')}: <code data-testid="preview-edges">{preview.parentEdgesMigrated}</code>
                  </div>
                  {preview.wouldCreateCycle ? (
                    <div role="alert" data-testid="preview-cycle-warning" className={cx(css.banner, css.bannerDanger)}>
                      {t('errMergeCycle')}
                    </div>
                  ) : null}
                  <div className={css.row}>
                    <button
                      type="button"
                      data-testid="tagmgmt-merge-confirm-btn"
                      disabled={busy || preview.wouldCreateCycle}
                      onClick={() => void handleMergeConfirm()}
                      className={cx(css.btn, css.btnPrimary)}
                    >
                      {t('tagMgmtMergeConfirmBtn')}
                    </button>
                    <button
                      type="button"
                      data-testid="tagmgmt-merge-cancel-btn"
                      onClick={() => setPreview(null)}
                      className={css.btn}
                    >
                      {t('tagMgmtMergeCancelBtn')}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : tags.length > 0 ? (
        <div className={css.muted}>{t('tagMgmtNoSelection')}</div>
      ) : null}
    </section>
  );
}
