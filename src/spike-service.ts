import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import {
  openNativeAssociatedPath,
  revealNativePath,
} from '@deepseek-ai/dsh-native-command';
import { collectDatabaseTableCounts } from './db/backup.ts';
import {
  getCurrentSchemaVersion,
  migrateDatabase,
  openMediaLibraryDatabase,
} from './db/schema.ts';
import { importTagStudioDatabase, type TagStudioImportReport } from './import/tagstudio-importer.ts';
import {
  getMediaDetailInDatabase,
  listTagsInDatabase,
  searchMediaInDatabase,
} from './search/search-repository.ts';
import type {
  GetMediaInput,
  ImportTagStudioInput,
  ImportTagStudioResult,
  LibraryOverview,
  ListTagsInput,
  ListTagsResult,
  M1TestMediaItem,
  MediaActionErrorCode,
  MediaActionResult,
  MediaDetailItem,
  MediaFileStatus,
  MediaRootConfig,
  SearchMediaInput,
  SearchMediaResult,
  SpikeStatus,
} from './types.ts';
import {
  normalizeCanonicalUncRoot,
  resolveAllowlistedUncPath,
} from './unc-path.ts';

export const DEFAULT_M1_ROOT_ID = 'nas-main';

const LONG_SUBDIR_A =
  'Archive_Segment_Alpha_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJ';
const LONG_SUBDIR_B =
  'Archive_Segment_Beta_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJK';
const LONG_SUBDIR_C =
  'Archive_Segment_Gamma_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123456789_ABCDEFGHIJ';

export const DEFAULT_M1_TEST_ITEMS: readonly M1TestMediaItem[] = [
  {
    mediaId: 'm1-basic-mkv',
    rootId: DEFAULT_M1_ROOT_ID,
    relativePath: 'movies\\sample-basic.mkv',
    label: 'Basic ASCII path (.mkv)',
    scenario: 'basic',
  },
  {
    mediaId: 'm1-spaces-mp4',
    rootId: DEFAULT_M1_ROOT_ID,
    relativePath: 'movies\\Folder With Spaces\\Sample Video With Spaces.mp4',
    label: 'Path containing spaces (.mp4)',
    scenario: 'spaces',
  },
  {
    mediaId: 'm1-cjk-mkv',
    rootId: DEFAULT_M1_ROOT_ID,
    relativePath: '动画归档\\测试目录\\中文文件名测试_01.mkv',
    label: 'Chinese / CJK directory and filename (.mkv)',
    scenario: 'cjk',
  },
  {
    mediaId: 'm1-comma-mkv',
    rootId: DEFAULT_M1_ROOT_ID,
    relativePath: 'movies\\director, cut\\part 1, scene 2 [1080p].mkv',
    label: 'Path containing commas (explorer.exe /select, hazards)',
    scenario: 'comma',
  },
  {
    mediaId: 'm1-long-path-mkv',
    rootId: DEFAULT_M1_ROOT_ID,
    relativePath: `${LONG_SUBDIR_A}\\${LONG_SUBDIR_B}\\${LONG_SUBDIR_C}\\deeply_nested_long_unc_path_sample_video_exceeding_260_characters.mkv`,
    label: 'Long UNC path (> 260 characters)',
    scenario: 'long_path',
  },
  {
    mediaId: 'm1-missing-file',
    rootId: DEFAULT_M1_ROOT_ID,
    relativePath: 'movies\\__non_existent_m1_spike_target__.mkv',
    label: 'Missing target file (structured error check)',
    scenario: 'missing_file',
  },
];

export interface NativeOpener {
  openPath(targetPath: string): Promise<void>;
  revealPath(targetPath: string): Promise<void>;
}

export interface FileProbeResult {
  readonly ok: boolean;
  readonly code?: 'FILE_NOT_FOUND' | 'NAS_OFFLINE_OR_TIMEOUT' | 'PERMISSION_DENIED';
  readonly message?: string;
}

export type FileProbeFn = (
  resolvedUncPath: string,
  timeoutMs: number,
) => Promise<FileProbeResult>;

export interface SpikeOverrideFileSchema {
  readonly uncRoot?: string;
  readonly tagstudioCopyPath?: string;
  readonly roots?: readonly MediaRootConfig[];
  readonly items?: readonly M1TestMediaItem[];
}

