import { describe, expectTypeOf, it } from 'vitest';
import type { AuditEvent } from '../../src/audit/events.js';
import type { writeAudit } from '../../src/audit/write.js';

// Compile-time checks: `npm run typecheck` fails if an event that should be refused is
// accepted (the @ts-expect-error lines would then be unused).

type Event = Parameters<typeof writeAudit>[1];

interface AdminCreated<Source, Extra = unknown> {
  action: 'ADMIN_CREATED';
  entityType: 'user';
  entityId: string;
  details: { source: Source; name: string; email: string } & Extra;
}

type Bootstrap = AdminCreated<'bootstrap'>;
type Cli = AdminCreated<'cli'>;
type UnknownEvent = {
  action: 'ORDER_TELEPORTED';
  entityType: 'user';
  entityId: string;
  details: object;
};
type WrongSource = AdminCreated<'web'>;
type WithPhone = AdminCreated<'cli', { phone: string }>;

describe('[NFR-AUD-02] typed audit events', () => {
  it('[NFR-AUD-02] accepts the slice 0 ADMIN_CREATED event in both of its forms', () => {
    expectTypeOf<Bootstrap>().toExtend<Event>();
    expectTypeOf<Cli>().toExtend<AuditEvent>();
  });

  it('[NFR-AUD-02] refuses an unknown event name and a wrong details shape', () => {
    // @ts-expect-error: not an event in the catalogue
    expectTypeOf<UnknownEvent>().toExtend<Event>();
    // @ts-expect-error: source must be 'cli' or 'bootstrap'
    expectTypeOf<WrongSource>().toExtend<Event>();
    // @ts-expect-error: a phone number never goes into audit details (ADR-0016)
    expectTypeOf<WithPhone>().toExtend<Event>();
  });
});
