import { normalizeLabel } from './mutations/transaction.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import {
  openNativeAssociatedPath,
  revealNativePath,
} from '@deepseek-ai/dsh-native-command';
import { collectDatabaseTableCounts } from './db/backup.ts';
import {
  createOperationalBackup,
  DEFAULT_DAILY_BACKUP_RETENTION,
  DEFAULT_PRE_MIGRATE_BACKUP_RETENTION,
  exportPortableMappingReport,
  listManagedBackups,
  maybeRunDailyAutoBackup,
  readAutoBackupState,
} from './db/ops.ts';
import {
  CURRENT_SCHEMA_VERSION,
  getCurrentSchemaVersion,
  migrateDatabase,
  openMediaLibraryDatabase,
  runDatabaseHealthChecks,
} from './db/schema.ts';
import { importTagStudioDatabase, type TagStudioImportReport } from './import/tagstudio-importer.ts';
import {
  commitIngestionManifest,
  defaultIngestionFileOps,
  ensureManifestForStagingFile,
  fetchMetadataForManifest,
  finishIngestionTask,
  findManifestTask,
  listFrozenIngestionManifests,
  updateIngestionPhase,
  type IngestionFileOps,
  listIngestionManifests,
  listIngestionTasks,
  markInterruptedIngestionTasks,
  MetadataFetcher,
  normalizeTargetSubdir,
  reconcileIngestionManifests,
  reviewIngestionManifest,
  scanStagingDirectory,
  softDeleteStagingFile,
  startIngestionTask,
} from './ingestion/index.ts';
import {
  addAlias,
  archiveTag,
  createTag,
  mergeTags,
  previewMerge,
  removeAlias,
  renameTag,
  restoreTag,
  setMediaTags,
} from './mutations/index.ts';
import {
  deletePerformerAlias,
  evaluateManifestPerformers,
  listPerformerAliases,
  listPerformerReviewQueue,
  normalizePerformerName,
  promotePerformerTagToManual,
  resolvePerformerReview,
  upsertPerformerAlias,
} from './performers/index.ts';
import {
  getMediaDetailInDatabase,
  listTagsInDatabase,
  searchMediaInDatabase,
} from './search/search-repository.ts';
import type {
  AliasInput,
  CommitIngestionInput,
  CommitIngestionResult,
  CreateBackupInput,
  CreateBackupResult,
  DeleteStagingFileInput,
  DeleteStagingFileResult,
  CreateTagInput,
  DegradedModeState,
  DeletePerformerAliasInput,
  DeletePerformerAliasResult,
  ExportMappingReportInput,
  ExportMappingReportResult,
  FetchedMetadataCandidate,
  FetchIngestionMetadataInput,
  GetMediaInput,
  ImportTagStudioInput,
  ImportTagStudioResult,
  IngestionManifest,
  IngestionTask,
  LibraryOverview,
  ListPerformerReviewInput,
  ListTagsInput,
  ListTagsResult,
  M1TestMediaItem,
  ManifestPerformerPreview,
  MediaActionErrorCode,
  MediaActionResult,
  MediaDetailItem,
  MediaFileStatus,
  MediaRootConfig,
  MergePreviewResult,
  MergeTagsInput,
  MergeTagsResult,
  MutationError,
  OpenStagingFileInput,
  OpsStatus,
  PerformerAliasRecord,
  PerformerReviewItem,
  PreviewManifestPerformersInput,
  PreviewMergeInput,
  PromotePerformerTagInput,
  PromotePerformerTagResult,
  ReconcileIngestionResult,
  RenameTagInput,
  ResolvePerformerReviewInput,
  ResolvePerformerReviewResult,
  ReviewIngestionInput,
  ReviewIngestionResult,
  ScanStagingResult,
  SearchMediaInput,
  SearchMediaResult,
  SetMediaTagsInput,
  SetMediaTagsResult,
  SpikeStatus,
  TagMutationResult,
  TagRevisionInput,
  UpsertPerformerAliasInput,
  UpsertPerformerAliasResult,
} from './types.ts';
import {
  normalizeCanonicalUncRoot,
  resolveAllowlistedUncPath,
} from './unc-path.ts';

