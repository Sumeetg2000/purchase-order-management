import type { Money } from '@po/contracts';
import { describe, expectTypeOf, it } from 'vitest';
import type { AuditEvent, AuditEventCatalogue } from '../../src/audit/events.js';
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
  { vendor: Vendor; lines: Line[]; total: Money; reason: null }
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

  it('[NFR-AUD-01] the PO number is the entry column, never repeated in its details', () => {
    expectTypeOf<AuditEventCatalogue['PO_CREATED']['details']>().not.toHaveProperty('poNumber');
    expectTypeOf<AuditEventCatalogue['PO_DRAFT_DELETED']['details']>().not.toHaveProperty(
      'poNumber',
    );
  });

  it('[NFR-AUD-01] an order event needs its order id and PO number, and money as Money', () => {
    // @ts-expect-error: an order event carries its PO number
    expectTypeOf<CreatedWithoutPoNumber>().toExtend<Event>();
    // @ts-expect-error: money is a Money string, never a number
    expectTypeOf<CreatedWithNumberTotal>().toExtend<Event>();
  });
});

interface Snapshot {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  paymentTerms: { type: 'NET'; netDays: number };
}
type Submitted = OrderEvent<
  'PO_SUBMITTED',
  {
    round: number;
    total: Money;
    tiers: { tier: number; threshold: Money }[];
    policyVersion: number;
    resultingStatus: 'PENDING_APPROVAL';
    vendorSnapshot: Snapshot;
  }
>;
type AutoApproved = OrderEvent<
  'PO_AUTO_APPROVED',
  { round: number; threshold: Money; policyVersion: number }
>;
type StepApproved = OrderEvent<
  'APPROVAL_STEP_APPROVED',
  { round: number; step: number; tier: number; versionApproved: number }
>;
type StepRejected = OrderEvent<
  'APPROVAL_STEP_REJECTED',
  { round: number; step: number; tier: number; reason: string }
>;
type Withdrawn = OrderEvent<
  'PO_WITHDRAWN',
  {
    round: number;
    reason: string;
    voidedSteps: {
      step: number;
      tier: number;
      earlierDecision: { by: { id: string; name: string }; at: string; version: number } | null;
    }[];
  }
>;
type PolicyChanged = {
  action: 'APPROVAL_POLICY_CHANGED';
  entityType: 'approval_policy';
  entityId: string;
  details: {
    before: { version: number; tiers: { tier: number; threshold: Money }[] } | null;
    after: { version: number; tiers: { tier: number; threshold: Money }[] };
  };
};
type RejectedWithoutReason = OrderEvent<
  'APPROVAL_STEP_REJECTED',
  { round: number; step: number; tier: number }
>;
type SubmittedWithoutRound = Omit<Submitted, 'details'> & {
  details: Omit<Submitted['details'], 'round'>;
};

describe('[NFR-AUD-01] typed approval audit events (slice 4)', () => {
  it('[NFR-AUD-01] accepts the five order events and the policy change with their details', () => {
    expectTypeOf<Submitted>().toExtend<Event>();
    expectTypeOf<AutoApproved>().toExtend<Event>();
    expectTypeOf<StepApproved>().toExtend<Event>();
    expectTypeOf<StepRejected>().toExtend<Event>();
    expectTypeOf<Withdrawn>().toExtend<Event>();
    expectTypeOf<PolicyChanged>().toExtend<Event>();
  });

  it('[NFR-AUD-01] a rejection needs its reason, and every approval event its round', () => {
    // @ts-expect-error: a rejection records why
    expectTypeOf<RejectedWithoutReason>().toExtend<Event>();
    // @ts-expect-error: every approval event names its round
    expectTypeOf<SubmittedWithoutRound>().toExtend<Event>();
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
