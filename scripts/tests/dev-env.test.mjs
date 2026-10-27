// The developer inner loop (research R25): the host-run API gets only its own variables,
// pointed at the compose services on loopback, and the dev compose file adds nothing but
// loopback ports.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseEnv } from 'node:util';
import { parse } from 'yaml';
import { apiDevEnv, composeFileArgs } from '../dev-env.mjs';

const example = parseEnv(readFileSync(new URL('../../.env.example', import.meta.url), 'utf8'));

describe('[NFR-OPS-02] dev loop API environment', () => {
  it('[NFR-OPS-02] points DATABASE_URL at the published db as po_app', () => {
    const env = apiDevEnv(example);
    assert.equal(
      env.DATABASE_URL,
      `postgres://po_app:${example.DB_APP_PASSWORD}@127.0.0.1:5432/po`,
    );
  });

  it('[NFR-OPS-02] encodes a password that is not URL-safe', () => {
    const env = apiDevEnv({ ...example, DB_APP_PASSWORD: 'a@b/c:d' });
    assert.equal(env.DATABASE_URL, 'postgres://po_app:a%40b%2Fc%3Ad@127.0.0.1:5432/po');
  });

  it('[NFR-OPS-02] rewrites only the compose mail host to loopback', () => {
    assert.equal(apiDevEnv(example).SMTP_HOST, '127.0.0.1');
    assert.equal(
      apiDevEnv({ ...example, SMTP_HOST: 'smtp.example.com' }).SMTP_HOST,
      'smtp.example.com',
    );
  });

  it('[NFR-OPS-02] passes no other process credentials', () => {
    const env = apiDevEnv(example);
    for (const key of Object.keys(env)) {
      assert.ok(
        !/^(POSTGRES_PASSWORD|DB_.+_PASSWORD|OWNER_DATABASE_URL|MAINTENANCE_DATABASE_URL)$/.test(
          key,
        ),
        `${key} must not reach the API`,
      );
    }
    assert.equal(env.HTTP_PORT, example.HTTP_PORT);
    assert.equal(env.METRICS_PORT, example.METRICS_PORT);
  });
});

describe('[NFR-OPS-02] dev compose file', () => {
  const dev = parse(readFileSync(new URL('../../compose.dev.yaml', import.meta.url), 'utf8'));

  it('[NFR-OPS-02] only publishes the db and mail ports, on loopback', () => {
    assert.deepEqual(dev, {
      services: {
        db: { ports: ['127.0.0.1:5432:5432'] },
        mailpit: { ports: ['127.0.0.1:1025:1025'] },
      },
    });
  });

  it('[NFR-OPS-02] keeps a local override file in the stack when one exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'dev-env-'));
    assert.deepEqual(composeFileArgs(root), ['-f', 'docker-compose.yml', '-f', 'compose.dev.yaml']);
    writeFileSync(join(root, 'docker-compose.override.yml'), 'services: {}\n');
    assert.deepEqual(composeFileArgs(root), [
      '-f',
      'docker-compose.yml',
      '-f',
      'docker-compose.override.yml',
      '-f',
      'compose.dev.yaml',
    ]);
  });
});
