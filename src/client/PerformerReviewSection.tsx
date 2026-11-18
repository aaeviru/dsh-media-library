import { useEffect, useState } from 'react';
import type {
  ManifestPerformerPreview,
  PerformerAliasRecord,
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

function PendingReviewRow({
  t,
  item,
  mediaLibrary,
  disabled,
  onResolved,
  onError,
}: {
  t: Translate;
  item: PerformerReviewItem;
  mediaLibrary: MediaLibraryNamespace;
  disabled: boolean;
  onResolved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [searchText, setSearchText] = useState('');
  const [options, setOptions] = useState<readonly TagSummary[]>([]);
  const [selectedTagId, setSelectedTagId] = useState<number>(item.candidateTags[0]?.id ?? 0);
  const [rememberRule, setRememberRule] = useState<boolean>(item.reason !== 'ambiguous');
  const [alwaysAsk, setAlwaysAsk] = useState<boolean>(item.reason === 'ambiguous');
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void mediaLibrary
        .listTags({ query: searchText.trim() || undefined, limit: 25 })
        .then((res) => {
          if (!active || !res.ok) return;
          setOptions(res.value.tags);
          if (selectedTagId === 0 && res.value.tags.length > 0 && item.candidateTags.length === 0) {
            setSelectedTagId(res.value.tags[0]!.id);
          }
        })
        .catch(() => undefined);
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [item.candidateTags.length, mediaLibrary, searchText, selectedTagId]);

  const mergedOptions: Array<{ id: number; name: string; kind: string }> = [];
  const seenIds = new Set<number>();
  for (const c of item.candidateTags) {
    seenIds.add(c.id);
    mergedOptions.push(c);
  }
  for (const o of options) {
    if (seenIds.has(o.id)) continue;
    seenIds.add(o.id);
    mergedOptions.push({ id: o.id, name: o.name, kind: '' });
  }

  const runResolve = async (mode: 'bind_existing' | 'create_performer_tag' | 'skip') => {
    setWorking(true);
    try {
      const res = await mediaLibrary.resolvePerformerReview({
        reviewId: item.id,
        mode,
        tagId: mode === 'bind_existing' ? selectedTagId : undefined,
        newTagName: mode === 'create_performer_tag' ? item.rawName : undefined,
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
          ? `Skipped performer "${item.rawName}".`
          : `Confirmed performer "${item.rawName}" -> ${res.value.item?.resolvedTagName ?? `#${selectedTagId}`}.`,
      );
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div
      data-testid={`performer-pending-row-${item.id}`}
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
          <strong>⚠ {item.rawName}</strong>{' '}
          <span style={{ opacity: 0.85 }}>({reasonLabel(t, item.reason)})</span>
          {item.manifestFilename ? (
            <span style={{ opacity: 0.72, marginLeft: '6px' }}>· {item.manifestFilename}</span>
          ) : null}
        </span>
      </div>

      {item.candidateTags.length > 0 ? (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          {item.candidateTags.map((c) => (
            <button
              key={c.id}
              type="button"
              disabled={disabled || working}
              onClick={() => setSelectedTagId(c.id)}
              style={{
                ...buttonStyle,
                padding: '2px 8px',
                borderColor: selectedTagId === c.id ? 'rgba(59,130,246,0.9)' : undefined,
                background: selectedTagId === c.id ? 'rgba(59,130,246,0.18)' : undefined,
              }}
            >
              #{c.id} {c.name}
            </button>
          ))}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          type="text"
          data-testid={`performer-tag-search-${item.id}`}
          placeholder={t('performerSearchTagPlaceholder')}
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          disabled={disabled || working}
          style={{ ...controlStyle, minWidth: '150px', flex: '1 1 150px' }}
        />
        <select
          data-testid={`performer-tag-select-${item.id}`}
          value={selectedTagId || ''}
          onChange={(e) => setSelectedTagId(Number(e.target.value) || 0)}
          disabled={disabled || working || mergedOptions.length === 0}
          style={{ ...controlStyle, minWidth: '160px', flex: '1 1 160px' }}
        >
          {mergedOptions.length === 0 ? <option value="">--</option> : null}
          {mergedOptions.map((o) => (
            <option key={o.id} value={o.id}>
              #{o.id} {o.name}{o.kind ? ` (${o.kind})` : ''}
            </option>
          ))}
        </select>
      </div>

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
          data-testid={`performer-bind-btn-${item.id}`}
          disabled={disabled || working || selectedTagId <= 0}
          onClick={() => void runResolve('bind_existing')}
          style={buttonStyle}
        >
          {t('performerBindBtn')}
        </button>
        <button
          type="button"
          data-testid={`performer-create-btn-${item.id}`}
          disabled={disabled || working}
          onClick={() => void runResolve('create_performer_tag')}
          style={buttonStyle}
        >
          {t('performerCreateBtn')}
        </button>
        <button
          type="button"
          data-testid={`performer-skip-btn-${item.id}`}
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
  const hasAny =
    preview.autoMatched.length > 0 ||
    preview.humanResolved.length > 0 ||
    preview.pendingReview.length > 0 ||
    preview.skipped.length > 0;

  if (!hasAny) return null;

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

      {(preview.autoMatched.length > 0 || preview.humanResolved.length > 0 || preview.skipped.length > 0) ? (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {preview.autoMatched.map((m) => (
            <span
              key={`auto-${m.normalizedName}-${m.tagId}`}
              data-testid={`performer-auto-chip-${m.tagId}`}
              style={{
                padding: '2px 8px',
                borderRadius: '999px',
                border: '1px solid rgba(34,197,94,0.6)',
                background: 'rgba(34,197,94,0.12)',
              }}
            >
              ✓ {m.rawName} → #{m.tagId} {m.tagName} ({t('performerAutoMatched')})
            </span>
          ))}
          {preview.humanResolved.map((m) => (
            <span
              key={`human-${m.normalizedName}-${m.tagId}`}
              data-testid={`performer-human-chip-${m.tagId}`}
              style={{
                padding: '2px 8px',
                borderRadius: '999px',
                border: '1px solid rgba(59,130,246,0.6)',
                background: 'rgba(59,130,246,0.12)',
              }}
            >
              ✓ {m.rawName} → #{m.tagId} {m.tagName} ({t('performerHumanConfirmed')})
            </span>
          ))}
          {preview.skipped.map((name) => (
            <span
              key={`skip-${name}`}
              style={{
                padding: '2px 8px',
                borderRadius: '999px',
                border: '1px solid rgba(128,128,128,0.4)',
                opacity: 0.72,
              }}
            >
              {t('performerSkipped')}: {name}
            </span>
          ))}
        </div>
      ) : null}

      {preview.pendingReview.map((item) => (
        <PendingReviewRow
          key={item.id}
          t={t}
          item={item}
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
            <PendingReviewRow
              key={item.id}
              t={t}
              item={item}
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
