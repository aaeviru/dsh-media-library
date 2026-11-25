import type {
  CatalogMatchMode,
  MediaSortField,
  MediaSortOrder,
  SearchMediaInput,
  SearchMediaResult,
} from '../../types.ts';

export interface SearchDraftState {
  readonly keyword: string;
  readonly catalogNumber: string;
  readonly catalogMatchMode: CatalogMatchMode;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly selectedTagIds: readonly number[];
  readonly sortBy: MediaSortField;
  readonly sortOrder: MediaSortOrder;
  readonly tagSearchInput: string;
}

export interface SearchExecutionOptions {
  readonly cursor?: string | undefined;
  readonly append?: boolean | undefined;
  readonly overrideTagIds?: readonly number[] | undefined;
  readonly overrideKeyword?: string | undefined;
  readonly overrideCatalog?: string | undefined;
  readonly overrideCatalogMode?: CatalogMatchMode | undefined;
  readonly overrideDateFrom?: string | undefined;
  readonly overrideDateTo?: string | undefined;
  readonly overrideSortBy?: MediaSortField | undefined;
  readonly overrideSortOrder?: MediaSortOrder | undefined;
}

export type RpcResponse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly message?: string | undefined } };

export interface SearchCoordinatorCallbacks {
  readonly searchMedia: (input: SearchMediaInput) => Promise<RpcResponse<SearchMediaResult>>;
  readonly onSearchingChange: (searching: boolean) => void;
  readonly onLoadingMoreChange: (loadingMore: boolean) => void;
  readonly onClearNextCursor: () => void;
  readonly onError: (message: string | null) => void;
  readonly onResult: (result: SearchMediaResult, isAppend: boolean) => void;
  readonly fallbackRpcError: () => string;
}

/**
 * Coordinates search requests, cursor ownership, and multi-RPC refresh cycles so an in-flight
 * refresh never captures a stale sort/filter closure or overwrites a newer user-initiated search.
 */
export class MediaSearchCoordinator {
  private draft: SearchDraftState;
  private committedQuery: SearchMediaInput | null = null;
  private requestSeq = 0;
  private refreshSeq = 0;
  private appending = false;

  constructor(initialDraft: SearchDraftState) {
    this.draft = initialDraft;
  }

  public syncDraft(nextDraft: SearchDraftState): void {
    this.draft = nextDraft;
  }

  public patchDraft(patch: Partial<SearchDraftState>): void {
    this.draft = { ...this.draft, ...patch };
  }

  public getDraft(): SearchDraftState {
    return this.draft;
  }

  public getCommittedQuery(): SearchMediaInput | null {
    return this.committedQuery;
  }

  public async executeSearch(
    callbacks: SearchCoordinatorCallbacks,
    options?: SearchExecutionOptions,
  ): Promise<void> {
    const isAppend = Boolean(options?.append && options?.cursor);
    if (isAppend && (!this.committedQuery || this.appending)) return;

    const requestId = ++this.requestSeq;
    this.appending = isAppend;
    if (isAppend) {
      callbacks.onLoadingMoreChange(true);
    } else {
      callbacks.onSearchingChange(true);
      callbacks.onLoadingMoreChange(false);
      callbacks.onClearNextCursor();
    }
    callbacks.onError(null);

    const current = this.draft;
    const effectiveTagIds = options?.overrideTagIds ?? current.selectedTagIds;
    const effectiveKeyword = (options?.overrideKeyword ?? current.keyword).trim();
    const effectiveCatalog = (options?.overrideCatalog ?? current.catalogNumber).trim();
    const effectiveCatalogMode = options?.overrideCatalogMode ?? current.catalogMatchMode;
    const effectiveDateFrom = (options?.overrideDateFrom ?? current.dateFrom).trim();
    const effectiveDateTo = (options?.overrideDateTo ?? current.dateTo).trim();
    const effectiveSortBy = options?.overrideSortBy ?? current.sortBy;
    const effectiveSortOrder = options?.overrideSortOrder ?? current.sortOrder;

    // The form is a draft. A cursor only belongs to the query that produced
    // the currently displayed results, never to subsequent draft edits.
    const query: SearchMediaInput = isAppend
      ? this.committedQuery!
      : {
          text: effectiveKeyword || undefined,
          catalogNumber: effectiveCatalog || undefined,
          catalogMatchMode: effectiveCatalogMode,
          tagIds: effectiveTagIds.length > 0 ? effectiveTagIds : undefined,
          dateFrom: effectiveDateFrom || undefined,
          dateTo: effectiveDateTo || undefined,
          sortBy: effectiveSortBy,
          sortOrder: effectiveSortOrder,
          limit: 50,
        };

    try {
      const res = await callbacks.searchMedia({
        ...query,
        cursor: isAppend ? options?.cursor : undefined,
      });
      if (requestId !== this.requestSeq) return;

      if (res.ok) {
        this.committedQuery = query;
        callbacks.onResult(res.value, isAppend);
      } else {
        callbacks.onError(res.error.message || callbacks.fallbackRpcError());
      }
    } catch (err) {
      if (requestId === this.requestSeq) {
        callbacks.onError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (requestId === this.requestSeq) {
        this.appending = false;
        callbacks.onSearchingChange(false);
        callbacks.onLoadingMoreChange(false);
      }
    }
  }

  /**
   * Run a full refresh (status/overview/ops RPCs + tag list + search).
   * If a newer search (e.g. a sort change) starts while awaiting metadata RPCs, skip the trailing
   * search so the refresh cannot issue a stale query or clobber the newer search's state.
   */
  public async refreshAll(params: {
    readonly loadMetadata: () => Promise<void>;
    readonly loadTags: (queryText: string) => Promise<void>;
    readonly searchCallbacks: SearchCoordinatorCallbacks;
  }): Promise<{ readonly searchSkippedDueToNewerRequest: boolean }> {
    const requestBeforeWait = this.requestSeq;
    const refreshId = ++this.refreshSeq;
    params.searchCallbacks.onSearchingChange(true);
    params.searchCallbacks.onError(null);
    let searchStarted = false;
    try {
      await params.loadMetadata();
      const tagsPromise = params.loadTags(this.draft.tagSearchInput);
      if (this.requestSeq !== requestBeforeWait) {
        await tagsPromise;
        return { searchSkippedDueToNewerRequest: true };
      }
      searchStarted = true;
      await Promise.all([tagsPromise, this.executeSearch(params.searchCallbacks)]);
      return { searchSkippedDueToNewerRequest: false };
    } catch (err) {
      if (this.requestSeq === requestBeforeWait && refreshId === this.refreshSeq) {
        params.searchCallbacks.onError(err instanceof Error ? err.message : String(err));
      }
      return { searchSkippedDueToNewerRequest: this.requestSeq !== requestBeforeWait };
    } finally {
      if (!searchStarted && this.requestSeq === requestBeforeWait && refreshId === this.refreshSeq) {
        params.searchCallbacks.onSearchingChange(false);
      }
    }
  }
}
