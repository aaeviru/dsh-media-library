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
});
