// The audit event catalogue (ADR-0016). Each slice adds the events it records; slice 0
// has ADMIN_CREATED. The actor, request id and time are never part of an event: the
// database fills them from the transaction's actor context.

/** A phone number never goes into audit details (ADR-0016). */
interface NoPhone {
  phone?: never;
}

export interface AuditEventCatalogue {
  ADMIN_CREATED: {
    entityType: 'user';
    details: NoPhone & {
      /** `bootstrap` is audited as SYSTEM, `cli` as OPERATOR (with osUser and host). */
      source: 'bootstrap' | 'cli';
      name: string;
      email: string;
    };
  };
}

export type AuditAction = keyof AuditEventCatalogue;

export type AuditEvent = {
  [A in AuditAction]: {
    action: A;
    entityType: AuditEventCatalogue[A]['entityType'];
    entityId: string;
    details: AuditEventCatalogue[A]['details'];
    /** Order events only (slice 3 on). */
    orderId?: string;
    poNumber?: string;
  };
}[AuditAction];
