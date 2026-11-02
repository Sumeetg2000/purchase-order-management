// The developer inner loop (research R25). Optional: `docker compose up` stays the only
// required setup.
//
//   node scripts/dev-env.mjs services       db, migrate and Mailpit from compose, with the
//                                           dev file's loopback ports
//   node scripts/dev-env.mjs api <cmd...>   runs <cmd> with the API's variables from .env,
//                                           its hosts rewritten to 127.0.0.1
//
// The API gets only its own variables (credential separation, contracts/config.md), so
// the same config check that runs in compose runs here.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Published on loopback by compose.dev.yaml. */
const LOOPBACK = '127.0.0.1';
const DB_PORT = 5432;
/** The compose service name that a host process reaches on loopback instead. */
const MAIL_SERVICE_HOST = 'mailpit';

/** Copied from .env as compose does; DATABASE_URL is composed, SMTP_HOST rewritten. */
const COPIED_KEYS = [
  'APP_ENV',
  'APP_ORIGIN',
  'LOG_LEVEL',
  'DB_POOL_SIZE',
  'DB_TX_TIMEOUT_MS',
  'DB_TX_MAX_WAIT_MS',
  'HTTP_PORT',
  'METRICS_PORT',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'MAIL_FROM',
];

/** What a host-run process needs from the shell; nothing else is inherited. */
const SYSTEM_KEYS = ['PATH', 'HOME', 'TERM', 'LANG', 'TMPDIR', 'TZ', 'FORCE_COLOR'];

/** The API's environment for a host-run process, from the parsed .env. */
export function apiDevEnv(dotenv) {
  const env = {};
  for (const key of COPIED_KEYS) {
    if (dotenv[key] !== undefined) env[key] = dotenv[key];
  }
  const password = encodeURIComponent(dotenv.DB_APP_PASSWORD ?? '');
  env.DATABASE_URL = `postgres://po_app:${password}@${LOOPBACK}:${DB_PORT}/po`;
  env.SMTP_HOST = dotenv.SMTP_HOST === MAIL_SERVICE_HOST ? LOOPBACK : dotenv.SMTP_HOST;
  return env;
}

/** The compose files for the dev services; a local override (quickstart) stays in. */
export function composeFileArgs(root = ROOT) {
  const files = ['docker-compose.yml'];
  if (existsSync(join(root, 'docker-compose.override.yml'))) {
    files.push('docker-compose.override.yml');
  }
  files.push('compose.dev.yaml');
  return files.flatMap((file) => ['-f', file]);
}

/** Runs a command to completion, forwarding Ctrl-C; resolves to its exit code. */
function run(command, args, env) {
  const child = spawn(command, args, { cwd: ROOT, env, stdio: 'inherit' });
  const forward = (signal) => child.kill(signal);
  process.on('SIGINT', forward).on('SIGTERM', forward);
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      process.off('SIGINT', forward).off('SIGTERM', forward);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

async function main([mode, ...rest]) {
  if (mode === 'services') {
    const compose = ['compose', ...composeFileArgs()];
    // migrate runs in the foreground: `up --wait` counts a running one-shot as healthy,
    // so the API could start before the migrations finish.
    const up = await run(
      'docker',
      [...compose, 'up', '-d', '--wait', 'db', 'mailpit'],
      process.env,
    );
    if (up !== 0) return up;
    return run(
      'docker',
      [...compose, 'up', '--no-deps', '--exit-code-from', 'migrate', 'migrate'],
      process.env,
    );
  }
  if (mode === 'api' && rest.length > 0) {
    const dotenv = parseEnv(readFileSync(join(ROOT, '.env'), 'utf8'));
    const system = Object.fromEntries(
      SYSTEM_KEYS.filter((key) => process.env[key] !== undefined).map((key) => [
        key,
        process.env[key],
      ]),
    );
    return run(rest[0], rest.slice(1), { ...system, ...apiDevEnv(dotenv) });
  }
  process.stderr.write('usage: node scripts/dev-env.mjs services | api <command...>\n');
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
