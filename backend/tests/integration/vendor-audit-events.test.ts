import { randomUUID } from 'node:crypto';
import { vendorSnapshot, type VendorSnapshot } from '@po/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../src/audit/events.js';
import { writeAudit } from '../../src/audit/write.js';
import { createPrismaClient, type AppPrismaClient } from '../../src/db/client.js';
import { withTransaction } from '../../src/db/transaction.js';
import { createTestDatabase } from '../support/db.js';
import { testLogger } from '../support/log-capture.js';
import { trackDatabase } from '../support/setup.js';

// The four vendor audit events (data-model.md): entity type vendor, before → after as
// full vendor snapshots (contact details included, ADR-0016 amended 2026-11-06).

const clients: AppPrismaClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.$disconnect()));
});

const active: VendorSnapshot = {
  name: 'Acme Supplies',
  contactName: 'Ravi Shah',
  contactEmail: 'ravi@acme.example',
  contactPhone: null,
  paymentTerms: { type: 'PARTIAL_ADVANCE', advancePercent: 20, netDays: 30 },
  status: 'ACTIVE',
};
const inactive: VendorSnapshot = { ...active, status: 'INACTIVE' };

describe('[NFR-AUD-03] vendor audit events', () => {
  it('[NFR-AUD-03] VENDOR_CREATED, UPDATED, DEACTIVATED and REACTIVATED record vendor snapshots', async () => {
    const db = trackDatabase(await createTestDatabase());
    const prisma = createPrismaClient({
      url: db.url('po_app'),
      poolSize: 1,
      connectionTimeoutMs: 2_000,
    });
    clients.push(prisma);
    const vendorId = randomUUID();
    const renamed: VendorSnapshot = { ...active, contactPhone: '+91 22 4000 1000' };
    const events: AuditEvent[] = [
      {
        action: 'VENDOR_CREATED',
        entityType: 'vendor',
        entityId: vendorId,
        details: { before: null, after: active },
      },
      {
        action: 'VENDOR_UPDATED',
        entityType: 'vendor',
        entityId: vendorId,
        details: { before: active, after: renamed },
      },
      {
        action: 'VENDOR_DEACTIVATED',
        entityType: 'vendor',
        entityId: vendorId,
        details: { before: renamed, after: { ...renamed, status: 'INACTIVE' } },
      },
      {
        action: 'VENDOR_REACTIVATED',
        entityType: 'vendor',
        entityId: vendorId,
        details: { before: inactive, after: active },
      },
    ];
    await withTransaction(
      {
        prisma,
        actor: {
          type: 'USER',
          userId: randomUUID(),
          name: 'Asha Rao',
          email: 'asha@example.local',
          actingRole: 'BUYER',
        },
        requestId: 'req-vendor-0001',
        timeoutMs: 5_000,
        maxWaitMs: 2_000,
        logger: testLogger(),
      },
      async (tx) => {
        for (const event of events) await writeAudit(tx, event);
      },
    );

    const admin = await db.client('postgres');
    const { rows } = await admin.query<{
      action: string;
      entity_type: string;
      acting_role: string;
      details: { before: unknown; after: unknown };
    }>(
      `SELECT action, entity_type, acting_role, details FROM audit_entries
        WHERE entity_id = $1 ORDER BY id`,
      [vendorId],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'VENDOR_CREATED',
      'VENDOR_UPDATED',
      'VENDOR_DEACTIVATED',
      'VENDOR_REACTIVATED',
    ]);
    for (const row of rows) {
      expect(row.entity_type).toBe('vendor');
      expect(row.acting_role).toBe('BUYER');
      expect(vendorSnapshot.parse(row.details.after)).toEqual(row.details.after);
      if (row.details.before !== null) vendorSnapshot.parse(row.details.before);
    }
    expect(rows[1]?.details).toEqual({ before: active, after: renamed });
  });
});
