import { defineConfig } from 'tsdown';
import { clientBundle } from '/home/aaevi/projects/deepseek-harness/packages/client/tsdown.client.ts';

export default defineConfig(
  clientBundle(import.meta.dirname, ['lib/types/index.js'], {
    companions: [
      {
        name: '@deepseek-ai/dsh-experimental-media-library/typert',
        entry: { 'typert.host': 'lib/typert.host.src.js' },
        outDir: 'lib',
        format: ['esm'],
        platform: 'node',
        target: 'es2024',
        fixedExtension: false,
        dts: false,
        clean: false,
        deps: {
          alwaysBundle: (specifier: string) => !specifier.startsWith('node:'),
        },
      },
    ],
  }),
);
