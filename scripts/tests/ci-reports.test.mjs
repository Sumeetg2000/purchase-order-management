// The traceability job reads every job's test report: each report job uploads its report
// as reports-*, and traceability waits for each of those jobs, the plans included.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const ci = parse(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));

/** The artifact names a job uploads. */
const uploads = (job) =>
  (job.steps ?? [])
    .filter((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@'))
    .map((step) => step.with.name);

describe('[NFR-DEV-01] CI test reports reach the traceability check', () => {
  it('[NFR-DEV-01] the plans job uploads its report as reports-plans', () => {
    assert.deepEqual(uploads(ci.jobs.plans), ['reports-plans']);
  });

  it('[NFR-DEV-01] traceability needs every job that uploads a reports-* artifact', () => {
    const reporters = Object.entries(ci.jobs)
      .filter(([, job]) => uploads(job).some((name) => name.startsWith('reports-')))
      .map(([id]) => id);
    assert.ok(reporters.includes('plans'));
    for (const id of reporters) assert.ok(ci.jobs.traceability.needs.includes(id), id);
  });

  it('[NFR-DEV-01] traceability still runs when the plans are skipped, never after a failure', () => {
    const condition = ci.jobs.traceability.if;
    assert.match(condition, /!cancelled\(\)/);
    assert.match(condition, /!contains\(needs\.\*\.result, 'failure'\)/);
  });
});
