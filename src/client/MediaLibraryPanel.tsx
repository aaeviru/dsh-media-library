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
  MediaSortField,
  MediaSortOrder,
  OpsStatus,
  SpikeStatus,
  TagSummary,
} from '../types.ts';
import type { MediaLibraryKey } from './locales.ts';
import type { MediaLibraryNamespace } from './namespace.ts';
import { BatchTagBar } from './BatchTagBar.tsx';
import { IngestionPanel } from './IngestionPanel.tsx';
import { TagManagementPanel } from './TagManagementPanel.tsx';
import { MediaSortControls } from './ui/MediaSortControls.tsx';
import {
  MediaSearchCoordinator,
  type SearchCoordinatorCallbacks,
  type SearchExecutionOptions,
} from './ui/search-coordinator.ts';
import { Button, Tag, cx, type TagTone } from './ui/primitives.ts';
import css from './ui/styles.module.css';

type Translate = (key: MediaLibraryKey) => string;

type ActiveTab = 'library' | 'ingestion' | 'tags' | 'ops' | 'diagnostics';

let persistedActiveTab: ActiveTab = 'library';

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
  const [activeTab, setActiveTabState] = useState<ActiveTab>(() => persistedActiveTab);
  const [mountedTabs, setMountedTabs] = useState<ReadonlySet<ActiveTab>>(
    () => new Set<ActiveTab>(['library', persistedActiveTab]),
  );
  const [backingUp, setBackingUp] = useState(false);
  const [backupResult, setBackupResult] = useState<CreateBackupResult | null>(null);
  const [exportingFormat, setExportingFormat] = useState<MappingReportFormat | null>(null);
  const [exportInfo, setExportInfo] = useState<string | null>(null);
  const [selectedMediaIds, setSelectedMediaIds] = useState<ReadonlySet<string>>(new Set());

  const selectTab = useCallback((next: ActiveTab) => {
    persistedActiveTab = next;
    setActiveTabState(next);
    setMountedTabs((prev) => (prev.has(next) ? prev : new Set([...prev, next])));
  }, []);

  const toggleTab = useCallback((target: Exclude<ActiveTab, 'library'>) => {
    setActiveTabState((prev) => {
      const next: ActiveTab = prev === target ? 'library' : target;
      persistedActiveTab = next;
      setMountedTabs((mounted) => (mounted.has(next) ? mounted : new Set([...mounted, next])));
      return next;
    });
  }, []);

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
  const [sortBy, setSortBy] = useState<MediaSortField>('media_date');
  const [sortOrder, setSortOrder] = useState<MediaSortOrder>('desc');

  // Search results & pagination state
  const [items, setItems] = useState<readonly MediaSearchItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalMatching, setTotalMatching] = useState(0);
  const [searchElapsedMs, setSearchElapsedMs] = useState(0);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const coordinatorRef = useRef<MediaSearchCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new MediaSearchCoordinator({
      keyword,
      catalogNumber,
      catalogMatchMode,
      dateFrom,
      dateTo,
      selectedTagIds: selectedTags.map((tag) => tag.id),
      sortBy,
      sortOrder,
      tagSearchInput,
    });
  }
  const coordinator = coordinatorRef.current;
  coordinator.syncDraft({
    keyword,
    catalogNumber,
    catalogMatchMode,
    dateFrom,
    dateTo,
    selectedTagIds: selectedTags.map((tag) => tag.id),
    sortBy,
    sortOrder,
    tagSearchInput,
  });

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

  const createSearchCallbacks = useCallback(
    (): SearchCoordinatorCallbacks => ({
      searchMedia: (query) => mediaLibrary.searchMedia(query),
      onSearchingChange: setSearching,
      onLoadingMoreChange: setLoadingMore,
      onClearNextCursor: () => setNextCursor(null),
      onError: setLoadError,
      onResult: (val, isAppend) => {
        setItems((prev) => (isAppend ? [...prev, ...val.items] : val.items));
        setNextCursor(val.nextCursor);
        setTotalMatching(val.totalMatching);
        setSearchElapsedMs(val.elapsedMs);
      },
      fallbackRpcError: () => t('rpcError'),
    }),
    [mediaLibrary, t],
  );

  const executeSearch = useCallback(
    async (options?: SearchExecutionOptions) => {
      await coordinator.executeSearch(createSearchCallbacks(), options);
    },
    [coordinator, createSearchCallbacks],
  );

  const refreshAll = useCallback(async () => {
    await coordinator.refreshAll({
      loadMetadata: async () => {
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
        }
      },
      loadTags,
      searchCallbacks: createSearchCallbacks(),
    });
  }, [coordinator, mediaLibrary, t, loadTags, createSearchCallbacks]);

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

  const handleTagsChanged = useCallback(async () => {
    await Promise.all([loadTags(coordinator.getDraft().tagSearchInput), executeSearch()]);
  }, [coordinator, loadTags, executeSearch]);

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
        const nextIds = next.map((item) => item.id);
        coordinator.patchDraft({ selectedTagIds: nextIds });
        void executeSearch({ overrideTagIds: nextIds });
        return next;
      });
    },
    [coordinator, executeSearch],
  );

  const handleSortFieldChange = useCallback(
    (nextSortBy: MediaSortField) => {
      const current = coordinator.getDraft();
      if (nextSortBy === current.sortBy) return;
      coordinator.patchDraft({ sortBy: nextSortBy });
      setSortBy(nextSortBy);
      void executeSearch({
        preserveAppliedFilters: true,
        overrideSortBy: nextSortBy,
        overrideSortOrder: current.sortOrder,
      });
    },
    [coordinator, executeSearch],
  );

  const handleSortOrderToggle = useCallback(() => {
    const current = coordinator.getDraft();
    const nextSortOrder: MediaSortOrder = current.sortOrder === 'desc' ? 'asc' : 'desc';
    coordinator.patchDraft({ sortOrder: nextSortOrder });
    setSortOrder(nextSortOrder);
    void executeSearch({
      preserveAppliedFilters: true,
      overrideSortBy: current.sortBy,
      overrideSortOrder: nextSortOrder,
    });
  }, [coordinator, executeSearch]);

  const handleResetFilters = useCallback(() => {
    setKeyword('');
    setCatalogNumber('');
    setCatalogMatchMode('exact');
    setDateFrom('');
    setDateTo('');
    setSelectedTags([]);
    setSortBy('media_date');
    setSortOrder('desc');
    coordinator.patchDraft({
      keyword: '',
      catalogNumber: '',
      catalogMatchMode: 'exact',
      dateFrom: '',
      dateTo: '',
      selectedTagIds: [],
      sortBy: 'media_date',
      sortOrder: 'desc',
    });
    void executeSearch({
      overrideTagIds: [],
      overrideKeyword: '',
      overrideCatalog: '',
      overrideCatalogMode: 'exact',
      overrideDateFrom: '',
      overrideDateTo: '',
      overrideSortBy: 'media_date',
      overrideSortOrder: 'desc',
    });
  }, [coordinator, executeSearch]);

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
    let tone: TagTone = 'success';
    if (st === 'missing') {
      label = t('statusMissing');
      tone = 'danger';
    } else if (st === 'offline') {
      label = t('statusOffline');
      tone = 'warning';
    } else if (st === 'unmapped') {
      label = t('statusUnmapped');
      tone = 'warning';
    } else if (st === 'permission_denied') {
      label = t('statusPermission');
      tone = 'danger';
    }
    return (
      <span data-testid={`media-status-${st}`}>
        <Tag tone={tone}>{label}</Tag>
      </span>
    );
  };

  // Show Diagnostics/Import inline on Library view only when the library is empty (onboarding),
  // or when the Diagnostics tab is active.
  const showDiagnosticsVisible =
    activeTab === 'diagnostics' || (activeTab === 'library' && overview?.counts.mediaFiles === 0);

  return (
    <div className={css.root}>
      {/* Top Header & Mutually Exclusive State-Preserving Tab Navigation (Issue #42 B5) */}
      <div className={css.header}>
        <div>
          <h2 className={css.heading}>{t('heading')}</h2>
          <p className={css.subtitle}>{t('subtitle')}</p>
        </div>
        <div className={css.headerControls}>
          <div role="tablist" aria-label={t('heading')} className={css.tabBar}>
            <button
              type="button"
              role="tab"
              data-testid="tab-library-btn"
              aria-selected={activeTab === 'library'}
              onClick={() => selectTab('library')}
              className={cx(css.tabBtn, activeTab === 'library' && css.tabBtnActive)}
            >
              {t('tabLibrary')}
            </button>
            <button
              type="button"
              role="tab"
              data-testid="toggle-ingestion-panel-btn"
              aria-selected={activeTab === 'ingestion'}
              aria-pressed={activeTab === 'ingestion'}
              onClick={() => toggleTab('ingestion')}
              className={cx(css.tabBtn, activeTab === 'ingestion' && css.tabBtnActive)}
            >
              {t('toggleIngestionPanel')}
            </button>
            <button
              type="button"
              role="tab"
              data-testid="toggle-tag-mgmt-btn"
              aria-selected={activeTab === 'tags'}
              aria-pressed={activeTab === 'tags'}
              onClick={() => toggleTab('tags')}
              className={cx(css.tabBtn, activeTab === 'tags' && css.tabBtnActive)}
            >
              {t('toggleTagMgmt')}
            </button>
            <button
              type="button"
              role="tab"
              data-testid="toggle-ops-panel-btn"
              aria-selected={activeTab === 'ops'}
              aria-pressed={activeTab === 'ops'}
              onClick={() => toggleTab('ops')}
              className={cx(css.tabBtn, activeTab === 'ops' && css.tabBtnActive)}
            >
              {t('toggleOpsPanel')}
            </button>
            <button
              type="button"
              role="tab"
              data-testid="toggle-diagnostics-btn"
              aria-selected={activeTab === 'diagnostics'}
              aria-pressed={activeTab === 'diagnostics'}
              onClick={() => toggleTab('diagnostics')}
              className={cx(css.tabBtn, activeTab === 'diagnostics' && css.tabBtnActive)}
            >
              {t('toggleDiagnostics')}
            </button>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshAll()}
            disabled={searching}
          >
            {t('refresh')}
          </Button>
        </div>
      </div>

      {/* Read-Only Degraded Mode Alert Banner (Issue #6 B4) */}
      {opsStatus?.degradedState.degraded ? (
        <div role="alert" data-testid="degraded-mode-banner" className={cx(css.banner, css.bannerDanger)}>
          <strong>{t('opsDegradedBanner')}</strong>{' '}
          {opsStatus.degradedState.reason ? <span>({opsStatus.degradedState.reason})</span> : null}
        </div>
      ) : null}

      {/* Overview Summary Strip */}
      {overview ? (
        <div className={css.overviewStrip}>
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
        <div role="alert" data-testid="media-library-error-banner" className={cx(css.banner, css.bannerDanger)}>
          {loadError}
        </div>
      ) : null}

      {/* Last Native Opener Action Banner */}
      {lastResult ? (
        <section
          data-testid="last-action-banner"
          className={cx(css.banner, css.stackSm, lastResult.ok ? css.bannerSuccess : css.bannerDanger)}
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

      {/* Import & M1 Diagnostics View (visible on Diagnostics tab, or inline on empty Library) */}
      {(mountedTabs.has('diagnostics') || showDiagnosticsVisible) ? (
        <section
          data-testid="diagnostics-drawer"
          hidden={!showDiagnosticsVisible}
          className={cx(css.panel, !showDiagnosticsVisible && css.hiddenTab)}
        >
          <div className={css.stack}>
            <h3 className={css.sectionTitle}>{t('importHeading')}</h3>
            <div className={css.row}>
              <input
                type="text"
                data-testid="import-source-input"
                value={importSourcePath}
                onChange={(e) => setImportSourcePath(e.target.value)}
                placeholder={t('importSourcePlaceholder')}
                className={cx(css.control, css.controlFlexWide)}
              />
              <input
                type="text"
                data-testid="import-unc-input"
                value={importUncRoot}
                onChange={(e) => setImportUncRoot(e.target.value)}
                placeholder={t('importUncPlaceholder')}
                className={cx(css.control, css.controlFlex)}
              />
              <button
                type="button"
                data-testid="import-submit-btn"
                disabled={importing || !importSourcePath.trim()}
                onClick={() => void handleImportSubmit()}
                className={cx(css.btn, css.btnPrimary)}
              >
                {importing ? t('importingBtn') : t('importBtn')}
              </button>
            </div>
            {importResult ? (
              <div
                data-testid="import-result-banner"
                className={cx(css.banner, importResult.ok ? css.bannerSuccess : css.bannerDanger)}
              >
                {importResult.message}
              </div>
            ) : null}
          </div>

          {status ? (
            <div className={css.stack}>
              <h3 className={css.sectionTitle}>{t('testItemsHeading')}</h3>
              <div className={css.diagGrid}>
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
              <div className={css.stackSm}>
                {status.items.map((item) => {
                  const isOpening = pendingMediaId === `open:${item.mediaId}`;
                  const isRevealing = pendingMediaId === `reveal:${item.mediaId}`;
                  return (
                    <div key={item.mediaId} className={cx(css.panelCompact, css.rowBetween)}>
                      <div>
                        <strong>{item.label}</strong>{' '}
                        <code className={css.muted}>({item.mediaId})</code>
                      </div>
                      <div className={css.rowTight}>
                        <button
                          type="button"
                          disabled={isOpening || isRevealing}
                          onClick={() => void handleAction('open', item.mediaId)}
                          className={cx(css.btn, css.btnSm)}
                        >
                          {t('openBtn')}
                        </button>
                        <button
                          type="button"
                          disabled={isOpening || isRevealing}
                          onClick={() => void handleAction('reveal', item.mediaId)}
                          className={cx(css.btn, css.btnSm)}
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

      {/* Issue #6 Backup, Restore & Cold-Fallback Ops View (lazy-mounted, state-preserved) */}
      {mountedTabs.has('ops') && opsStatus ? (
        <section
          data-testid="ops-panel"
          hidden={activeTab !== 'ops'}
          className={cx(css.panel, activeTab !== 'ops' && css.hiddenTab)}
        >
          <div className={css.rowBetween}>
            <strong className={css.sectionTitle}>{t('opsHeading')}</strong>
            <div className={css.row}>
              <button
                type="button"
                data-testid="create-backup-btn"
                disabled={backingUp}
                onClick={() => void handleCreateBackup()}
                className={cx(css.btn, css.btnPrimary)}
              >
                {backingUp ? t('opsCreatingBackup') : t('opsCreateBackupBtn')}
              </button>
              <button
                type="button"
                data-testid="export-json-btn"
                disabled={exportingFormat !== null}
                onClick={() => void handleExportReport('json')}
                className={css.btn}
              >
                {exportingFormat === 'json' ? t('opsExporting') : t('opsExportJsonBtn')}
              </button>
              <button
                type="button"
                data-testid="export-csv-btn"
                disabled={exportingFormat !== null}
                onClick={() => void handleExportReport('csv')}
                className={css.btn}
              >
                {exportingFormat === 'csv' ? t('opsExporting') : t('opsExportCsvBtn')}
              </button>
            </div>
          </div>

          <div className={cx(css.row, css.muted)}>
            <span>
              <strong>{t('opsRetentionLabel')}</strong> {opsStatus.dailyRetentionCount} /{' '}
              {opsStatus.preMigrateRetentionCount}
            </span>
            <span>
              <strong>{t('opsNasDirLabel')}</strong> <code>{opsStatus.nasBackupDir ?? '—'}</code>
            </span>
            <span>
              <strong>Backup Dir:</strong> <code>{opsStatus.backupDir}</code>
            </span>
          </div>

          {backupResult ? (
            <div
              role="status"
              data-testid="backup-result-banner"
              className={cx(css.banner, backupResult.ok ? css.bannerSuccess : css.bannerDanger)}
            >
              {backupResult.ok
                ? `Backup OK: ${backupResult.backupPath} (sha256:${backupResult.sha256?.slice(0, 12)}, pruned:${backupResult.prunedCount ?? 0})${backupResult.nasCopyWarning ? ` · ${backupResult.nasCopyWarning}` : ''}`
                : `Backup failed: ${backupResult.error}`}
            </div>
          ) : null}

          {exportInfo ? (
            <div role="status" data-testid="export-result-banner" className={css.banner}>
              {exportInfo}
            </div>
          ) : null}

          <div>
            <strong>
              {t('opsBackupsHeading')} ({opsStatus.backups.length}):
            </strong>
            {opsStatus.backups.length === 0 ? (
              <div className={css.muted}>{t('opsNoBackups')}</div>
            ) : (
              <ul data-testid="ops-backup-list" className={css.backupList}>
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

      {/* Issue #7 Staging & Recoverable Ingestion View (lazy-mounted, state-preserved) */}
      {mountedTabs.has('ingestion') ? (
        <div hidden={activeTab !== 'ingestion'} className={activeTab !== 'ingestion' ? css.hiddenTab : undefined}>
          <IngestionPanel
            t={t}
            mediaLibrary={mediaLibrary}
            degraded={Boolean(opsStatus?.degradedState.degraded)}
            onCommitted={handleTagsChanged}
          />
        </div>
      ) : null}

      {/* Issue #5 Tag & Alias Management View (lazy-mounted, state-preserved) */}
      {mountedTabs.has('tags') ? (
        <div hidden={activeTab !== 'tags'} className={activeTab !== 'tags' ? css.hiddenTab : undefined}>
          <TagManagementPanel t={t} mediaLibrary={mediaLibrary} onChanged={handleTagsChanged} />
        </div>
      ) : null}

      {/* Main Library View (Search & Filter + Batch Bar + Results Table; state preserved across tab switches) */}
      <div
        data-testid="library-main-view"
        hidden={activeTab !== 'library'}
        className={cx(css.stackMd, activeTab !== 'library' && css.hiddenTab)}
      >
        <section className={css.panel}>
          <div className={css.filterGrid}>
            {/* Keyword Search */}
            <div className={css.stackSm}>
              <label className={css.fieldLabel}>{t('searchKeywordLabel')}</label>
              <input
                type="text"
                data-testid="search-keyword-input"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void executeSearch();
                }}
                placeholder={t('searchKeywordPlaceholder')}
                className={css.control}
              />
            </div>

            {/* Catalog Number + Exact/Prefix Mode */}
            <div className={css.stackSm}>
              <div className={css.rowBetween}>
                <label className={css.fieldLabel}>{t('catalogLabel')}</label>
                <div className={css.rowTight}>
                  <button
                    type="button"
                    data-testid="catalog-mode-exact"
                    onClick={() => setCatalogMatchMode('exact')}
                    className={cx(css.btn, css.btnXs, catalogMatchMode === 'exact' && css.btnActive)}
                  >
                    {t('catalogExact')}
                  </button>
                  <button
                    type="button"
                    data-testid="catalog-mode-prefix"
                    onClick={() => setCatalogMatchMode('prefix')}
                    className={cx(css.btn, css.btnXs, catalogMatchMode === 'prefix' && css.btnActive)}
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
                className={css.control}
              />
            </div>

            {/* Date From */}
            <div className={css.stackSm}>
              <label className={css.fieldLabel}>{t('dateFromLabel')}</label>
              <input
                type="text"
                data-testid="search-date-from-input"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void executeSearch();
                }}
                placeholder="YYYY-MM-DD"
                className={css.control}
              />
            </div>

            {/* Date To */}
            <div className={css.stackSm}>
              <label className={css.fieldLabel}>{t('dateToLabel')}</label>
              <input
                type="text"
                data-testid="search-date-to-input"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void executeSearch();
                }}
                placeholder="YYYY-MM-DD"
                className={css.control}
              />
            </div>
          </div>

          {/* Tag & Alias Search + Multi-Tag AND Chips */}
          <div className={css.stack}>
            <div className={css.row}>
              <label className={css.fieldLabel}>{t('tagFilterLabel')}</label>
              <input
                type="text"
                data-testid="tag-search-input"
                value={tagSearchInput}
                onChange={(e) => setTagSearchInput(e.target.value)}
                placeholder={t('tagSearchPlaceholder')}
                className={cx(css.control, css.controlFlex)}
              />
              <button
                type="button"
                data-testid="search-submit-btn"
                disabled={searching}
                onClick={() => void executeSearch()}
                className={cx(css.btn, css.btnPrimary)}
              >
                {searching ? t('searchingBtn') : t('searchBtn')}
              </button>
              <button
                type="button"
                data-testid="search-reset-btn"
                onClick={handleResetFilters}
                className={css.btn}
              >
                {t('clearFiltersBtn')}
              </button>
            </div>

            {/* Active Selected Tag AND Filter Chips */}
            {selectedTags.length > 0 ? (
              <div data-testid="active-tag-filters" className={css.rowTight}>
                <span className={css.muted}>{t('activeTagFilters')}</span>
                {selectedTags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    data-testid={`active-tag-chip-${tag.id}`}
                    onClick={() => toggleTagSelection(tag)}
                    className={cx(css.pillChip, css.pillChipActive)}
                  >
                    {tag.name} ×
                  </button>
                ))}
              </div>
            ) : null}

            {/* Available Tag Suggestions (Name + Aliases + Count) */}
            {availableTags.length > 0 ? (
              <div data-testid="tag-suggestions-list" className={css.suggestionsList}>
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
                      className={cx(css.pillChip, isSelected && css.pillChipActive)}
                    >
                      {tag.name}
                      {aliasLabel} <span className={css.mutedSm}>[{tag.mediaCount}]</span>
                    </button>
                  );
                })}
              </div>
            ) : null}

            {/* Ambiguous Alias Warning */}
            {tagAmbiguousAliases.length > 0 ? (
              <div data-testid="ambiguous-alias-warning" className={cx(css.banner, css.bannerWarn)}>
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
        <section className={css.stackMd}>
          <div className={css.rowBetween}>
            <h3 className={css.resultsTitle}>
              {t('resultsHeading')}{' '}
              <code data-testid="search-results-summary" className={css.muted}>
                ({items.length} / {totalMatching} · {searchElapsedMs} ms)
              </code>
            </h3>
            <MediaSortControls
              t={t}
              sortBy={sortBy}
              sortOrder={sortOrder}
              onSortByChange={handleSortFieldChange}
              onSortOrderToggle={handleSortOrderToggle}
            />
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
            <div data-testid="empty-results-state" className={css.emptyBox}>
              {overview && overview.counts.mediaFiles === 0
                ? t('emptyLibraryState')
                : t('emptySearchState')}
            </div>
          ) : (
            <div className={css.tableWrap}>
              <table data-testid="media-results-table" className={css.table}>
                <thead>
                  <tr className={css.tableHeadRow}>
                    <th className={css.thCheck}>
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
                    <th className={cx(css.th, css.thNowrap)}>{t('colCatalogDate')}</th>
                    <th className={css.th}>{t('colFileAndTitle')}</th>
                    <th className={css.th}>{t('colTags')}</th>
                    <th className={cx(css.th, css.thNowrap)}>{t('colStatus')}</th>
                    <th className={cx(css.th, css.thNowrap)}>{t('colActions')}</th>
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
                        className={cx(
                          css.tableRow,
                          selectedMediaIds.has(item.mediaId) && css.tableRowSelected,
                        )}
                      >
                        <td className={css.tdCheck}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${item.filename}`}
                            data-testid={`select-media-checkbox-${item.mediaId}`}
                            checked={selectedMediaIds.has(item.mediaId)}
                            onChange={() => toggleMediaSelected(item.mediaId)}
                            onClick={(ev) => ev.stopPropagation()}
                          />
                        </td>
                        <td className={cx(css.td, css.tdCatalog)}>
                          <div>
                            <strong>{item.catalogNumber ? <code>{item.catalogNumber}</code> : '—'}</strong>
                          </div>
                          <div className={css.mutedSm}>{item.mediaDate ?? '—'}</div>
                        </td>
                        <td className={css.td}>
                          <div>
                            <strong>
                              {item.title ? `${item.title} (${item.filename})` : item.filename}
                            </strong>
                          </div>
                          <code className={css.pathCode}>{item.relativePath}</code>
                        </td>
                        <td className={cx(css.td, css.tdTags)}>
                          <div className={css.rowTight}>
                            {item.tags.map((tag) => (
                              <button
                                key={tag.id}
                                type="button"
                                onClick={() => toggleTagSelection({ id: tag.id, name: tag.name })}
                                className={css.pillChip}
                              >
                                {tag.name}
                              </button>
                            ))}
                          </div>
                        </td>
                        <td className={cx(css.td, css.tdNowrap)}>{renderStatusBadge(item.status)}</td>
                        <td className={cx(css.td, css.tdActions)}>
                          <div className={css.rowTight}>
                            <button
                              type="button"
                              data-testid={`open-media-btn-${item.mediaId}`}
                              disabled={isOpening || isRevealing}
                              onClick={() => void handleAction('open', item.mediaId)}
                              className={cx(css.btn, css.btnSm)}
                            >
                              {t('openBtn')}
                            </button>
                            <button
                              type="button"
                              data-testid={`reveal-media-btn-${item.mediaId}`}
                              disabled={isOpening || isRevealing}
                              onClick={() => void handleAction('reveal', item.mediaId)}
                              className={cx(css.btn, css.btnSm)}
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
            <div className={css.loadMoreWrap}>
              <button
                type="button"
                data-testid="load-more-btn"
                disabled={loadingMore || searching}
                onClick={() => void executeSearch({ cursor: nextCursor, append: true })}
                className={css.btn}
              >
                {loadingMore ? t('loadingMoreBtn') : t('loadMoreBtn')}
              </button>
            </div>
          ) : null}
        </section>
      </div>

      {/* Floating Right-Click Context Menu */}
      {contextMenu ? (
        <div
          ref={contextMenuRef}
          role="menu"
          data-testid="media-row-context-menu"
          onClick={(ev) => ev.stopPropagation()}
          style={{
            top: `${contextMenu.y}px`,
            left: `${contextMenu.x}px`,
          }}
          className={css.contextMenu}
        >
          <div className={css.contextMenuHeader}>
            {contextMenu.filename} (#{contextMenu.mediaId})
          </div>
          <button
            type="button"
            role="menuitem"
            data-testid="context-menu-open-btn"
            onClick={() => void handleAction('open', contextMenu.mediaId)}
            className={css.contextMenuItem}
          >
            {t('contextMenuOpen')}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="context-menu-reveal-btn"
            onClick={() => void handleAction('reveal', contextMenu.mediaId)}
            className={css.contextMenuItem}
          >
            {t('contextMenuReveal')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
