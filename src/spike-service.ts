import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openNativeAssociatedPath,
  revealNativePath,
} from '@deepseek-ai/dsh-native-command';
import type {
  M1TestMediaItem,
  MediaActionErrorCode,
  MediaActionResult,
  MediaRootConfig,
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
  readonly roots?: readonly MediaRootConfig[];
  readonly items?: readonly M1TestMediaItem[];
}

export interface SpikeServiceOptions {
  readonly baseDir?: string | undefined;
  readonly dataDirName?: string | undefined;
  readonly configuredUncRoot?: string | (() => string) | undefined;
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
  private readonly probeTimeoutMs: number;
  private readonly explicitRoots: readonly MediaRootConfig[] | undefined;
  private readonly explicitItems: readonly M1TestMediaItem[] | undefined;
  private readonly opener: NativeOpener;
  private readonly fileProbe: FileProbeFn;

  constructor(options: SpikeServiceOptions = {}) {
    this.localDataDir = resolveLocalDataDir(options.baseDir, options.dataDirName ?? 'media-library');
    this.localDatabasePath = path.join(this.localDataDir, 'library.sqlite3');
    this.spikeOverridePath = path.join(this.localDataDir, 'm1-spike.json');
    this.configuredUncRoot = options.configuredUncRoot ?? '\\\\NAS\\MediaTest';
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

  getEffectiveRootsAndItems(): {
    activeUncRoot: string;
    roots: readonly MediaRootConfig[];
    items: readonly M1TestMediaItem[];
  } {
    const override = this.readLocalOverrideFile();
    const rawUncRoot =
      override?.uncRoot?.trim() || this.readConfiguredUncRoot().trim() || '\\\\NAS\\MediaTest';
    const normalizedRoot = normalizeCanonicalUncRoot(rawUncRoot);
    const activeUncRoot = normalizedRoot.ok ? normalizedRoot.canonicalRoot : rawUncRoot;

    const roots: readonly MediaRootConfig[] =
      this.explicitRoots ??
      override?.roots ?? [
        {
          rootId: DEFAULT_M1_ROOT_ID,
          label: 'Primary Synology NAS Media Share (M1 Spike)',
          canonicalUncRoot: activeUncRoot,
          enabled: true,
        },
      ];

    const items: readonly M1TestMediaItem[] =
      this.explicitItems ?? override?.items ?? [...DEFAULT_M1_TEST_ITEMS];

    return {
      activeUncRoot,
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

  async openMedia(mediaId: string): Promise<MediaActionResult> {
    return this.executeMediaAction('open', mediaId);
  }

  async revealMedia(mediaId: string): Promise<MediaActionResult> {
    return this.executeMediaAction('reveal', mediaId);
  }

  private async executeMediaAction(
    action: 'open' | 'reveal',
    mediaId: string,
  ): Promise<MediaActionResult> {
    const startMs = Date.now();
    const trimmedId = typeof mediaId === 'string' ? mediaId.trim() : '';
    const { roots, items } = this.getEffectiveRootsAndItems();

    const item = items.find((entry) => entry.mediaId === trimmedId);
    if (!item) {
      return {
        ok: false,
        mediaId: trimmedId,
        action,
        code: 'UNKNOWN_MEDIA_ID',
        message: `Unknown mediaId '${trimmedId}'. Client may only request registered mediaIds.`,
        elapsedMs: Date.now() - startMs,
      };
    }

    const resolution = resolveAllowlistedUncPath(roots, item.rootId, item.relativePath);
    if (!resolution.ok) {
      return {
        ok: false,
        mediaId: item.mediaId,
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
      return {
        ok: false,
        mediaId: item.mediaId,
        action,
        code,
        message: probe.message ?? `Target file probe failed: ${resolvedUncPath}`,
        resolvedUncPath,
        elapsedMs: Date.now() - startMs,
      };
    }

    try {
      if (action === 'open') {
        await this.opener.openPath(resolvedUncPath);
      } else {
        await this.opener.revealPath(resolvedUncPath);
      }
      return {
        ok: true,
        mediaId: item.mediaId,
        action,
        resolvedUncPath,
        elapsedMs: Date.now() - startMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        mediaId: item.mediaId,
        action,
        code: 'OPENER_FAILED',
        message: `Native ${action} command failed for '${resolvedUncPath}': ${message}`,
        resolvedUncPath,
        elapsedMs: Date.now() - startMs,
      };
    }
  }
}
