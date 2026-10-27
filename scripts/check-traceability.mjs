#!/usr/bin/env node
// The traceability check (ADR-0013, research R20). Reads docs/traceability.md, the section
// headings of docs/BRIEF.md and the test runners' JSON reports in reports/, and fails when:
//   - a test cites an ID that isn't in the matrix
//   - a section or subsection of the brief has no row
//   - a row marked Tested has no test carrying its ID
//   - a row marked Done has no passing test carrying its ID
// Todo and Spec rows are not checked. It also writes the requirement → tests listing.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requirementIds } from './lib/requirement-ids.mjs';

const STATUSES = new Set(['Todo', 'Spec', 'Tested', 'Done']);

function cells(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Rows of every table that has an ID and a Status column. */
export function parseMatrix(markdown) {
  const rows = [];
  let header;
  for (const line of markdown.split('\n')) {
    if (!line.trim().startsWith('|')) {
      header = undefined;
      continue;
    }
    const row = cells(line);
    if (!header) {
      header = row;
      continue;
    }
    if (row.every((cell) => /^:?-+:?$/.test(cell))) continue;
    const idColumn = header.indexOf('ID');
    const statusColumn = header.indexOf('Status');
    if (idColumn === -1 || statusColumn === -1) continue;
    const briefColumn = header.indexOf('Brief');
    rows.push({
      ids: requirementIds(row[idColumn] ?? ''),
      status: row[statusColumn] ?? '',
      brief: briefColumn === -1 ? '' : (row[briefColumn] ?? ''),
      text: line.trim(),
    });
  }
  return rows;
}

/** Numbered section headings of the brief: `## 3. Title` → 3, `### 3.1 Title` → 3.1. */
export function parseBriefSections(markdown) {
  return [...markdown.matchAll(/^#{2,3}\s+(\d+(?:\.\d+)?)\.?\s/gm)].map((m) => m[1]);
}

/** Sections a row's Brief cell cites; §3.1 also covers §3. */
function citedSections(brief) {
  const cited = new Set();
  for (const [, major, minor] of brief.matchAll(/§(\d+)(?:\.(\d+))?/g)) {
    cited.add(major);
    if (minor) cited.add(`${major}.${minor}`);
  }
  return cited;
}

function vitestTests(report) {
  return report.testResults.flatMap((file) =>
    (file.assertionResults ?? []).map((test) => ({
      name: test.fullName ?? [...(test.ancestorTitles ?? []), test.title].join(' '),
      status: test.status === 'passed' ? 'passed' : test.status,
    })),
  );
}

function playwrightTests(report) {
  const found = [];
  const walk = (suite, titles) => {
    // The top-level suites are files; their titles are paths, not test names.
    const path = titles === undefined ? [] : [...titles, suite.title];
    for (const spec of suite.specs ?? []) {
      const passed =
        spec.tests.length > 0 && spec.tests.every((t) => ['expected', 'flaky'].includes(t.status));
      const skipped = spec.tests.every((t) => t.status === 'skipped');
      found.push({
        name: [...path, spec.title].join(' '),
        status: passed ? 'passed' : skipped ? 'skipped' : 'failed',
      });
    }
    for (const child of suite.suites ?? []) walk(child, path);
  };
  for (const file of report.suites ?? []) walk(file, undefined);
  return found;
}

/** Tests from a Vitest-style report (Vitest and our node:test reporter) or Playwright's. */
export function testsFromReport(report) {
  if (Array.isArray(report.testResults)) return vitestTests(report);
  if (Array.isArray(report.suites)) return playwrightTests(report);
  throw new Error('unrecognised test report format');
}

export function checkTraceability({ matrix, brief, reports }) {
  const errors = [];
  const rows = parseMatrix(matrix);
  const tests = reports.flatMap(testsFromReport);
  const known = new Set(rows.flatMap((row) => row.ids));

  for (const test of tests) {
    for (const id of new Set(requirementIds(test.name))) {
      if (!known.has(id))
        errors.push(`test "${test.name}" cites ${id}, which is not in the matrix`);
    }
  }

  const covered = new Set(rows.flatMap((row) => [...citedSections(row.brief)]));
  for (const section of parseBriefSections(brief)) {
    if (!covered.has(section)) errors.push(`brief §${section} has no row in the matrix`);
  }

  const carrying = (id) => tests.filter((test) => requirementIds(test.name).includes(id));
  const listing = {};
  for (const row of rows) {
    if (!STATUSES.has(row.status)) {
      errors.push(`${row.ids.join(', ') || row.text}: unknown status "${row.status}"`);
      continue;
    }
    for (const id of row.ids) {
      const found = carrying(id);
      listing[id] ??= { status: row.status, tests: found };
      if (row.status === 'Tested' && found.length === 0) {
        errors.push(`${id} is Tested but no test carries its ID`);
      }
      if (row.status === 'Done' && !found.some((test) => test.status === 'passed')) {
        errors.push(`${id} is Done but no passing test carries its ID`);
      }
    }
  }
  return { errors, listing };
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const reportsDir = join(root, 'reports');
  const reportFiles = readdirSync(reportsDir).filter(
    (name) => name.endsWith('.json') && name !== 'traceability.json',
  );
  if (reportFiles.length === 0) {
    console.error('check-traceability: no test reports in reports/; run the tests first');
    process.exit(1);
  }
  const { errors, listing } = checkTraceability({
    matrix: readFileSync(join(root, 'docs/traceability.md'), 'utf8'),
    brief: readFileSync(join(root, 'docs/BRIEF.md'), 'utf8'),
    reports: reportFiles.map((name) => JSON.parse(readFileSync(join(reportsDir, name), 'utf8'))),
  });
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, 'traceability.json'), `${JSON.stringify(listing, null, 2)}\n`);
  console.log(`check-traceability: read ${reportFiles.join(', ')}`);
  if (errors.length > 0) {
    for (const error of errors) console.error(`  ${error}`);
    console.error(`check-traceability: ${String(errors.length)} problem(s)`);
    process.exit(1);
  }
  console.log('check-traceability: ok (requirement → tests listing in reports/traceability.json)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
