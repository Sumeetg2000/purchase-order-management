import { describe, expect, it } from 'vitest';
import { AUDIT_RETENTION_YEARS } from '../../src/audit/retention.js';
import { createTestDatabase } from '../support/db.js';
import { trackDatabase } from '../support/setup.js';

describe('[NFR-AUD-02] audit retention period', () => {
  it('[NFR-AUD-02] is 8 years (ADR-0020)', () => {
    expect(AUDIT_RETENTION_YEARS).toBe(8);
  });

  it('[NFR-AUD-02] the audit_retention_guard trigger refuses deletes inside the same period', async () => {
    const db = trackDatabase(await createTestDatabase());
    const admin = await db.client('postgres');
    const { rows } = await admin.query<{ src: string }>(
      `SELECT prosrc AS src FROM pg_proc WHERE proname = 'audit_retention_guard'`,
    );
    const src = rows[0]?.src ?? '';
    const intervals = [...src.matchAll(/interval '([^']+)'/g)].map((m) => m[1]);
    expect(intervals).toEqual([`${String(AUDIT_RETENTION_YEARS)} years`]);
    // The refusal's DETAIL names the period too, so it can't drift from the check.
    const named = [...src.matchAll(/(\d+)-year/g)].map((m) => m[1]);
    expect(named).toEqual([String(AUDIT_RETENTION_YEARS)]);
  });
});
