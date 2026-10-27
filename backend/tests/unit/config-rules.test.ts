import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apiConfig } from '../../src/config/api.js';
import { cliConfig } from '../../src/config/cli.js';
import { loadConfig } from '../../src/config/load.js';
import { maintenanceConfig } from '../../src/config/maintenance.js';
import { migrateConfig } from '../../src/config/migrate.js';
import type { ProcessConfig } from '../../src/config/rules.js';

type Env = Record<string, string | undefined>;

function run(config: ProcessConfig, env: Env) {
  const lines: string[] = [];
  let exitCode: number | undefined;
  const result = loadConfig(config.schema, env, {
    write: (line) => lines.push(line),
    exit: (code) => {
      exitCode = code;
    },
  });
  return { result, output: lines.join('\n'), exitCode };
}

// Low-entropy placeholders: long enough for the length rules, obviously fake.
const appUrl = 'postgres://po_app:xxxx-app-xxxx-xxxx@db:5432/po';
const ownerUrl = 'postgres://po_owner:xxxx-owner-xxxx-xxxx@db:5432/po';
const maintUrl = 'postgres://po_maintenance:xxxx-maint-xxxx-xxxx@db:5432/po';

const apiEnv: Env = {
  APP_ENV: 'local',
  APP_ORIGIN: 'http://localhost:8080',
  DATABASE_URL: appUrl,
  DB_POOL_SIZE: '10',
  DB_TX_TIMEOUT_MS: '5000',
  DB_TX_MAX_WAIT_MS: '2000',
  HTTP_PORT: '3000',
  METRICS_PORT: '9464',
  LOG_LEVEL: 'info',
  SMTP_HOST: 'mailpit',
  SMTP_PORT: '1025',
  SMTP_SECURE: 'false',
  SMTP_USER: '',
  SMTP_PASSWORD: '',
  MAIL_FROM: 'no-reply@example.local',
};

const cliEnv: Env = {
  APP_ENV: 'local',
  APP_ORIGIN: 'http://localhost:8080',
  DATABASE_URL: appUrl,
  LOG_LEVEL: 'info',
};

const migrateEnv: Env = {
  APP_ENV: 'local',
  APP_ORIGIN: 'http://localhost:8080',
  POSTGRES_PASSWORD: 'xxxx-postgres-xxxx',
  DB_OWNER_PASSWORD: 'xxxx-owner-xxxx-xxxx',
  DB_APP_PASSWORD: 'xxxx-app-xxxx-xxxx',
  DB_MAINTENANCE_PASSWORD: 'xxxx-maint-xxxx-xxxx',
  OWNER_DATABASE_URL: ownerUrl,
  DATABASE_URL: appUrl,
  LOG_LEVEL: 'info',
  SEED_DEMO_DATA: 'true',
  BOOTSTRAP_ADMIN_EMAIL: 'admin@example.local',
  BOOTSTRAP_ADMIN_NAME: 'Local Admin',
};

const maintenanceEnv: Env = {
  APP_ENV: 'local',
  MAINTENANCE_DATABASE_URL: maintUrl,
  LOG_LEVEL: 'info',
  PURGE_INTERVAL_HOURS: '24',
};

const processes: [ProcessConfig, Env][] = [
  [apiConfig, apiEnv],
  [cliConfig, cliEnv],
  [migrateConfig, migrateEnv],
  [maintenanceConfig, maintenanceEnv],
];

function expectRefused(config: ProcessConfig, env: Env, key: string) {
  const { output, exitCode, result } = run(config, env);
  expect(exitCode).toBe(1);
  expect(result).toBeUndefined();
  expect(output).toMatch(new RegExp(`^\\s*${key}: .+`, 'm'));
  return output;
}

