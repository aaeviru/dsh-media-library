#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface LintRulesResult {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

function walkFiles(
  dir: string,
  predicate: (full: string, name: string) => boolean,
  acc: string[] = [],
): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(full, predicate, acc);
    } else if (ent.isFile() && predicate(full, ent.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function isCommentLine(line: string): boolean {
  return /^\s*(?:\/\*|\*|\/\/|\{\/\*)/.test(line);
}

/**
 * Run deterministic zero-dependency static lint rules against `repoRoot` (Issue #28).
 */
export function runLintRules(repoRoot: string): LintRulesResult {
  const violations: string[] = [];
  const rel = (abs: string): string => path.relative(repoRoot, abs).replace(/\\/g, '/');

  // 1. Client UI rules: zero hardcoded colors, zero native <select>, zero raw UNC literals / RPC tempPath payloads.
  const clientFiles = walkFiles(
    path.join(repoRoot, 'src', 'client'),
    (_full, name) => /\.(tsx?|css)$/.test(name),
  );
  for (const file of clientFiles) {
    const relPath = rel(file);
    const isTsx = file.endsWith('.tsx');
    const isCode = /\.(tsx?)$/.test(file);
    const isLocales = relPath === 'src/client/locales.ts';
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (/#[0-9a-fA-F]{3,8}\b/.test(line) || /\brgba?\s*\(/.test(line)) {
        violations.push(`${relPath}:${idx + 1} hardcoded color: ${line.trim()}`);
      }
      if (isTsx && /<select\b/.test(line) && !isCommentLine(line)) {
        violations.push(`${relPath}:${idx + 1} forbidden native <select> (Issue #28 / #47 B3): ${line.trim()}`);
      }
      if (isCode && !isCommentLine(line)) {
        if (!isLocales && /['"`]\\\\[^'"`\s]+/.test(line)) {
          violations.push(`${relPath}:${idx + 1} forbidden raw UNC literal in client code (Issue #28): ${line.trim()}`);
        }
        if (/\bmediaLibrary\.[A-Za-z0-9_]+\s*\([^)]*\b(?:tempPath|uncPath)\s*:/.test(line)) {
          violations.push(`${relPath}:${idx + 1} forbidden raw path field in client RPC call (Issue #28 / #29): ${line.trim()}`);
        }
      }
    });
  }

  // 2. Machine absolute path rule across src/, scripts/*.{ts,mjs}, and tsconfig.test.json.
  const machinePathFiles = [
    ...walkFiles(path.join(repoRoot, 'src'), (_full, name) => /\.(tsx?|css)$/.test(name)),
    ...walkFiles(path.join(repoRoot, 'scripts'), (_full, name) => /\.(mjs|ts)$/.test(name)),
  ];
  const tsconfigTestPath = path.join(repoRoot, 'tsconfig.test.json');
  if (fs.existsSync(tsconfigTestPath)) {
    machinePathFiles.push(tsconfigTestPath);
  }
  const machinePathRe = /(?:\/home\/[A-Za-z0-9._-]+\/|C:\\\\Users\\\\|C:\/Users\/)/i;
  for (const file of machinePathFiles) {
    const relPath = rel(file);
    if (relPath === 'scripts/lint-rules.ts') continue;
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (!isCommentLine(line) && machinePathRe.test(line)) {
        violations.push(`${relPath}:${idx + 1} forbidden hardcoded machine path (Issue #28): ${line.trim()}`);
      }
    });
  }

  return { ok: violations.length === 0, violations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const res = runLintRules(repoRoot);
  if (!res.ok) {
    console.error('Static lint rules gate failed:\n' + res.violations.join('\n'));
    process.exit(1);
  }
  console.log('Static lint rules gate passed (0 hardcoded colors, 0 native <select>, 0 client UNC/RPC raw paths, 0 machine paths).');
}
