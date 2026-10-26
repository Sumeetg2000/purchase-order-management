import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../src/audit/events.js';
import { ForbiddenAuditDetailError, writeAudit } from '../../src/audit/write.js';
import type { AuditedTransaction } from '../../src/db/transaction.js';

function stubTransaction() {
  const calls: unknown[] = [];
  const tx = {
    $executeRaw: (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(1);
    },
  } as unknown as AuditedTransaction;
  return { tx, calls };
}

function event(details: Record<string, unknown>): AuditEvent {
  return {
    action: 'ADMIN_CREATED',
    entityType: 'user',
    entityId: '0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f',
    // Cast: these shapes are what the types should already refuse; this checks the
    // run-time guard behind them.
    details: details as AuditEvent['details'],
  };
}

describe('[NFR-PRIV-01] audit details never hold a phone number', () => {
  it.each([
    ['a phone key', { source: 'cli', name: 'A', email: 'a@x.local', phone: '+910000000000' }],
    ['a phoneNumber key', { source: 'cli', name: 'A', email: 'a@x.local', phoneNumber: 'x' }],
    ['a mobile key', { source: 'cli', name: 'A', email: 'a@x.local', mobile: 'x' }],
    [
      'a nested after.phone key',
      { source: 'cli', name: 'A', email: 'a@x.local', after: { phone: 'x' } },
    ],
    [
      'a mobileNumber key inside an array',
      { source: 'cli', name: 'A', email: 'a@x.local', changes: [{ mobileNumber: 'x' }] },
    ],
  ])('[NFR-PRIV-01] refuses %s before writing anything', async (_case, details) => {
    const { tx, calls } = stubTransaction();
    await expect(writeAudit(tx, event(details))).rejects.toBeInstanceOf(ForbiddenAuditDetailError);
    expect(calls).toEqual([]);
  });

  it('[NFR-PRIV-01] writes an event without phone-like keys', async () => {
    const { tx, calls } = stubTransaction();
    await writeAudit(tx, event({ source: 'cli', name: 'A', email: 'a@x.local' }));
    expect(calls).toHaveLength(1);
  });
});
