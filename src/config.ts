import type { Volatile } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';

export interface Config {
  uncRoot: Volatile<string>;
  dataDir: string;
  probeTimeoutMs: number;
}

export const Config = Schema.object({
  uncRoot: Schema.string()
    .default('\\\\NAS\\MediaTest')
    .description('Canonical Windows UNC root path for M1 Host/SMB spike verification (e.g. \\\\SynologyNAS\\Media\\Library).')
    .volatile(),
  dataDir: Schema.string()
    .default('media-library')
    .description('Subdirectory under the local DSH data directory (%DSH_HOME%/media-library) used for local SQLite storage.'),
  probeTimeoutMs: Schema.number()
    .min(100)
    .default(5000)
    .description('Maximum milliseconds to wait when probing NAS file reachability before launching native opener.'),
});
