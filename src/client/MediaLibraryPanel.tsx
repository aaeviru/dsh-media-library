import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type {
  AmbiguousAliasWarning,
  CatalogMatchMode,
  CreateBackupResult,
  ImportTagStudioResult,
  LibraryOverview,
  MappingReportFormat,
  MediaActionErrorCode,
  MediaActionResult,
  MediaFileStatus,
  MediaSearchItem,
  OpsStatus,
  SearchMediaInput,
  SpikeStatus,
  TagSummary,
} from '../types.ts';
import type { MediaLibraryKey } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';
import { BatchTagBar } from './BatchTagBar.tsx';
import { IngestionPanel } from './IngestionPanel.tsx';
import { TagManagementPanel } from './TagManagementPanel.tsx';

type Translate = (key: MediaLibraryKey) => string;

let persistedShowIngestionPanel = false;

interface ContextMenuState {
  readonly mediaId: string;
  readonly filename: string;
  readonly x: number;
  readonly y: number;
}

function mapErrorCodeToMediaStatus(code: MediaActionErrorCode): MediaFileStatus | null {
  switch (code) {
    case 'FILE_NOT_FOUND':
      return 'missing';
    case 'NAS_OFFLINE_OR_TIMEOUT':
      return 'offline';
    case 'UNMAPPED_ROOT':
    case 'DISABLED_ROOT':
    case 'INVALID_UNC_ROOT':
      return 'unmapped';
    case 'PERMISSION_DENIED':
      return 'permission_denied';
    default:
      return null;
  }
}

