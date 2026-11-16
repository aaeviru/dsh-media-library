import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import type {
  MergePreviewSuccess,
  MutationError,
  MutationErrorCode,
  TagSummary,
} from '../types.ts';
import type { MediaLibraryKey } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';

type Translate = (key: MediaLibraryKey) => string;

const ERROR_KEYS: Partial<Record<MutationErrorCode, MediaLibraryKey>> = {
  REVISION_CONFLICT: 'errRevisionConflict',
  TAG_NAME_CONFLICT: 'errTagNameConflict',
  ALIAS_CONFLICT: 'errAliasConflict',
  BATCH_TOO_LARGE: 'errBatchTooLarge',
  TAG_IN_USE: 'errTagInUse',
  MERGE_WOULD_CREATE_CYCLE: 'errMergeCycle',
  TAG_ARCHIVED: 'errTagArchived',
};

/** Shared by the tag panel and the batch bar. All values are rendered as React text (never HTML). */
export function describeMutationError(t: Translate, error: MutationError): string {
  const key = ERROR_KEYS[error.code];
  const label = key ? t(key) : t('errGeneric');
  return `[${error.code}] ${label} — ${error.message}`;
}

export const controlStyle: CSSProperties = {
  padding: '5px 10px',
  borderRadius: '6px',
  border: '1px solid rgba(128,128,128,0.35)',
  background: 'transparent',
  color: 'inherit',
  fontSize: '12px',
};

