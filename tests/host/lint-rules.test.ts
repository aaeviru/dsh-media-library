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

  it('catches hardcoded colors, native <select>, multiline/quoted/trailing-comma RPC raw paths, UNC literals, and bare home dirs without false positives', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lint-rules-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'src', 'client'), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });

      const sampleUncLine = "export const hint = 'e.g. \\\\\\\\SynologyNAS\\\\Media';\n";

      // Allowed: locales.ts placeholder, single-backslash ordinary string, commented-out RPC, and string value containing "uncPath:".
      fs.writeFileSync(path.join(tmpDir, 'src', 'client', 'locales.ts'), sampleUncLine);
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'client', 'safe.ts'),
        [
          "export const label = '\\\\foo\\bar';",
          '// void mediaLibrary.fetchIngestionMetadata({ tempPath: x });',
          'void mediaLibrary.searchMedia({ text: "show uncPath: examples" });',
        ].join('\n') + '\n',
      );
      const cleanRes = runLintRules(tmpDir);
      assert.equal(cleanRes.ok, true, `Expected safe fixtures to pass, got:\n${cleanRes.violations.join('\n')}`);

      // Inject violations covering every form.
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'client', 'bad.module.css'),
        '.card { color: #ff00aa; background: rgba(0, 0, 0, 0.5); }\n',
      );
      fs.writeFileSync(
        path.join(tmpDir, 'src', 'client', 'BadPanel.tsx'),
        [
          sampleUncLine.trim(),
          'export const rawUnc = String.raw`\\\\NAS\\Share`;',
          'export function BadPanel(tempPath: string) {',
          '  void mediaLibrary.fetchIngestionMetadata({',
          '    tempPath,',
          '  },);',
          '  void mediaLibrary.fetchIngestionMetadata({ "tempPath": tempPath });',
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
      assert.equal(
        res.violations.filter((v) => v.includes('BadPanel.tsx') && v.includes('forbidden raw UNC literal')).length,
        2,
      );
      assert.equal(
        res.violations.filter((v) => v.includes('forbidden raw path field in client RPC call')).length,
        3,
      );
      assert.ok(res.violations.some((v) => v.includes('src/host-bad.ts') && v.includes('hardcoded machine path')));
      assert.ok(res.violations.some((v) => v.includes('scripts/bad-helper.mjs') && v.includes('hardcoded machine path')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
