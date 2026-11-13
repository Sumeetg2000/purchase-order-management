import type { OrderStatus } from '@po/contracts';

export const ORDER_STATUS_LABELS = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
} as const satisfies Record<OrderStatus, string>;
