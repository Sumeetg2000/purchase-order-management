// Static checks on docker-compose.yml: exposure, credential separation and start order
// (contracts/config.md, contracts/metrics.md). Run with `node --test scripts/tests/`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const compose = parse(readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8'));
const services = compose.services ?? {};

// The variables each process may receive (contracts/config.md). The config schemas refuse
// anything else at startup; this test keeps compose from passing it in the first place.
const ALLOWED = {
  api: [
    'APP_ENV',
    'APP_ORIGIN',
    'DATABASE_URL',
    'DB_POOL_SIZE',
    'DB_TX_TIMEOUT_MS',
    'DB_TX_MAX_WAIT_MS',
    'HTTP_PORT',
    'METRICS_PORT',
    'LOG_LEVEL',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_SECURE',
    'SMTP_USER',
    'SMTP_PASSWORD',
    'MAIL_FROM',
  ],
  maintenance: ['APP_ENV', 'MAINTENANCE_DATABASE_URL', 'LOG_LEVEL', 'PURGE_INTERVAL_HOURS'],
  migrate: [
    'APP_ENV',
    'APP_ORIGIN',
    'POSTGRES_PASSWORD',
    'DB_OWNER_PASSWORD',
    'DB_APP_PASSWORD',
    'DB_MAINTENANCE_PASSWORD',
    'OWNER_DATABASE_URL',
    'DATABASE_URL',
    'LOG_LEVEL',
    'SEED_DEMO_DATA',
    'BOOTSTRAP_ADMIN_EMAIL',
    'BOOTSTRAP_ADMIN_NAME',
  ],
};

/** Compose accepts `environment` as a map or as a list of KEY=value strings. */
function environment(name) {
  const env = services[name]?.environment;
  if (Array.isArray(env)) {
    return Object.fromEntries(
      env.map((entry) => {
        const [key, ...rest] = String(entry).split('=');
        return [key, rest.join('=')];
      }),
    );
  }
  return env ?? {};
}

function dependsOn(name) {
  const deps = services[name]?.depends_on ?? {};
  return Array.isArray(deps) ? Object.fromEntries(deps.map((d) => [d, {}])) : deps;
}

describe('[NFR-OPS-01] compose services', () => {
  it('[NFR-OPS-01] defines exactly the slice 0 services', () => {
    assert.deepEqual(Object.keys(services).sort(), [
      'api',
      'db',
      'mailpit',
      'maintenance',
      'migrate',
      'web',
    ]);
  });

  it('[NFR-OPS-01] api, migrate and maintenance run the same API image', () => {
    for (const name of ['api', 'migrate', 'maintenance']) {
      assert.equal(services[name].build?.dockerfile, 'deploy/api.Dockerfile', name);
      assert.equal(services[name].build?.context, '.', name);
    }
    assert.equal(services.web.build?.dockerfile, 'deploy/web.Dockerfile');
  });
});

describe('[NFR-OPS-02] compose exposure', () => {
  it('[NFR-OPS-03] only web publishes a port, apart from Mailpit locally', () => {
    for (const [name, service] of Object.entries(services)) {
      if (name === 'web' || name === 'mailpit') continue;
      assert.equal(service.ports, undefined, `${name} must not publish ports`);
    }
    assert.deepEqual(services.web.ports, ['${WEB_PORT}:8080']);
  });

  it('[NFR-OPS-04] Mailpit publishes its UI on 127.0.0.1:8025 only, under the local profile', () => {
    assert.deepEqual(services.mailpit.profiles, ['local']);
    assert.deepEqual(services.mailpit.ports, ['127.0.0.1:8025:8025']);
  });

  it('[NFR-OPS-02] api exposes the metrics port inside the network only', () => {
    assert.deepEqual(services.api.expose, ['9464']);
    assert.equal(services.api.ports, undefined);
  });
  it('[NFR-OPS-03] api listens on the ports the edge proxies to and compose exposes', () => {
    const nginx = readFileSync(new URL('../../deploy/nginx/default.conf', import.meta.url), 'utf8');
    const env = environment('api');
    assert.equal(String(env.HTTP_PORT), '3000');
    assert.equal(String(env.METRICS_PORT), '9464');
    assert.match(nginx, /http:\/\/api:3000\b/);
    assert.deepEqual(services.api.expose, [String(env.METRICS_PORT)]);
  });
});

