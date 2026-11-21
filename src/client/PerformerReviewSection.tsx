import { normalizePerformerName } from '../types.ts';
import { useEffect, useState } from 'react';
import type {
  ManifestPerformerPreview,
  PerformerAliasRecord,
  PerformerCandidateTag,
  PerformerReviewItem,
  TagSummary,
} from '../types.ts';
import type { MediaLibraryKey } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';
import { cx } from './ui/primitives.ts';
import css from './ui/styles.module.css';

type Translate = (key: MediaLibraryKey) => string;

function reasonLabel(t: Translate, reason: PerformerReviewItem['reason']): string {
  if (reason === 'ambiguous') return t('performerPendingReasonAmbiguous');
  if (reason === 'archived_target') return t('performerPendingReasonArchived');
  return t('performerPendingReasonUnknown');
}

interface PerformerPickerTarget {
  readonly key: string;
  readonly reviewId: number | null;
  readonly manifestId: number | null;
  readonly manifestFilename: string | null;
  readonly rawName: string;
  readonly headingText: string;
  readonly candidateTags: readonly PerformerCandidateTag[];
  readonly initialTagId: number;
  readonly defaultRememberRule: boolean;
  readonly defaultAlwaysAsk: boolean;
}

/**
 * Search + clickable suggestion pill picker (no native `<select>` dropdown).
 * Used both for pending performer review rows and for editing already-selected/skipped performers.
 */
