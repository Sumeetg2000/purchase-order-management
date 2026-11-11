import {
  VENDOR_STATUSES,
  type PaymentTerms,
  type Vendor,
  type VendorSnapshot,
  type VendorStatus,
} from '@po/contracts';

// A vendor row ↔ the API's shapes (FR-012): the payment-term columns become the
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

function statusOf(row: VendorRow): VendorStatus {
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
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
