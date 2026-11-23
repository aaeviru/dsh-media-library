#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Strip JS/TS comments while preserving newline positions, and replace non-key string values
 * so RPC payload key inspection never triggers on comments or string values like `query: "uncPath: x"`,
 * while still preserving quoted object keys like `{ "tempPath": x }`.
 */
function sanitizeForRpcKeyScan(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    // Single-line comment
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < source.length) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    // String or template literal
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      const literal = source.slice(i, j);
      // Peek ahead past whitespace: if followed by ':', this string is an object property key — keep it!
      let k = j;
      while (k < source.length && (source[k] === ' ' || source[k] === '\t')) k++;
      if (quote !== '`' && source[k] === ':') {
        out += literal;
      } else {
        out += quote;
        for (let m = i + 1; m < j - 1; m++) {
          out += source[m] === '\n' ? '\n' : ' ';
        }
        if (j - 1 > i) out += quote;
      }
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
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
  // Ordinary JS string literals require escaped backslashes (\\\\server\\share -> \\server\share at runtime).
  const ordinaryUncLiteralRe = /(['"`])(?:\\.|(?!\1)[^\\])*?\\\\\\\\[A-Za-z0-9._-]+\\\\[A-Za-z0-9._-]+(?:\\.|(?!\1)[^\\])*?\1/;
  // String.raw`...` templates represent literal backslashes directly (\\server\share).
  const stringRawUncLiteralRe = /\bString\.raw`[^`]*?\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9._-]+[^`]*?`/;
  const multilineRpcCallRe = /\bmediaLibrary\.[A-Za-z0-9_]+\s*\(\s*\{[\s\S]*?\}\s*,?\s*\)/g;
  const rawPathFieldRe = /(?:^|[{,\s])(?:['"]?(?:tempPath|uncPath)['"]?\s*:|(?:tempPath|uncPath)\s*[,}\n\r])/;

  for (const file of clientFiles) {
    const relPath = rel(file);
    const isTsx = file.endsWith('.tsx');
    const isCode = /\.(tsx?)$/.test(file);
    const isLocales = relPath === 'src/client/locales.ts';
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      if (/#[0-9a-fA-F]{3,8}\b/.test(line) || /\brgba?\s*\(/.test(line)) {
        violations.push(`${relPath}:${idx + 1} hardcoded color: ${line.trim()}`);
      }
      if (isTsx && /<select\b/.test(line) && !isCommentLine(line)) {
        violations.push(`${relPath}:${idx + 1} forbidden native <select> (Issue #28 / #47 B3): ${line.trim()}`);
      }
      if (isCode && !isLocales && !isCommentLine(line)) {
        if (ordinaryUncLiteralRe.test(line) || stringRawUncLiteralRe.test(line)) {
          violations.push(`${relPath}:${idx + 1} forbidden raw UNC literal in client code (Issue #28): ${line.trim()}`);
        }
      }
    });

    if (isCode) {
      const sanitized = sanitizeForRpcKeyScan(content);
      multilineRpcCallRe.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = multilineRpcCallRe.exec(sanitized)) !== null) {
        const callText = match[0];
        if (rawPathFieldRe.test(callText)) {
          const lineNo = lineNumberAt(sanitized, match.index);
          violations.push(
            `${relPath}:${lineNo} forbidden raw path field in client RPC call (Issue #28 / #29): ${callText.replace(/\s+/g, ' ').trim()}`,
          );
        }
      }
    }
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
  const machinePathRe = /(?:\/home\/[A-Za-z0-9._-]+(?:\/|['"`\s]|$)|C:\\\\Users(?:\\\\|['"`\s]|$)|C:\/Users(?:\/|['"`\s]|$))/i;
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
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const res = runLintRules(repoRoot);
  if (!res.ok) {
    console.error('Static lint rules gate failed:\n' + res.violations.join('\n'));
    process.exit(1);
  }
  console.log('Static lint rules gate passed (0 hardcoded colors, 0 native <select>, 0 client UNC/RPC raw paths, 0 machine paths).');
}