// Config/plugin replacement can create a second service while old async I/O is still alive.
// Keep process-local ownership across module reloads; a true Host restart starts with an empty registry.
const LIVE_TASKS_KEY = Symbol.for('dsh-media-library.live-ingestion-tasks');
const FILE_EXECUTION_KEY = Symbol.for('dsh-media-library.file-ingestion-execution');
const STAGING_MANIFEST_OPS_KEY = Symbol.for('dsh-media-library.staging-manifest-ops');
const DAILY_BACKUP_IN_FLIGHT_KEY = Symbol.for('dsh-media-library.daily-backup-in-flight');
const hostRuntime = globalThis as typeof globalThis & {
  [LIVE_TASKS_KEY]?: Map<string, Set<number>>;
  [FILE_EXECUTION_KEY]?: { databasePath: string; task: IngestionTask; isStagingDelete?: boolean };
  [STAGING_MANIFEST_OPS_KEY]?: Map<string, number>;
  [DAILY_BACKUP_IN_FLIGHT_KEY]?: Map<string, Promise<void>>;
};
const liveIngestionTasks = hostRuntime[LIVE_TASKS_KEY] ??= new Map<string, Set<number>>();
const stagingManifestOpsInFlight = hostRuntime[STAGING_MANIFEST_OPS_KEY] ??= new Map<string, number>();
const dailyBackupInFlightByDb = hostRuntime[DAILY_BACKUP_IN_FLIGHT_KEY] ??= new Map<string, Promise<void>>();

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
  readonly configuredNasBackupDir?: string | (() => string) | undefined;
  readonly configuredStagingDir?: string | (() => string) | undefined;
  readonly configuredTargetSubdir?: string | (() => string) | undefined;
  readonly cmadbBaseUrl?: string | undefined;
  readonly ppvdbBaseUrl?: string | undefined;
  readonly configuredCmadbCookie?: string | (() => string) | undefined;
  readonly configuredPpvdbCookie?: string | (() => string) | undefined;
  readonly metadataFetcher?: MetadataFetcher | undefined;
  readonly allowCrossDeviceCopy?: boolean | undefined;
  readonly ingestionFileOps?: IngestionFileOps | undefined;
  readonly backupRetentionCount?: number | undefined;
  readonly preMigrateRetentionCount?: number | undefined;
  readonly autoDailyBackup?: boolean | undefined;
  readonly supportedMaxVersion?: number | undefined;
  readonly now?: (() => Date) | undefined;
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
  private readonly backupDir: string;
  private readonly spikeOverridePath: string;
  private configuredUncRoot: string | (() => string);
  private configuredTagStudioCopyPath: string | (() => string);
  private configuredNasBackupDir: string | (() => string);
  private configuredStagingDir: string | (() => string);
  private configuredTargetSubdir: string | (() => string);
  private readonly cmadbBaseUrl: string;
  private readonly ppvdbBaseUrl: string;
  private configuredCmadbCookie: string | (() => string);
  private configuredPpvdbCookie: string | (() => string);
  private readonly explicitFetcher: MetadataFetcher | undefined;
  private readonly allowCrossDeviceCopy: boolean;
  private readonly ingestionFileOps: IngestionFileOps;
  private readonly backupRetentionCount: number;
  private readonly preMigrateRetentionCount: number;
  private readonly autoDailyBackup: boolean;
  private readonly supportedMaxVersion: number;
  private readonly now: () => Date;
  private readonly probeTimeoutMs: number;
  private readonly explicitRoots: readonly MediaRootConfig[] | undefined;
  private readonly explicitItems: readonly M1TestMediaItem[] | undefined;
  private readonly opener: NativeOpener;
  private readonly fileProbe: FileProbeFn;
  private initialization: Promise<void> | undefined;
  private degradedState: DegradedModeState = {
    degraded: false,
    reason: null,
    schemaVersion: 0,
    supportedMaxVersion: CURRENT_SCHEMA_VERSION,
    healthOk: true,
    checkedAt: new Date(0).toISOString(),
  };

  constructor(options: SpikeServiceOptions = {}) {
    this.localDataDir = resolveLocalDataDir(options.baseDir, options.dataDirName ?? 'media-library');
    this.localDatabasePath = options.dbPath
      ? path.resolve(options.dbPath)
      : path.join(this.localDataDir, 'library.sqlite3');
    this.backupDir = path.join(path.dirname(this.localDatabasePath), 'backups');
    this.spikeOverridePath = path.join(this.localDataDir, 'm1-spike.json');
    this.configuredUncRoot = options.configuredUncRoot ?? '\\\\NAS\\MediaTest';
    this.configuredTagStudioCopyPath = options.configuredTagStudioCopyPath ?? '';
    this.configuredNasBackupDir = options.configuredNasBackupDir ?? '';
    this.configuredStagingDir = options.configuredStagingDir ?? '';
    this.configuredTargetSubdir = options.configuredTargetSubdir ?? 'ingested';
    this.cmadbBaseUrl = options.cmadbBaseUrl ?? 'https://fc2cmadb.com';
    this.ppvdbBaseUrl = options.ppvdbBaseUrl ?? 'https://fc2ppvdb.com';
    this.configuredCmadbCookie = options.configuredCmadbCookie ?? '';
    this.configuredPpvdbCookie = options.configuredPpvdbCookie ?? '';
    this.explicitFetcher = options.metadataFetcher;
    this.allowCrossDeviceCopy = options.allowCrossDeviceCopy ?? false;
    this.ingestionFileOps = options.ingestionFileOps ?? defaultIngestionFileOps;
    this.backupRetentionCount = Math.max(1, options.backupRetentionCount ?? DEFAULT_DAILY_BACKUP_RETENTION);
    this.preMigrateRetentionCount = Math.max(1, options.preMigrateRetentionCount ?? DEFAULT_PRE_MIGRATE_BACKUP_RETENTION);
    this.autoDailyBackup = options.autoDailyBackup ?? true;
    this.supportedMaxVersion = options.supportedMaxVersion ?? CURRENT_SCHEMA_VERSION;
    this.now = options.now ?? (() => new Date());
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

  private readConfiguredNasBackupDir(): string {
    return typeof this.configuredNasBackupDir === 'function'
      ? this.configuredNasBackupDir()
      : this.configuredNasBackupDir;
  }

  private readStringSetting(value: string | (() => string)): string {
    return typeof value === 'function' ? value() : value;
  }

  private createMetadataFetcher(): MetadataFetcher {
    if (this.explicitFetcher) return this.explicitFetcher;
    return new MetadataFetcher({
      cmadbBaseUrl: this.cmadbBaseUrl,
      ppvdbBaseUrl: this.ppvdbBaseUrl,
      cmadbCookie: this.readStringSetting(this.configuredCmadbCookie),
      ppvdbCookie: this.readStringSetting(this.configuredPpvdbCookie),
    });
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

  private makeDegradedMutationError(): MutationError {
    return {
      ok: false,
      code: 'READ_ONLY_DEGRADED',
      message: this.degradedState.reason ?? 'Database is in read-only degraded mode.',
      failures: [],
    };
  }

  initialize(): Promise<void> {
    // Share startup work across concurrent overview/tag/search RPCs. Do not keep
    // a live connection: the importer and backup/restore own separate lifetimes.
    this.initialization ??= (async () => {
      const checkedAt = this.now().toISOString();
      const { db, dbPath } = openMediaLibraryDatabase({ dbPath: this.localDatabasePath });
      try {
        const existingVersion = getCurrentSchemaVersion(db);
        if (existingVersion > this.supportedMaxVersion) {
          this.degradedState = {
            degraded: true,
            reason: `Database schema v${existingVersion} is newer than supported v${this.supportedMaxVersion}. Entering read-only degraded mode; restore a matching backup or upgrade the plugin.`,
            schemaVersion: existingVersion,
            supportedMaxVersion: this.supportedMaxVersion,
            healthOk: true,
            checkedAt,
          };
          return;
        }

        const mig = await migrateDatabase(db, {
          dbPath,
          backupDir: this.backupDir,
          appVersion: '0.7.10',
          now: this.now,
        });
        if (!mig.health.ok) {
          this.degradedState = {
            degraded: true,
            reason: `Database integrity check failed (${JSON.stringify(mig.health.integrityCheck)}). Entering read-only degraded mode.`,
            schemaVersion: mig.currentVersion,
            supportedMaxVersion: this.supportedMaxVersion,
            healthOk: false,
            checkedAt,
          };
          return;
        }

        this.degradedState = {
          degraded: false,
          reason: null,
          schemaVersion: mig.currentVersion,
          supportedMaxVersion: this.supportedMaxVersion,
          healthOk: true,
          checkedAt,
        };

        markInterruptedIngestionTasks(db, this.now, [...(liveIngestionTasks.get(this.localDatabasePath) ?? [])]);
      } catch (err) {
        let schemaVersion = 0;
        let healthOk = false;
        try {
          schemaVersion = getCurrentSchemaVersion(db);
          healthOk = runDatabaseHealthChecks(db).ok;
        } catch {
          // Ignore follow-up probe failure.
        }
        this.degradedState = {
          degraded: true,
          reason: `Migration or startup check failed (${err instanceof Error ? err.message : String(err)}). Entering read-only degraded mode.`,
          schemaVersion,
          supportedMaxVersion: this.supportedMaxVersion,
          healthOk,
          checkedAt,
        };
      } finally {
        db.close();
      }
      await this.maybeTriggerDailyAutoBackup();
    })();
    return this.initialization;
  }

  private retainIngestionTask(db: DatabaseSync, taskId: number): void {
    const ids = liveIngestionTasks.get(this.localDatabasePath) ?? new Set<number>();
    ids.add(taskId);
    liveIngestionTasks.set(this.localDatabasePath, ids);
    const task = listIngestionTasks(db, 1, this.now).find(t => t.id === taskId);
    if (task && task.op !== 'fetch') hostRuntime[FILE_EXECUTION_KEY] = { databasePath: this.localDatabasePath, task };
  }

  private startFileIngestionTask(db: DatabaseSync, targetKey: string, op: 'commit' | 'reconcile', message: string) {
    const active = hostRuntime[FILE_EXECUTION_KEY];
    if (active) {
      const existing = { ...active.task, waitingWarning: this.now().getTime() - Date.parse(active.task.phaseStartedAt) >= 30_000 };
      return { acquired: false as const, existing };
    }
    // No await between process admission, durable acquisition and ownership registration.
    const lock = startIngestionTask(db, targetKey, op, message, this.now);
    if (lock.acquired) this.retainIngestionTask(db, lock.taskId);
    return lock;
  }

  private releaseIngestionTask(taskId: number): void {
    const ids = liveIngestionTasks.get(this.localDatabasePath);
    ids?.delete(taskId);
    if (ids?.size === 0) liveIngestionTasks.delete(this.localDatabasePath);
    const active = hostRuntime[FILE_EXECUTION_KEY];
    if (active?.databasePath === this.localDatabasePath && active.task.id === taskId) delete hostRuntime[FILE_EXECUTION_KEY];
  }

  private async withInitializedDatabase<T>(fn: (db: DatabaseSync) => T): Promise<T> {
    await this.initialize();
    const { db } = openMediaLibraryDatabase({ dbPath: this.localDatabasePath });
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  }

  private async maybeTriggerDailyAutoBackup(): Promise<void> {
    if (!this.autoDailyBackup || this.degradedState.degraded) return;
    const existing = dailyBackupInFlightByDb.get(this.localDatabasePath);
    if (existing) {
      await existing;
      return;
    }
    const run = (async () => {
      let db: DatabaseSync | null = null;
      try {
        const opened = openMediaLibraryDatabase({ dbPath: this.localDatabasePath });
        db = opened.db;
        await maybeRunDailyAutoBackup({
          db,
          dbPath: opened.dbPath,
          backupDir: this.backupDir,
          nasBackupDir: this.readConfiguredNasBackupDir(),
          dailyRetention: this.backupRetentionCount,
          preMigrateRetention: this.preMigrateRetentionCount,
          now: this.now,
        });
      } catch {
        // Daily auto-backup is best-effort operational maintenance and must not fail committed writes.
      } finally {
        try {
          db?.close();
        } catch {
          // Ignore close errors during best-effort daily auto-backup cleanup.
        }
      }
    })();
    dailyBackupInFlightByDb.set(this.localDatabasePath, run);
    try {
      await run;
    } finally {
      if (dailyBackupInFlightByDb.get(this.localDatabasePath) === run) {
        dailyBackupInFlightByDb.delete(this.localDatabasePath);
      }
    }
  }

  private async withWritableDatabase<T>(fn: (db: DatabaseSync) => T): Promise<T | MutationError> {
    await this.initialize();
    if (this.degradedState.degraded) {
      return this.makeDegradedMutationError();
    }
    const { db } = openMediaLibraryDatabase({ dbPath: this.localDatabasePath });
    let result: T;
    try {
      result = await fn(db);
    } finally {
      db.close();
    }
    await this.maybeTriggerDailyAutoBackup();
    return result;
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

  // --- Issue #5 tag / alias management: every write goes through src/mutations (single transaction,
  // revision checks, mutation_log audit). Inputs are ids and controlled strings only.

  async createTag(input: CreateTagInput): Promise<TagMutationResult> {
    return this.withWritableDatabase((db) => createTag(db, input));
  }

  async renameTag(input: RenameTagInput): Promise<TagMutationResult> {
    return this.withWritableDatabase((db) => renameTag(db, input));
  }

  async addAlias(input: AliasInput): Promise<TagMutationResult> {
    return this.withWritableDatabase((db) => addAlias(db, input));
  }

  async removeAlias(input: AliasInput): Promise<TagMutationResult> {
    return this.withWritableDatabase((db) => removeAlias(db, input));
  }

  async setMediaTags(input: SetMediaTagsInput): Promise<SetMediaTagsResult> {
    return this.withWritableDatabase((db) => setMediaTags(db, input));
  }

  async previewMerge(input: PreviewMergeInput): Promise<MergePreviewResult> {
    return this.withInitializedDatabase((db) => previewMerge(db, input));
  }

  async mergeTags(input: MergeTagsInput): Promise<MergeTagsResult> {
    return this.withWritableDatabase((db) => {
      const active = this.tagReferenceTask(db, input);
      if (active) return { ok: false, code: 'IN_PROGRESS' as const, message: `Task #${active.id} freezes references to these tags until it finishes.`, failures: [] };
      return mergeTags(db, input);
    });
  }

  async archiveTag(input: TagRevisionInput): Promise<TagMutationResult> {
    return this.withWritableDatabase((db) => archiveTag(db, input));
  }

  async restoreTag(input: TagRevisionInput): Promise<TagMutationResult> {
    return this.withWritableDatabase((db) => restoreTag(db, input));
  }

  async getOpsStatus(): Promise<OpsStatus> {
    await this.initialize();
    const state = readAutoBackupState(this.backupDir);
    const nasBackupDir = this.readConfiguredNasBackupDir().trim() || null;
    return {
      localDataDir: this.localDataDir,
      localDatabasePath: this.localDatabasePath,
      backupDir: this.backupDir,
      nasBackupDir,
      dailyRetentionCount: this.backupRetentionCount,
      preMigrateRetentionCount: this.preMigrateRetentionCount,
      autoDailyBackup: this.autoDailyBackup,
      lastAutoBackupAt: state?.lastBackupAt ?? null,
      lastBackupSha256: state?.lastSha256 ?? null,
      degradedState: this.degradedState,
      backups: listManagedBackups(this.backupDir),
    };
  }

  async createBackup(_input?: CreateBackupInput): Promise<CreateBackupResult> {
    await this.initialize();
    return createOperationalBackup({
      dbPath: this.localDatabasePath,
      backupDir: this.backupDir,
      nasBackupDir: this.readConfiguredNasBackupDir(),
      dailyRetention: this.backupRetentionCount,
      preMigrateRetention: this.preMigrateRetentionCount,
      now: this.now,
    });
  }

  async exportMappingReport(input: ExportMappingReportInput): Promise<ExportMappingReportResult> {
    try {
      return await this.withInitializedDatabase((db) =>
        exportPortableMappingReport(db, {
          format: input.format,
          appVersion: '0.7.10',
          now: this.now,
        }),
      );
    } catch (err) {
      return {
        ok: false,
        format: input.format,
        filename: '',
        mimeType: 'text/plain',
        rowCount: 0,
        sha256: '',
        content: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // --- Issue #7 M4: Recoverable Media Ingestion & Metadata Lookup ---

  async scanStagingFiles(): Promise<ScanStagingResult> {
    await this.initialize();
    const { roots } = this.getEffectiveRootsAndItems();
    const configuredStaging = this.readStringSetting(this.configuredStagingDir).trim();
    const targetSubdir = normalizeTargetSubdir(this.readStringSetting(this.configuredTargetSubdir));
    const defaultRoot = roots.find((r) => r.rootId === DEFAULT_M1_ROOT_ID && r.enabled);
    const isPlaceholderUnc = !configuredStaging && defaultRoot?.canonicalUncRoot.toLowerCase() === '\\\\nas\\mediatest';
    const effectiveStagingDir =
      configuredStaging ||
      (defaultRoot ? path.join(defaultRoot.canonicalUncRoot, 'temp') : '');

    if (isPlaceholderUnc) {
      return {
        ok: false,
        stagingDir: effectiveStagingDir,
        targetRootId: DEFAULT_M1_ROOT_ID,
        targetSubdir,
        elapsedMs: 0,
        files: [],
        manifests: await this.listIngestionManifests(),
        error: 'Please configure your real NAS uncRoot or stagingDir before scanning temp.',
      };
    }

    if (this.degradedState.degraded) {
      return {
        ok: false,
        stagingDir: effectiveStagingDir,
        targetRootId: DEFAULT_M1_ROOT_ID,
        targetSubdir,
        elapsedMs: 0,
        files: [],
        manifests: await this.listIngestionManifests(),
        error: `READ_ONLY_DEGRADED: ${this.degradedState.reason ?? 'Database is in read-only degraded mode.'}`,
      };
    }

    const { db } = openMediaLibraryDatabase({ dbPath: this.localDatabasePath });
    let scanRes: ScanStagingResult;
    try {
      scanRes = await scanStagingDirectory(db, {
        stagingDir: effectiveStagingDir,
        targetRootId: DEFAULT_M1_ROOT_ID,
        targetSubdir,
        roots,
        timeoutMs: this.probeTimeoutMs,
        fileOps: this.ingestionFileOps,
        now: this.now,
      });
    } finally {
      db.close();
    }
    await this.maybeTriggerDailyAutoBackup();
    return scanRes;
  }

  async listIngestionManifests(): Promise<IngestionManifest[]> {
    return this.withInitializedDatabase((db) => listIngestionManifests(db));
  }

  async listIngestionTasks(): Promise<IngestionTask[]> {
    return this.withInitializedDatabase((db) => listIngestionTasks(db, 20, this.now));
  }

  private ingestionStagingDir(): string {
    const { roots } = this.getEffectiveRootsAndItems();
    const configured = this.readStringSetting(this.configuredStagingDir).trim();
    const root = roots.find(r => r.rootId === DEFAULT_M1_ROOT_ID && r.enabled);
    if (!configured && (!root || root.canonicalUncRoot.toLowerCase() === '\\\\nas\\mediatest')) {
      throw new Error('Staging directory is not configured.');
    }
    return configured || path.win32.join(root!.canonicalUncRoot, 'temp');
  }

  async fetchIngestionMetadata(input: FetchIngestionMetadataInput): Promise<FetchedMetadataCandidate> {
    await this.initialize();
    if (this.degradedState.degraded) {
      return {
        ok: false,
        provider: null,
        category: 'client_error',
        reason: `READ_ONLY_DEGRADED: ${this.degradedState.reason ?? 'Database is in read-only degraded mode.'}`,
        sourceUrl: '',
        title: null,
        writer: null,
        actresses: [],
        mediaDate: null,
        candidateTags: [],
        manifest: null,
      };
    }
    const activeDelete = hostRuntime[FILE_EXECUTION_KEY];
    if (activeDelete?.databasePath === this.localDatabasePath && activeDelete.isStagingDelete) {
      return {
        ok: false,
        provider: null,
        category: 'client_error',
        reason: `IN_PROGRESS: ${activeDelete.task.message || 'Staging soft-delete is currently running.'}`,
        sourceUrl: '',
        title: null,
        writer: null,
        actresses: [],
        mediaDate: null,
        candidateTags: [],
        manifest: null,
      };
    }
    // Synchronously register in-flight manifest op and guarantee decrement in finally even if setup throws.
    stagingManifestOpsInFlight.set(
      this.localDatabasePath,
      (stagingManifestOpsInFlight.get(this.localDatabasePath) ?? 0) + 1,
    );
    let db: DatabaseSync | null = null;
    let taskId: number | null = null;
    let fetchResult: FetchedMetadataCandidate | null = null;
    try {
      const fetcher = this.createMetadataFetcher();
      const { roots } = this.getEffectiveRootsAndItems();
      const targetSubdir = normalizeTargetSubdir(this.readStringSetting(this.configuredTargetSubdir));
      db = openMediaLibraryDatabase({ dbPath: this.localDatabasePath }).db;
      let manifestId = input.manifestId;
      if (!manifestId && (input as { readonly tempPath?: unknown }).tempPath !== undefined) {
        throw new Error('PATH_TRAVERSAL_REJECTED: Client must submit manifestId or staging relativePath, not raw tempPath.');
      }
      if (!manifestId && input.relativePath) {
        const created = await ensureManifestForStagingFile(db, {
          relativePath: input.relativePath,
          stagingDir: this.ingestionStagingDir(),
          targetRootId: DEFAULT_M1_ROOT_ID,
          targetSubdir,
          roots,
          fileOps: this.ingestionFileOps,
          now: this.now,
        });
        manifestId = created.id;
      }
      if (!manifestId) {
        return {
          ok: false,
          provider: null,
          category: 'client_error',
          reason: 'Either manifestId or relativePath is required.',
          sourceUrl: '',
          title: null,
          writer: null,
          actresses: [],
          mediaDate: null,
          candidateTags: [],
          manifest: null,
        };
      }
      const targetKey = `manifest:${manifestId}`;
      const lock = startIngestionTask(db, targetKey, 'fetch', `Fetching metadata for manifest #${manifestId}...`, this.now);
      if (!lock.acquired) {
        return {
          ok: false,
          provider: null,
          category: 'client_error',
          reason: `IN_PROGRESS: ${lock.existing.message || 'Task already running for this item.'}`,
          sourceUrl: '',
          title: null,
          writer: null,
          actresses: [],
          mediaDate: null,
          candidateTags: [],
          manifest: null,
        };
      }
      taskId = lock.taskId;
      this.retainIngestionTask(db, taskId);
      const res = await fetchMetadataForManifest(db, manifestId, fetcher, this.now);
      finishIngestionTask(
        db,
        taskId,
        res.ok ? 'succeeded' : 'failed',
        res.ok ? `Fetched from ${res.provider}: ${res.title ?? ''}` : `[${res.category}] ${res.reason}`,
        this.now,
      );
      fetchResult = res;
    } catch (err) {
      if (taskId !== null && db) {
        finishIngestionTask(db, taskId, 'failed', err instanceof Error ? err.message : String(err), this.now);
      }
      throw err;
    } finally {
      if (taskId !== null) this.releaseIngestionTask(taskId);
      const nextCount = (stagingManifestOpsInFlight.get(this.localDatabasePath) ?? 1) - 1;
      if (nextCount <= 0) stagingManifestOpsInFlight.delete(this.localDatabasePath);
      else stagingManifestOpsInFlight.set(this.localDatabasePath, nextCount);
      db?.close();
    }
    if (fetchResult) {
      await this.maybeTriggerDailyAutoBackup();
      return fetchResult;
    }
    throw new Error('Unexpected empty fetch result.');
  }

  async reviewIngestion(input: ReviewIngestionInput): Promise<ReviewIngestionResult> {
    await this.initialize();
    if (this.degradedState.degraded) {
      return {
        ok: false,
        code: 'READ_ONLY_DEGRADED',
        message: this.degradedState.reason ?? 'Database is in read-only degraded mode.',
      };
    }
    const activeDelete = hostRuntime[FILE_EXECUTION_KEY];
    if (activeDelete?.databasePath === this.localDatabasePath && activeDelete.isStagingDelete) {
      return {
        ok: false,
        code: 'IN_PROGRESS',
        message: activeDelete.task.message || 'Staging soft-delete is currently running.',
      };
    }
    const { roots } = this.getEffectiveRootsAndItems();
    const targetSubdir = normalizeTargetSubdir(this.readStringSetting(this.configuredTargetSubdir));
    stagingManifestOpsInFlight.set(
      this.localDatabasePath,
      (stagingManifestOpsInFlight.get(this.localDatabasePath) ?? 0) + 1,
    );
    let reviewRes: ReviewIngestionResult;
    try {
      reviewRes = await this.withInitializedDatabase(async (db) => {
        let manifestId = input.manifestId;
        if (!manifestId && (input as { readonly tempPath?: unknown }).tempPath !== undefined) {
          throw new Error('PATH_TRAVERSAL_REJECTED: Client must submit manifestId or staging relativePath, not raw tempPath.');
        }
        if (!manifestId && input.relativePath) {
          const created = await ensureManifestForStagingFile(db, {
            relativePath: input.relativePath,
            stagingDir: this.ingestionStagingDir(),
            targetRootId: DEFAULT_M1_ROOT_ID,
            targetSubdir,
            roots,
            fileOps: this.ingestionFileOps,
            now: this.now,
          });
          manifestId = created.id;
        }
        if (!manifestId) {
          return { ok: false as const, code: 'INVALID_INPUT' as const, message: 'Either manifestId or relativePath is required.' };
        }
        const active = findManifestTask(db, manifestId);
        if (active) return { ok: false as const, code: 'IN_PROGRESS' as const, message: `Task #${active.id} freezes this Manifest until it finishes.` };
        return reviewIngestionManifest(db, { ...input, manifestId }, this.now);
      });
    } finally {
      const nextCount = (stagingManifestOpsInFlight.get(this.localDatabasePath) ?? 1) - 1;
      if (nextCount <= 0) stagingManifestOpsInFlight.delete(this.localDatabasePath);
      else stagingManifestOpsInFlight.set(this.localDatabasePath, nextCount);
    }
    if (reviewRes.ok) await this.maybeTriggerDailyAutoBackup();
    return reviewRes;
  }

  async commitIngestion(input: CommitIngestionInput): Promise<CommitIngestionResult> {
    await this.initialize();
    if (this.degradedState.degraded) {
      return {
        ok: false,
        code: 'READ_ONLY_DEGRADED',
        message: this.degradedState.reason ?? 'Database is in read-only degraded mode.',
      };
    }
    const activeDelete = hostRuntime[FILE_EXECUTION_KEY];
    if (activeDelete?.databasePath === this.localDatabasePath && activeDelete.isStagingDelete) {
      return {
        ok: false,
        code: 'IN_PROGRESS',
        message: activeDelete.task.message || 'Staging soft-delete is currently running.',
      };
    }
    const { roots } = this.getEffectiveRootsAndItems();
    const res = await this.withInitializedDatabase(async (db) => {
      const targetKey = `manifest:${input.manifestId}`;
      const lock = this.startFileIngestionTask(db, targetKey, 'commit', `Moving & indexing manifest #${input.manifestId}...`);
      if (!lock.acquired) {
        return {
          ok: false,
          code: 'IN_PROGRESS' as const,
          activeTask: lock.existing,
          message: `Task #${lock.existing.id}: ` + lock.existing.message || 'Move & index already in progress for this item.',
        };
      }
      try {
        const commitRes = await commitIngestionManifest(db, {
          manifestId: input.manifestId,
          allowCrossDeviceCopy: this.allowCrossDeviceCopy,
          stagingDir: this.ingestionStagingDir(),
          onPhase: phase => {
            updateIngestionPhase(db, lock.taskId, phase, this.now);
            this.retainIngestionTask(db, lock.taskId);
          },
          roots,
          fileOps: this.ingestionFileOps,
          now: this.now,
        });
        finishIngestionTask(db, lock.taskId, commitRes.ok ? 'succeeded' : 'failed', commitRes.message + (commitRes.warning ? ` (${commitRes.warning})` : ''), this.now);
        return commitRes;
      } catch (err) {
        finishIngestionTask(db, lock.taskId, 'failed', err instanceof Error ? err.message : String(err), this.now);
        throw err;
      } finally {
        this.releaseIngestionTask(lock.taskId);
      }
    });
    if (res.ok) await this.maybeTriggerDailyAutoBackup();
    return res;
  }

  async reconcileIngestion(): Promise<ReconcileIngestionResult> {
    await this.initialize();
    if (this.degradedState.degraded) {
      return {
        ok: false,
        reconciledCount: 0,
        copiedNotDeletedFixed: 0,
        movedNotIndexedFixed: 0,
        indexedButMissingMarked: 0,
        errors: [`READ_ONLY_DEGRADED: ${this.degradedState.reason ?? 'Database is in read-only degraded mode.'}`],
        manifests: await this.listIngestionManifests(),
      };
    }
    const { roots } = this.getEffectiveRootsAndItems();
    const res = await this.withInitializedDatabase(async (db) => {
      const lock = this.startFileIngestionTask(db, 'reconcile:all', 'reconcile', 'Reconciling interrupted ingestion manifests...');
      if (!lock.acquired) {
        return {
          ok: false,
          reconciledCount: 0,
          copiedNotDeletedFixed: 0,
          movedNotIndexedFixed: 0,
          indexedButMissingMarked: 0,
          activeTask: lock.existing,
          errors: [`Task #${lock.existing.id}: ` + lock.existing.message || 'Reconcile already in progress.'],
          manifests: listIngestionManifests(db),
        };
      }
      try {
        const reconcileRes = await reconcileIngestionManifests(db, {
          roots,
          stagingDir: this.ingestionStagingDir(),
          onPhase: phase => {
            updateIngestionPhase(db, lock.taskId, phase, this.now);
            this.retainIngestionTask(db, lock.taskId);
          },
          fileOps: this.ingestionFileOps,
          now: this.now,
        });
        finishIngestionTask(
          db,
          lock.taskId,
          reconcileRes.ok ? 'succeeded' : 'failed',
          reconcileRes.ok ? `Reconciled ${reconcileRes.reconciledCount} manifest(s).` : reconcileRes.errors.join('; '),
          this.now,
        );
        return reconcileRes;
      } catch (err) {
        finishIngestionTask(db, lock.taskId, 'failed', err instanceof Error ? err.message : String(err), this.now);
        throw err;
      } finally {
        this.releaseIngestionTask(lock.taskId);
      }
    });
    if (res.reconciledCount > 0) await this.maybeTriggerDailyAutoBackup();
    return res;
  }

  /**
   * Open a video file currently inside the Host-configured staging `temp` directory using the native player.
   * Strictly enforces Host-side containment inside `stagingDir` (rejects traversal, absolute/UNC paths, and non-video files).
   */
  async openStagingFile(input: OpenStagingFileInput): Promise<MediaActionResult> {
    const startMs = Date.now();
    const rawRel = typeof input?.relativePath === 'string' ? input.relativePath.trim() : '';
    const mediaId = `staging:${rawRel}`;

    const { roots } = this.getEffectiveRootsAndItems();
    const configuredStaging = this.readStringSetting(this.configuredStagingDir).trim();
    const defaultRoot = roots.find((r) => r.rootId === DEFAULT_M1_ROOT_ID && r.enabled);
    const isPlaceholderUnc = !configuredStaging && defaultRoot?.canonicalUncRoot.toLowerCase() === '\\\\nas\\mediatest';
    const effectiveStagingDir =
      configuredStaging || (defaultRoot ? path.join(defaultRoot.canonicalUncRoot, 'temp') : '');

    if (!effectiveStagingDir || isPlaceholderUnc) {
      return {
        ok: false,
        mediaId,
        action: 'open',
        code: 'INVALID_UNC_ROOT',
        message: 'Staging temp directory is not configured.',
        elapsedMs: Date.now() - startMs,
      };
    }

    const normalizedRel = rawRel.replace(/\\/g, '/');
    const segments = normalizedRel.split('/').filter(Boolean);
    const videoExts = new Set(['.avi', '.mkv', '.mp4', '.mov', '.wmv', '.m4v', '.ts']);
    const ext = path.extname(rawRel).toLowerCase();
    if (
      !rawRel ||
      rawRel.includes('\0') ||
      rawRel.startsWith('/') ||
      rawRel.startsWith('\\') ||
      /^[a-zA-Z]:/.test(rawRel) ||
      segments.length === 0 ||
      segments.some((s) => s === '.' || s === '..') ||
      !videoExts.has(ext)
    ) {
      return {
        ok: false,
        mediaId,
        action: 'open',
        code: 'PATH_TRAVERSAL_REJECTED',
        message: `Rejected staging path '${rawRel}': must be a relative video file inside stagingDir.`,
        elapsedMs: Date.now() - startMs,
      };
    }

    const isWinStyle = effectiveStagingDir.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(effectiveStagingDir);
    const resolvedPath = isWinStyle
      ? path.win32.resolve(effectiveStagingDir, ...segments)
      : path.resolve(effectiveStagingDir, ...segments);
    const baseResolved = isWinStyle ? path.win32.resolve(effectiveStagingDir) : path.resolve(effectiveStagingDir);
    const relCheck = isWinStyle
      ? path.win32.relative(baseResolved, resolvedPath)
      : path.relative(baseResolved, resolvedPath);
    if (!relCheck || relCheck.startsWith('..') || (isWinStyle ? path.win32.isAbsolute(relCheck) : path.isAbsolute(relCheck))) {
      return {
        ok: false,
        mediaId,
        action: 'open',
        code: 'PATH_TRAVERSAL_REJECTED',
        message: `Resolved path escaped stagingDir: ${rawRel}`,
        elapsedMs: Date.now() - startMs,
      };
    }

    const probe = await this.fileProbe(resolvedPath, this.probeTimeoutMs);
    if (!probe.ok) {
      return {
        ok: false,
        mediaId,
        action: 'open',
        code: probe.code ?? 'FILE_NOT_FOUND',
        message: probe.message ?? `Staging file not accessible: ${resolvedPath}`,
        resolvedUncPath: resolvedPath,
        elapsedMs: Date.now() - startMs,
      };
    }

    try {
      await this.opener.openPath(resolvedPath);
      return {
        ok: true,
        mediaId,
        action: 'open',
        resolvedUncPath: resolvedPath,
        elapsedMs: Date.now() - startMs,
      };
    } catch (err) {
      return {
        ok: false,
        mediaId,
        action: 'open',
        code: 'OPENER_FAILED',
        message: err instanceof Error ? err.message : String(err),
        resolvedUncPath: resolvedPath,
        elapsedMs: Date.now() - startMs,
      };
    }
  }

  /**
   * Issue #26: Soft-delete an unindexed staged file by moving it into `<stagingDir>/.trash/`
   * and removing any associated unindexed manifest (with `mutation_log` audit).
   * Shares the process-wide `FILE_EXECUTION_KEY` lock with `commitIngestion` / `reconcileIngestion`.
   */
  async deleteStagingFile(input: DeleteStagingFileInput): Promise<DeleteStagingFileResult> {
    await this.initialize();
    if (this.degradedState.degraded) {
      return {
        ok: false,
        code: 'READ_ONLY_DEGRADED',
        message: this.degradedState.reason ?? 'Database is in read-only degraded mode.',
      };
    }
    const activeDelete = hostRuntime[FILE_EXECUTION_KEY];
    if (activeDelete?.databasePath === this.localDatabasePath && activeDelete.isStagingDelete) {
      return {
        ok: false,
        code: 'IN_PROGRESS',
        message: activeDelete.task.message || 'Staging soft-delete is currently running.',
      };
    }

    if ((input as { readonly tempPath?: unknown })?.tempPath !== undefined) {
      return {
        ok: false,
        code: 'PATH_TRAVERSAL_REJECTED',
        message: 'Client must submit manifestId or staging relativePath, not raw tempPath.',
      };
    }

    const { roots } = this.getEffectiveRootsAndItems();
    const configuredStaging = this.readStringSetting(this.configuredStagingDir).trim();
    const defaultRoot = roots.find((r) => r.rootId === DEFAULT_M1_ROOT_ID && r.enabled);
    const isPlaceholderUnc =
      !configuredStaging && defaultRoot?.canonicalUncRoot.toLowerCase() === '\\\\nas\\mediatest';
    const effectiveStagingDir =
      configuredStaging || (defaultRoot ? path.win32.join(defaultRoot.canonicalUncRoot, 'temp') : '');

    if (!effectiveStagingDir || isPlaceholderUnc) {
      return {
        ok: false,
        code: 'INVALID_INPUT',
        message: 'Staging temp directory is not configured.',
      };
    }

    const active = hostRuntime[FILE_EXECUTION_KEY];
    if (active) {
      return {
        ok: false,
        code: 'IN_PROGRESS',
        message: `Task #${active.task.id}: ${active.task.message || 'Another file ingestion operation is already running.'}`,
      };
    }
    if ((stagingManifestOpsInFlight.get(this.localDatabasePath) ?? 0) > 0) {
      return {
        ok: false,
        code: 'IN_PROGRESS',
        message: 'Another staging metadata fetch or review operation is currently in progress.',
      };
    }

    const nowIso = this.now().toISOString();
    const syntheticLock: { databasePath: string; task: IngestionTask; isStagingDelete: boolean } = {
      databasePath: this.localDatabasePath,
      isStagingDelete: true,
      task: {
        id: 0,
        targetKey: input.manifestId !== undefined ? `manifest:${input.manifestId}` : `staging:${input.relativePath ?? ''}`,
        op: 'commit',
        status: 'running',
        phase: 'cleanup',
        phaseStartedAt: nowIso,
        waitingWarning: false,
        message: 'Moving staged file to .trash...',
        startedAt: nowIso,
        finishedAt: null,
      },
    };
    hostRuntime[FILE_EXECUTION_KEY] = syntheticLock;

    let res: DeleteStagingFileResult;
    try {
      res = await this.withInitializedDatabase((db) =>
        softDeleteStagingFile(db, {
          manifestId: input.manifestId,
          relativePath: input.relativePath,
          expectedFileSize: input.expectedFileSize,
          stagingDir: effectiveStagingDir,
          fileOps: this.ingestionFileOps,
          now: this.now,
        }),
      );
    } finally {
      if (hostRuntime[FILE_EXECUTION_KEY] === syntheticLock) {
        delete hostRuntime[FILE_EXECUTION_KEY];
      }
    }

    if (res.ok) {
      await this.maybeTriggerDailyAutoBackup();
    }
    return res;
  }

  async previewManifestPerformers(input: PreviewManifestPerformersInput): Promise<ManifestPerformerPreview> {
    await this.initialize();
    if (this.degradedState.degraded) {
      const db = new DatabaseSync(this.localDatabasePath, { readOnly: true });
      try {
        const preview = evaluateManifestPerformers(db, input.manifestId, { now: this.now, readOnly: true });
        return { ...preview, canCommit: false };
      } finally {
        db.close();
      }
    }
    const res = await this.withInitializedDatabase((db) => evaluateManifestPerformers(db, input.manifestId, { now: this.now }));
    await this.maybeTriggerDailyAutoBackup();
    return res;
  }

  async listPerformerAliases(): Promise<PerformerAliasRecord[]> {
    await this.initialize();
    return this.withInitializedDatabase((db) => listPerformerAliases(db));
  }

  private tagReferenceTask(db: DatabaseSync, input: MergeTagsInput): IngestionTask | null {
    const ids = [input.sourceTagId, input.targetTagId];
    const tagNames = db.prepare(`SELECT normalized_name AS name FROM tags WHERE id IN (?, ?)
      UNION SELECT normalized_alias AS name FROM tag_aliases WHERE tag_id IN (?, ?)`)
      .all(...ids, ...ids) as Array<{ name: string }>;
    const names = new Set(tagNames.map(row => row.name));
    const aliases = db.prepare('SELECT normalized_name FROM performer_aliases WHERE tag_id IN (?, ?)')
      .all(...ids) as Array<{ normalized_name: string }>;
    for (const manifest of listFrozenIngestionManifests(db)) {
      const normalTag = manifest.tags.some(tag => (tag.tagId !== undefined && ids.includes(tag.tagId)) || names.has(normalizeLabel(tag.name)));
      const performerRule = manifest.actresses.some(name => aliases.some(alias => alias.normalized_name === normalizePerformerName(name)));
      const performerDecision = db.prepare(`SELECT 1 FROM performer_review_queue
        WHERE manifest_id = ? AND resolved_tag_id IN (?, ?) AND status = 'resolved' LIMIT 1`).get(manifest.id, ...ids);
      if (normalTag || performerRule || performerDecision) return findManifestTask(db, manifest.id);
    }
    return null;
  }

  private performerRuleTask(db: DatabaseSync, rawName: string): IngestionTask | null {
    const name = normalizePerformerName(rawName);
    for (const manifest of listFrozenIngestionManifests(db)) {
      if (manifest.actresses.some(a => normalizePerformerName(a) === name)) return findManifestTask(db, manifest.id);
    }
    return null;
  }

  async upsertPerformerAlias(input: UpsertPerformerAliasInput): Promise<UpsertPerformerAliasResult> {
    await this.initialize();
    if (this.degradedState.degraded) {
      return {
        ok: false,
        code: 'READ_ONLY_DEGRADED',
        message: this.degradedState.reason ?? 'Database is in read-only degraded mode.',
      };
    }
    const activeDelete = hostRuntime[FILE_EXECUTION_KEY];
    if (activeDelete?.databasePath === this.localDatabasePath && activeDelete.isStagingDelete) {
      return {
        ok: false,
        code: 'IN_PROGRESS',
        message: activeDelete.task.message || 'Staging soft-delete is currently running.',
      };
    }
    const res = await this.withInitializedDatabase((db) => {
      const active = this.performerRuleTask(db, input.rawAlias);
      if (active) return { ok: false as const, code: 'IN_PROGRESS' as const, message: `Task #${active.id} freezes this performer input.` };
      return upsertPerformerAlias(db, input, { now: this.now });
    });
    if (res.ok) await this.maybeTriggerDailyAutoBackup();
    return res;
  }

  async deletePerformerAlias(input: DeletePerformerAliasInput): Promise<DeletePerformerAliasResult> {
    await this.initialize();
    if (this.degradedState.degraded) {
      return {
        ok: false,
        code: 'READ_ONLY_DEGRADED',
        message: this.degradedState.reason ?? 'Database is in read-only degraded mode.',
      };
    }
    const activeDelete = hostRuntime[FILE_EXECUTION_KEY];
    if (activeDelete?.databasePath === this.localDatabasePath && activeDelete.isStagingDelete) {
      return {
        ok: false,
        code: 'IN_PROGRESS',
        message: activeDelete.task.message || 'Staging soft-delete is currently running.',
      };
    }
    const res = await this.withInitializedDatabase((db) => {
      const alias = db.prepare('SELECT raw_alias FROM performer_aliases WHERE id = ?').get(input.aliasId) as { raw_alias: string } | undefined;
      const active = alias ? this.performerRuleTask(db, alias.raw_alias) : null;
      if (active) return { ok: false as const, code: 'IN_PROGRESS' as const, message: `Task #${active.id} freezes this performer input.` };
      return deletePerformerAlias(db, input, { now: this.now });
    });
    if (res.ok) await this.maybeTriggerDailyAutoBackup();
    return res;
  }

  async listPerformerReviewQueue(input?: ListPerformerReviewInput): Promise<PerformerReviewItem[]> {
    await this.initialize();
    return this.withInitializedDatabase((db) => listPerformerReviewQueue(db, input));
  }

  async resolvePerformerReview(input: ResolvePerformerReviewInput): Promise<ResolvePerformerReviewResult> {
    await this.initialize();
    if (this.degradedState.degraded) {
      return {
        ok: false,
        code: 'READ_ONLY_DEGRADED',
        message: this.degradedState.reason ?? 'Database is in read-only degraded mode.',
      };
    }
    const activeDelete = hostRuntime[FILE_EXECUTION_KEY];
    if (activeDelete?.databasePath === this.localDatabasePath && activeDelete.isStagingDelete) {
      return {
        ok: false,
        code: 'IN_PROGRESS',
        message: activeDelete.task.message || 'Staging soft-delete is currently running.',
      };
    }
    const res = await this.withInitializedDatabase((db) => {
      const review = input.reviewId ? db.prepare('SELECT manifest_id, raw_name FROM performer_review_queue WHERE id = ?').get(input.reviewId) as { manifest_id: number; raw_name: string } | undefined : undefined;
      const manifestId = review?.manifest_id ?? input.manifestId;
      const active = manifestId ? findManifestTask(db, manifestId) : null;
      // Remembering an alias can also affect another executing Manifest.
      const ruleTask = input.rememberRule && input.mode !== 'skip' ? this.performerRuleTask(db, review?.raw_name ?? input.rawName ?? '') : null;
      if (active || ruleTask) return { ok: false as const, code: 'IN_PROGRESS' as const, message: `Task #${(active ?? ruleTask)!.id} freezes this performer input.` };
      return resolvePerformerReview(db, input, { now: this.now });
    });
    if (res.ok) await this.maybeTriggerDailyAutoBackup();
    return res;
  }

  async promotePerformerTagToManual(input: PromotePerformerTagInput): Promise<PromotePerformerTagResult> {
    await this.initialize();
    if (this.degradedState.degraded) {
      return {
        ok: false,
        code: 'READ_ONLY_DEGRADED',
        message: this.degradedState.reason ?? 'Database is in read-only degraded mode.',
      };
    }
    const activeDelete = hostRuntime[FILE_EXECUTION_KEY];
    if (activeDelete?.databasePath === this.localDatabasePath && activeDelete.isStagingDelete) {
      return {
        ok: false,
        code: 'IN_PROGRESS',
        message: activeDelete.task.message || 'Staging soft-delete is currently running.',
      };
    }
    const res = await this.withInitializedDatabase((db) => promotePerformerTagToManual(db, input, { now: this.now }));
    if (res.ok) await this.maybeTriggerDailyAutoBackup();
    return res;
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
      if (this.degradedState.degraded) {
        return {
          ok: false,
          status: 'failed',
          message: `READ_ONLY_DEGRADED: ${this.degradedState.reason ?? 'Database is in read-only degraded mode.'}`,
          importedEntries: 0,
          skippedSidecarEntries: 0,
          importedTags: 0,
          importedMediaTags: 0,
          sourceSha256: '',
        };
      }
      const report = await importTagStudioDatabase({
        sourceDbPath,
        targetDbPath: this.localDatabasePath,
        mode: 'import',
        rootId: DEFAULT_M1_ROOT_ID,
        canonicalUncRoot: uncRoot,
        force: input?.force ?? false,
      });

      if (report.status === 'succeeded') {
        await this.maybeTriggerDailyAutoBackup();
      }

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
    if (numericDbId === null || this.degradedState.degraded || !fs.existsSync(this.localDatabasePath)) {
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
