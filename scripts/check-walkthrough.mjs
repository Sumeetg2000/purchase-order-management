#!/usr/bin/env node
// The walkthrough check (ADR-0013, amended 2026-11-26): every repository path that
// docs/walkthrough.md names in backticks must exist, so its answers can't point at code,
// tests or committed plans that have moved or gone. API routes (`/api/…`), codes and URLs
// aren't paths; a `:line` or `#anchor` suffix is dropped before the check.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TOP_LEVEL = /^(backend|frontend|packages|docs|scripts|specs|deploy|\.github)\//;

/** The repository paths a document names in backticks, with their line numbers. */
export function namedPaths(markdown) {
  return markdown.split('\n').flatMap((text, i) =>
    [...text.matchAll(/`([^`\s]+)`/g)]
      .map(([, token]) => token.replace(/[#:].*$/, ''))
      .filter((token) => TOP_LEVEL.test(token))
      .map((path) => ({ path, line: i + 1 })),
  );
}

/** The named paths that don't exist. */
export function missingPaths(markdown, exists) {
  return namedPaths(markdown).filter(({ path }) => !exists(path));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = 'docs/walkthrough.md';
  const missing = missingPaths(readFileSync(join(ROOT, file), 'utf8'), (path) =>
    existsSync(join(ROOT, path)),
  );
  for (const { path, line } of missing)
    console.error(`${file}:${String(line)}: ${path} does not exist`);
  if (missing.length > 0) process.exit(1);
  console.log(
    `check-walkthrough: ok (${String(namedPaths(readFileSync(join(ROOT, file), 'utf8')).length)} paths)`,
  );
}
