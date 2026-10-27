#!/usr/bin/env node
// The requirement-ID ban (ADR-0013, research R20). Requirement and task IDs belong in test
// names only, so this scans every tracked file except tests, docs/ and specs/ and fails on
// any ID not covered by scripts/requirement-id-allowlist.txt.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bannedIds } from './lib/requirement-ids.mjs';

const EXCLUDED = [/(^|\/)[^/]*\.(test|spec)\.[^/]+$/, /^docs\//, /^specs\//];

export function isExcluded(path) {
  return EXCLUDED.some((pattern) => pattern.test(path));
}

/**
 * Allowlist lines: `path token` allows one token in one file; `dir/` allows everything
 * under a directory. `#` starts a comment.
 */
export function parseAllowlist(text) {
  const entries = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [path, token, ...rest] = line.split(/\s+/);
    if (rest.length > 0 || (token === undefined && !path.endsWith('/'))) {
      throw new Error(`requirement-id allowlist: bad entry "${line}"`);
    }
    entries.push({ path, token });
  }
  return entries;
}

function allowed(allowlist, path, match) {
  return allowlist.some((entry) =>
    entry.token === undefined
      ? path.startsWith(entry.path)
      : entry.path === path && entry.token === match,
  );
}

/** Every banned ID in the given files (paths relative to root), with its line. */
export function checkFiles({ root, files, allowlist }) {
  const violations = [];
  for (const path of files) {
    if (isExcluded(path)) continue;
    let text;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch {
      continue; // deleted in the working tree, or not a regular file
    }
    if (text.includes('\0')) continue; // binary
    for (const { match, index } of bannedIds(text)) {
      if (allowed(allowlist, path, match)) continue;
      const line = text.slice(0, index).split('\n').length;
      violations.push({ path, line, match });
    }
  }
  return violations;
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const allowlist = parseAllowlist(
    readFileSync(join(root, 'scripts/requirement-id-allowlist.txt'), 'utf8'),
  );
  const violations = checkFiles({ root, files, allowlist });
  for (const v of violations) console.error(`${v.path}:${String(v.line)}: ${v.match}`);
  if (violations.length > 0) {
    console.error(
      `check-requirement-ids: ${String(violations.length)} ID(s) outside test names (ADR-0013)`,
    );
    process.exit(1);
  }
  console.log(`check-requirement-ids: ok (${String(files.length)} tracked files)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
