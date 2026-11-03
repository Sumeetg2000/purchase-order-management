// The audit event catalogue (ADR-0016). Each slice adds the events it records; slice 0
// has ADMIN_CREATED. The actor, request id and time are never part of an event: the
// database fills them from the transaction's actor context.

export interface AuditEventCatalogue {
  /** A self-signup: never with a role (ADR-0017). */
  USER_SIGNED_UP: {
    entityType: 'user';
    details: { emailDomain: string; roles: readonly [] };
  };
  /** A no-role user asked for access, or changed the message of their open request. */
  ACCESS_REQUESTED: {
    entityType: 'access_request';
    details: { requestId: string; message: string };
  };
  /** A user proved control of their mailbox: by the verification link or a reset. */
  USER_EMAIL_VERIFIED: {
    entityType: 'user';
    details: { via: 'link' | 'reset' };
  };
  ADMIN_CREATED: {
    entityType: 'user';
    details: {
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