describe('[NFR-OPS-02] edge forwarding headers', () => {
  const nginx = readFileSync(new URL('../../deploy/nginx/default.conf', import.meta.url), 'utf8');

  it('[NFR-OPS-02] the edge replaces X-Forwarded-For with the connecting address', () => {
    assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
    assert.doesNotMatch(nginx, /\$proxy_add_x_forwarded_for/);
  });
});

describe('[NFR-OPS-02] container privileges', () => {
  const built = Object.entries(services).filter(([, service]) => service.build);

  it('[NFR-OPS-02] covers every service built from this repository', () => {
    assert.deepEqual(built.map(([name]) => name).sort(), ['api', 'maintenance', 'migrate', 'web']);
  });

  for (const [name, service] of built) {
    it(`[NFR-OPS-02] ${name} cannot gain privileges and drops every capability`, () => {
      assert.ok(service.security_opt?.includes('no-new-privileges:true'), `${name} security_opt`);
      assert.deepEqual(service.cap_drop, ['ALL'], `${name} cap_drop`);
    });
  }
});

describe('[NFR-OPS-05] compose credential separation', () => {
  it('[NFR-OPS-05] no service reads a shared env_file', () => {
    for (const [name, service] of Object.entries(services)) {
      assert.equal(service.env_file, undefined, `${name} must not use env_file`);
    }
  });

  for (const [name, allowed] of Object.entries(ALLOWED)) {
    it(`[NFR-OPS-05] ${name} receives only its allowed variables`, () => {
      const keys = Object.keys(environment(name));
      assert.ok(keys.length > 0, `${name} needs an explicit environment list`);
      const extra = keys.filter((key) => !allowed.includes(key));
      assert.deepEqual(extra, [], `${name} receives variables it must not have`);
    });
  }

  it('[NFR-OPS-05] migrate gets DATABASE_URL for the bootstrap and never the maintenance URL', () => {
    const env = environment('migrate');
    assert.ok('DATABASE_URL' in env);
    assert.ok('OWNER_DATABASE_URL' in env);
    assert.ok(!('MAINTENANCE_DATABASE_URL' in env));
  });

  it('[NFR-OPS-05] each composed URL names its own role and password', () => {
    const app = /^postgres(ql)?:\/\/po_app:\$\{DB_APP_PASSWORD\}@db:5432\/po$/;
    const owner = /^postgres(ql)?:\/\/po_owner:\$\{DB_OWNER_PASSWORD\}@db:5432\/po$/;
    const maint = /^postgres(ql)?:\/\/po_maintenance:\$\{DB_MAINTENANCE_PASSWORD\}@db:5432\/po$/;
    assert.match(environment('api').DATABASE_URL, app);
    assert.match(environment('migrate').DATABASE_URL, app);
    assert.match(environment('migrate').OWNER_DATABASE_URL, owner);
    assert.match(environment('maintenance').MAINTENANCE_DATABASE_URL, maint);
  });

  it('[NFR-OPS-05] the database container receives only the superuser password', () => {
    const keys = Object.keys(environment('db'));
    assert.ok(keys.includes('POSTGRES_PASSWORD'));
    assert.deepEqual(
      keys.filter((key) => /PASSWORD|_URL$/.test(key) && key !== 'POSTGRES_PASSWORD'),
      [],
    );
  });
});

describe('[NFR-OPS-01] compose start order and health', () => {
  it('[NFR-OPS-01] migrate waits for a healthy database', () => {
    assert.equal(dependsOn('migrate').db?.condition, 'service_healthy');
    assert.match(JSON.stringify(services.db.healthcheck?.test), /pg_isready/);
  });

  it('[NFR-OPS-01] api and maintenance wait for migrate to complete successfully', () => {
    for (const name of ['api', 'maintenance']) {
      assert.equal(dependsOn(name).migrate?.condition, 'service_completed_successfully', name);
    }
  });

  it('[NFR-OPS-01] api is health-checked on /healthz and web waits for it', () => {
    assert.match(JSON.stringify(services.api.healthcheck?.test), /wget.*\/healthz/);
    assert.equal(dependsOn('web').api?.condition, 'service_healthy');
  });

  it('[NFR-OPS-01] migrate is one-shot and the long-running services restart', () => {
    assert.ok([undefined, 'no'].includes(services.migrate.restart));
    for (const name of ['db', 'api', 'web', 'maintenance']) {
      assert.equal(services[name].restart, 'unless-stopped', name);
    }
  });
});
