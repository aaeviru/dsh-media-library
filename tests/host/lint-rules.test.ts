import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runLintRules } from '../../scripts/lint-rules.ts';

describe('Static Lint Rules Gate (Issue #28)', () => {
  it('passes cleanly on the current repository', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
    const res = runLintRules(repoRoot);
    assert.equal(res.ok, true, `Unexpected violations:\n${res.violations.join('\n')}`);
  });

  it('catches hardcoded colors, native <select>, client UNC/RPC raw paths, and machine paths while allowing locales placeholders', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lint-rules-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'src', 'client'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });

      // Allowed placeholder in src/client/locales.ts must NOT trigger a violation.
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'client', 'locales.ts'),
        "export const en = { placeholder: 'e.g. \\\\\\\\SynologyNAS\\\\Media' };\n",
      );
      assert.equal(runLintRules(tmpDir).ok, true);

      // Inject 1 violation per rule and verify all are caught.
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'client', 'bad.module.css'),
        '.card { color: #ff00aa; background: rgba(0, 0, 0, 0.5); }\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'client', 'BadPanel.tsx'),
        [
          'export function BadPanel() {',
          "  const unc = '\\\\\\\\NAS\\\\Secret';",
          '  void mediaLibrary.fetchIngestionMetadata({ tempPath: unc });',
          '  return <select><option>x</option></select>;',
          '}',
        ].join('\n') + '\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'host-bad.ts'),
        "export const p = '/home/alice/project/secret';\n",
      );
      fs.writeFileSync(
        path.join(tmpDir, 'scripts', 'bad-helper.mjs'),
        "export const win = 'C:\\\\Users\\\\bob\\\\file.txt';\n",
      );

      const res = runLintRules(tmpDir);
      assert.equal(res.ok, false);
      assert.ok(res.violations.some((v) => v.includes('hardcoded color')));
      assert.ok(res.violations.some((v) => v.includes('forbidden native <select>')));
      assert.ok(res.violations.some((v) => v.includes('forbidden raw UNC literal')));
      assert.ok(res.violations.some((v) => v.includes('forbidden raw path field in client RPC call')));
      assert.ok(res.violations.some((v) => v.includes('src/host-bad.ts') && v.includes('hardcoded machine path')));
      assert.ok(res.violations.some((v) => v.includes('scripts/bad-helper.mjs') && v.includes('hardcoded machine path')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
