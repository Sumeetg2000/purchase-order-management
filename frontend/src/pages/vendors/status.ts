import type { VendorStatus, VendorStatusFilter } from '@po/contracts';

export const VENDOR_STATUS_LABELS = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
} as const satisfies Record<VendorStatus, string>;

export const VENDOR_FILTER_LABELS = {
  ...VENDOR_STATUS_LABELS,
  ALL: 'All',
} as const satisfies Record<VendorStatusFilter, string>;
