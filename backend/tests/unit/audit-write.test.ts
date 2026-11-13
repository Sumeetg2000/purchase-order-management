import type { Money } from '@po/contracts';
import { describe, expectTypeOf, it } from 'vitest';
import type { AuditEvent } from '../../src/audit/events.js';
import type { writeAudit } from '../../src/audit/write.js';
import type { Prisma } from '../../src/generated/prisma/client.js';

// Compile-time checks: `npm run typecheck` fails if an event that should be refused is
// accepted (the @ts-expect-error lines would then be unused).

type Event = Parameters<typeof writeAudit>[1];
type Transaction = Parameters<typeof writeAudit>[0];

interface AdminCreated<Source> {
  action: 'ADMIN_CREATED';
  entityType: 'user';
  entityId: string;
  details: { source: Source; name: string; email: string };
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

interface Line {
  id: string;
  description: string;
  quantity: number;
  unitPrice: Money;
  lineTotal: Money;
}
interface Vendor {
  id: string;
  name: string;
}

interface OrderEvent<A extends string, D> {
  action: A;
  entityType: 'order';
  entityId: string;
  orderId: string;
  poNumber: string;
  details: D;
}

type Created = OrderEvent<'PO_CREATED', { vendor: Vendor; lines: Line[]; total: Money }>;
type Edited = OrderEvent<
  'PO_EDITED',
  {
    vendor: { before: Vendor; after: Vendor };
    lines: {
      added: Line[];
      removed: Line[];
      changed: { id: string; quantity: { before: number; after: number } }[];
    };
    total: { before: Money; after: Money };
  }
>;
type Deleted = OrderEvent<
  'PO_DRAFT_DELETED',
  { poNumber: string; vendor: Vendor; lines: Line[]; total: Money; reason: null }
>;
type CreatedWithoutPoNumber = Omit<Created, 'poNumber'>;
type CreatedWithNumberTotal = OrderEvent<
  'PO_CREATED',
  { vendor: Vendor; lines: Line[]; total: number }
>;

describe('[NFR-AUD-01] typed order audit events', () => {
  it('[NFR-AUD-01] accepts PO_CREATED, PO_EDITED and PO_DRAFT_DELETED with their details', () => {
    expectTypeOf<Created>().toExtend<Event>();
    expectTypeOf<Edited>().toExtend<Event>();
    expectTypeOf<Deleted>().toExtend<Event>();
  });

  it('[NFR-AUD-01] an order event needs its order id and PO number, and money as Money', () => {
    // @ts-expect-error: an order event carries its PO number
    expectTypeOf<CreatedWithoutPoNumber>().toExtend<Event>();
    // @ts-expect-error: money is a Money string, never a number
    expectTypeOf<CreatedWithNumberTotal>().toExtend<Event>();
  });
});

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
  });

  it('[NFR-AUD-02] takes only a transaction from withTransaction, never a plain Prisma one', () => {
    // @ts-expect-error: a raw prisma.$transaction client has no actor context set
    expectTypeOf<Prisma.TransactionClient>().toExtend<Transaction>();
  });
});
