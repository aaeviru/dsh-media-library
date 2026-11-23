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

  it('catches hardcoded colors, native <select>, multiline/shorthand RPC raw paths, embedded UNC literals, and bare home dirs while allowing locales placeholders', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lint-rules-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'src', 'client'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });

      const sampleUncLine = "export const hint = 'e.g. \\\\\\\\SynologyNAS\\\\Media';\n";

      // Allowed placeholder in src/client/locales.ts must NOT trigger a violation.
      fs.writeFileSync(path.join(tmpDir, 'src', 'client', 'locales.ts'), sampleUncLine);
      // Single escaped backslash (non-UNC) must NOT be falsely flagged as UNC.
      fs.writeFileSync(path.join(tmpDir, 'src', 'client', 'safe.ts'), "export const esc = '\\\\n';\n");
      assert.equal(runLintRules(tmpDir).ok, true);

      // Inject 1+ violations per rule (including identical UNC string outside locales.ts, multiline/shorthand RPC, bare /home/user).
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'client', 'bad.module.css'),
        '.card { color: #ff00aa; background: rgba(0, 0, 0, 0.5); }\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'client', 'BadPanel.tsx'),
        [
          sampleUncLine.trim(),
          'export function BadPanel(tempPath: string) {',
          '  void mediaLibrary.fetchIngestionMetadata({',
          '    tempPath,',
          '  });',
          '  void mediaLibrary.reviewIngestion({',
          '    uncPath: tempPath,',
          '  });',
          '  return <select><option>x</option></select>;',
          '}',
        ].join('\n') + '\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'host-bad.ts'),
        "export const home = '/home/alice';\n",
      );
      fs.writeFileSync(
        path.join(tmpDir, 'scripts', 'bad-helper.mjs'),
        "export const win = 'C:\\\\Users\\\\bob\\\\file.txt';\n",
      );

      const res = runLintRules(tmpDir);
      assert.equal(res.ok, false);
      assert.ok(res.violations.some((v) => v.includes('hardcoded color')));
      assert.ok(res.violations.some((v) => v.includes('forbidden native <select>')));
      assert.ok(res.violations.some((v) => v.includes('BadPanel.tsx') && v.includes('forbidden raw UNC literal')));
      assert.ok(res.violations.filter((v) => v.includes('forbidden raw path field in client RPC call')).length === 2);
      assert.ok(res.violations.some((v) => v.includes('src/host-bad.ts') && v.includes('hardcoded machine path')));
      assert.ok(res.violations.some((v) => v.includes('scripts/bad-helper.mjs') && v.includes('hardcoded machine path')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
