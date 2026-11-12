import type { ActingRole, UserRole, UserStatus } from '@po/contracts';

// Roles and statuses as the screens name them (ADR-0016: Admin shows as "Procurement Admin").

export const ROLE_LABELS: Readonly<Record<UserRole, string>> = {
  BUYER: 'Buyer',
  APPROVER: 'Approver',
  ADMIN: 'Procurement Admin',
};

/** The capacity an audit entry records; SELF is a user acting on their own account. */
export const ACTING_ROLE_LABELS: Readonly<Record<ActingRole, string>> = {
  ...ROLE_LABELS,
  SELF: 'Self',
};

export const STATUS_LABELS: Readonly<Record<UserStatus, string>> = {
  ACTIVE: 'Active',
  UNVERIFIED: 'Unverified',
  DEACTIVATED: 'Deactivated',
};

/** "Buyer + Approver", or "No role". */
export function roleSetLabel(roles: readonly UserRole[]): string {
  return roles.length === 0 ? 'No role' : roles.map((role) => ROLE_LABELS[role]).join(' + ');
}
