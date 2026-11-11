import {
  ADVANCE_PERCENT_MAX,
  ADVANCE_PERCENT_MIN,
  AUDIT_ACTOR_TYPES,
  CONTACT_NAME_MAX,
  CONTACT_PHONE_MAX,
  CONTACT_PHONE_PATTERN,
  EMAIL_MAX_LENGTH,
  NET_DAYS_MAX,
  PAYMENT_TERM_TYPES,
  VENDOR_NAME_MAX,
  VENDOR_STATUSES,
} from '@po/contracts';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../support/db.js';
import { trackDatabase } from '../support/setup.js';

// Every vendor constant's SQL copy in migration 0011 equals the constant (CLAUDE.md,
// research R13), and the one normalisation rule, vendor_name_key, treats the names a
// person would call the same as one name (research R2).

const UNIQUE_VIOLATION = '23505';

async function admin(): Promise<pg.Client> {
  const db = trackDatabase(await createTestDatabase());
  return db.client('postgres');
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

/** Runs a statement in a transaction with a SYSTEM actor context, as po_app would. */
async function withActor(client: pg.Client, sql: string, params: unknown[] = []) {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.actor_txid', txid_current()::text, true)`);
    await client.query(`SELECT set_config('app.actor_type', 'SYSTEM', true)`);
    await client.query(sql, params);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function insertNamed(client: pg.Client, name: string) {
  return withActor(
    client,
    `INSERT INTO vendors (name, contact_name, contact_email, payment_term_type, net_days)
     VALUES ($1, 'Ravi', 'ravi@acme.example', 'NET', 30)`,
    [name],
  );
}

describe('[FR-VEN-01] vendor constants equal their SQL copies (0011)', () => {
  it('[FR-VEN-01] name, contact name, email and phone lengths', async () => {
    const client = await admin();
    expect(await constraintDef(client, 'vendors_name_length')).toBe(
      `CHECK (((char_length(name) >= 1) AND (char_length(name) <= ${String(VENDOR_NAME_MAX)})))`,
    );
    expect(await constraintDef(client, 'vendors_contact_name_length')).toBe(
      `CHECK (((char_length(contact_name) >= 1) AND (char_length(contact_name) <= ${String(CONTACT_NAME_MAX)})))`,
    );
    expect(await constraintDef(client, 'vendors_contact_email_valid')).toContain(
      `(char_length(contact_email) <= ${String(EMAIL_MAX_LENGTH)})`,
    );
    const phone = CONTACT_PHONE_PATTERN.source.replace(
      /\+\$$/,
      `{1,${String(CONTACT_PHONE_MAX)}}$`,
    );
    expect(await constraintDef(client, 'vendors_contact_phone_valid')).toContain(
      `(contact_phone ~ '${phone}'::text)`,
    );
  });

  it('[FR-VEN-01] payment term types and their numbers', async () => {
    const client = await admin();
    expect(literals(await constraintDef(client, 'vendors_payment_term_type_valid'))).toEqual([
      ...PAYMENT_TERM_TYPES,
    ]);
    const terms = await constraintDef(client, 'vendors_payment_terms_valid');
    expect(terms).toContain(`(net_days <= ${String(NET_DAYS_MAX)})`);
    expect(terms).toContain(`(advance_percent >= ${String(ADVANCE_PERCENT_MIN)})`);
    expect(terms).toContain(`(advance_percent <= ${String(ADVANCE_PERCENT_MAX)})`);
    // Every NET_DAYS_MAX copy, and no other upper bound on net_days.
    expect([...terms.matchAll(/net_days <= (\d+)/g)].map(([, n]) => Number(n))).toEqual([
      NET_DAYS_MAX,
      NET_DAYS_MAX,
    ]);
  });

  it('[FR-VEN-01] vendor statuses and audit actor types', async () => {
    const client = await admin();
    expect(literals(await constraintDef(client, 'vendors_status_valid'))).toEqual([
      ...VENDOR_STATUSES,
    ]);
    expect(literals(await constraintDef(client, 'audit_entries_actor_type_valid'))).toEqual([
      ...AUDIT_ACTOR_TYPES,
    ]);
  });
});

describe('[FR-VEN-01] vendor_name_key: one name however it is cased or spaced', () => {
  // One pair per kind of difference, each a different name from the others.
  const sameName: [string, string][] = [
    ['ÉCOLE Supplies', 'école supplies'],
    ['ÖZTÜRK GIDA', 'öztürk gida'],
    ['Acme\tSupplies', 'acme supplies'],
    ['Bolt\u00a0Traders', 'Bolt Traders'],
    ['Crest  \u2003 Metals', 'CREST METALS'],
    ['Cafe\u0301 Foods', 'Café Foods'],
  ];

  it('[FR-VEN-01] is IMMUTABLE and gives each pair one key', async () => {
    const client = await admin();
    const { rows: fn } = await client.query<{ volatility: string }>(
      `SELECT provolatile AS volatility FROM pg_proc WHERE proname = 'vendor_name_key'`,
    );
    expect(fn).toEqual([{ volatility: 'i' }]);
    for (const [a, b] of sameName) {
      const { rows } = await client.query<{ a: string; b: string }>(
        'SELECT vendor_name_key($1) AS a, vendor_name_key($2) AS b',
        [a, b],
      );
      expect(rows[0]?.a, `${a} / ${b}`).toBe(rows[0]?.b);
    }
    const { rows } = await client.query<{ key: string }>(
      `SELECT vendor_name_key('ÉCOLE  Supplies') AS key`,
    );
    expect(rows[0]?.key).toBe('école supplies');
  });

  it('[FR-VEN-01] a second vendor with any of these spellings clashes on vendors_name_key_key', async () => {
    const client = await admin();
    for (const [a, b] of sameName) {
      await insertNamed(client, a);
      const error = await insertNamed(client, b).catch((e: unknown) => e);
      expect(error, `${a} / ${b}`).toMatchObject({
        code: UNIQUE_VIOLATION,
        constraint: 'vendors_name_key_key',
      });
    }
  });

  it('[FR-VEN-01] po_app may call it, for the list prefix filter', async () => {
    const client = await admin();
    const { rows } = await client.query<{ app: boolean; anyone: boolean }>(
      `SELECT has_function_privilege('po_app', 'vendor_name_key(text)', 'EXECUTE') AS app,
              has_function_privilege('public', 'vendor_name_key(text)', 'EXECUTE') AS anyone`,
    );
    expect(rows[0]).toEqual({ app: true, anyone: false });
  });
});
