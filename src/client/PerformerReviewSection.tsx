import { useEffect, useState } from 'react';
import type {
  ManifestPerformerPreview,
  PerformerAliasRecord,
  PerformerCandidateTag,
  PerformerReviewItem,
  TagSummary,
} from '../types.ts';
import { buttonStyle, controlStyle } from './TagManagementPanel.tsx';
import type { MediaLibraryKey } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';

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
    <div
      data-testid={`performer-picker-${target.key}`}
      style={{
        padding: '8px 10px',
        borderRadius: '6px',
        border: '1px solid rgba(245,158,11,0.5)',
        background: 'rgba(245,158,11,0.08)',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
        <span>
          <strong>{target.headingText}</strong>
          {target.manifestFilename ? (
            <span style={{ opacity: 0.72, marginLeft: '6px' }}>· {target.manifestFilename}</span>
          ) : null}
        </span>
        {onCancel ? (
          <button
            type="button"
            disabled={working}
            onClick={onCancel}
            style={{ ...buttonStyle, padding: '2px 8px' }}
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
        style={controlStyle}
      />

      {mergedOptions.length === 0 ? (
        <span style={{ opacity: 0.72 }}>{t('performerNoMatchingTags')}</span>
      ) : (
        <div
          data-testid={`performer-tag-pills-${target.key}`}
          style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', maxHeight: '110px', overflowY: 'auto' }}
        >
          {mergedOptions.map((o) => {
            const isSelected = selectedTagId === o.id;
            return (
              <button
                key={o.id}
                type="button"
                data-testid={`performer-tag-pill-${o.id}`}
                disabled={disabled || working}
                onClick={() => setSelectedTagId(o.id)}
                style={{
                  ...buttonStyle,
                  padding: '2px 9px',
                  borderRadius: '999px',
                  borderColor: isSelected
                    ? 'rgba(59,130,246,0.95)'
                    : o.isCandidate
                      ? 'rgba(245,158,11,0.75)'
                      : undefined,
                  background: isSelected
                    ? 'rgba(59,130,246,0.22)'
                    : o.isCandidate
                      ? 'rgba(245,158,11,0.12)'
                      : undefined,
                  fontWeight: isSelected ? 600 : 400,
                }}
              >
                {isSelected ? '✓ ' : ''}#{o.id} {o.name}
              </button>
            );
          })}
        </div>
      )}

      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={rememberRule}
            onChange={(e) => setRememberRule(e.target.checked)}
            disabled={disabled || working}
          />
          <span>{t('performerRememberRule')}</span>
        </label>
        {rememberRule ? (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer' }}>
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
          style={buttonStyle}
        >
          {t('performerBindBtn')}
        </button>
        <button
          type="button"
          data-testid={`performer-create-btn-${target.key}`}
          disabled={disabled || working}
          onClick={() => void runResolve('create_performer_tag')}
          style={buttonStyle}
        >
          {t('performerCreateBtn')}
        </button>
        <button
          type="button"
          data-testid={`performer-skip-btn-${target.key}`}
          disabled={disabled || working}
          onClick={() => void runResolve('skip')}
          style={buttonStyle}
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

  const chipEditBtnStyle = {
    border: 'none',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    textDecoration: 'underline',
    padding: '0 2px',
    marginLeft: '4px',
    fontSize: '11px',
    opacity: 0.85,
  } as const;

  return (
    <div
      data-testid="ingestion-performer-section"
      style={{
        padding: '8px 10px',
        borderRadius: '6px',
        border: '1px solid rgba(128,128,128,0.28)',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
      }}
    >
      <strong>{t('performerSectionHeading')}</strong>

      {(preview.autoMatched.length > 0 || preview.humanResolved.length > 0 || preview.skippedEntries.length > 0) ? (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {preview.autoMatched.map((m) => (
            <span
              key={`auto-${m.normalizedName}-${m.tagId}`}
              data-testid={`performer-auto-chip-${m.tagId}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '2px 8px',
                borderRadius: '999px',
                border: '1px solid rgba(34,197,94,0.6)',
                background: 'rgba(34,197,94,0.12)',
              }}
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
                  style={chipEditBtnStyle}
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
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '2px 8px',
                borderRadius: '999px',
                border: '1px solid rgba(59,130,246,0.6)',
                background: 'rgba(59,130,246,0.12)',
              }}
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
                  style={chipEditBtnStyle}
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
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '2px 8px',
                borderRadius: '999px',
                border: '1px solid rgba(128,128,128,0.4)',
                opacity: 0.82,
              }}
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
                  style={chipEditBtnStyle}
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
  onChanged,
  onError,
}: {
  t: Translate;
  mediaLibrary: MediaLibraryNamespace;
  aliases: readonly PerformerAliasRecord[];
  pendingQueue: readonly PerformerReviewItem[];
  disabled: boolean;
  onChanged: (msg: string) => void;
  onError: (msg: string) => void;
}) {
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
    <div
      data-testid="performer-drawer"
      style={{
        padding: '10px 12px',
        borderRadius: '6px',
        border: '1px solid rgba(128,128,128,0.32)',
        background: 'rgba(128,128,128,0.05)',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <strong>
          {t('performerQueueHeading')} ({pendingQueue.length})
        </strong>
        {pendingQueue.length === 0 ? (
          <span style={{ opacity: 0.72 }}>{t('performerNoPending')}</span>
        ) : (
          pendingQueue.map((item) => (
            <PerformerTagPickerEditor
              key={item.id}
              t={t}
              target={toPendingTarget(t, item)}
              mediaLibrary={mediaLibrary}
              disabled={disabled}
              onResolved={onChanged}
              onError={onError}
            />
          ))
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid rgba(128,128,128,0.2)', paddingTop: '8px' }}>
        <strong>
          {t('performerRulesHeading')} ({aliases.length})
        </strong>
        {aliases.length === 0 ? (
          <span style={{ opacity: 0.72 }}>{t('performerNoRules')}</span>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '180px', overflowY: 'auto' }}>
            {aliases.map((a) => (
              <li
                key={a.id}
                data-testid={`performer-alias-row-${a.id}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '8px',
                  flexWrap: 'wrap',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  border: a.needsRemediation
                    ? '1px solid rgba(239,68,68,0.6)'
                    : '1px solid rgba(128,128,128,0.22)',
                }}
              >
                <span>
                  <code>{a.rawAlias}</code> → <strong>#{a.tagId} {a.tagName}</strong>{' '}
                  <code style={{ opacity: 0.8 }}>[{a.policy}]</code>
                  {a.isAmbiguous ? <span style={{ marginLeft: '6px', color: '#f59e0b' }}>⚠ ambiguous</span> : null}
                  {a.needsRemediation ? <span style={{ marginLeft: '6px', color: '#ef4444' }}>⚠ archived target</span> : null}
                </span>
                <span style={{ display: 'inline-flex', gap: '6px' }}>
                  <button
                    type="button"
                    disabled={disabled || a.needsRemediation}
                    onClick={() => void handleTogglePolicy(a)}
                    style={{ ...buttonStyle, padding: '2px 8px' }}
                  >
                    {t('performerTogglePolicyBtn')}
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void handleDeleteAlias(a)}
                    style={{ ...buttonStyle, padding: '2px 8px' }}
                  >
                    {t('performerDeleteRuleBtn')}
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