export interface SpikeServiceOptions {
  readonly baseDir?: string | undefined;
  readonly dataDirName?: string | undefined;
  readonly dbPath?: string | undefined;
  readonly configuredUncRoot?: string | (() => string) | undefined;
  readonly configuredTagStudioCopyPath?: string | (() => string) | undefined;
  readonly probeTimeoutMs?: number | undefined;
  readonly roots?: readonly MediaRootConfig[] | undefined;
  readonly items?: readonly M1TestMediaItem[] | undefined;
  readonly opener?: NativeOpener | undefined;
  readonly fileProbe?: FileProbeFn | undefined;
}

export function resolveLocalDataDir(baseDir?: string, dataDirName = 'media-library'): string {
  const effectiveBase =
    baseDir?.trim() ||
    process.env.DSH_HOME?.trim() ||
    path.join(os.homedir(), '.dsh');
  return path.resolve(effectiveBase, dataDirName);
}

export function probeNodeSqliteBuiltIn(): boolean {
  try {
    const getBuiltin = (
      process as NodeJS.Process & {
        getBuiltinModule?: (id: string) => unknown;
      }
    ).getBuiltinModule;
    if (typeof getBuiltin !== 'function') {
      return false;
    }
    const mod = getBuiltin('node:sqlite') as { DatabaseSync?: unknown } | undefined;
    return Boolean(mod && typeof mod.DatabaseSync === 'function');
  } catch {
    return false;
  }
}

export const defaultNativeOpener: NativeOpener = {
  async openPath(targetPath: string): Promise<void> {
    await openNativeAssociatedPath(targetPath, AbortSignal.timeout(10_000));
  },
  async revealPath(targetPath: string): Promise<void> {
    await revealNativePath(targetPath, AbortSignal.timeout(10_000));
  },
};

