import type { Money, UserRole, UserStatus, VendorSnapshot } from '@po/contracts';

// The audit event catalogue (ADR-0016). Each slice adds the events it records; slice 0
// has ADMIN_CREATED. The actor, request id and time are never part of an event: the
// database fills them from the transaction's actor context.

/** A line as an order event records it (data-model.md): money as Money strings. */
export interface AuditOrderLine {
  id: string;
  description: string;
  quantity: number;
  unitPrice: Money;
  lineTotal: Money;
}

/** The vendor an order event names: its id and its name at the time. */
export interface AuditOrderVendor {
  id: string;
  name: string;
}

interface Change<T> {
  before: T;
  after: T;
}

/** One changed line of an edit: only the fields that changed, each before → after. */
export interface AuditLineChange {
  id: string;
  position?: Change<number>;
  description?: Change<string>;
  quantity?: Change<number>;
  unitPrice?: Change<Money>;
  lineTotal?: Change<Money>;
}

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
  /** A user changed their own name. */
  USER_PROFILE_UPDATED: {
    entityType: 'user';
    details: { before: string; after: string };
  };
  /** An admin changed a user's role set; every session of theirs ended. */
  USER_ROLES_CHANGED: {
    entityType: 'user';
    details: { before: readonly UserRole[]; after: readonly UserRole[]; sessionsRevoked: number };
  };
  USER_DEACTIVATED: {
    entityType: 'user';
    details: { before: UserStatus; after: UserStatus; sessionsRevoked: number };
  };
  USER_REACTIVATED: {
    entityType: 'user';
    details: { before: UserStatus; after: UserStatus; sessionsRevoked: number };
  };
  /** An admin sent a user the reset email; the entity is the user, nothing else is kept. */
  USER_PASSWORD_RESET_SENT: {
    entityType: 'user';
    details: Record<string, never>;
  };
  /** Assigning a role closed the user's open request. */
  ACCESS_REQUEST_RESOLVED: {
    entityType: 'access_request';
    details: { requestId: string; roles: readonly UserRole[] };
  };
  /** An admin dismissed a request, or deactivating its user did. */
  ACCESS_REQUEST_DISMISSED: {
    entityType: 'access_request';
    details: { requestId: string; note: string | null };
  };
  /** A Buyer added a vendor (slice 2). Contact details in full (ADR-0016, 2026-11-06). */
  VENDOR_CREATED: {
    entityType: 'vendor';
    details: { before: null; after: VendorSnapshot };
  };
  /** Every accepted edit, even one that changes nothing, writes one and moves the version. */
  VENDOR_UPDATED: {
    entityType: 'vendor';
    details: { before: VendorSnapshot; after: VendorSnapshot };
  };
  VENDOR_DEACTIVATED: {
    entityType: 'vendor';
    details: { before: VendorSnapshot; after: VendorSnapshot };
  };
  VENDOR_REACTIVATED: {
    entityType: 'vendor';
    details: { before: VendorSnapshot; after: VendorSnapshot };
  };
  /** A Buyer raised a draft order (slice 3): its vendor, every line and the total. */
  PO_CREATED: {
    entityType: 'order';
    details: { vendor: AuditOrderVendor; lines: AuditOrderLine[]; total: Money };
  };
  /** An edit that changed something; a no-op save writes none (FR-020). */
  PO_EDITED: {
    entityType: 'order';
    details: {
      vendor?: Change<AuditOrderVendor>;
      lines: { added: AuditOrderLine[]; removed: AuditOrderLine[]; changed: AuditLineChange[] };
      total: Change<Money>;
    };
  };
  /** The owner deleted a draft: its full contents outlive it here. */
  PO_DRAFT_DELETED: {
    entityType: 'order';
    details: {
      poNumber: string;
      vendor: AuditOrderVendor;
      lines: AuditOrderLine[];
      total: Money;
      reason: string | null;
    };
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
  } & (AuditEventCatalogue[A]['entityType'] extends 'order'
    ? // An order event names its order and PO number in their own columns (ADR-0016).
      { orderId: string; poNumber: string }
    : { orderId?: never; poNumber?: never });
}[AuditAction];
