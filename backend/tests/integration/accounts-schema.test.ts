import { randomBytes, randomUUID } from 'node:crypto';
import {
  ACCESS_REQUEST_MESSAGE_MAX_LENGTH,
  ACCESS_REQUEST_NOTE_MAX_LENGTH,
  ACCESS_REQUEST_STATUSES,
} from '@po/contracts';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  LOCKOUT_THRESHOLD,
  SESSION_REVOKE_REASONS,
  USER_AGENT_MAX_LENGTH,
} from '../../src/auth/constants.js';
import { RATE_LIMIT_BUCKET_NAMES } from '../../src/rate-limit/buckets.js';
import { createTestDatabase } from '../support/db.js';
import { trackDatabase } from '../support/setup.js';

// Migrations 0007–0010 (data-model.md): the slice 1 columns, CHECKs and indexes, and every
// SQL copy of a code constant pinned to that constant.

const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

async function admin(): Promise<pg.Client> {
  const db = trackDatabase(await createTestDatabase());
  return db.client('postgres');
}

async function sqlstate(client: pg.Client, sql: string, params: unknown[] = []) {
  try {
    await client.query(sql, params);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** Seeds a user as the superuser, bypassing the actor-context trigger. */
async function insertUser(client: pg.Client, status = 'ACTIVE'): Promise<string> {
  const id = randomUUID();
  await client.query('BEGIN');
  await client.query('SET LOCAL session_replication_role = replica');
  await client.query(
    `INSERT INTO users (id, name, email, roles, status, deactivated_at)
     VALUES ($1, 'Schema User', $2, '{BUYER}', $3, CASE WHEN $3 = 'DEACTIVATED' THEN now() END)`,
    [id, `${id}@example.local`, status],
  );
  await client.query('COMMIT');
  return id;
}

async function insertSession(client: pg.Client, userId: string): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO sessions (id, user_id, created_at, last_used_at, absolute_expires_at,
                           expires_at, user_agent, ip)
     VALUES ($1, $2, now(), now(), now() + interval '30 days', now() + interval '7 days',
             'test agent', '10.0.0.1')`,
    [id, userId],
  );
  return id;
}

async function constraintDef(client: pg.Client, name: string): Promise<string> {
  const { rows } = await client.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
    [name],
  );
  return rows[0]?.def ?? '';
}

/** The quoted string literals of a CHECK's IN / ANY list, in order. */
function literals(def: string): string[] {
  return [...def.matchAll(/'([^']+)'::text/g)].map(([, value]) => value ?? '');
}

async function columns(client: pg.Client, table: string) {
  const { rows } = await client.query<{ column_name: string; type: string; nullable: string }>(
    `SELECT column_name, data_type AS type, is_nullable AS nullable
       FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return rows.map(
    (r) => `${r.column_name} ${r.type} ${r.nullable === 'YES' ? 'NULL' : 'NOT NULL'}`,
  );
}

async function indexes(client: pg.Client, table: string): Promise<[string, string][]> {
  const { rows } = await client.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = $1 AND indexname LIKE '%_idx' ORDER BY indexname`,
    [table],
  );
  return rows.map((r) => [
    r.indexname,
    r.indexdef.replace(/^CREATE (UNIQUE )?INDEX \S+ ON \S+ USING btree /, '$1'),
  ]);
}

describe('[FR-ACC-07] users: login bookkeeping and admin-list indexes (0007)', () => {
  it('[FR-ACC-07] adds last_login_at, failed_login_count and locked_until, and no phone', async () => {
    const client = await admin();
    const cols = await columns(client, 'users');
    expect(cols).toEqual(
      expect.arrayContaining([
        'last_login_at timestamp with time zone NULL',
        'failed_login_count integer NOT NULL',
        'locked_until timestamp with time zone NULL',
      ]),
    );
    expect(cols.some((c) => c.startsWith('phone '))).toBe(false);
  });

  it('[NFR-SEC-07] failed_login_count stays between 0 and LOCKOUT_THRESHOLD - 1', async () => {
    const client = await admin();
    expect(await constraintDef(client, 'users_failed_login_count_range')).toBe(
      `CHECK (((failed_login_count >= 0) AND (failed_login_count <= ${String(LOCKOUT_THRESHOLD - 1)})))`,
    );
    const id = await insertUser(client);
    for (const count of [-1, LOCKOUT_THRESHOLD]) {
      expect(
        await sqlstate(
          client,
          `SET session_replication_role = replica;
           UPDATE users SET failed_login_count = ${String(count)} WHERE id = '${id}'`,
        ),
      ).toBe(CHECK_VIOLATION);
    }
  });

  it('[FR-ADM-01] has the admin-list indexes, including the case-insensitive prefix ones', async () => {
    const client = await admin();
    expect(await indexes(client, 'users')).toEqual([
      ['users_lower_email_prefix_idx', '(lower(email) text_pattern_ops)'],
      ['users_lower_name_prefix_idx', '(lower(name) text_pattern_ops)'],
      ['users_name_id_idx', '(name, id)'],
      ['users_status_name_id_idx', '(status, name, id)'],
    ]);
  });
});

describe('[NFR-SEC-02] sessions and refresh tokens (0008)', () => {
  it('[NFR-SEC-02] sessions and refresh_tokens have the planned columns', async () => {
    const client = await admin();
    expect(await columns(client, 'sessions')).toEqual([
      'id uuid NOT NULL',
      'user_id uuid NOT NULL',
      'created_at timestamp with time zone NOT NULL',
      'last_used_at timestamp with time zone NOT NULL',
      'absolute_expires_at timestamp with time zone NOT NULL',
      'expires_at timestamp with time zone NOT NULL',
      'user_agent text NOT NULL',
      'ip inet NOT NULL',
      'revoked_at timestamp with time zone NULL',
      'revoke_reason text NULL',
    ]);
    expect(await columns(client, 'refresh_tokens')).toEqual([
      'id uuid NOT NULL',
      'session_id uuid NOT NULL',
      'token_hash bytea NOT NULL',
      'expires_at timestamp with time zone NOT NULL',
      'rotated_at timestamp with time zone NULL',
      'created_at timestamp with time zone NOT NULL',
    ]);
  });

  it('[NFR-SEC-02] revoke_reason allows exactly SESSION_REVOKE_REASONS, in order', async () => {
    const client = await admin();
    expect(literals(await constraintDef(client, 'sessions_revoke_reason_valid'))).toEqual([
      ...SESSION_REVOKE_REASONS,
    ]);
  });

  it('[NFR-SEC-02] revoked_at and revoke_reason are set together or not at all', async () => {
    const client = await admin();
    const userId = await insertUser(client);
    const id = await insertSession(client, userId);
    expect(
      await sqlstate(client, `UPDATE sessions SET revoked_at = now() WHERE id = $1`, [id]),
    ).toBe(CHECK_VIOLATION);
    expect(
      await sqlstate(client, `UPDATE sessions SET revoke_reason = 'LOGOUT' WHERE id = $1`, [id]),
    ).toBe(CHECK_VIOLATION);
    expect(
      await sqlstate(
        client,
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'LOGOUT' WHERE id = $1`,
        [id],
      ),
    ).toBeUndefined();
    expect(
      await sqlstate(client, `UPDATE sessions SET revoke_reason = 'BORED' WHERE id = $1`, [id]),
    ).toBe(CHECK_VIOLATION);
  });

  it('[NFR-SEC-09] a session never outlives its absolute expiry, which follows its creation', async () => {
    const client = await admin();
    const userId = await insertUser(client);
    const id = await insertSession(client, userId);
    expect(
      await sqlstate(
        client,
        `UPDATE sessions SET expires_at = absolute_expires_at + interval '1 second' WHERE id = $1`,
        [id],
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await sqlstate(client, `UPDATE sessions SET absolute_expires_at = created_at WHERE id = $1`, [
        id,
      ]),
    ).toBe(CHECK_VIOLATION);
  });

  it('[NFR-SEC-02] user_agent is at most USER_AGENT_MAX_LENGTH characters', async () => {
    const client = await admin();
    const userId = await insertUser(client);
    const id = await insertSession(client, userId);
    const set = (length: number) =>
      sqlstate(client, `UPDATE sessions SET user_agent = repeat('a', $2) WHERE id = $1`, [
        id,
        length,
      ]);
    expect(await set(USER_AGENT_MAX_LENGTH)).toBeUndefined();
    expect(await set(USER_AGENT_MAX_LENGTH + 1)).toBe(CHECK_VIOLATION);
  });

  it('[NFR-SEC-02] a session needs an existing user', async () => {
    const client = await admin();
    await expect(insertSession(client, randomUUID())).rejects.toMatchObject({
      code: FOREIGN_KEY_VIOLATION,
    });
  });

  it('[NFR-SEC-02] refresh token hashes are 32-byte, unique, and deleted with their session', async () => {
    const client = await admin();
    const userId = await insertUser(client);
    const sessionId = await insertSession(client, userId);
    const insert = (hash: Buffer) =>
      sqlstate(
        client,
        `INSERT INTO refresh_tokens (id, session_id, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, now() + interval '7 days', now())`,
        [randomUUID(), sessionId, hash],
      );
    expect(await insert(randomBytes(31))).toBe(CHECK_VIOLATION);
    const hash = randomBytes(32);
    expect(await insert(hash)).toBeUndefined();
    expect(await insert(hash)).toBe(UNIQUE_VIOLATION);

    await client.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
    const { rows } = await client.query('SELECT 1 FROM refresh_tokens');
    expect(rows).toEqual([]);
  });

  it('[NFR-SEC-02] has the list, purge and cascade indexes', async () => {
    const client = await admin();
    expect(await indexes(client, 'sessions')).toEqual([
      ['sessions_ended_idx', '(COALESCE(revoked_at, expires_at))'],
      [
        'sessions_user_active_idx',
        '(user_id, last_used_at DESC, id DESC) WHERE (revoked_at IS NULL)',
      ],
    ]);
    expect(await indexes(client, 'refresh_tokens')).toEqual([
      ['refresh_tokens_session_id_idx', '(session_id)'],
    ]);
  });
});