export function MediaLibraryPanel({
  t,
  mediaLibrary,
}: {
  t: Translate;
  mediaLibrary: MediaLibraryNamespace;
}) {
  const [status, setStatus] = useState<SpikeStatus | null>(null);
  const [overview, setOverview] = useState<LibraryOverview | null>(null);
  const [opsStatus, setOpsStatus] = useState<OpsStatus | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [showTagMgmt, setShowTagMgmt] = useState(false);
  const [showOpsPanel, setShowOpsPanel] = useState(false);
  const [showIngestionPanel, setShowIngestionPanel] = useState(() => persistedShowIngestionPanel);
  const [backingUp, setBackingUp] = useState(false);
  const [backupResult, setBackupResult] = useState<CreateBackupResult | null>(null);
  const [exportingFormat, setExportingFormat] = useState<MappingReportFormat | null>(null);
  const [exportInfo, setExportInfo] = useState<string | null>(null);
  const [selectedMediaIds, setSelectedMediaIds] = useState<ReadonlySet<string>>(new Set());

  // Search filter state
  const [keyword, setKeyword] = useState('');
  const [catalogNumber, setCatalogNumber] = useState('');
  const [catalogMatchMode, setCatalogMatchMode] = useState<CatalogMatchMode>('exact');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [tagSearchInput, setTagSearchInput] = useState('');
  const [availableTags, setAvailableTags] = useState<readonly TagSummary[]>([]);
  const [tagAmbiguousAliases, setTagAmbiguousAliases] = useState<readonly AmbiguousAliasWarning[]>([]);
  const [selectedTags, setSelectedTags] = useState<readonly { id: number; name: string }[]>([]);

  // Search results & pagination state
  const [items, setItems] = useState<readonly MediaSearchItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalMatching, setTotalMatching] = useState(0);
  const [searchElapsedMs, setSearchElapsedMs] = useState(0);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const committedQuery = useRef<SearchMediaInput | null>(null);
  const searchRequest = useRef(0);
  const appending = useRef(false);

  // Import form state
  const [importSourcePath, setImportSourcePath] = useState('');
  const [importUncRoot, setImportUncRoot] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportTagStudioResult | null>(null);

  // Action & Context Menu state
  const [pendingMediaId, setPendingMediaId] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<MediaActionResult | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const loadTags = useCallback(
    async (queryText: string) => {
      try {
        const res = await mediaLibrary.listTags({
          query: queryText.trim() || undefined,
          limit: 40,
        });
        if (res.ok) {
          setAvailableTags(res.value.tags);
          setTagAmbiguousAliases(res.value.ambiguousAliases);
        }
      } catch {
        // Non-fatal tag autocomplete error
      }
    },
    [mediaLibrary],
  );

  const executeSearch = useCallback(
    async (options?: {
      readonly cursor?: string | undefined;
      readonly append?: boolean | undefined;
      readonly overrideTagIds?: readonly number[] | undefined;
      readonly overrideKeyword?: string | undefined;
      readonly overrideCatalog?: string | undefined;
      readonly overrideCatalogMode?: CatalogMatchMode | undefined;
      readonly overrideDateFrom?: string | undefined;
      readonly overrideDateTo?: string | undefined;
    }) => {
      const isAppend = Boolean(options?.append && options?.cursor);
      if (isAppend && (!committedQuery.current || appending.current)) return;
      const requestId = ++searchRequest.current;
      appending.current = isAppend;
      if (isAppend) {
        setLoadingMore(true);
      } else {
        setSearching(true);
        setLoadingMore(false);
        setNextCursor(null);
      }
      setLoadError(null);

      const effectiveTagIds = options?.overrideTagIds ?? selectedTags.map((tag) => tag.id);
      const effectiveKeyword = (options?.overrideKeyword ?? keyword).trim();
      const effectiveCatalog = (options?.overrideCatalog ?? catalogNumber).trim();
      const effectiveCatalogMode = options?.overrideCatalogMode ?? catalogMatchMode;
      const effectiveDateFrom = (options?.overrideDateFrom ?? dateFrom).trim();
      const effectiveDateTo = (options?.overrideDateTo ?? dateTo).trim();

      // The form is a draft. A cursor only belongs to the query that produced
      // the currently displayed results, never to subsequent draft edits.
      const query: SearchMediaInput = isAppend ? committedQuery.current! : {
        text: effectiveKeyword || undefined,
        catalogNumber: effectiveCatalog || undefined,
        catalogMatchMode: effectiveCatalogMode,
        tagIds: effectiveTagIds.length > 0 ? effectiveTagIds : undefined,
        dateFrom: effectiveDateFrom || undefined,
        dateTo: effectiveDateTo || undefined,
        limit: 50,
      };
      try {
        const res = await mediaLibrary.searchMedia({ ...query, cursor: isAppend ? options?.cursor : undefined });
        if (requestId !== searchRequest.current) return;

        if (res.ok) {
          committedQuery.current = query;
          const val = res.value;
          setItems((prev) => (isAppend ? [...prev, ...val.items] : val.items));
          setNextCursor(val.nextCursor);
          setTotalMatching(val.totalMatching);
          setSearchElapsedMs(val.elapsedMs);
        } else {
          setLoadError(res.error.message || t('rpcError'));
        }
      } catch (err) {
        if (requestId === searchRequest.current) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (requestId === searchRequest.current) {
          appending.current = false;
          setSearching(false);
          setLoadingMore(false);
        }
      }
    },
    [
      mediaLibrary,
      selectedTags,
      keyword,
      catalogNumber,
      catalogMatchMode,
      dateFrom,
      dateTo,
      t,
    ],
  );

  const refreshAll = useCallback(async () => {
    setSearching(true);
    setLoadError(null);
    try {
      const [statusRes, overviewRes, opsRes] = await Promise.all([
        mediaLibrary.spikeStatus(),
        mediaLibrary.getLibraryOverview(),
        mediaLibrary.getOpsStatus(),
      ]);

      if (statusRes.ok) {
        setStatus(statusRes.value);
      } else {
        setLoadError(statusRes.error.message || t('rpcError'));
      }
      if (opsRes.ok) {
        setOpsStatus(opsRes.value);
      }

      if (overviewRes.ok) {
        setOverview(overviewRes.value);
        setImportSourcePath((prev) => prev || overviewRes.value.defaultTagStudioSourcePath);
        setImportUncRoot((prev) => prev || overviewRes.value.activeUncRoot);
        if (overviewRes.value.counts.mediaFiles === 0) {
          setShowDiagnostics(true);
        }
      }

      await Promise.all([loadTags(tagSearchInput), executeSearch()]);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [mediaLibrary, t, loadTags, tagSearchInput, executeSearch]);

  useEffect(() => {
    void refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadTags(tagSearchInput);
  }, [tagSearchInput, loadTags]);

  // Selection only ever refers to rows currently displayed.
  useEffect(() => {
    setSelectedMediaIds((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(items.map((item) => item.mediaId));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  const toggleMediaSelected = useCallback((mediaId: string) => {
    setSelectedMediaIds((prev) => {
      const next = new Set(prev);
      if (next.has(mediaId)) next.delete(mediaId);
      else next.add(mediaId);
      return next;
    });
  }, []);

  const handleTagsChanged = useCallback(() => {
    void loadTags(tagSearchInput);
    void executeSearch();
  }, [loadTags, tagSearchInput, executeSearch]);

  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!contextMenu || !menu) return;
    const rect = menu.getBoundingClientRect();
    const x = Math.max(8, Math.min(contextMenu.x, window.innerWidth - rect.width - 8));
    const y = Math.max(8, Math.min(contextMenu.y, window.innerHeight - rect.height - 8));
    if (x !== contextMenu.x || y !== contextMenu.y) {
      setContextMenu({ ...contextMenu, x, y });
    }
  }, [contextMenu]);

  // Dismiss context menu on window click, viewport changes or Escape key
  useEffect(() => {
    if (!contextMenu) return;
    const handleGlobalClick = () => setContextMenu(null);
    const handleGlobalKeyDown = (ev: globalThis.KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setContextMenu(null);
      }
    };
    window.addEventListener('click', handleGlobalClick);
    window.addEventListener('resize', handleGlobalClick);
    window.addEventListener('scroll', handleGlobalClick, true);
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => {
      window.removeEventListener('click', handleGlobalClick);
      window.removeEventListener('resize', handleGlobalClick);
      window.removeEventListener('scroll', handleGlobalClick, true);
      window.removeEventListener('keydown', handleGlobalKeyDown);
    };
  }, [contextMenu]);

  const handleCreateBackup = useCallback(async () => {
    setBackingUp(true);
    setBackupResult(null);
    try {
      const res = await mediaLibrary.createBackup({ reason: 'manual' });
      if (res.ok) {
        setBackupResult(res.value);
        const opsRes = await mediaLibrary.getOpsStatus();
        if (opsRes.ok) setOpsStatus(opsRes.value);
      } else {
        setBackupResult({ ok: false, error: res.error.message || t('rpcError') });
      }
    } catch (err) {
      setBackupResult({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBackingUp(false);
    }
  }, [mediaLibrary, t]);

  const handleExportReport = useCallback(
    async (format: MappingReportFormat) => {
      setExportingFormat(format);
      setExportInfo(null);
      try {
        const res = await mediaLibrary.exportMappingReport({ format });
        if (!res.ok) {
          setExportInfo(res.error.message || t('rpcError'));
          return;
        }
        const val = res.value;
        if (!val.ok) {
          setExportInfo(val.error ?? 'Export failed');
          return;
        }
        const blob = new Blob([val.content], { type: val.mimeType });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = val.filename;
        anchor.click();
        URL.revokeObjectURL(url);
        setExportInfo(`${val.filename} (${val.rowCount} rows · sha256:${val.sha256.slice(0, 12)})`);
      } catch (err) {
        setExportInfo(err instanceof Error ? err.message : String(err));
      } finally {
        setExportingFormat(null);
      }
    },
    [mediaLibrary, t],
  );

  const handleAction = useCallback(
    async (action: 'open' | 'reveal', mediaId: string) => {
      setContextMenu(null);
      setPendingMediaId(`${action}:${mediaId}`);
      try {
        const res =
          action === 'open'
            ? await mediaLibrary.openMedia(mediaId)
            : await mediaLibrary.revealMedia(mediaId);
        if (res.ok) {
          const actionResult = res.value;
          setLastResult(actionResult);
          if (actionResult.ok) {
            setItems((prev) =>
              prev.map((it) => (it.mediaId === mediaId ? { ...it, status: 'indexed' } : it)),
            );
          } else {
            const mappedStatus = mapErrorCodeToMediaStatus(actionResult.code);
            if (mappedStatus) {
              setItems((prev) =>
                prev.map((it) => (it.mediaId === mediaId ? { ...it, status: mappedStatus } : it)),
              );
            }
          }
        } else {
          setLastResult({
            ok: false,
            mediaId,
            action,
            code: 'OPENER_FAILED',
            message: res.error.message || t('rpcError'),
            elapsedMs: 0,
          });
        }
      } catch (err) {
        setLastResult({
          ok: false,
          mediaId,
          action,
          code: 'OPENER_FAILED',
          message: err instanceof Error ? err.message : String(err),
          elapsedMs: 0,
        });
      } finally {
        setPendingMediaId(null);
      }
    },
    [mediaLibrary, t],
  );

  const handleImportSubmit = useCallback(async () => {
    if (!importSourcePath.trim()) return;
    setImporting(true);
    setImportResult(null);
    setLoadError(null);
    try {
      const res = await mediaLibrary.importTagStudioCopy({
        sourceDbPath: importSourcePath.trim(),
        uncRoot: importUncRoot.trim() || undefined,
      });
      if (res.ok) {
        setImportResult(res.value);
        if (res.value.ok) {
          await refreshAll();
        }
      } else {
        setLoadError(res.error.message || t('rpcError'));
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }, [importSourcePath, importUncRoot, mediaLibrary, refreshAll, t]);

  const toggleTagSelection = useCallback(
    (tag: { id: number; name: string }) => {
      setSelectedTags((prev) => {
        const exists = prev.some((item) => item.id === tag.id);
        const next = exists ? prev.filter((item) => item.id !== tag.id) : [...prev, tag];
        void executeSearch({ overrideTagIds: next.map((item) => item.id) });
        return next;
      });
    },
    [executeSearch],
  );

  const handleResetFilters = useCallback(() => {
    setKeyword('');
    setCatalogNumber('');
    setCatalogMatchMode('exact');
    setDateFrom('');
    setDateTo('');
    setSelectedTags([]);
    void executeSearch({
      overrideTagIds: [],
      overrideKeyword: '',
      overrideCatalog: '',
      overrideCatalogMode: 'exact',
      overrideDateFrom: '',
      overrideDateTo: '',
    });
  }, [executeSearch]);

  const handleRowContextMenu = useCallback(
    (ev: ReactMouseEvent<HTMLTableRowElement>, item: MediaSearchItem) => {
      ev.preventDefault();
      setContextMenu({
        mediaId: item.mediaId,
        filename: item.filename,
        x: ev.clientX,
        y: ev.clientY,
      });
    },
    [],
  );

  const handleRowKeyDown = useCallback(
    (ev: ReactKeyboardEvent<HTMLTableRowElement>, item: MediaSearchItem) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void handleAction('open', item.mediaId);
      } else if (ev.key === 'r' || ev.key === 'R') {
        ev.preventDefault();
        void handleAction('reveal', item.mediaId);
      } else if (ev.key === 'Escape') {
        setContextMenu(null);
      }
    },
    [handleAction],
  );

  const renderStatusBadge = (st: MediaFileStatus) => {
    let label = t('statusIndexed');
    let border = 'rgba(34,197,94,0.45)';
    let bg = 'rgba(34,197,94,0.1)';
    if (st === 'missing') {
      label = t('statusMissing');
      border = 'rgba(239,68,68,0.5)';
      bg = 'rgba(239,68,68,0.12)';
    } else if (st === 'offline') {
      label = t('statusOffline');
      border = 'rgba(245,158,11,0.55)';
      bg = 'rgba(245,158,11,0.14)';
    } else if (st === 'unmapped') {
      label = t('statusUnmapped');
      border = 'rgba(245,158,11,0.55)';
      bg = 'rgba(245,158,11,0.14)';
    } else if (st === 'permission_denied') {
      label = t('statusPermission');
      border = 'rgba(239,68,68,0.5)';
      bg = 'rgba(239,68,68,0.12)';
    }
    return (
      <span
        data-testid={`media-status-${st}`}
        style={{
          display: 'inline-block',
          padding: '2px 8px',
          borderRadius: '999px',
          border: `1px solid ${border}`,
          background: bg,
          fontSize: '11px',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    );
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '20px 24px',
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        position: 'relative',
      }}
    >
      {/* Top Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '12px',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 style={{ margin: '0 0 4px 0', fontSize: '20px', fontWeight: 600 }}>
            {t('heading')}
          </h2>
          <p style={{ margin: 0, opacity: 0.78, fontSize: '13px' }}>{t('subtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            type="button"
            data-testid="toggle-diagnostics-btn"
            onClick={() => setShowDiagnostics((prev) => !prev)}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid rgba(128,128,128,0.35)',
              background: showDiagnostics ? 'rgba(128,128,128,0.16)' : 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            {t('toggleDiagnostics')}
          </button>
          <button
            type="button"
            data-testid="toggle-tag-mgmt-btn"
            aria-pressed={showTagMgmt}
            onClick={() => setShowTagMgmt((prev) => !prev)}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid rgba(128,128,128,0.35)',
              background: showTagMgmt ? 'rgba(128,128,128,0.16)' : 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            {t('toggleTagMgmt')}
          </button>
          <button
            type="button"
            data-testid="toggle-ops-panel-btn"
            aria-pressed={showOpsPanel}
            onClick={() => setShowOpsPanel((prev) => !prev)}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid rgba(128,128,128,0.35)',
              background: showOpsPanel ? 'rgba(128,128,128,0.16)' : 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            {t('toggleOpsPanel')}
          </button>
          <button
            type="button"
            data-testid="toggle-ingestion-panel-btn"
            aria-pressed={showIngestionPanel}
            onClick={() =>
              setShowIngestionPanel((prev) => {
                const next = !prev;
                persistedShowIngestionPanel = next;
                return next;
              })
            }
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid rgba(128,128,128,0.35)',
              background: showIngestionPanel ? 'rgba(128,128,128,0.16)' : 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            {t('toggleIngestionPanel')}
          </button>
          <button
            type="button"
            onClick={() => void refreshAll()}
            disabled={searching}
            style={{
              padding: '6px 12px',
              borderRadius: '6px',
              border: '1px solid rgba(128,128,128,0.35)',
              background: 'transparent',
              color: 'inherit',
              cursor: searching ? 'wait' : 'pointer',
              fontSize: '12px',
            }}
          >
            {t('refresh')}
          </button>
        </div>
      </div>

      {/* Read-Only Degraded Mode Alert Banner (Issue #6 B4) */}
      {opsStatus?.degradedState.degraded ? (
        <div
          role="alert"
          data-testid="degraded-mode-banner"
          style={{
            padding: '10px 14px',
            borderRadius: '8px',
            border: '1px solid rgba(239,68,68,0.6)',
            background: 'rgba(239,68,68,0.14)',
            fontSize: '12px',
          }}
        >
          <strong>{t('opsDegradedBanner')}</strong>{' '}
          {opsStatus.degradedState.reason ? <span>({opsStatus.degradedState.reason})</span> : null}
        </div>
      ) : null}

      {/* Overview Summary Strip */}
      {overview ? (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: '8px',
            border: '1px solid rgba(128,128,128,0.22)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '12px 24px',
            fontSize: '12px',
            alignItems: 'center',
          }}
        >
          <div>
            <strong>{t('indexedSummary')}:</strong>{' '}
            <code data-testid="overview-counts">
              {overview.counts.mediaFiles} files · {overview.counts.tags} tags ·{' '}
              {overview.counts.tagAliases} aliases
            </code>
          </div>
          <div>
            <strong>{t('activeUncRoot')}:</strong> <code>{overview.activeUncRoot}</code>
          </div>
          <div>
            <strong>{t('localDbPath')}:</strong> <code>{overview.databasePath}</code>
          </div>
        </div>
      ) : null}

      {/* Error Banner */}
      {loadError ? (
        <div
          role="alert"
          data-testid="media-library-error-banner"
          style={{
            padding: '12px',
            borderRadius: '8px',
            border: '1px solid rgba(239,68,68,0.5)',
            background: 'rgba(239,68,68,0.1)',
            fontSize: '13px',
          }}
        >
          {loadError}
        </div>
      ) : null}

      {/* Last Native Opener Action Banner */}
      {lastResult ? (
        <section
          data-testid="last-action-banner"
          style={{
            padding: '10px 14px',
            borderRadius: '8px',
            border: lastResult.ok
              ? '1px solid rgba(34,197,94,0.45)'
              : '1px solid rgba(239,68,68,0.45)',
            background: lastResult.ok ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
            fontSize: '12px',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}
        >
          <div>
            <strong>{t('lastActionHeading')}:</strong>{' '}
            <code>
              [{lastResult.ok ? 'OK' : lastResult.code}] {lastResult.action}({lastResult.mediaId})
            </code>{' '}
            <span>({lastResult.elapsedMs} ms)</span>
          </div>
          {lastResult.resolvedUncPath ? (
            <div>
              <strong>UNC:</strong> <code>{lastResult.resolvedUncPath}</code>
            </div>
          ) : null}
          {!lastResult.ok ? <div>{lastResult.message}</div> : null}
        </section>
      ) : null}

      {/* Collapsible Import & M1 Diagnostics Drawer */}
      {showDiagnostics ? (
        <section
          data-testid="diagnostics-drawer"
          style={{
            padding: '14px 16px',
            borderRadius: '8px',
            border: '1px solid rgba(128,128,128,0.28)',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>
              {t('importHeading')}
            </h3>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <input
                type="text"
                data-testid="import-source-input"
                value={importSourcePath}
                onChange={(e) => setImportSourcePath(e.target.value)}
                placeholder={t('importSourcePlaceholder')}
                style={{
                  flex: '2 1 280px',
                  padding: '6px 10px',
                  borderRadius: '6px',
                  border: '1px solid rgba(128,128,128,0.35)',
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: '12px',
                }}
              />
              <input
                type="text"
                data-testid="import-unc-input"
                value={importUncRoot}
                onChange={(e) => setImportUncRoot(e.target.value)}
                placeholder={t('importUncPlaceholder')}
                style={{
                  flex: '1 1 220px',
                  padding: '6px 10px',
                  borderRadius: '6px',
                  border: '1px solid rgba(128,128,128,0.35)',
                  background: 'transparent',
                  color: 'inherit',
                  fontSize: '12px',
                }}
              />
              <button
                type="button"
                data-testid="import-submit-btn"
                disabled={importing || !importSourcePath.trim()}
                onClick={() => void handleImportSubmit()}
                style={{
                  padding: '6px 12px',
                  borderRadius: '6px',
                  border: '1px solid rgba(128,128,128,0.45)',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: importing ? 'wait' : 'pointer',
                  fontSize: '12px',
                  fontWeight: 600,
                }}
              >
                {importing ? t('importingBtn') : t('importBtn')}
              </button>
            </div>
            {importResult ? (
              <div
                data-testid="import-result-banner"
                style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: importResult.ok
                    ? '1px solid rgba(34,197,94,0.45)'
                    : '1px solid rgba(239,68,68,0.45)',
                  fontSize: '12px',
                }}
              >
                {importResult.message}
              </div>
            ) : null}
          </div>

          {status ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600 }}>
                {t('testItemsHeading')}
              </h3>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: '6px 14px',
                  fontSize: '12px',
                }}
              >
                <div>
                  <strong>{t('platform')}:</strong> <code>{status.platform}</code>
                </div>
                <div>
                  <strong>{t('nodeVersion')}:</strong> <code>{status.nodeVersion}</code>
                </div>
                <div>
                  <strong>{t('nodeSqlite')}:</strong>{' '}
                  <code>
                    {status.nodeSqliteAvailable ? t('statusAvailable') : t('statusMissingDriver')}
                  </code>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {status.items.map((item) => {
                  const isOpening = pendingMediaId === `open:${item.mediaId}`;
                  const isRevealing = pendingMediaId === `reveal:${item.mediaId}`;
                  return (
                    <div
                      key={item.mediaId}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid rgba(128,128,128,0.22)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '10px',
                        flexWrap: 'wrap',
                        fontSize: '12px',
                      }}
                    >
                      <div>
                        <strong>{item.label}</strong>{' '}
                        <code style={{ opacity: 0.75 }}>({item.mediaId})</code>
                      </div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          type="button"
                          disabled={isOpening || isRevealing}
                          onClick={() => void handleAction('open', item.mediaId)}
                          style={{
                            padding: '4px 8px',
                            borderRadius: '5px',
                            border: '1px solid rgba(128,128,128,0.35)',
                            background: 'transparent',
                            color: 'inherit',
                            cursor: 'pointer',
                            fontSize: '11px',
                          }}
                        >
                          {t('openBtn')}
                        </button>
                        <button
                          type="button"
                          disabled={isOpening || isRevealing}
                          onClick={() => void handleAction('reveal', item.mediaId)}
                          style={{
                            padding: '4px 8px',
                            borderRadius: '5px',
                            border: '1px solid rgba(128,128,128,0.35)',
                            background: 'transparent',
                            color: 'inherit',
                            cursor: 'pointer',
                            fontSize: '11px',
                          }}
                        >
                          {t('revealBtn')}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Issue #6 Backup, Restore & Cold-Fallback Ops Panel */}
      {showOpsPanel && opsStatus ? (
        <section
          data-testid="ops-panel"
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
            <strong style={{ fontSize: '14px' }}>{t('opsHeading')}</strong>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                data-testid="create-backup-btn"
                disabled={backingUp}
                onClick={() => void handleCreateBackup()}
                style={{
                  padding: '6px 12px',
                  borderRadius: '6px',
                  border: '1px solid rgba(128,128,128,0.35)',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: backingUp ? 'wait' : 'pointer',
                  fontSize: '12px',
                }}
              >
                {backingUp ? t('opsCreatingBackup') : t('opsCreateBackupBtn')}
              </button>
              <button
                type="button"
                data-testid="export-json-btn"
                disabled={exportingFormat !== null}
                onClick={() => void handleExportReport('json')}
                style={{
                  padding: '6px 12px',
                  borderRadius: '6px',
                  border: '1px solid rgba(128,128,128,0.35)',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: exportingFormat ? 'wait' : 'pointer',
                  fontSize: '12px',
                }}
              >
                {exportingFormat === 'json' ? t('opsExporting') : t('opsExportJsonBtn')}
              </button>
              <button
                type="button"
                data-testid="export-csv-btn"
                disabled={exportingFormat !== null}
                onClick={() => void handleExportReport('csv')}
                style={{
                  padding: '6px 12px',
                  borderRadius: '6px',
                  border: '1px solid rgba(128,128,128,0.35)',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: exportingFormat ? 'wait' : 'pointer',
                  fontSize: '12px',
                }}
              >
                {exportingFormat === 'csv' ? t('opsExporting') : t('opsExportCsvBtn')}
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', opacity: 0.85 }}>
            <span>
              <strong>{t('opsRetentionLabel')}</strong> {opsStatus.dailyRetentionCount} / {opsStatus.preMigrateRetentionCount}
            </span>
            <span>
              <strong>{t('opsNasDirLabel')}</strong> <code>{opsStatus.nasBackupDir ?? '—'}</code>
            </span>
            <span>
              <strong>Backup Dir:</strong> <code>{opsStatus.backupDir}</code>
            </span>
          </div>

          {backupResult ? (
            <div role="status" data-testid="backup-result-banner" style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.3)' }}>
              {backupResult.ok
                ? `Backup OK: ${backupResult.backupPath} (sha256:${backupResult.sha256?.slice(0, 12)}, pruned:${backupResult.prunedCount ?? 0})${backupResult.nasCopyWarning ? ` · ${backupResult.nasCopyWarning}` : ''}`
                : `Backup failed: ${backupResult.error}`}
            </div>
          ) : null}

          {exportInfo ? (
            <div role="status" data-testid="export-result-banner" style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.3)' }}>
              {exportInfo}
            </div>
          ) : null}

          <div>
            <strong>{t('opsBackupsHeading')} ({opsStatus.backups.length}):</strong>
            {opsStatus.backups.length === 0 ? (
              <div style={{ opacity: 0.72, marginTop: '4px' }}>{t('opsNoBackups')}</div>
            ) : (
              <ul data-testid="ops-backup-list" style={{ margin: '4px 0 0 18px', padding: 0 }}>
                {opsStatus.backups.slice(0, 10).map((b) => (
                  <li key={b.path}>
                    <code>{b.filename}</code> ({b.kind}, {Math.round(b.size / 1024)} KB)
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : null}

      {/* Issue #7 Staging & Recoverable Ingestion */}
      {showIngestionPanel ? (
        <IngestionPanel
          t={t}
          mediaLibrary={mediaLibrary}
          degraded={Boolean(opsStatus?.degradedState.degraded)}
          onCommitted={handleTagsChanged}
        />
      ) : null}

      {/* Issue #5 tag & alias management */}
      {showTagMgmt ? (
        <TagManagementPanel t={t} mediaLibrary={mediaLibrary} onChanged={handleTagsChanged} />
      ) : null}

      {/* M2 Search & Filter Panel */}
      <section
        style={{
          padding: '14px 16px',
          borderRadius: '8px',
          border: '1px solid rgba(128,128,128,0.25)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
            gap: '10px 14px',
            alignItems: 'end',
          }}
        >
          {/* Keyword Search */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', fontWeight: 500 }}>{t('searchKeywordLabel')}</label>
            <input
              type="text"
              data-testid="search-keyword-input"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void executeSearch();
              }}
              placeholder={t('searchKeywordPlaceholder')}
              style={{
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(128,128,128,0.35)',
                background: 'transparent',
                color: 'inherit',
                fontSize: '12px',
              }}
            />
          </div>

          {/* Catalog Number + Exact/Prefix Mode */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label style={{ fontSize: '12px', fontWeight: 500 }}>{t('catalogLabel')}</label>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  type="button"
                  data-testid="catalog-mode-exact"
                  onClick={() => setCatalogMatchMode('exact')}
                  style={{
                    padding: '1px 6px',
                    borderRadius: '4px',
                    border: '1px solid rgba(128,128,128,0.35)',
                    background:
                      catalogMatchMode === 'exact' ? 'rgba(128,128,128,0.22)' : 'transparent',
                    color: 'inherit',
                    fontSize: '11px',
                    cursor: 'pointer',
                  }}
                >
                  {t('catalogExact')}
                </button>
                <button
                  type="button"
                  data-testid="catalog-mode-prefix"
                  onClick={() => setCatalogMatchMode('prefix')}
                  style={{
                    padding: '1px 6px',
                    borderRadius: '4px',
                    border: '1px solid rgba(128,128,128,0.35)',
                    background:
                      catalogMatchMode === 'prefix' ? 'rgba(128,128,128,0.22)' : 'transparent',
                    color: 'inherit',
                    fontSize: '11px',
                    cursor: 'pointer',
                  }}
                >
                  {t('catalogPrefix')}
                </button>
              </div>
            </div>
            <input
              type="text"
              data-testid="search-catalog-input"
              value={catalogNumber}
              onChange={(e) => setCatalogNumber(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void executeSearch();
              }}
              placeholder={t('catalogPlaceholder')}
              style={{
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(128,128,128,0.35)',
                background: 'transparent',
                color: 'inherit',
                fontSize: '12px',
              }}
            />
          </div>

          {/* Date From */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', fontWeight: 500 }}>{t('dateFromLabel')}</label>
            <input
              type="text"
              data-testid="search-date-from-input"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void executeSearch();
              }}
              placeholder="YYYY-MM-DD"
              style={{
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(128,128,128,0.35)',
                background: 'transparent',
                color: 'inherit',
                fontSize: '12px',
              }}
            />
          </div>

          {/* Date To */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <label style={{ fontSize: '12px', fontWeight: 500 }}>{t('dateToLabel')}</label>
            <input
              type="text"
              data-testid="search-date-to-input"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void executeSearch();
              }}
              placeholder="YYYY-MM-DD"
              style={{
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(128,128,128,0.35)',
                background: 'transparent',
                color: 'inherit',
                fontSize: '12px',
              }}
            />
          </div>
        </div>

        {/* Tag & Alias Search + Multi-Tag AND Chips */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div
            style={{
              display: 'flex',
              gap: '8px',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <label style={{ fontSize: '12px', fontWeight: 500 }}>{t('tagFilterLabel')}</label>
            <input
              type="text"
              data-testid="tag-search-input"
              value={tagSearchInput}
              onChange={(e) => setTagSearchInput(e.target.value)}
              placeholder={t('tagSearchPlaceholder')}
              style={{
                flex: '1 1 220px',
                padding: '5px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(128,128,128,0.35)',
                background: 'transparent',
                color: 'inherit',
                fontSize: '12px',
              }}
            />
            <button
              type="button"
              data-testid="search-submit-btn"
              disabled={searching}
              onClick={() => void executeSearch()}
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                border: '1px solid rgba(128,128,128,0.45)',
                background: 'rgba(128,128,128,0.16)',
                color: 'inherit',
                cursor: searching ? 'wait' : 'pointer',
                fontSize: '12px',
                fontWeight: 600,
              }}
            >
              {searching ? t('searchingBtn') : t('searchBtn')}
            </button>
            <button
              type="button"
              data-testid="search-reset-btn"
              onClick={handleResetFilters}
              style={{
                padding: '6px 12px',
                borderRadius: '6px',
                border: '1px solid rgba(128,128,128,0.35)',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: '12px',
              }}
            >
              {t('clearFiltersBtn')}
            </button>
          </div>

          {/* Active Selected Tag AND Filter Chips */}
          {selectedTags.length > 0 ? (
            <div
              data-testid="active-tag-filters"
              style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}
            >
              <span style={{ fontSize: '12px', opacity: 0.8 }}>{t('activeTagFilters')}</span>
              {selectedTags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  data-testid={`active-tag-chip-${tag.id}`}
                  onClick={() => toggleTagSelection(tag)}
                  style={{
                    padding: '3px 8px',
                    borderRadius: '999px',
                    border: '1px solid rgba(59,130,246,0.55)',
                    background: 'rgba(59,130,246,0.15)',
                    color: 'inherit',
                    cursor: 'pointer',
                    fontSize: '11px',
                  }}
                >
                  {tag.name} ×
                </button>
              ))}
            </div>
          ) : null}

          {/* Available Tag Suggestions (Name + Aliases + Count) */}
          {availableTags.length > 0 ? (
            <div
              data-testid="tag-suggestions-list"
              style={{
                display: 'flex',
                gap: '6px',
                flexWrap: 'wrap',
                maxHeight: '84px',
                overflowY: 'auto',
              }}
            >
              {availableTags.slice(0, 24).map((tag) => {
                const isSelected = selectedTags.some((item) => item.id === tag.id);
                const aliasLabel =
                  tag.aliases.length > 0 ? ` (${tag.aliases.slice(0, 2).join(', ')})` : '';
                return (
                  <button
                    key={tag.id}
                    type="button"
                    data-testid={`tag-option-${tag.id}`}
                    onClick={() => toggleTagSelection({ id: tag.id, name: tag.name })}
                    style={{
                      padding: '3px 8px',
                      borderRadius: '999px',
                      border: isSelected
                        ? '1px solid rgba(59,130,246,0.6)'
                        : '1px solid rgba(128,128,128,0.28)',
                      background: isSelected ? 'rgba(59,130,246,0.16)' : 'transparent',
                      color: 'inherit',
                      cursor: 'pointer',
                      fontSize: '11px',
                    }}
                  >
                    {tag.name}
                    {aliasLabel} <span style={{ opacity: 0.65 }}>[{tag.mediaCount}]</span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* Ambiguous Alias Warning */}
          {tagAmbiguousAliases.length > 0 ? (
            <div
              data-testid="ambiguous-alias-warning"
              style={{
                padding: '6px 10px',
                borderRadius: '6px',
                border: '1px solid rgba(245,158,11,0.5)',
                background: 'rgba(245,158,11,0.1)',
                fontSize: '11px',
              }}
            >
              {tagAmbiguousAliases.map((amb) => (
                <div key={amb.normalizedAlias}>
                  Shared alias <code>{amb.normalizedAlias}</code> maps to multiple tags:{' '}
                  {amb.matchingTags.map((m) => `${m.name} (#${m.id})`).join(', ')}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      {/* Results Section */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <h3 style={{ margin: 0, fontSize: '15px', fontWeight: 600 }}>
            {t('resultsHeading')}{' '}
            <code
              data-testid="search-results-summary"
              style={{ fontSize: '12px', fontWeight: 400, opacity: 0.8 }}
            >
              ({items.length} / {totalMatching} · {searchElapsedMs} ms)
            </code>
          </h3>
        </div>

        {items.length > 0 && (
          <BatchTagBar
            t={t}
            mediaLibrary={mediaLibrary}
            selectedItems={items.filter((item) => selectedMediaIds.has(item.mediaId))}
            onClearSelection={() => setSelectedMediaIds(new Set())}
            onApplied={handleTagsChanged}
          />
        )}

        {items.length === 0 && !searching ? (
          <div
            data-testid="empty-results-state"
            style={{
              padding: '28px 16px',
              borderRadius: '8px',
              border: '1px dashed rgba(128,128,128,0.3)',
              textAlign: 'center',
              fontSize: '13px',
              opacity: 0.82,
            }}
          >
            {overview && overview.counts.mediaFiles === 0
              ? t('emptyLibraryState')
              : t('emptySearchState')}
          </div>
        ) : (
          <div
            style={{
              borderRadius: '8px',
              border: '1px solid rgba(128,128,128,0.25)',
              overflowX: 'auto',
            }}
          >
            <table
              data-testid="media-results-table"
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '12px',
                textAlign: 'left',
              }}
            >
              <thead>
                <tr
                  style={{
                    borderBottom: '1px solid rgba(128,128,128,0.25)',
                    background: 'rgba(128,128,128,0.06)',
                  }}
                >
                  <th style={{ padding: '8px 8px 8px 12px', width: '28px' }}>
                    <input
                      type="checkbox"
                      aria-label="Select all visible rows"
                      data-testid="select-all-media-checkbox"
                      checked={items.length > 0 && items.every((item) => selectedMediaIds.has(item.mediaId))}
                      onChange={(ev) => {
                        if (ev.target.checked) {
                          setSelectedMediaIds(new Set(items.map((item) => item.mediaId)));
                        } else {
                          setSelectedMediaIds(new Set());
                        }
                      }}
                    />
                  </th>
                  <th style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>
                    {t('colCatalogDate')}
                  </th>
                  <th style={{ padding: '8px 12px' }}>{t('colFileAndTitle')}</th>
                  <th style={{ padding: '8px 12px' }}>{t('colTags')}</th>
                  <th style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{t('colStatus')}</th>
                  <th style={{ padding: '8px 12px', whiteSpace: 'nowrap' }}>{t('colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const isOpening = pendingMediaId === `open:${item.mediaId}`;
                  const isRevealing = pendingMediaId === `reveal:${item.mediaId}`;
                  return (
                    <tr
                      key={item.mediaId}
                      tabIndex={0}
                      data-testid={`media-row-${item.mediaId}`}
                      onClick={(ev) => {
                        const target = ev.target as HTMLElement | null;
                        if (target?.closest('button, input, a, select, textarea')) return;
                        if (window.getSelection()?.toString()) return;
                        toggleMediaSelected(item.mediaId);
                      }}
                      onContextMenu={(ev) => handleRowContextMenu(ev, item)}
                      onKeyDown={(ev) => handleRowKeyDown(ev, item)}
                      style={{
                        borderBottom: '1px solid rgba(128,128,128,0.15)',
                        background: selectedMediaIds.has(item.mediaId) ? 'rgba(59,130,246,0.1)' : undefined,
                        cursor: 'pointer',
                      }}
                    >
                      <td style={{ padding: '8px 8px 8px 12px', verticalAlign: 'top' }}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${item.filename}`}
                          data-testid={`select-media-checkbox-${item.mediaId}`}
                          checked={selectedMediaIds.has(item.mediaId)}
                          onChange={() => toggleMediaSelected(item.mediaId)}
                          onClick={(ev) => ev.stopPropagation()}
                        />
                      </td>
                      <td style={{ padding: '8px 12px', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                        <div style={{ fontWeight: 600 }}>
                          {item.catalogNumber ? <code>{item.catalogNumber}</code> : '—'}
                        </div>
                        <div style={{ opacity: 0.72, fontSize: '11px' }}>
                          {item.mediaDate ?? '—'}
                        </div>
                      </td>
                      <td style={{ padding: '8px 12px', verticalAlign: 'top' }}>
                        <div style={{ fontWeight: 600 }}>
                          {item.title ? `${item.title} (${item.filename})` : item.filename}
                        </div>
                        <code
                          style={{
                            fontSize: '11px',
                            opacity: 0.76,
                            wordBreak: 'break-all',
                          }}
                        >
                          {item.relativePath}
                        </code>
                      </td>
                      <td style={{ padding: '8px 12px', verticalAlign: 'top' }}>
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                          {item.tags.map((tag) => (
                            <button
                              key={tag.id}
                              type="button"
                              onClick={() => toggleTagSelection({ id: tag.id, name: tag.name })}
                              style={{
                                padding: '2px 6px',
                                borderRadius: '999px',
                                border: '1px solid rgba(128,128,128,0.3)',
                                background: 'transparent',
                                color: 'inherit',
                                cursor: 'pointer',
                                fontSize: '11px',
                              }}
                            >
                              {tag.name}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td style={{ padding: '8px 12px', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                        {renderStatusBadge(item.status)}
                      </td>
                      <td style={{ padding: '8px 12px', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            type="button"
                            data-testid={`open-media-btn-${item.mediaId}`}
                            disabled={isOpening || isRevealing}
                            onClick={() => void handleAction('open', item.mediaId)}
                            style={{
                              padding: '4px 8px',
                              borderRadius: '5px',
                              border: '1px solid rgba(128,128,128,0.35)',
                              background: 'transparent',
                              color: 'inherit',
                              cursor: 'pointer',
                              fontSize: '11px',
                            }}
                          >
                            {t('openBtn')}
                          </button>
                          <button
                            type="button"
                            data-testid={`reveal-media-btn-${item.mediaId}`}
                            disabled={isOpening || isRevealing}
                            onClick={() => void handleAction('reveal', item.mediaId)}
                            style={{
                              padding: '4px 8px',
                              borderRadius: '5px',
                              border: '1px solid rgba(128,128,128,0.35)',
                              background: 'transparent',
                              color: 'inherit',
                              cursor: 'pointer',
                              fontSize: '11px',
                            }}
                          >
                            {t('revealBtn')}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Keyset Pagination Load More Button */}
        {nextCursor ? (
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '6px' }}>
            <button
              type="button"
              data-testid="load-more-btn"
              disabled={loadingMore || searching}
              onClick={() => void executeSearch({ cursor: nextCursor, append: true })}
              style={{
                padding: '6px 16px',
                borderRadius: '6px',
                border: '1px solid rgba(128,128,128,0.4)',
                background: 'transparent',
                color: 'inherit',
                cursor: loadingMore ? 'wait' : 'pointer',
                fontSize: '12px',
                fontWeight: 500,
              }}
            >
              {loadingMore ? t('loadingMoreBtn') : t('loadMoreBtn')}
            </button>
          </div>
        ) : null}
      </section>

      {/* Floating Right-Click Context Menu */}
      {contextMenu ? (
        <div
          ref={contextMenuRef}
          role="menu"
          data-testid="media-row-context-menu"
          onClick={(ev) => ev.stopPropagation()}
          style={{
            position: 'fixed',
            top: `${contextMenu.y}px`,
            left: `${contextMenu.x}px`,
            zIndex: 9999,
            width: '260px',
            maxWidth: 'calc(100vw - 16px)',
            maxHeight: 'calc(100vh - 16px)',
            overflowY: 'auto',
            boxSizing: 'border-box',
            padding: '6px',
            borderRadius: '8px',
            border: '1px solid rgba(128,128,128,0.4)',
            background: '#1e1e22',
            color: '#f4f4f6',
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            fontSize: '12px',
          }}
        >
          <div
            style={{
              padding: '4px 8px',
              opacity: 0.7,
              fontSize: '11px',
              borderBottom: '1px solid rgba(128,128,128,0.25)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {contextMenu.filename} (#{contextMenu.mediaId})
          </div>
          <button
            type="button"
            role="menuitem"
            data-testid="context-menu-open-btn"
            onClick={() => void handleAction('open', contextMenu.mediaId)}
            style={{
              padding: '6px 8px',
              borderRadius: '5px',
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            {t('contextMenuOpen')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="context-menu-reveal-btn"
            onClick={() => void handleAction('reveal', contextMenu.mediaId)}
            style={{
              padding: '6px 8px',
              borderRadius: '5px',
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            {t('contextMenuReveal')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