describe('[NFR-OPS-02] config rules: valid local configuration', () => {
  const cases = processes.map(([config, env]) => ({ process: config.process, config, env }));
  it.each(cases)('[NFR-OPS-02] $process starts with its local variables', ({ config, env }) => {
    const { exitCode, output } = run(config, env);
    expect(output).toBe('');
    expect(exitCode).toBeUndefined();
  });

  it('[NFR-OPS-02] parses booleans strictly and treats empty optional values as unset', () => {
    const { result } = run(apiConfig, apiEnv);
    expect(result).toMatchObject({ SMTP_SECURE: false, HTTP_PORT: 3000, METRICS_PORT: 9464 });
    expect(result).not.toHaveProperty('SMTP_USER', '');
    expect(run(apiConfig, { ...apiEnv, SMTP_SECURE: 'yes' }).exitCode).toBe(1);
  });

  it('[NFR-OPS-02] lower-cases the bootstrap admin email', () => {
    const { result } = run(migrateConfig, {
      ...migrateEnv,
      BOOTSTRAP_ADMIN_EMAIL: 'Admin@Example.Local',
    });
    expect(result).toMatchObject({ BOOTSTRAP_ADMIN_EMAIL: 'admin@example.local' });
  });

  it('[NFR-OPS-02] keeps only the keys the process reads', () => {
    const { result } = run(cliConfig, { ...cliEnv, PATH: '/usr/bin', HOME: '/home/x' });
    expect(Object.keys(result ?? {}).sort()).toEqual([...cliConfig.keys].sort());
  });
});

describe('[NFR-OPS-02] config rules: production refusals', () => {
  it('[NFR-OPS-02] refuses SEED_DEMO_DATA=true in production', () => {
    expectRefused(migrateConfig, { ...migrateEnv, APP_ENV: 'production' }, 'SEED_DEMO_DATA');
    const ok = run(migrateConfig, {
      ...migrateEnv,
      APP_ENV: 'production',
      SEED_DEMO_DATA: 'false',
    });
    expect(ok.exitCode).toBeUndefined();
  });

  it('[NFR-OPS-02] refuses SMTP_HOST=mailpit in production', () => {
    expectRefused(apiConfig, { ...apiEnv, APP_ENV: 'production' }, 'SMTP_HOST');
    const ok = run(apiConfig, { ...apiEnv, APP_ENV: 'production', SMTP_HOST: 'smtp.example.com' });
    expect(ok.exitCode).toBeUndefined();
  });

  it('[NFR-OPS-02] refuses a change-me- secret in production, naming the key only', () => {
    const output = expectRefused(
      migrateConfig,
      {
        ...migrateEnv,
        APP_ENV: 'production',
        SEED_DEMO_DATA: 'false',
        DB_APP_PASSWORD: 'change-me-app-local-only',
        DATABASE_URL: 'postgres://po_app:change-me-app-local-only@db:5432/po',
      },
      'DB_APP_PASSWORD',
    );
    expect(output).not.toContain('change-me-app-local-only');
  });

  it('[NFR-OPS-02] refuses a change-me- password embedded in a database URL in production', () => {
    const output = expectRefused(
      apiConfig,
      {
        ...apiEnv,
        APP_ENV: 'production',
        SMTP_HOST: 'smtp.example.com',
        DATABASE_URL: 'postgres://po_app:change-me-app-local-only@db:5432/po',
      },
      'DATABASE_URL',
    );
    expect(output).not.toContain('change-me-app-local-only');
  });

  it('[NFR-OPS-02] allows change-me- placeholders outside production', () => {
    const { exitCode } = run(migrateConfig, {
      ...migrateEnv,
      DB_APP_PASSWORD: 'change-me-app-local-only',
      DATABASE_URL: 'postgres://po_app:change-me-app-local-only@db:5432/po',
    });
    expect(exitCode).toBeUndefined();
  });
});

