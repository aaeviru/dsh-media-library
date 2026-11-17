import type { Volatile } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';

export interface Config {
  uncRoot: Volatile<string>;
  tagstudioCopyPath: Volatile<string>;
  dataDir: string;
  probeTimeoutMs: number;
  nasBackupDir: Volatile<string>;
  backupRetentionCount: number;
  preMigrateRetentionCount: number;
  autoDailyBackup: boolean;
  stagingDir: Volatile<string>;
  ingestionTargetSubdir: Volatile<string>;
  cmadbBaseUrl: string;
  ppvdbBaseUrl: string;
  cmadbCookie: Volatile<string>;
  ppvdbCookie: Volatile<string>;
}

export const Config = Schema.object({
  uncRoot: Schema.string()
    .default('\\\\NAS\\MediaTest')
    .description('Canonical Windows UNC root path for NAS media share (e.g. \\\\SynologyNAS\\Media\\Library).')
    .volatile(),
  tagstudioCopyPath: Schema.string()
    .default('')
    .description('Optional local path to a read-only TagStudio ts_library.sqlite copy for one-click import.')
    .volatile(),
  dataDir: Schema.string()
    .default('media-library')
    .description('Subdirectory under the local DSH data directory (%DSH_HOME%/media-library) used for local SQLite storage.'),
  probeTimeoutMs: Schema.number()
    .min(100)
    .default(5000)
    .description('Maximum milliseconds to wait when probing NAS file reachability before launching native opener.'),
  nasBackupDir: Schema.string()
    .default('')
    .description('Optional NAS/archive directory where verified local SQLite backups are copied for cold retention.')
    .volatile(),
  backupRetentionCount: Schema.number()
    .min(1)
    .max(100)
    .default(14)
    .description('Number of recent daily/manual library-backup-*.sqlite3 files to retain.'),
  preMigrateRetentionCount: Schema.number()
    .min(1)
    .max(50)
    .default(5)
    .description('Number of recent pre-migrate-*.sqlite3 backups to retain.'),
  autoDailyBackup: Schema.boolean()
    .default(true)
    .description('Automatically create at most one verified backup per 24h when new writes/imports occurred.'),
  stagingDir: Schema.string()
    .default('')
    .description('Staging temp folder holding video files awaiting metadata lookup, review, and ingestion.')
    .volatile(),
  ingestionTargetSubdir: Schema.string()
    .default('ingested')
    .description('Fixed target subdirectory under uncRoot where reviewed files are moved (keeping original filename).')
    .volatile(),
  cmadbBaseUrl: Schema.string()
    .default('https://fc2cmadb.com')
    .description('Primary metadata provider base URL.'),
  ppvdbBaseUrl: Schema.string()
    .default('https://fc2ppvdb.com')
    .description('Fallback metadata provider base URL.'),
  cmadbCookie: Schema.string()
    .default('')
    .description('Optional Cookie header for primary metadata provider.')
    .volatile(),
  ppvdbCookie: Schema.string()
    .default('')
    .description('Optional Cookie header for fallback metadata provider.')
    .volatile(),
});
