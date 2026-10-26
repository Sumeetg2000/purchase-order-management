import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AppPrismaClient } from '../../src/db/client.js';
import { createApp } from '../../src/http/app.js';
import { productionRoutes } from '../../src/http/routes/index.js';
import { testLogger } from '../support/log-capture.js';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/** Every source file the given entry reaches through relative imports. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const [, spec] of text.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)) {
      const target = join(dirname(file), spec ?? '').replace(/\.js$/, '.ts');
      if (existsSync(target)) visit(target);
    }
  };
  visit(join(SRC, entry));
  return new Set([...seen].map((file) => relative(SRC, file)));
}

describe('[FR-ADM-05] operator code is unreachable over HTTP', () => {
  it('[FR-ADM-05] the API server reaches no CLI or bootstrap code', () => {
    // The guarded code exists, so the check below is not vacuous.
    expect(existsSync(join(SRC, 'cli/run.ts'))).toBe(true);
    expect(existsSync(join(SRC, 'bootstrap/run.ts'))).toBe(true);
    const files = [...reachable('server.ts')];
    expect(files).toContain('http/routes/index.ts');
    expect(files.filter((f) => f.startsWith('cli/') || f.startsWith('bootstrap/'))).toEqual([]);
  });

  it('[FR-ADM-05] the public app has no /metrics route', async () => {
    const app = createApp({
      logger: testLogger(),
      appOrigin: 'http://localhost:8080',
      routes: productionRoutes({ prisma: {} as AppPrismaClient, expectedMigrations: [] }),
    });
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(404);
    expect((res.body as { code?: string }).code).toBe('NOT_FOUND');
  });
});
