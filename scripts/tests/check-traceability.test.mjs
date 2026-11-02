// The traceability check (ADR-0013, research R20): reads the matrix, the brief's section
// headings and the test runners' JSON reports, and applies the row status rules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { checkTraceability } from '../check-traceability.mjs';

const fixture = (name) =>
  readFileSync(new URL(`./fixtures/traceability/${name}`, import.meta.url), 'utf8');

const base = {
  matrix: fixture('matrix.md'),
  brief: fixture('brief.md'),
  reports: [JSON.parse(fixture('vitest.json')), JSON.parse(fixture('playwright.json'))],
};

/** A Vitest report with one extra test. */
function withTest(fullName, status = 'passed') {
  const report = JSON.parse(fixture('vitest.json'));
  report.testResults[0].assertionResults.push({
    ancestorTitles: [],
    fullName,
    title: fullName,
    status,
  });
  return report;
}

const errorsFor = (input) => checkTraceability({ ...base, ...input }).errors;

describe('[NFR-DEV-01] traceability check', () => {
  it('[NFR-DEV-01] passes on a consistent matrix, brief and reports', () => {
    assert.deepEqual(errorsFor({}), []);
  });

  it('[NFR-DEV-01] a test citing an ID that is not in the matrix fails', () => {
    const errors = errorsFor({
      reports: [withTest('[FR-XYZ-99] something unplanned'), base.reports[1]],
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /FR-XYZ-99/);
    assert.match(errors[0], /something unplanned/);
  });

  it('[NFR-DEV-01] a brief section with no row fails, at either heading level', () => {
    const errors = errorsFor({ brief: `${base.brief}\n### 3.3 Totals\n\n## 4. Data\n` });
    assert.deepEqual(
      errors.map((e) => e.match(/§[\d.]+/)?.[0]),
      ['§3.3', '§4'],
    );
  });

  it('[NFR-DEV-01] a Tested row with no test carrying its ID fails', () => {
    const matrix = base.matrix.replace('| Orders | FR-PO-01 |', '| Orders | FR-PO-02 |');
    const errors = errorsFor({
      matrix: matrix.replace('| Background | FR-BG-01 |', '| Background | FR-PO-01 |'),
    });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /FR-PO-02.*Tested/);
  });

  it('[NFR-DEV-01] a Done row whose only tests fail or are skipped fails', () => {
    const matrix = base.matrix.replace('| orders | Tested |', '| orders | Done |');
    assert.equal(errorsFor({ matrix }).length, 1);
    assert.match(errorsFor({ matrix })[0], /FR-PO-01.*Done/);

    const skipped = JSON.parse(fixture('vitest.json'));
    skipped.testResults[0].assertionResults[2].status = 'skipped';
    const errors = errorsFor({ reports: [skipped] });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /NFR-OPS-01.*Done/);
  });

  it('[NFR-DEV-01] a Done row passes on a passing Playwright test alone', () => {
    const vitest = JSON.parse(fixture('vitest.json'));
    vitest.testResults[0].assertionResults.shift();
    assert.deepEqual(errorsFor({ reports: [vitest, base.reports[1]] }), []);

    const playwright = JSON.parse(fixture('playwright.json'));
    playwright.suites[0].suites[0].specs[0].tests[0].status = 'unexpected';
    assert.match(errorsFor({ reports: [vitest, playwright] })[0] ?? '', /FR-VEN-01.*Done/);
  });

  it('[NFR-DEV-01] Todo and Spec rows are not checked for tests', () => {
    const errors = errorsFor({
      reports: [withTest('[FR-ACT-01] a failing early test', 'failed'), base.reports[1]],
    });
    assert.deepEqual(errors, []);
  });

  it('[NFR-DEV-01] an unknown status fails', () => {
    const matrix = base.matrix.replace('| none yet | Todo |', '| none yet | Finished |');
    assert.match(errorsFor({ matrix })[0] ?? '', /FR-BG-01.*Finished/);
  });

  it('[NFR-DEV-01] lists each requirement with the tests that carry it', () => {
    const { listing } = checkTraceability(base);
    assert.deepEqual(listing['FR-VEN-01'], {
      status: 'Done',
      tests: [
        { name: '[FR-VEN-01] vendor create', status: 'passed' },
        { name: '[FR-VEN-01] vendor screens a buyer adds a vendor', status: 'passed' },
      ],
    });
    assert.deepEqual(listing['FR-BG-01'], { status: 'Todo', tests: [] });
  });
});
