import { describe, expectTypeOf, it } from 'vitest';
import type { AuditEvent } from '../../src/audit/events.js';
import type { writeAudit } from '../../src/audit/write.js';

// Compile-time checks: `npm run typecheck` fails if an event that should be refused is
// accepted (the @ts-expect-error lines would then be unused).

type Event = Parameters<typeof writeAudit>[1];

describe('[NFR-AUD-02] typed audit events', () => {
  it('[NFR-AUD-02] accepts the slice 0 ADMIN_CREATED event in both of its forms', () => {
    expectTypeOf<{
      action: 'ADMIN_CREATED';
      entityType: 'user';
      entityId: string;
      details: { source: 'bootstrap'; name: string; email: string };
    }>().toExtend<Event>();
    expectTypeOf<{
      action: 'ADMIN_CREATED';
      entityType: 'user';
      entityId: string;
      details: { source: 'cli'; name: string; email: string };
    }>().toExtend<AuditEvent>();
  });

  it('[NFR-AUD-02] refuses an unknown event name and a wrong details shape', () => {
    // @ts-expect-error: not an event in the catalogue
    expectTypeOf<{
      action: 'ORDER_TELEPORTED';
      entityType: 'user';
      entityId: string;
      details: object;
    }>().toExtend<Event>();
    // @ts-expect-error: source must be 'cli' or 'bootstrap'
    expectTypeOf<{
      action: 'ADMIN_CREATED';
      entityType: 'user';
      entityId: string;
      details: { source: 'web'; name: string; email: string };
    }>().toExtend<Event>();
    // @ts-expect-error: a phone number never goes into audit details (ADR-0016)
    expectTypeOf<{
      action: 'ADMIN_CREATED';
      entityType: 'user';
      entityId: string;
      details: { source: 'cli'; name: string; email: string; phone: string };
    }>().toExtend<Event>();
  });
});
