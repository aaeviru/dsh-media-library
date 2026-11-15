import type { Volatile } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export interface Config {
    uncRoot: Volatile<string>;
    dataDir: string;
    probeTimeoutMs: number;
}
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    uncRoot: Schema<string, string, "volatile-defined">;
    dataDir: Schema<string, string, "defined">;
    probeTimeoutMs: Schema<number, number, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    uncRoot: Schema<string, string, "volatile-defined">;
    dataDir: Schema<string, string, "defined">;
    probeTimeoutMs: Schema<number, number, "defined">;
}>>, "plain">;
//# sourceMappingURL=config.d.ts.map