describe('[NFR-OPS-02] config rules: credential separation', () => {
  const apiCliForbidden = [
    ['OWNER_DATABASE_URL', ownerUrl],
    ['POSTGRES_PASSWORD', 'xxxx-postgres-xxxx'],
    ['MAINTENANCE_DATABASE_URL', maintUrl],
    ['DB_OWNER_PASSWORD', 'xxxx-owner-xxxx-xxxx'],
    ['DB_APP_PASSWORD', 'xxxx-app-xxxx-xxxx'],
    ['DB_MAINTENANCE_PASSWORD', 'xxxx-maint-xxxx-xxxx'],
    ['DB_ANYTHING_PASSWORD', 'xxxx-other-xxxx-xxxx'],
  ] as const;

  for (const [config, env] of [
    [apiConfig, apiEnv],
    [cliConfig, cliEnv],
  ] as const) {
    it.each(apiCliForbidden)(`[NFR-OPS-05] ${config.process} refuses %s`, (key, value) => {
      const output = expectRefused(config, { ...env, [key]: value }, key);
      expect(output).not.toContain(value);
    });

    it.each(['po_owner', 'postgres', 'po_maintenance'])(
      `[NFR-OPS-05] ${config.process} refuses a DATABASE_URL whose user is %s`,
      (user) => {
        const url = `postgres://${user}:xxxx-pw-xxxx-xxxx@db:5432/po`;
        const output = expectRefused(config, { ...env, DATABASE_URL: url }, 'DATABASE_URL');
        expect(output).not.toContain('xxxx-pw-xxxx-xxxx');
      },
    );
  }

  it.each([
    ['DATABASE_URL', appUrl],
    ['OWNER_DATABASE_URL', ownerUrl],
    ['POSTGRES_PASSWORD', 'xxxx-postgres-xxxx'],
    ['DB_OWNER_PASSWORD', 'xxxx-owner-xxxx-xxxx'],
    ['DB_APP_PASSWORD', 'xxxx-app-xxxx-xxxx'],
    ['DB_MAINTENANCE_PASSWORD', 'xxxx-maint-xxxx-xxxx'],
  ])('[NFR-OPS-05] maintenance refuses %s', (key, value) => {
    const output = expectRefused(maintenanceConfig, { ...maintenanceEnv, [key]: value }, key);
    expect(output).not.toContain(value);
  });

  it.each(['po_app', 'po_owner', 'postgres'])(
    '[NFR-OPS-05] maintenance refuses a MAINTENANCE_DATABASE_URL whose user is %s',
    (user) => {
      const url = `postgres://${user}:xxxx-pw-xxxx-xxxx@db:5432/po`;
      expectRefused(
        maintenanceConfig,
        { ...maintenanceEnv, MAINTENANCE_DATABASE_URL: url },
        'MAINTENANCE_DATABASE_URL',
      );
    },
  );

  it('[NFR-OPS-05] migrate refuses MAINTENANCE_DATABASE_URL', () => {
    const output = expectRefused(
      migrateConfig,
      { ...migrateEnv, MAINTENANCE_DATABASE_URL: maintUrl },
      'MAINTENANCE_DATABASE_URL',
    );
    expect(output).not.toContain(maintUrl);
  });

  it('[NFR-OPS-05] migrate refuses role URLs for the wrong user', () => {
    expectRefused(migrateConfig, { ...migrateEnv, DATABASE_URL: ownerUrl }, 'DATABASE_URL');
    expectRefused(
      migrateConfig,
      { ...migrateEnv, OWNER_DATABASE_URL: appUrl },
      'OWNER_DATABASE_URL',
    );
  });

  it('[NFR-OPS-05] migrate refuses role URLs whose password differs from the role password it provisions', () => {
    const staleOwner = 'postgres://po_owner:xxxx-stale-xxxx-xxxx@db:5432/po';
    const staleApp = 'postgres://po_app:xxxx-stale-xxxx-xxxx@db:5432/po';
    const owner = expectRefused(
      migrateConfig,
      { ...migrateEnv, OWNER_DATABASE_URL: staleOwner },
      'OWNER_DATABASE_URL',
    );
    const app = expectRefused(
      migrateConfig,
      { ...migrateEnv, DATABASE_URL: staleApp },
      'DATABASE_URL',
    );
    for (const output of [owner, app]) {
      expect(output).not.toContain('xxxx-stale-xxxx-xxxx');
      expect(output).not.toContain('xxxx-owner-xxxx-xxxx');
      expect(output).not.toContain('xxxx-app-xxxx-xxxx');
    }
  });

  it('[NFR-OPS-05] reports a forbidden variable even when other keys are also invalid', () => {
    const { output } = run(apiConfig, {
      ...apiEnv,
      HTTP_PORT: 'abc',
      POSTGRES_PASSWORD: 'xxxx-postgres-xxxx',
    });
    expect(output).toMatch(/^\s*HTTP_PORT: /m);
    expect(output).toMatch(/^\s*POSTGRES_PASSWORD: /m);
  });
});