function PerformerTagPickerEditor({
  t,
  target,
  mediaLibrary,
  disabled,
  onResolved,
  onError,
  onCancel,
}: {
  t: Translate;
  target: PerformerPickerTarget;
  mediaLibrary: MediaLibraryNamespace;
  disabled: boolean;
  onResolved: (msg: string) => void;
  onError: (msg: string) => void;
  onCancel?: (() => void) | undefined;
}) {
  const [searchText, setSearchText] = useState('');
  const [options, setOptions] = useState<readonly TagSummary[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<number>(target.initialTagId);
  const [rememberRule, setRememberRule] = useState<boolean>(target.defaultRememberRule);
  const [alwaysAsk, setAlwaysAsk] = useState<boolean>(target.defaultAlwaysAsk);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void mediaLibrary
        .listTags({ query: searchText.trim() || undefined, limit: 16 })
        .then((res) => {
          if (!active || !res.ok) return;
          setOptions(res.value.tags);
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [mediaLibrary, searchText]);

  const mergedOptions: Array<{ id: number; name: string; isCandidate: boolean }> = [];
  const seenIds = new Set<number>();
  for (const c of target.candidateTags) {
    seenIds.add(c.id);
    mergedOptions.push({ id: c.id, name: c.name, isCandidate: true });
  }
  for (const o of options) {
    if (seenIds.has(o.id)) continue;
    seenIds.add(o.id);
    mergedOptions.push({ id: o.id, name: o.name, isCandidate: false });
  }

  const runResolve = async (mode: 'bind_existing' | 'create_performer_tag' | 'skip') => {
    setWorking(true);
    try {
      const res = await mediaLibrary.resolvePerformerReview({
        reviewId: target.reviewId ?? undefined,
        manifestId: target.reviewId === null ? (target.manifestId ?? undefined) : undefined,
        rawName: target.reviewId === null ? target.rawName : undefined,
        mode,
        tagId: mode === 'bind_existing' ? selectedTagId : undefined,
        newTagName: mode === 'create_performer_tag' ? target.rawName : undefined,
        rememberRule: mode === 'skip' ? false : rememberRule,
        rulePolicy: alwaysAsk ? 'always_ask' : 'auto',
      });
      if (!res.ok) {
        onError(res.error.message || t('rpcError'));
        return;
      }
      if (!res.value.ok) {
        onError(res.value.message || res.value.code || 'Resolve failed');
        return;
      }
      onResolved(
        mode === 'skip'
          ? `Skipped performer "${target.rawName}".`
          : `Confirmed performer "${target.rawName}" -> ${res.value.item?.resolvedTagName ?? `#${selectedTagId}`}.`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div data-testid={`performer-picker-${target.key}`} className={css.performerPickerCard}>
      <div className={css.rowBetween}>
        <span>
          <strong>{target.headingText}</strong>
          {target.manifestFilename ? (
            <span className={css.muted}> · {target.manifestFilename}</span>
          ) : null}
        </span>
        {onCancel ? (
          <button
            type="button"
            disabled={working}
            onClick={onCancel}
            className={cx(css.btn, css.btnXs)}
          >
            {t('performerCancelEditBtn')}
          </button>
        ) : null}
      </div>

      <input
        type="text"
        data-testid={`performer-tag-search-${target.key}`}
        placeholder={t('performerSearchTagPlaceholder')}
        value={searchText}
        onChange={(e) => setSearchText(e.target.value)}
        disabled={disabled || working}
        className={css.control}
      />

      {mergedOptions.length === 0 ? (
        <span className={css.muted}>{t('performerNoMatchingTags')}</span>
      ) : (
        <div data-testid={`performer-tag-pills-${target.key}`} className={css.performerPillsScroll}>
          {mergedOptions.map((o) => {
            const isSelected = selectedTagId === o.id;
            return (
              <button
                key={o.id}
                type="button"
                data-testid={`performer-tag-pill-${o.id}`}
                disabled={disabled || working}
                onClick={() => setSelectedTagId(o.id)}
                className={cx(
                  css.pillChip,
                  isSelected ? css.pillChipActive : o.isCandidate && css.pillChipWarn,
                )}
              >
                {isSelected ? '✓ ' : ''}#{o.id} {o.name}
              </button>
            );
          })}
        </div>
      )}

      <div className={css.row}>
        <label className={css.checkboxLabel}>
          <input
            type="checkbox"
            checked={rememberRule}
            onChange={(e) => setRememberRule(e.target.checked)}
            disabled={disabled || working}
          />
          <span>{t('performerRememberRule')}</span>
        </label>
        {rememberRule ? (
          <label className={css.checkboxLabel}>
            <input
              type="checkbox"
              checked={alwaysAsk}
              onChange={(e) => setAlwaysAsk(e.target.checked)}
              disabled={disabled || working}
            />
            <span>{t('performerAlwaysAsk')}</span>
          </label>
        ) : null}
        <button
          type="button"
          data-testid={`performer-bind-btn-${target.key}`}
          disabled={disabled || working || selectedTagId <= 0}
          onClick={() => void runResolve('bind_existing')}
          className={cx(css.btn, css.btnPrimary)}
        >
          {t('performerBindBtn')}
        </button>
        <button
          type="button"
          data-testid={`performer-create-btn-${target.key}`}
          disabled={disabled || working}
          onClick={() => void runResolve('create_performer_tag')}
          className={css.btn}
        >
          {t('performerCreateBtn')}
        </button>
        <button
          type="button"
          data-testid={`performer-skip-btn-${target.key}`}
          disabled={disabled || working}
          onClick={() => void runResolve('skip')}
          className={css.btn}
        >
          {t('performerSkipBtn')}
        </button>
      </div>
    </div>
  );
}

function toPendingTarget(t: Translate, item: PerformerReviewItem): PerformerPickerTarget {
  return {
    key: `r-${item.id}`,
    reviewId: item.id,
    manifestId: item.manifestId,
    manifestFilename: item.manifestFilename,
    rawName: item.rawName,
    headingText: `⚠ ${item.rawName} (${reasonLabel(t, item.reason)})`,
    candidateTags: item.candidateTags,
    initialTagId: item.candidateTags[0]?.id ?? 0,
    defaultRememberRule: item.reason !== 'ambiguous',
    defaultAlwaysAsk: item.reason === 'ambiguous',
  };
}

export function PerformerInlineCard({
  t,
  preview,
  mediaLibrary,
  disabled,
  onChanged,
  onError,
}: {
  t: Translate;
  preview: ManifestPerformerPreview;
  mediaLibrary: MediaLibraryNamespace;
  disabled: boolean;
  onChanged: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [editingTarget, setEditingTarget] = useState<PerformerPickerTarget | null>(null);

  useEffect(() => {
    setEditingTarget(null);
  }, [preview.manifestId]);

  const hasAny =
    preview.autoMatched.length > 0 ||
    preview.humanResolved.length > 0 ||
    preview.pendingReview.length > 0 ||
    preview.skippedEntries.length > 0;

  if (!hasAny) return null;

  return (
    <div data-testid="ingestion-performer-section" className={css.performerCard}>
      <strong>{t('performerSectionHeading')}</strong>

      {(preview.autoMatched.length > 0 || preview.humanResolved.length > 0 || preview.skippedEntries.length > 0) ? (
        <div className={css.rowTight}>
          {preview.autoMatched.map((m) => (
            <span
              key={`auto-${m.normalizedName}-${m.tagId}`}
              data-testid={`performer-auto-chip-${m.tagId}`}
              className={cx(css.pillChip, css.pillChipStatic, css.pillChipSuccess)}
            >
              <span>
                ✓ {m.rawName} → #{m.tagId} {m.tagName} ({t('performerAutoMatched')})
              </span>
              {!disabled ? (
                <button
                  type="button"
                  data-testid={`performer-edit-auto-${m.tagId}`}
                  onClick={() =>
                    setEditingTarget({
                      key: `auto-${m.normalizedName}`,
                      reviewId: null,
                      manifestId: preview.manifestId,
                      manifestFilename: null,
                      rawName: m.rawName,
                      headingText: `${t('performerEditBtn')}: ${m.rawName}`,
                      candidateTags: [{ id: m.tagId, name: m.tagName, kind: 'performer' }],
                      initialTagId: m.tagId,
                      defaultRememberRule: false,
                      defaultAlwaysAsk: false,
                    })
                  }
                  className={css.inlineLinkBtn}
                >
                  {t('performerEditBtn')}
                </button>
              ) : null}
            </span>
          ))}
          {preview.humanResolved.map((m) => (
            <span
              key={`human-${m.normalizedName}-${m.tagId}`}
              data-testid={`performer-human-chip-${m.tagId}`}
              className={cx(css.pillChip, css.pillChipStatic, css.pillChipActive)}
            >
              <span>
                ✓ {m.rawName} → #{m.tagId} {m.tagName} ({t('performerHumanConfirmed')})
              </span>
              {!disabled ? (
                <button
                  type="button"
                  data-testid={`performer-edit-human-${m.tagId}`}
                  onClick={() =>
                    setEditingTarget({
                      key: `human-${m.reviewId ?? m.normalizedName}`,
                      reviewId: m.reviewId,
                      manifestId: preview.manifestId,
                      manifestFilename: null,
                      rawName: m.rawName,
                      headingText: `${t('performerEditBtn')}: ${m.rawName}`,
                      candidateTags: [{ id: m.tagId, name: m.tagName, kind: 'performer' }],
                      initialTagId: m.tagId,
                      defaultRememberRule: false,
                      defaultAlwaysAsk: false,
                    })
                  }
                  className={css.inlineLinkBtn}
                >
                  {t('performerEditBtn')}
                </button>
              ) : null}
            </span>
          ))}
          {preview.skippedEntries.map((s) => (
            <span
              key={`skip-${s.reviewId}`}
              data-testid={`performer-skipped-chip-${s.reviewId}`}
              className={cx(css.pillChip, css.pillChipStatic)}
            >
              <span>
                {t('performerSkipped')}: {s.rawName}
              </span>
              {!disabled ? (
                <button
                  type="button"
                  data-testid={`performer-edit-skipped-${s.reviewId}`}
                  onClick={() =>
                    setEditingTarget({
                      key: `skip-${s.reviewId}`,
                      reviewId: s.reviewId,
                      manifestId: preview.manifestId,
                      manifestFilename: null,
                      rawName: s.rawName,
                      headingText: `${t('performerEditBtn')}: ${s.rawName}`,
                      candidateTags: [],
                      initialTagId: 0,
                      defaultRememberRule: true,
                      defaultAlwaysAsk: false,
                    })
                  }
                  className={css.inlineLinkBtn}
                >
                  {t('performerEditBtn')}
                </button>
              ) : null}
            </span>
          ))}
        </div>
      ) : null}

      {editingTarget ? (
        <PerformerTagPickerEditor
          key={editingTarget.key}
          t={t}
          target={editingTarget}
          mediaLibrary={mediaLibrary}
          disabled={disabled}
          onResolved={(msg) => {
            setEditingTarget(null);
            onChanged(msg);
          }}
          onError={onError}
          onCancel={() => setEditingTarget(null)}
        />
      ) : null}

      {preview.pendingReview.map((item) => (
        <PerformerTagPickerEditor
          key={item.id}
          t={t}
          target={toPendingTarget(t, item)}
          mediaLibrary={mediaLibrary}
          disabled={disabled}
          onResolved={onChanged}
          onError={onError}
        />
      ))}
    </div>
  );
}

export function PerformerDrawer({
  t,
  mediaLibrary,
  aliases,
  pendingQueue,
  disabled,
  frozenManifestIds = [],
  frozenPerformerNames = [],
  onChanged,
  onError,
}: {
  t: Translate;
  mediaLibrary: MediaLibraryNamespace;
  aliases: readonly PerformerAliasRecord[];
  pendingQueue: readonly PerformerReviewItem[];
  disabled: boolean;
  frozenManifestIds?: readonly number[];
  frozenPerformerNames?: readonly string[];
  onChanged: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);
  const aliasFrozen = (name: string) => frozenPerformerNames.some(n =>
    normalizePerformerName(n) === normalizePerformerName(name));
  const handleTogglePolicy = async (alias: PerformerAliasRecord) => {
    const nextPolicy = alias.policy === 'always_ask' ? 'auto' : 'always_ask';
    const res = await mediaLibrary.upsertPerformerAlias({
      rawAlias: alias.rawAlias,
      tagId: alias.tagId,
      policy: nextPolicy,
      note: alias.note,
    });
    if (!res.ok) {
      onError(res.error.message || t('rpcError'));
      return;
    }
    if (!res.value.ok) {
      onError(res.value.message || res.value.code || 'Update failed');
      return;
    }
    onChanged(`Updated performer alias "${alias.rawAlias}" policy -> ${nextPolicy}.`);
  };

  const handleDeleteAlias = async (alias: PerformerAliasRecord) => {
    const res = await mediaLibrary.deletePerformerAlias({ aliasId: alias.id });
    if (!res.ok) {
      onError(res.error.message || t('rpcError'));
      return;
    }
    if (!res.value.ok) {
      onError(res.value.message || res.value.code || 'Delete failed');
      return;
    }
    onChanged(`Deleted performer alias "${alias.rawAlias}".`);
  };

  return (
    <div data-testid="performer-drawer" className={css.performerCard}>
      <div className={css.stackSm}>
        <strong>
          {t('performerQueueHeading')} ({pendingQueue.length})
        </strong>
        {pendingQueue.length === 0 ? (
          <span className={css.muted}>{t('performerNoPending')}</span>
        ) : (
          pendingQueue.map((item) => (
            <PerformerTagPickerEditor
              key={item.id}
              t={t}
              target={toPendingTarget(t, item)}
              mediaLibrary={mediaLibrary}
              disabled={disabled || (item.manifestId !== null && frozenManifestIds.includes(item.manifestId))}
              onResolved={onChanged}
              onError={onError}
            />
          ))
        )}
      </div>

      <div className={cx(css.stackSm, css.dividerTop)}>
        <strong>
          {t('performerRulesHeading')} ({aliases.length})
        </strong>
        {aliases.length === 0 ? (
          <span className={css.muted}>{t('performerNoRules')}</span>
        ) : (
          <ul className={css.scrollList}>
            {aliases.map((a) => (
              <li
                key={a.id}
                data-testid={`performer-alias-row-${a.id}`}
                className={cx(css.performerAliasRow, a.needsRemediation && css.performerAliasRowDanger)}
              >
                <span>
                  <code>{a.rawAlias}</code> → <strong>#{a.tagId} {a.tagName}</strong>{' '}
                  <code className={css.muted}>[{a.policy}]</code>
                  {a.isAmbiguous ? <span className={css.warnText}>⚠ ambiguous</span> : null}
                  {a.needsRemediation ? <span className={css.dangerText}>⚠ archived target</span> : null}
                </span>
                <span className={css.rowTight}>
                  <button
                    type="button"
                    disabled={disabled || aliasFrozen(a.rawAlias) || a.needsRemediation}
                    onClick={() => void handleTogglePolicy(a)}
                    className={cx(css.btn, css.btnXs)}
                  >
                    {t('performerTogglePolicyBtn')}
                  </button>
                  {confirmingDeleteId === a.id ? (
                    <>
                      <button
                        type="button"
                        data-testid={`performer-delete-confirm-${a.id}`}
                        disabled={disabled || aliasFrozen(a.rawAlias)}
                        onClick={() => {
                          setConfirmingDeleteId(null);
                          void handleDeleteAlias(a);
                        }}
                        className={cx(css.btn, css.btnXs, css.btnDanger)}
                      >
                        {t('performerDeleteConfirmBtn')}
                      </button>
                      <button
                        type="button"
                        data-testid={`performer-delete-cancel-${a.id}`}
                        disabled={disabled}
                        onClick={() => setConfirmingDeleteId(null)}
                        className={cx(css.btn, css.btnXs)}
                      >
                        {t('performerCancelEditBtn')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      data-testid={`performer-delete-btn-${a.id}`}
                      disabled={disabled || aliasFrozen(a.rawAlias)}
                      onClick={() => setConfirmingDeleteId(a.id)}
                      className={cx(css.btn, css.btnXs, css.btnDanger)}
                    >
                      {t('performerDeleteRuleBtn')}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
