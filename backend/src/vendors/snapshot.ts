import {
  VENDOR_STATUSES,
  type PaymentTerms,
  type Vendor,
  type VendorBody,
  type VendorSnapshot,
  type VendorStatus,
} from '@po/contracts';
import type { VendorFields } from './repository.js';

// A vendor row ↔ the API's shapes (spec: the snapshot an order stores): the payment-term columns become the
// `paymentTerms` union and back. Pure, so the order slices can reuse it. The table's
// CHECKs allow only valid combinations; one the code can't map means code and database
// disagree, which fails loudly.

/** A vendor as the repository reads it. */
export interface VendorRow {
  id: string;
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  paymentTermType: string;
  netDays: number | null;
  advancePercent: number | null;
  status: string;
  deactivatedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The payment-term columns a write stores. */
export interface PaymentTermColumns {
  paymentTermType: PaymentTerms['type'];
  netDays: number | null;
  advancePercent: number | null;
}

function unmappable(row: VendorRow, what: string): Error {
  return new Error(`Vendor ${row.id} has ${what} the code doesn't know`);
}

export function paymentTermsOf(row: VendorRow): PaymentTerms {
  const { paymentTermType: type, netDays, advancePercent } = row;
  if (type === 'NET' && netDays !== null) return { type, netDays };
  if (type === 'ADVANCE') return { type };
  if (type === 'PARTIAL_ADVANCE' && netDays !== null && advancePercent !== null) {
    return { type, advancePercent, netDays };
  }
  throw unmappable(row, `payment terms ${type}`);
}

export function termColumns(terms: PaymentTerms): PaymentTermColumns {
  switch (terms.type) {
    case 'NET':
      return { paymentTermType: terms.type, netDays: terms.netDays, advancePercent: null };
    case 'ADVANCE':
      return { paymentTermType: terms.type, netDays: null, advancePercent: null };
    case 'PARTIAL_ADVANCE':
      return {
        paymentTermType: terms.type,
        netDays: terms.netDays,
        advancePercent: terms.advancePercent,
      };
  }
}

/** What a create or an edit stores, from the API body (or the demo seed's). */
export function fieldsOf(body: VendorBody): VendorFields {
  return {
    name: body.name,
    contactName: body.contactName,
    contactEmail: body.contactEmail,
    // Omitted or null: no phone, stored as NULL, never "" (research R6).
    contactPhone: body.contactPhone ?? null,
    ...termColumns(body.paymentTerms),
  };
}

export function statusOf(row: VendorRow): VendorStatus {
  const status = VENDOR_STATUSES.find((known) => known === row.status);
  if (!status) throw unmappable(row, `status ${row.status}`);
  return status;
}

export function toVendor(row: VendorRow): Vendor {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    paymentTerms: paymentTermsOf(row),
    status: statusOf(row),
    deactivatedAt: row.deactivatedAt?.toISOString() ?? null,
    version: row.version,
  };
}

/** The vendor as its audit entries record it (data-model.md). */
export function toSnapshot(row: VendorRow): VendorSnapshot {
  return {
    name: row.name,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    paymentTerms: paymentTermsOf(row),
    status: statusOf(row),
  };
}

/**
 * The vendor as an order stores it on submit (data-model.md): the audit snapshot
 * without status, plus the id. Slice 4 stores it; the active check returns it.
 */
export type VendorOrderSnapshot = Omit<VendorSnapshot, 'status'> & { id: string };

export function toOrderSnapshot(row: VendorRow): VendorOrderSnapshot {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    paymentTerms: paymentTermsOf(row),
  };
}
