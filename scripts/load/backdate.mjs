// The load test's age shift (specs/008-outstanding-report/research.md R7; ADR-0012,
// amended 2026-11-26, owner guards). Orders raised in one run are all approved today; to
// give the report a spread of ages, each order's own times are moved back by its planned
// days in one transaction with triggers off, on the isolated po-load stack only. Receipts
// move with their order, so every ordering the rules check still holds; audit entries keep
// their real times. Reconciliation runs right after, and any row fails the run.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LOAD_PROJECT = 'po-load';
const DATABASE = 'po';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECONCILIATION_SQL = fileURLToPath(
  new URL('../../backend/src/db/reconciliation.sql', import.meta.url),
);

/** POSTGRES_PASSWORD from the stack's throwaway env file (scripts/ci-env.sh). */
function superuserPassword(envFile) {
  const line = readFileSync(envFile, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('POSTGRES_PASSWORD='));
  const password = line?.slice('POSTGRES_PASSWORD='.length).trim();
  if (!password) throw new Error(`backdate: no POSTGRES_PASSWORD in the env file`);
  return password;
}

/** The one running db container of the po-load project, or a refusal. */
function loadDbContainer(docker) {
  const result = spawnSync(
    docker,
    [
      'ps',
      '--quiet',
      '--filter',
      `label=com.docker.compose.project=${LOAD_PROJECT}`,
      '--filter',
      'label=com.docker.compose.service=db',
    ],
    { encoding: 'utf8' },
  );
  const ids = (result.stdout ?? '').split('\n').filter(Boolean);
  if (result.status !== 0 || ids.length !== 1) {
    throw new Error(
      `backdate: expected one running db container in compose project ${LOAD_PROJECT}, ` +
        `found ${String(ids.length)}. Refusing to change any database.`,
    );
  }
  return ids[0];
}

/** psql as the superuser in the container; the password travels only in the environment. */
function psql(docker, container, password, sql) {
  const result = spawnSync(
    docker,
    [
      'exec',
      '-i',
      '-e',
      'PGPASSWORD',
      container,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      'postgres',
      '-d',
      DATABASE,
      '-v',
      'ON_ERROR_STOP=1',
      '-X',
      '-q',
      '-A',
      '-t',
    ],
    { input: sql, encoding: 'utf8', env: { ...process.env, PGPASSWORD: password } },
  );
  if (result.status !== 0) {
    throw new Error(`backdate: psql failed: ${(result.stderr ?? '').replaceAll(password, '***')}`);
  }
  return result.stdout ?? '';
}

/** The shift: one transaction, triggers off, each order's own times back by its days. */
export function shiftSql(ages) {
  const values = ages
    .map(({ orderId, days }) => `('${orderId}'::uuid, ${String(days)})`)
    .join(',\n    ');
  return `BEGIN;
SET LOCAL session_replication_role = replica;
CREATE TEMP TABLE load_ages (order_id uuid PRIMARY KEY, days int NOT NULL) ON COMMIT DROP;
INSERT INTO load_ages VALUES
    ${values};
UPDATE purchase_orders o
   SET created_at = o.created_at - a.days * interval '1 day',
       submitted_at = o.submitted_at - a.days * interval '1 day',
       approved_at = o.approved_at - a.days * interval '1 day',
       cancelled_at = o.cancelled_at - a.days * interval '1 day'
  FROM load_ages a WHERE o.id = a.order_id;
UPDATE approval_rounds r
   SET submitted_at = r.submitted_at - a.days * interval '1 day',
       closed_at = r.closed_at - a.days * interval '1 day'
  FROM load_ages a WHERE r.order_id = a.order_id;
UPDATE approval_steps s
   SET decided_at = s.decided_at - a.days * interval '1 day',
       voided_at = s.voided_at - a.days * interval '1 day'
  FROM load_ages a WHERE s.order_id = a.order_id;
UPDATE goods_receipts g
   SET received_on = g.received_on - a.days,
       recorded_at = g.recorded_at - a.days * interval '1 day'
  FROM load_ages a WHERE g.order_id = a.order_id;
COMMIT;
`;
}

/**
 * Shifts the orders' ages on the po-load stack, then reconciles. `ages`:
 * [{ orderId, days }]. Throws (changing nothing) unless every guard holds.
 */
export async function backdate({
  projectName,
  envFile,
  ages,
  docker = 'docker',
  log = console.info,
}) {
  if (projectName !== LOAD_PROJECT) {
    throw new Error(
      `backdate: COMPOSE_PROJECT_NAME is ${String(projectName)}, not ${LOAD_PROJECT}. Refusing.`,
    );
  }
  for (const { orderId, days } of ages) {
    if (!UUID.test(String(orderId)) || !Number.isInteger(days) || days < 0) {
      throw new Error(`backdate: bad age ${JSON.stringify({ orderId, days })}`);
    }
  }
  const container = loadDbContainer(docker);
  const password = superuserPassword(envFile);
  psql(docker, container, password, shiftSql(ages));
  log(`backdate: shifted ${String(ages.length)} orders on ${LOAD_PROJECT}`);
  const rows = psql(docker, container, password, readFileSync(RECONCILIATION_SQL, 'utf8')).trim();
  if (rows !== '') {
    throw new Error(`backdate: reconciliation returned rows after the shift:\n${rows}`);
  }
  log('backdate: reconciliation clean');
}
