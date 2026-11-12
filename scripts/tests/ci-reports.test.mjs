// The traceability job reads every job's test report: each report job uploads its report
// as reports-*, and traceability waits for each of those jobs, the plans included.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const workflow = (file) =>
  parse(readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'));
const ci = workflow('ci.yml');

/** The input a reusable workflow's `${{ inputs.<name> }}` refers to, from the caller. */
const resolve = (value, inputs) =>
  String(value).replace(/\$\{\{\s*inputs\.([\w-]+)\s*\}\}/g, (_, name) => inputs[name]);

/** The artifact names a job uploads, through a reusable workflow it calls. */
const uploads = (job) => {
  if (job.uses?.startsWith('./.github/workflows/')) {
    const called = workflow(job.uses.slice('./.github/workflows/'.length));
    return Object.values(called.jobs).flatMap((inner) =>
      uploads(inner).map((name) => resolve(name, job.with ?? {})),
    );
  }
  return (job.steps ?? [])
    .filter((step) => String(step.uses ?? '').startsWith('actions/upload-artifact@'))
    .map((step) => step.with.name);
};

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