export const buttonStyle: CSSProperties = {
  ...controlStyle,
  cursor: 'pointer',
  fontWeight: 600,
};

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
    <section
      data-testid="tag-management-panel"
      style={{
        padding: '14px 16px',
        borderRadius: '8px',
        border: '1px solid rgba(128,128,128,0.28)',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>{t('tagMgmtHeading')}</h3>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text"
          data-testid="tagmgmt-create-input"
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !busy) void handleCreate();
          }}
          placeholder={t('tagMgmtCreatePlaceholder')}
          style={{ ...controlStyle, flex: '1 1 220px' }}
        />
        <button
          type="button"
          data-testid="tagmgmt-create-btn"
          disabled={busy || !createName.trim()}
          onClick={() => void handleCreate()}
          style={buttonStyle}
        >
          {t('tagMgmtCreateBtn')}
        </button>
      </div>

      {busy ? (
        <div data-testid="tagmgmt-busy" style={{ fontSize: '12px', opacity: 0.8 }}>
          {t('tagMgmtBusy')}
        </div>
      ) : null}
      {message ? (
        <div
          role="status"
          data-testid="tagmgmt-message"
          style={{ ...controlStyle, border: '1px solid rgba(34,197,94,0.45)' }}
        >
          {message}
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          data-testid="tagmgmt-error"
          style={{ ...controlStyle, border: '1px solid rgba(239,68,68,0.5)', background: 'rgba(239,68,68,0.1)' }}
        >
          {error}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text"
          data-testid="tagmgmt-filter-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('tagMgmtFilterPlaceholder')}
          style={{ ...controlStyle, flex: '1 1 220px' }}
        />
        <label style={{ fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' }}>
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
        <div data-testid="tagmgmt-loading" style={{ fontSize: '12px', opacity: 0.8 }}>
          {t('tagMgmtLoading')}
        </div>
      ) : tags.length === 0 ? (
        <div
          data-testid="tagmgmt-empty"
          style={{ padding: '14px', border: '1px dashed rgba(128,128,128,0.3)', borderRadius: '8px', fontSize: '12px' }}
        >
          {t('tagMgmtEmpty')}
        </div>
      ) : (
        <ul
          data-testid="tagmgmt-list"
          style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px' }}
        >
          {tags.map((tag) => (
            <li key={tag.id}>
              <button
                type="button"
                data-testid={`tagmgmt-row-${tag.id}`}
                aria-pressed={tag.id === selectedId}
                onClick={() => setSelectedId(tag.id)}
                style={{
                  ...controlStyle,
                  width: '100%',
                  textAlign: 'left',
                  cursor: 'pointer',
                  background: tag.id === selectedId ? 'rgba(59,130,246,0.16)' : 'transparent',
                  opacity: tag.archived ? 0.6 : 1,
                }}
              >
                <strong>{tag.name}</strong>
                {tag.aliases.length > 0 ? <span> ({tag.aliases.join(', ')})</span> : null}{' '}
                <span style={{ opacity: 0.65 }}>
                  [{tag.mediaCount}] · r{tag.revision}
                </span>
                {tag.archived ? (
                  <span data-testid={`tagmgmt-archived-badge-${tag.id}`} style={{ marginLeft: '6px' }}>
                    {t('tagMgmtArchivedBadge')}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected ? (
        <div
          data-testid="tagmgmt-detail"
          style={{ display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '8px', borderTop: '1px solid rgba(128,128,128,0.25)' }}
        >
          <div style={{ fontSize: '13px' }}>
            <strong>{t('tagMgmtSelectedHeading')}:</strong> <span data-testid="tagmgmt-selected-name">{selected.name}</span>{' '}
            <code data-testid="tagmgmt-selected-revision">r{selected.revision}</code>
          </div>

          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <input
              type="text"
              data-testid="tagmgmt-rename-input"
              value={renameValue}
              disabled={selected.archived}
              onChange={(e) => setRenameValue(e.target.value)}
              style={{ ...controlStyle, flex: '1 1 220px' }}
            />
            <button
              type="button"
              data-testid="tagmgmt-rename-btn"
              disabled={busy || selected.archived || !renameValue.trim()}
              onClick={() => void handleRename()}
              style={buttonStyle}
            >
              {t('tagMgmtRenameBtn')}
            </button>
            {selected.archived ? (
              <button
                type="button"
                data-testid="tagmgmt-restore-btn"
                disabled={busy}
                onClick={() => void handleRestore()}
                style={buttonStyle}
              >
                {t('tagMgmtRestoreBtn')}
              </button>
            ) : (
              <button
                type="button"
                data-testid="tagmgmt-archive-btn"
                disabled={busy}
                onClick={() => void handleArchive()}
                style={buttonStyle}
              >
                {t('tagMgmtArchiveBtn')}
              </button>
            )}
          </div>

          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
            {selected.aliases.length === 0 ? (
              <span style={{ fontSize: '12px', opacity: 0.7 }}>{t('tagMgmtNoAliases')}</span>
            ) : (
              selected.aliases.map((alias, index) => (
                <span
                  key={`${alias}-${index}`}
                  data-testid={`tagmgmt-alias-${index}`}
                  style={{ ...controlStyle, borderRadius: '999px', padding: '2px 8px' }}
                >
                  {alias}{' '}
                  <button
                    type="button"
                    aria-label={`${t('tagMgmtRemoveAliasBtn')}: ${alias}`}
                    data-testid={`tagmgmt-alias-remove-${index}`}
                    disabled={busy}
                    onClick={() => void handleRemoveAlias(alias)}
                    style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer' }}
                  >
                    ×
                  </button>
                </span>
              ))
            )}
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
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
              style={{ ...controlStyle, flex: '1 1 220px' }}
            />
            <button
              type="button"
              data-testid="tagmgmt-alias-add-btn"
              disabled={busy || selected.archived || !aliasValue.trim()}
              onClick={() => void handleAddAlias()}
              style={buttonStyle}
            >
              {t('tagMgmtAddAliasBtn')}
            </button>
          </div>

          {!selected.archived ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <strong style={{ fontSize: '12px' }}>{t('tagMgmtMergeHeading')}</strong>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <select
                  data-testid="tagmgmt-merge-source-select"
                  aria-label={t('tagMgmtMergeSourceLabel')}
                  value={mergeSourceId ?? ''}
                  onChange={(e) => {
                    setMergeSourceId(e.target.value ? Number(e.target.value) : null);
                    setPreview(null);
                  }}
                  style={{ ...controlStyle, flex: '1 1 220px', colorScheme: 'light dark' }}
                >
                  <option value="" style={{ color: '#111827', backgroundColor: '#ffffff' }}>
                    {t('tagMgmtMergePickSource')}
                  </option>
                  {mergeCandidates.map((tag) => (
                    <option key={tag.id} value={tag.id} style={{ color: '#111827', backgroundColor: '#ffffff' }}>
                      {tag.name} (#{tag.id})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid="tagmgmt-merge-preview-btn"
                  disabled={busy || mergeSourceId === null}
                  onClick={() => void handlePreview()}
                  style={buttonStyle}
                >
                  {t('tagMgmtMergePreviewBtn')}
                </button>
              </div>
              {preview ? (
                <div
                  data-testid="tagmgmt-merge-preview"
                  style={{ ...controlStyle, display: 'flex', flexDirection: 'column', gap: '4px' }}
                >
                  <div>
                    {t('tagMgmtPreviewAffected')}: <code data-testid="preview-affected">{preview.affectedMedia}</code>
                  </div>
                  <div>
                    {t('tagMgmtPreviewDeduped')}: <code data-testid="preview-deduped">{preview.dedupedMedia}</code>
                  </div>
                  <div>
                    {t('tagMgmtPreviewAliasesMigrated')}: <code data-testid="preview-aliases-migrated">{preview.aliasesMigrated}</code>
                  </div>
                  <div>
                    {t('tagMgmtPreviewAliasesConflicting')}:{' '}
                    <code data-testid="preview-aliases-conflicting">{preview.aliasesConflicting}</code>
                  </div>
                  <div>
                    {t('tagMgmtPreviewEdges')}: <code data-testid="preview-edges">{preview.parentEdgesMigrated}</code>
                  </div>
                  {preview.wouldCreateCycle ? (
                    <div role="alert" data-testid="preview-cycle-warning">
                      {t('errMergeCycle')}
                    </div>
                  ) : null}
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      type="button"
                      data-testid="tagmgmt-merge-confirm-btn"
                      disabled={busy || preview.wouldCreateCycle}
                      onClick={() => void handleMergeConfirm()}
                      style={buttonStyle}
                    >
                      {t('tagMgmtMergeConfirmBtn')}
                    </button>
                    <button
                      type="button"
                      data-testid="tagmgmt-merge-cancel-btn"
                      onClick={() => setPreview(null)}
                      style={buttonStyle}
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
        <div style={{ fontSize: '12px', opacity: 0.7 }}>{t('tagMgmtNoSelection')}</div>
      ) : null}
    </section>
  );
}
