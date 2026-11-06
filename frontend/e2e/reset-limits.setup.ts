import { execFileSync } from 'node:child_process';
import { test as setup } from '@playwright/test';

// Runs before each browser (playwright.config.ts): clears the rate-limit counters of the
// disposable end-to-end stack, so the browsers, which run one after another from the
// stack's one address, never share ADR-0017's per-IP limits. It goes straight to the
// database container; the API has no route for it. It refuses, loudly, unless the
// compose project po-e2e is running and the tests target its TLS edge.

const E2E_PROJECT = 'po-e2e';

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

/** The one running container of a service in the e2e project. */
function e2eContainer(service: string): string {
  const ids = docker(
    'ps',
    '--quiet',
    '--filter',
    `label=com.docker.compose.project=${E2E_PROJECT}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
  )
    .split('\n')
    .filter(Boolean);
  const [id] = ids;
  if (ids.length !== 1 || id === undefined) {
    throw new Error(
      `reset-limits: expected one running ${service} container in compose project ` +
        `${E2E_PROJECT}, found ${String(ids.length)}. Refusing to clear any database.`,
    );
  }
  return id;
}

setup('clear the e2e stack rate-limit counters', ({ baseURL }) => {
  const published = docker('port', e2eContainer('tls'), '8443/tcp')
    .split('\n')
    .map((binding) => binding.split(':').at(-1));
  const target = new URL(baseURL ?? 'http://unset.invalid');
  if (target.protocol !== 'https:' || !published.includes(target.port)) {
    throw new Error(
      `reset-limits: the tests target ${target.origin}, not compose project ${E2E_PROJECT}'s ` +
        `TLS edge (port ${published.join(', ')}). Refusing to clear its counters.`,
    );
  }
  const psql = ['exec', e2eContainer('db'), 'psql', '-U', 'postgres', '-d', 'po'];
  docker(...psql, '-v', 'ON_ERROR_STOP=1', '-c', 'DELETE FROM rate_limit_counters');
});