describe('[FR-ACC-09] access requests (0009)', () => {
  async function insertRequest(
    client: pg.Client,
    userId: string,
    values: { message?: string; status?: string; note?: string | null; decided?: boolean } = {},
  ) {
    return sqlstate(
      client,
      `INSERT INTO access_requests (id, user_id, message, status, admin_note, decided_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() END)`,
      [
        randomUUID(),
        userId,
        values.message ?? 'Please add me as a buyer',
        values.status ?? 'OPEN',
        values.note ?? null,
        values.decided ?? false,
      ],
    );
  }

  it('[FR-ACC-09] status allows exactly ACCESS_REQUEST_STATUSES, in order', async () => {
    const client = await admin();
    expect(literals(await constraintDef(client, 'access_requests_status_valid'))).toEqual([
      ...ACCESS_REQUEST_STATUSES,
    ]);
  });

  it('[FR-ACC-09] the message is 1 to ACCESS_REQUEST_MESSAGE_MAX_LENGTH characters', async () => {
    const client = await admin();
    const userId = await insertUser(client);
    expect(await insertRequest(client, userId, { message: '' })).toBe(CHECK_VIOLATION);
    expect(
      await insertRequest(client, userId, {
        message: 'm'.repeat(ACCESS_REQUEST_MESSAGE_MAX_LENGTH + 1),
      }),
    ).toBe(CHECK_VIOLATION);
    expect(
      await insertRequest(client, userId, {
        message: 'm'.repeat(ACCESS_REQUEST_MESSAGE_MAX_LENGTH),
      }),
    ).toBeUndefined();
  });

  it('[FR-ADM-06] an admin note only on a dismissed request, at most ACCESS_REQUEST_NOTE_MAX_LENGTH characters', async () => {
    const client = await admin();
    const userId = await insertUser(client);
    expect(await insertRequest(client, userId, { note: 'no' })).toBe(CHECK_VIOLATION);
    expect(
      await insertRequest(client, userId, {
        status: 'DISMISSED',
        decided: true,
        note: 'n'.repeat(ACCESS_REQUEST_NOTE_MAX_LENGTH + 1),
      }),
    ).toBe(CHECK_VIOLATION);
    expect(
      await insertRequest(client, userId, {
        status: 'DISMISSED',
        decided: true,
        note: 'n'.repeat(ACCESS_REQUEST_NOTE_MAX_LENGTH),
      }),
    ).toBeUndefined();
  });

  it('[FR-ACC-09] decided_at is set exactly when the request is no longer open', async () => {
    const client = await admin();
    const userId = await insertUser(client);
    expect(await insertRequest(client, userId, { decided: true })).toBe(CHECK_VIOLATION);
    expect(await insertRequest(client, userId, { status: 'RESOLVED' })).toBe(CHECK_VIOLATION);
    expect(
      await insertRequest(client, userId, { status: 'RESOLVED', decided: true }),
    ).toBeUndefined();
  });

  it('[FR-ACC-09] a user has at most one open request; decided ones may pile up', async () => {
    const client = await admin();
    const userId = await insertUser(client);
    expect(await insertRequest(client, userId)).toBeUndefined();
    expect(await insertRequest(client, userId)).toBe(UNIQUE_VIOLATION);
    expect(
      await insertRequest(client, userId, { status: 'DISMISSED', decided: true }),
    ).toBeUndefined();
    expect(
      await insertRequest(client, userId, { status: 'DISMISSED', decided: true }),
    ).toBeUndefined();
  });

  it('[FR-ACC-09] updated_at follows the database clock on every update', async () => {
    const client = await admin();
    const userId = await insertUser(client);
    await insertRequest(client, userId);
    await client.query(`UPDATE access_requests SET updated_at = '2000-01-01' WHERE user_id = $1`, [
      userId,
    ]);
    const { rows } = await client.query<{ fresh: boolean }>(
      `SELECT updated_at > now() - interval '1 minute' AS fresh FROM access_requests`,
    );
    expect(rows).toEqual([{ fresh: true }]);
  });

  it('[FR-ADM-06] has the one-open rule and the list indexes', async () => {
    const client = await admin();
    expect(await indexes(client, 'access_requests')).toEqual([
      ['access_requests_one_open_idx', "UNIQUE (user_id) WHERE (status = 'OPEN'::text)"],
      ['access_requests_status_updated_idx', '(status, updated_at DESC, id DESC)'],
      ['access_requests_updated_idx', '(updated_at DESC, id DESC)'],
      ['access_requests_user_latest_idx', '(user_id, created_at DESC)'],
    ]);
  });
});

