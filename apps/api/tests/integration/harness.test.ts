import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../support/db.js';
import { trackDatabase } from '../support/setup.js';

describe('[NFR-AUD-02] test database harness', () => {
  it('gives each test its own migrated database reachable as po_app', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');

    const who = await app.query<{ current_user: string; db: string }>(
      'SELECT current_user, current_database() AS db',
    );
    expect(who.rows[0]).toEqual({ current_user: 'po_app', db: db.name });

    const migrations = await app.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL',
    );
    expect(Number(migrations.rows[0]?.count)).toBeGreaterThanOrEqual(1);
  });

  it('refuses CREATE TABLE as po_app', async () => {
    const db = trackDatabase(await createTestDatabase());
    const app = await db.client('po_app');
    await expect(app.query('CREATE TABLE intruder (id int)')).rejects.toThrow(
      /permission denied for schema public/,
    );
  });

  it('isolates databases between tests', async () => {
    const a = trackDatabase(await createTestDatabase());
    const b = trackDatabase(await createTestDatabase());
    expect(a.name).not.toBe(b.name);
  });
});
