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

function skipWhitespaceAndComments(source: string, start: number): number {
  let k = start;
  while (k < source.length) {
    const c = source[k]!;
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      k++;
      continue;
    }
    if (c === '/' && source[k + 1] === '/') {
      k += 2;
      while (k < source.length && source[k] !== '\n') k++;
      continue;
    }
    if (c === '/' && source[k + 1] === '*') {
      k += 2;
      while (k < source.length && !(source[k] === '*' && source[k + 1] === '/')) k++;
      if (k < source.length) k += 2;
      continue;
    }
    break;
  }
  return k;
}

/**
 * Strip JS/TS comments while preserving newline positions, and blank out string/template contents
 * except for quoted object property keys `'tempPath'`, `"tempPath"`, `'uncPath'`, `"uncPath"`
 * (even when whitespace or comments appear before `:`). Blanking all other quoted keys ensures
 * characters like `}` inside `{ "}": 0, tempPath }` can never disrupt brace balancing.
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
    // Regex literal (e.g. /[/*]/): skip so /* or quotes inside a regex never masquerade as comments/strings.
    if (ch === '/' && next !== '/' && next !== '*') {
      let prevIdx = i - 1;
      while (prevIdx >= 0 && (source[prevIdx] === ' ' || source[prevIdx] === '\t')) prevIdx--;
      const prevChar = prevIdx >= 0 ? source[prevIdx]! : '';
      if (!prevChar || '=(,[{:;!&|?+-*%^~<>\n\r'.includes(prevChar)) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < source.length && source[j] !== '\n') {
          const rc = source[j]!;
          if (rc === '\\') {
            j += 2;
            continue;
          }
          if (rc === '[') {
            inClass = true;
          } else if (rc === ']') {
            inClass = false;
          } else if (rc === '/' && !inClass) {
            j++;
            closed = true;
            break;
          }
          j++;
        }
        if (closed) {
          out += ' '.repeat(j - i);
          i = j;
          continue;
        }
      }
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
      const inner = source.slice(i + 1, Math.max(i + 1, j - 1));
      // Peek ahead past whitespace and comments: preserve only forbidden quoted property keys followed by ':'.
      const k = skipWhitespaceAndComments(source, j);
      if (quote !== '`' && (inner === 'tempPath' || inner === 'uncPath') && source[k] === ':') {
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
 * Find the matching closing `}` index for the `{` at `openBraceIdx` in sanitized source.
 */
function findBalancedBlockEnd(source: string, openBraceIdx: number): number {
  let depth = 0;
  for (let i = openBraceIdx; i < source.length; i++) {
    const c = source[i]!;
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Check whether any top-level property key in an RPC payload object body is `tempPath` or `uncPath`
 * (explicit key, quoted key, or shorthand property), ignoring values such as ternary expressions.
 */
function hasForbiddenPayloadKey(objectBody: string): boolean {
  const segments: string[] = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let segStart = 0;
  for (let i = 0; i < objectBody.length; i++) {
    const c = objectBody[i]!;
    if (c === '{') braceDepth++;
    else if (c === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (c === '(') parenDepth++;
    else if (c === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (c === '[') bracketDepth++;
    else if (c === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (c === ',' && braceDepth === 0 && parenDepth === 0 && bracketDepth === 0) {
      segments.push(objectBody.slice(segStart, i));
      segStart = i + 1;
    }
  }
  segments.push(objectBody.slice(segStart));

  const explicitForbiddenKeyRe = /^(?:(['"])(tempPath|uncPath)\1|(tempPath|uncPath))\s*:/;
  const shorthandForbiddenKeyRe = /^(?:tempPath|uncPath)$/;

  for (const rawSeg of segments) {
    const seg = rawSeg.trim();
    if (!seg || seg.startsWith('...')) continue;
    if (explicitForbiddenKeyRe.test(seg) || shorthandForbiddenKeyRe.test(seg)) {
      return true;
    }
  }
  return false;
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
  // String.raw`...` templates represent literal backslashes directly (\\server\share), including multiline templates.
  const stringRawUncLiteralRe = /\bString\.raw`[^`]*?\\\\[A-Za-z0-9._-]+\\[A-Za-z0-9._-]+[^`]*?`/g;
  const rpcCallStartRe = /\bmediaLibrary\.[A-Za-z0-9_]+\s*\(\s*\{/g;

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
        if (ordinaryUncLiteralRe.test(line)) {
          violations.push(`${relPath}:${idx + 1} forbidden raw UNC literal in client code (Issue #28): ${line.trim()}`);
        }
      }
    });

    if (isCode && !isLocales) {
      stringRawUncLiteralRe.lastIndex = 0;
      let rawMatch: RegExpExecArray | null;
      while ((rawMatch = stringRawUncLiteralRe.exec(content)) !== null) {
        const lineNo = lineNumberAt(content, rawMatch.index);
        if (isCommentLine(lines[lineNo - 1] ?? '')) continue;
        violations.push(
          `${relPath}:${lineNo} forbidden raw UNC literal in client code (Issue #28): ${rawMatch[0].replace(/\s+/g, ' ').trim()}`,
        );
      }
    }

    if (isCode) {
      const sanitized = sanitizeForRpcKeyScan(content);
      rpcCallStartRe.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = rpcCallStartRe.exec(sanitized)) !== null) {
        const openBraceIdx = match.index + match[0].length - 1;
        const closeBraceIdx = findBalancedBlockEnd(sanitized, openBraceIdx);
        if (closeBraceIdx === -1) continue;
        const objectBody = sanitized.slice(openBraceIdx + 1, closeBraceIdx);
        if (hasForbiddenPayloadKey(objectBody)) {
          const lineNo = lineNumberAt(sanitized, match.index);
          const snippet = sanitized.slice(match.index, closeBraceIdx + 1).replace(/\s+/g, ' ').trim();
          violations.push(
            `${relPath}:${lineNo} forbidden raw path field in client RPC call (Issue #28 / #29): ${snippet}`,
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