describe('[NFR-SEC-05] rate-limit counters (0010)', () => {
  it('[NFR-SEC-05] bucket allows exactly RATE_LIMIT_BUCKET_NAMES, in order', async () => {
    const client = await admin();
    expect(literals(await constraintDef(client, 'rate_limit_counters_bucket_valid'))).toEqual([
      ...RATE_LIMIT_BUCKET_NAMES,
    ]);
  });

  it('[NFR-SEC-05] one row per bucket, key and window; hits >= 1; a window ends after it starts', async () => {
    const client = await admin();
    const insert = (hits: number, end = "now() + interval '1 minute'") =>
      sqlstate(
        client,
        `INSERT INTO rate_limit_counters (bucket, key, window_start, window_end, hits)
         VALUES ('${RATE_LIMIT_BUCKET_NAMES[0] ?? ''}', '10.0.0.1', date_trunc('minute', now()),
                 ${end}, ${String(hits)})`,
      );
    expect(await insert(0)).toBe(CHECK_VIOLATION);
    expect(await insert(1, "date_trunc('minute', now())")).toBe(CHECK_VIOLATION);
    expect(await insert(1)).toBeUndefined();
    expect(await insert(1)).toBe(UNIQUE_VIOLATION);
  });

  it('[NFR-SEC-05] has the purge index on window_end', async () => {
    const client = await admin();
    expect(await indexes(client, 'rate_limit_counters')).toEqual([
      ['rate_limit_counters_window_end_idx', '(window_end)'],
    ]);
  });
});