export async function defaultUncFileProbe(
  resolvedUncPath: string,
  timeoutMs: number,
): Promise<FileProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const statPromise = fs.promises.stat(resolvedUncPath);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const timeoutErr = new Error(
          `Timed out after ${timeoutMs}ms while probing NAS path: ${resolvedUncPath}`,
        ) as NodeJS.ErrnoException;
        timeoutErr.code = 'ETIMEDOUT';
        reject(timeoutErr);
      }, timeoutMs);
    });
    const stats = await Promise.race([statPromise, timeoutPromise]);
    if (!stats.isFile()) {
      return {
        ok: false,
        code: 'FILE_NOT_FOUND',
        message: `Target UNC path is not a regular file: ${resolvedUncPath}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return classifyFsError(error, resolvedUncPath);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function classifyFsError(
  error: unknown,
  resolvedUncPath: string,
): {
  ok: false;
  code: 'FILE_NOT_FOUND' | 'NAS_OFFLINE_OR_TIMEOUT' | 'PERMISSION_DENIED';
  message: string;
} {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code ?? '';
  const rawMessage = error instanceof Error ? error.message : String(error);

  if (errno === 'EACCES' || errno === 'EPERM') {
    return {
      ok: false,
      code: 'PERMISSION_DENIED',
      message: `Access denied on SMB share for path '${resolvedUncPath}': ${rawMessage}`,
    };
  }

  if (
    errno === 'ETIMEDOUT' ||
    errno === 'EHOSTUNREACH' ||
    errno === 'ENETUNREACH' ||
    errno === 'ECONNREFUSED' ||
    errno === 'ECONNRESET' ||
    errno === 'EBUSY' ||
    errno === 'EIO'
  ) {
    return {
      ok: false,
      code: 'NAS_OFFLINE_OR_TIMEOUT',
      message: `NAS share is unreachable or timed out for '${resolvedUncPath}' (${errno}): ${rawMessage}`,
    };
  }

  if (errno === 'ENOENT' || errno === 'ENOTDIR') {
    return {
      ok: false,
      code: 'FILE_NOT_FOUND',
      message: `File not found at '${resolvedUncPath}': ${rawMessage}`,
    };
  }

  if (errno === 'UNKNOWN' && /network|unc|share|host/i.test(rawMessage)) {
    return {
      ok: false,
      code: 'NAS_OFFLINE_OR_TIMEOUT',
      message: `Windows SMB network path unreachable for '${resolvedUncPath}': ${rawMessage}`,
    };
  }

  return {
    ok: false,
    code: 'FILE_NOT_FOUND',
    message: `Unable to access target file '${resolvedUncPath}' (${errno || 'ERROR'}): ${rawMessage}`,
  };
}

export class MediaLibrarySpikeService {
  private readonly localDataDir: string;
  private readonly localDatabasePath: string;
  private readonly spikeOverridePath: string;
  private configuredUncRoot: string | (() => string);
  private configuredTagStudioCopyPath: string | (() => string);
  private readonly probeTimeoutMs: number;
  private readonly explicitRoots: readonly MediaRootConfig[] | undefined;
  private readonly explicitItems: readonly M1TestMediaItem[] | undefined;
  private readonly opener: NativeOpener;
  private readonly fileProbe: FileProbeFn;
  private initialization: Promise<void> | undefined;

  constructor(options: SpikeServiceOptions = {}) {
    this.localDataDir = resolveLocalDataDir(options.baseDir, options.dataDirName ?? 'media-library');
    this.localDatabasePath = options.dbPath
      ? path.resolve(options.dbPath)
      : path.join(this.localDataDir, 'library.sqlite3');
    this.spikeOverridePath = path.join(this.localDataDir, 'm1-spike.json');
    this.configuredUncRoot = options.configuredUncRoot ?? '\\\\NAS\\MediaTest';
    this.configuredTagStudioCopyPath = options.configuredTagStudioCopyPath ?? '';
    this.probeTimeoutMs = options.probeTimeoutMs ?? 5000;
    this.explicitRoots = options.roots;
    this.explicitItems = options.items;
    this.opener = options.opener ?? defaultNativeOpener;
    this.fileProbe = options.fileProbe ?? defaultUncFileProbe;
  }

  private readConfiguredUncRoot(): string {
    return typeof this.configuredUncRoot === 'function'
      ? this.configuredUncRoot()
      : this.configuredUncRoot;
  }

  private readConfiguredTagStudioCopyPath(): string {
    return typeof this.configuredTagStudioCopyPath === 'function'
      ? this.configuredTagStudioCopyPath()
      : this.configuredTagStudioCopyPath;
  }

  private readLocalOverrideFile(): SpikeOverrideFileSchema | null {
    try {
      if (!fs.existsSync(this.spikeOverridePath)) {
        return null;
      }
      const raw = fs.readFileSync(this.spikeOverridePath, 'utf8');
      const parsed = JSON.parse(raw) as SpikeOverrideFileSchema;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  initialize(): Promise<void> {
    // Share startup work across concurrent overview/tag/search RPCs. Do not keep
    // a live connection: the importer and backup/restore own separate lifetimes.
    this.initialization ??= (async () => {
      const { db, dbPath } = openMediaLibraryDatabase({ dbPath: this.localDatabasePath });
      try {
        await migrateDatabase(db, { dbPath });
      } finally {
        db.close();
      }
    })().catch((error) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  private async withInitializedDatabase<T>(fn: (db: DatabaseSync) => T): Promise<T> {
    await this.initialize();
    const { db } = openMediaLibraryDatabase({ dbPath: this.localDatabasePath });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  getEffectiveRootsAndItems(): {
    activeUncRoot: string;
    hasRootAllowlistOverride: boolean;
    defaultTagStudioSourcePath: string;
    roots: readonly MediaRootConfig[];
    items: readonly M1TestMediaItem[];
  } {
    const override = this.readLocalOverrideFile();
    const rawUncRoot =
      override?.uncRoot?.trim() || this.readConfiguredUncRoot().trim() || '\\\\NAS\\MediaTest';
    const normalizedRoot = normalizeCanonicalUncRoot(rawUncRoot);
    const activeUncRoot = normalizedRoot.ok ? normalizedRoot.canonicalRoot : rawUncRoot;

    const defaultTagStudioSourcePath =
      override?.tagstudioCopyPath?.trim() ||
      this.readConfiguredTagStudioCopyPath().trim() ||
      '';

    const roots: readonly MediaRootConfig[] =
      this.explicitRoots ??
      override?.roots ?? [
        {
          rootId: DEFAULT_M1_ROOT_ID,
          label: 'Primary Synology NAS Media Share',
          canonicalUncRoot: activeUncRoot,
          enabled: true,
        },
      ];

    const items: readonly M1TestMediaItem[] =
      this.explicitItems ?? override?.items ?? [...DEFAULT_M1_TEST_ITEMS];

    return {
      activeUncRoot,
      hasRootAllowlistOverride: this.explicitRoots !== undefined || override?.roots !== undefined,
      defaultTagStudioSourcePath,
      roots,
      items,
    };
  }

  getSpikeStatus(): SpikeStatus {
    const { activeUncRoot, roots, items } = this.getEffectiveRootsAndItems();
    return {
      platform: process.platform,
      nodeVersion: process.version,
      nodeSqliteAvailable: probeNodeSqliteBuiltIn(),
      localDataDir: this.localDataDir,
      localDatabasePath: this.localDatabasePath,
      spikeOverridePath: this.spikeOverridePath,
      activeUncRoot,
      roots,
      items,
    };
  }

  async getLibraryOverview(): Promise<LibraryOverview> {
    const { activeUncRoot, defaultTagStudioSourcePath } = this.getEffectiveRootsAndItems();
    const databaseExists = fs.existsSync(this.localDatabasePath);

    return this.withInitializedDatabase((db) => {
      const schemaVersion = getCurrentSchemaVersion(db);
      const counts = collectDatabaseTableCounts(db);

      const lastRunRow = db
        .prepare(
          `SELECT finished_at, status, source_fingerprint, report_json
           FROM import_runs
           ORDER BY id DESC
           LIMIT 1`,
        )
        .get() as
        | {
            finished_at: string;
            status: string;
            source_fingerprint: string;
            report_json: string;
          }
        | undefined;

      let lastImport: LibraryOverview['lastImport'] = null;
      if (lastRunRow) {
        try {
          const parsed = JSON.parse(lastRunRow.report_json) as TagStudioImportReport;
          lastImport = {
            finishedAt: String(lastRunRow.finished_at),
            status: String(lastRunRow.status),
            sourceFingerprint: String(lastRunRow.source_fingerprint),
            importedEntries: parsed.reconciliation.entries.importedEntries,
            skippedSidecarEntries: parsed.reconciliation.entries.skippedSidecarEntries,
            importedTags: parsed.reconciliation.tags.importedTags,
          };
        } catch {
          lastImport = {
            finishedAt: String(lastRunRow.finished_at),
            status: String(lastRunRow.status),
            sourceFingerprint: String(lastRunRow.source_fingerprint),
            importedEntries: counts.mediaFiles,
            skippedSidecarEntries: 0,
            importedTags: counts.tags,
          };
        }
      }

      return {
        databasePath: this.localDatabasePath,
        databaseExists,
        schemaVersion,
        activeUncRoot,
        defaultTagStudioSourcePath,
        counts: {
          mediaFiles: counts.mediaFiles,
          tags: counts.tags,
          tagAliases: counts.tagAliases,
          mediaTags: counts.mediaTags,
          importRuns: counts.importRuns,
        },
        lastImport,
      };
    });
  }

  async listTags(input?: ListTagsInput): Promise<ListTagsResult> {
    return this.withInitializedDatabase((db) => listTagsInDatabase(db, input));
  }

  async searchMedia(input?: SearchMediaInput): Promise<SearchMediaResult> {
    const start = performance.now();
    const result = await this.withInitializedDatabase((db) => searchMediaInDatabase(db, input));
    return { ...result, elapsedMs: Number((performance.now() - start).toFixed(2)) };
  }

  async getMedia(input: GetMediaInput): Promise<MediaDetailItem | null> {
    return this.withInitializedDatabase((db) => getMediaDetailInDatabase(db, input.mediaId));
  }

  async importTagStudioCopy(input?: ImportTagStudioInput): Promise<ImportTagStudioResult> {
    const { activeUncRoot, defaultTagStudioSourcePath } = this.getEffectiveRootsAndItems();
    const sourceDbPath = input?.sourceDbPath?.trim() || defaultTagStudioSourcePath;
    if (!sourceDbPath) {
      return {
        ok: false,
        status: 'failed',
        message: 'TagStudio read-only source path is required.',
        importedEntries: 0,
        skippedSidecarEntries: 0,
        importedTags: 0,
        importedMediaTags: 0,
        sourceSha256: '',
      };
    }

    const uncRoot = input?.uncRoot?.trim() || activeUncRoot;
    try {
      await this.initialize();
      const report = await importTagStudioDatabase({
        sourceDbPath,
        targetDbPath: this.localDatabasePath,
        mode: 'import',
        rootId: DEFAULT_M1_ROOT_ID,
        canonicalUncRoot: uncRoot,
        force: input?.force ?? false,
      });

      return {
        ok: true,
        status: report.status,
        message:
          report.status === 'already_imported'
            ? `Already imported (SHA-256: ${report.source.sha256Before.slice(0, 12)}...).`
            : `Imported ${report.reconciliation.entries.importedEntries} media files and ${report.reconciliation.tags.importedTags} tags (skipped ${report.reconciliation.entries.skippedSidecarEntries} sidecar files).`,
        importedEntries: report.reconciliation.entries.importedEntries,
        skippedSidecarEntries: report.reconciliation.entries.skippedSidecarEntries,
        importedTags: report.reconciliation.tags.importedTags,
        importedMediaTags: report.reconciliation.tagEntries.importedMediaTags,
        sourceSha256: report.source.sha256After,
      };
    } catch (error) {
      return {
        ok: false,
        status: 'failed',
        message: error instanceof Error ? error.message : String(error),
        importedEntries: 0,
        skippedSidecarEntries: 0,
        importedTags: 0,
        importedMediaTags: 0,
        sourceSha256: '',
      };
    }
  }

  async openMedia(mediaId: string): Promise<MediaActionResult> {
    return this.executeMediaAction('open', mediaId);
  }

  async revealMedia(mediaId: string): Promise<MediaActionResult> {
    return this.executeMediaAction('reveal', mediaId);
  }

  private resolveTargetFromDatabaseOrSpike(trimmedId: string): {
    readonly found: boolean;
    readonly numericDbId: number | null;
    readonly mediaId: string;
    readonly rootId: string;
    readonly relativePath: string;
    readonly roots: readonly MediaRootConfig[];
  } {
    const { activeUncRoot, hasRootAllowlistOverride, roots: defaultRoots, items } = this.getEffectiveRootsAndItems();

    // 1. Check if trimmedId is a numeric database media_files.id (`"1"`, `"2554"`, etc.)
    if (/^\d+$/.test(trimmedId)) {
      const numericId = Number(trimmedId);
      if (Number.isSafeInteger(numericId) && numericId > 0 && fs.existsSync(this.localDatabasePath)) {
        const { db } = openMediaLibraryDatabase({ dbPath: this.localDatabasePath });
        try {
          const tableExists = db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media_files'")
            .get();
          if (tableExists) {
            const row = db
              .prepare(
                `SELECT
                   mf.id,
                   mf.root_id,
                   mf.relative_path,
                   mr.name AS root_label,
                   mr.canonical_unc_root AS db_unc_root,
                   mr.enabled AS root_enabled
                 FROM media_files mf
                 LEFT JOIN media_roots mr ON mr.id = mf.root_id
                 WHERE mf.id = ?`,
              )
              .get(numericId) as
              | {
                  id: number;
                  root_id: string;
                  relative_path: string;
                  root_label: string | null;
                  db_unc_root: string | null;
                  root_enabled: number | null;
                }
              | undefined;

            if (row) {
              // A Host allowlist (including an empty list) always wins over DB
              // mappings. Database roots are only the fallback when none is set.
              let effectiveRoots = defaultRoots;
              if (!hasRootAllowlistOverride && row.db_unc_root !== null) {
                const useConfiguredRoot =
                  activeUncRoot !== '\\\\NAS\\MediaTest' && activeUncRoot !== '\\\\NAS\\Media';
                effectiveRoots = [
                  {
                    rootId: String(row.root_id),
                    label: row.root_label ? String(row.root_label) : 'Synology NAS Media',
                    canonicalUncRoot: useConfiguredRoot ? activeUncRoot : String(row.db_unc_root),
                    enabled: row.root_enabled !== null ? Boolean(row.root_enabled) : true,
                  },
                ];
              }
              return {
                found: true,
                numericDbId: numericId,
                mediaId: String(numericId),
                rootId: String(row.root_id),
                relativePath: String(row.relative_path),
                roots: effectiveRoots.map((root) => root.rootId === row.root_id
                  ? { ...root, enabled: root.enabled && row.root_enabled === 1 }
                  : root),
              };
            }
          }
        } finally {
          db.close();
        }
      }
    }

    // 2. Fallback to M1 spike test items (`m1-basic-mkv`, etc.)
    const spikeItem = items.find((entry) => entry.mediaId === trimmedId);
    if (spikeItem) {
      return {
        found: true,
        numericDbId: null,
        mediaId: spikeItem.mediaId,
        rootId: spikeItem.rootId,
        relativePath: spikeItem.relativePath,
        roots: defaultRoots,
      };
    }

    return {
      found: false,
      numericDbId: null,
      mediaId: trimmedId,
      rootId: '',
      relativePath: '',
      roots: defaultRoots,
    };
  }

  private persistMediaStatusIfInDb(
    numericDbId: number | null,
    status: MediaFileStatus,
  ): void {
    if (numericDbId === null || !fs.existsSync(this.localDatabasePath)) {
      return;
    }
    try {
      const { db } = openMediaLibraryDatabase({ dbPath: this.localDatabasePath });
      try {
        db.prepare('UPDATE media_files SET status = ? WHERE id = ?').run(status, numericDbId);
      } finally {
        db.close();
      }
    } catch {
      // Best-effort status update
    }
  }

  private async executeMediaAction(
    action: 'open' | 'reveal',
    mediaId: string,
  ): Promise<MediaActionResult> {
    const startMs = Date.now();
    const trimmedId = typeof mediaId === 'string' ? mediaId.trim() : '';

    // Strictly reject raw UNC paths or path traversal strings passed as mediaId (`B4`)
    if (
      !trimmedId ||
      trimmedId.includes('\\') ||
      trimmedId.includes('/') ||
      trimmedId.includes('..') ||
      trimmedId.includes(':')
    ) {
      return {
        ok: false,
        mediaId: trimmedId,
        action,
        code: 'UNKNOWN_MEDIA_ID',
        message: `Unknown mediaId '${trimmedId}'. Client may only request registered mediaIds.`,
        elapsedMs: Date.now() - startMs,
      };
    }

    if (/^\d+$/.test(trimmedId) && fs.existsSync(this.localDatabasePath)) {
      await this.initialize();
    }
    const target = this.resolveTargetFromDatabaseOrSpike(trimmedId);
    if (!target.found) {
      return {
        ok: false,
        mediaId: trimmedId,
        action,
        code: 'UNKNOWN_MEDIA_ID',
        message: `Unknown mediaId '${trimmedId}'. Client may only request registered mediaIds.`,
        elapsedMs: Date.now() - startMs,
      };
    }

    const resolution = resolveAllowlistedUncPath(
      target.roots,
      target.rootId,
      target.relativePath,
    );
    if (!resolution.ok) {
      if (['UNMAPPED_ROOT', 'DISABLED_ROOT', 'INVALID_UNC_ROOT'].includes(resolution.code)) {
        this.persistMediaStatusIfInDb(target.numericDbId, 'unmapped');
      }
      return {
        ok: false,
        mediaId: target.mediaId,
        action,
        code: resolution.code,
        message: resolution.message,
        elapsedMs: Date.now() - startMs,
      };
    }

    const { resolvedUncPath } = resolution;

    const probe = await this.fileProbe(resolvedUncPath, this.probeTimeoutMs);
    if (!probe.ok) {
      const code: MediaActionErrorCode = probe.code ?? 'FILE_NOT_FOUND';
      if (code === 'FILE_NOT_FOUND') {
        this.persistMediaStatusIfInDb(target.numericDbId, 'missing');
      } else if (code === 'NAS_OFFLINE_OR_TIMEOUT') {
        this.persistMediaStatusIfInDb(target.numericDbId, 'offline');
      } else if (code === 'PERMISSION_DENIED') {
        this.persistMediaStatusIfInDb(target.numericDbId, 'permission_denied');
      }
      return {
        ok: false,
        mediaId: target.mediaId,
        action,
        code,
        message: probe.message ?? `Target file probe failed: ${resolvedUncPath}`,
        resolvedUncPath,
        elapsedMs: Date.now() - startMs,
      };
    }

    this.persistMediaStatusIfInDb(target.numericDbId, 'indexed');

    try {
      if (action === 'open') {
        await this.opener.openPath(resolvedUncPath);
      } else {
        await this.opener.revealPath(resolvedUncPath);
      }
      return {
        ok: true,
        mediaId: target.mediaId,
        action,
        resolvedUncPath,
        elapsedMs: Date.now() - startMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        mediaId: target.mediaId,
        action,
        code: 'OPENER_FAILED',
        message: `Native ${action} command failed for '${resolvedUncPath}': ${message}`,
        resolvedUncPath,
        elapsedMs: Date.now() - startMs,
      };
    }
  }
}
