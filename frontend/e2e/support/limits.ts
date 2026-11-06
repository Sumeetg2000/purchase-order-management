import { execFileSync } from 'node:child_process';

// Clears the disposable end-to-end stack's shared rate-limit counters: the buckets keyed by
// a client address (ADR-0017), which every test shares because every request comes from
// the stack's one address. Buckets keyed by an email or a user aren't touched: each test
// uses fresh ones, so a test that drives one to its limit (rate-limit.spec.ts) keeps its
// count whatever runs beside it. It goes straight to the database container; the API has
// no route for it. It refuses, loudly, unless compose project po-e2e is running and the
// tests target its TLS edge.

const E2E_PROJECT = 'po-e2e';

/** The per-address buckets (backend/src/rate-limit/buckets.ts). */
const SHARED_BUCKETS = ['login-ip', 'signup-ip'] as const;

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

export function resetSharedLimits(baseURL: string | undefined): void {
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
  const buckets = SHARED_BUCKETS.map((bucket) => `'${bucket}'`).join(', ');
  docker(
    ...['exec', e2eContainer('db'), 'psql', '-U', 'postgres', '-d', 'po'],
    ...['-v', 'ON_ERROR_STOP=1'],
    ...['-c', `DELETE FROM rate_limit_counters WHERE bucket IN (${buckets})`],
  );
}
