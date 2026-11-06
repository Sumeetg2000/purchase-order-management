// Vendor constants (ADR-0005, specs/003-vendors/data-model.md). The vendors table's CHECKs
// and generated name_key (migration 0011_vendors) hold SQL copies of these;
// backend/tests/integration/vendor-constants.test.ts pins each one.

export const VENDOR_NAME_MAX = 200;
export const CONTACT_NAME_MAX = 200;
export const CONTACT_PHONE_MAX = 30;
/** The characters a phone may hold; it must also hold at least one digit. */
export const CONTACT_PHONE_PATTERN = /^[0-9 +()-]+$/;
export const NET_DAYS_MAX = 180;
export const ADVANCE_PERCENT_MIN = 1;
export const ADVANCE_PERCENT_MAX = 99;

export const PAYMENT_TERM_TYPES = ['NET', 'ADVANCE', 'PARTIAL_ADVANCE'] as const;
export type PaymentTermType = (typeof PAYMENT_TERM_TYPES)[number];

export const VENDOR_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

/** Filter values for the list; ALL is a filter only, never a vendor status. */
export const VENDOR_STATUS_FILTERS = [...VENDOR_STATUSES, 'ALL'] as const;
export type VendorStatusFilter = (typeof VENDOR_STATUS_FILTERS)[number];
export const VENDOR_STATUS_FILTER_DEFAULT = 'ACTIVE' satisfies VendorStatusFilter;

/** The audit actions of a vendor's history (data-model.md). */
export const VENDOR_AUDIT_ACTIONS = [
  'VENDOR_CREATED',
  'VENDOR_UPDATED',
  'VENDOR_DEACTIVATED',
  'VENDOR_REACTIVATED',
] as const;
export type VendorAuditAction = (typeof VENDOR_AUDIT_ACTIONS)[number];

/** JavaScript's \s, the whitespace the generated name_key collapses (research R2). */
const WHITESPACE_RUN = /\s+/gu;

/**
 * The uniqueness and search key of a vendor name: NFC, every whitespace run collapsed to
 * one space, trimmed, lower-case. The same rule as the generated name_key column; a test
 * pins the two together.
 */
export function normaliseVendorName(name: string): string {
  return name.normalize('NFC').replace(WHITESPACE_RUN, ' ').trim().toLowerCase();
}