describe('[NFR-OPS-02] config rules: values', () => {
  it('[NFR-OPS-02] refuses METRICS_PORT equal to HTTP_PORT', () => {
    expectRefused(apiConfig, { ...apiEnv, METRICS_PORT: '3000' }, 'METRICS_PORT');
  });

  it('[NFR-OPS-02] requires SMTP_USER and SMTP_PASSWORD together, or neither', () => {
    expectRefused(apiConfig, { ...apiEnv, SMTP_USER: 'mailer' }, 'SMTP_PASSWORD');
    expectRefused(apiConfig, { ...apiEnv, SMTP_PASSWORD: 'not-a-real-password' }, 'SMTP_USER');
    const { result } = run(apiConfig, {
      ...apiEnv,
      SMTP_USER: 'mailer',
      SMTP_PASSWORD: 'not-a-real-password',
    });
    expect(result).toMatchObject({ SMTP_USER: 'mailer' });
  });

  it('[NFR-OPS-02] requires the role passwords to be at least 16 characters and all different', () => {
    expectRefused(
      migrateConfig,
      { ...migrateEnv, DB_OWNER_PASSWORD: 'short' },
      'DB_OWNER_PASSWORD',
    );
    expectRefused(
      migrateConfig,
      { ...migrateEnv, DB_MAINTENANCE_PASSWORD: migrateEnv['DB_APP_PASSWORD'] },
      'DB_MAINTENANCE_PASSWORD',
    );
  });

  it.each(['http://localhost:8080/', 'localhost:8080', 'http://localhost:8080/app'])(
    '[NFR-OPS-02] refuses APP_ORIGIN %s (absolute origin, no trailing slash or path)',
    (origin) => {
      expectRefused(apiConfig, { ...apiEnv, APP_ORIGIN: origin }, 'APP_ORIGIN');
    },
  );

  it.each([
    ['APP_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['DB_POOL_SIZE', '0'],
    ['SMTP_PORT', 'smtp'],
    ['MAIL_FROM', 'not-an-email'],
  ])('[NFR-OPS-02] refuses %s=%s', (key, value) => {
    expectRefused(apiConfig, { ...apiEnv, [key]: value }, key);
  });

  it('[NFR-OPS-02] refuses a missing required key, naming it', () => {
    expectRefused(
      maintenanceConfig,
      { ...maintenanceEnv, PURGE_INTERVAL_HOURS: undefined },
      'PURGE_INTERVAL_HOURS',
    );
  });
});

describe('[NFR-OPS-01] .env.example documents every variable', () => {
  // Read by docker compose itself, not by any process (contracts/config.md).
  const composeOnly = ['COMPOSE_PROFILES', 'WEB_PORT'];

  const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
  const assigned = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1] ?? '');
  const composedLine = /^#\s*composed:\s*(.+)$/m.exec(example)?.[1] ?? '';
  const composed = composedLine
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const documented = new Set([...assigned, ...composed]);
  const read = new Set(processes.flatMap(([config]) => config.keys));

  it('[NFR-OPS-01] every key a process reads is in .env.example (assigned or composed)', () => {
    const missing = [...read].filter((key) => !documented.has(key));
    expect(missing).toEqual([]);
  });

  it('[NFR-OPS-01] .env.example has no key that no process or compose reads', () => {
    const unused = [...documented].filter((key) => !read.has(key) && !composeOnly.includes(key));
    expect(unused).toEqual([]);
  });

  it('[NFR-OPS-01] the composed URLs are not assigned in .env.example', () => {
    expect(composed.sort()).toEqual([
      'DATABASE_URL',
      'MAINTENANCE_DATABASE_URL',
      'OWNER_DATABASE_URL',
    ]);
    for (const key of composed) expect(assigned).not.toContain(key);
  });
});
