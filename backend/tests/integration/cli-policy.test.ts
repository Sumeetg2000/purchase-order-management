import type { Order } from '@po/contracts';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/run.js';
import { APPROVAL_POLICY_LOCK } from '../../src/db/locks.js';
import { APP_ORIGIN } from '../support/accounts.js';
import { ordersHarness } from '../support/orders.js';

// The approval policy CLI (ADR-0002, research R1): policy:set writes a new version through
// set_approval_policy as the operator, audited; policy:show prints the current one.

const OPERATOR = { osUser: 'deploy', host: 'ops-host-1' };

type Harness = Awaited<ReturnType<typeof ordersHarness>>;

async function cli(h: Harness, argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    env: { APP_ENV: 'local', APP_ORIGIN, DATABASE_URL: h.db.url('po_app'), LOG_LEVEL: 'error' },
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    ...OPERATOR,
  });
  return { code, stdout, stderr };
}

function versions(h: Harness) {
  return h.query<{ version: number; tiers: string[] }>(
    `SELECT p.version, array_agg(t.threshold::text ORDER BY t.tier) AS tiers
       FROM approval_policies p JOIN approval_policy_tiers t ON t.policy_version = p.version
      GROUP BY p.version ORDER BY p.version`,
  );
}

function policyAudits(h: Harness) {
  return h.query(
    `SELECT action, actor_type, entity_type, entity_id, details
       FROM audit_entries WHERE entity_type = 'approval_policy' ORDER BY occurred_at, id`,
  );
}

async function submitted(h: Harness, unitPrice: string) {
  const draft = await h.draftAt(unitPrice);
  return (await h.submitOrder(draft.id, draft.version)).body as Order;
}

describe('[FR-APR-05] policy:set', () => {
  it('[FR-APR-05] creates version 2, used by the next submission; an earlier order keeps version 1', async () => {
    const h = await ordersHarness();
    const before = await submitted(h, '150000');
    expect(before).toMatchObject({ status: 'PENDING_APPROVAL', approval: { policyVersion: 1 } });

    const result = await cli(h, ['policy:set', '--tier1', '200000']);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('Approval policy set: version 2, tier 1 above 200000.0000\n');
    expect(await versions(h)).toEqual([
      { version: 1, tiers: ['100000.0000'] },
      { version: 2, tiers: ['200000.0000'] },
    ]);

    const after = await submitted(h, '150000');
    expect(after).toMatchObject({ status: 'APPROVED', approval: { policyVersion: 2 } });
    const earlier = (await h.getOrder(before.id)).body as Order;
    expect(earlier).toMatchObject({ status: 'PENDING_APPROVAL', approval: { policyVersion: 1 } });
    expect(earlier.approval?.steps).toHaveLength(1);
  });

  it('[FR-APR-05] is audited APPROVAL_POLICY_CHANGED as OPERATOR, before → after, with osUser and host', async () => {
    const h = await ordersHarness();
    expect((await cli(h, ['policy:set', '--tier1', '250000.5'])).code).toBe(0);
    expect(await policyAudits(h)).toEqual([
      {
        action: 'APPROVAL_POLICY_CHANGED',
        actor_type: 'OPERATOR',
        entity_type: 'approval_policy',
        entity_id: '2',
        details: {
          before: { version: 1, tiers: [{ tier: 1, threshold: '100000.0000' }] },
          after: { version: 2, tiers: [{ tier: 1, threshold: '250000.5000' }] },
          osUser: OPERATOR.osUser,
          host: OPERATOR.host,
        },
      },
    ]);
  });

  it('[FR-APR-05] the current value is a no-op: a message, exit 0, no version, no audit', async () => {
    const h = await ordersHarness();
    for (const same of ['100000', '100000.0000']) {
      expect(await cli(h, ['policy:set', '--tier1', same])).toEqual({
        code: 0,
        stdout: 'Approval policy unchanged: version 1 already has tier 1 above 100000.0000\n',
        stderr: '',
      });
    }
    expect(await versions(h)).toHaveLength(1);
    expect(await policyAudits(h)).toEqual([]);
  });

  it('[FR-APR-05] an invalid amount is exit 1, the value not echoed, and nothing changes', async () => {
    const h = await ordersHarness();
    const bad = [
      ['--tier1', '0'],
      ['--tier1', '0.0000'],
      ['--tier1=-5'],
      ['--tier1', '-5'],
      ['--tier1', '200000.12345'],
      ['--tier1', 'abc'],
      ['--tier1', '1e6'],
      ['--tier1', ''],
      ['--tier1', '1000000000000000000'],
      [],
      ['--tier2', '200000'],
      ['--tier1', '200000', 'extra'],
    ];
    for (const args of bad) {
      const result = await cli(h, ['policy:set', ...args]);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stdout, args.join(' ')).toBe('');
      expect(result.stderr, args.join(' ')).toMatch(/^ERROR (USAGE|INVALID_ARGUMENT): /);
      expect(result.stderr).not.toMatch(/12345|abc|1e6/);
    }
    expect(await versions(h)).toHaveLength(1);
    expect(await policyAudits(h)).toEqual([]);
  });

  it('[FR-APR-05] refused while a submit holds the policy lock: exit 3 UNAVAILABLE, nothing changes; then it runs', async () => {
    const h = await ordersHarness();
    // A submit holds APPROVAL_POLICY_LOCK shared until it commits (approvals/repository.ts).
    const submit = await h.db.client('postgres');
    await submit.query('BEGIN');
    await submit.query('SELECT pg_advisory_xact_lock_shared($1)', [
      APPROVAL_POLICY_LOCK.toString(),
    ]);
    const refused = await cli(h, ['policy:set', '--tier1', '200000']);
    await submit.query('COMMIT');
    expect(refused.code).toBe(3);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toMatch(/^ERROR UNAVAILABLE: .*lock.*nothing was changed\n$/);
    expect(await versions(h)).toHaveLength(1);
    expect(await policyAudits(h)).toEqual([]);

    expect((await cli(h, ['policy:set', '--tier1', '200000'])).code).toBe(0);
    expect(await versions(h)).toHaveLength(2);
  }, 15_000);
});

describe('[FR-APR-05] policy:show', () => {
  it('[FR-APR-05] prints the current version, its tiers and when it took effect, and changes nothing', async () => {
    const h = await ordersHarness();
    const seeded = await cli(h, ['policy:show']);
    expect(seeded.stderr).toBe('');
    expect(seeded.code).toBe(0);
    const [v1] = await h.query<{ at: string }>(
      `SELECT to_char(effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
         FROM approval_policies WHERE version = 1`,
    );
    expect(seeded.stdout).toBe(
      `Approval policy version 1, effective ${v1?.at ?? ''}\n  tier 1: above 100000.0000\n`,
    );

    await cli(h, ['policy:set', '--tier1', '200000']);
    expect((await cli(h, ['policy:show'])).stdout).toMatch(
      /^Approval policy version 2, effective \d{4}-\d\d-\d\dT[\d:.]+Z\n {2}tier 1: above 200000\.0000\n$/,
    );
    expect(await versions(h)).toHaveLength(2);
    expect(await policyAudits(h)).toHaveLength(1);
  });

  it('[FR-APR-05] takes no flags', async () => {
    const h = await ordersHarness();
    const result = await cli(h, ['policy:show', '--tier1', '1']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^ERROR USAGE: /);
  });
});
