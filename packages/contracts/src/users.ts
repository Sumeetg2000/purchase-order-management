// User roles, role sets and statuses (ADR-0016). The users table's CHECK constraints
// (migration 0002_users) allow exactly these; a backend test compares them.

export const USER_ROLES = ['BUYER', 'APPROVER', 'ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Each role by name, e.g. ROLE.ADMIN. */
export const ROLE = Object.fromEntries(USER_ROLES.map((role) => [role, role])) as {
  readonly [R in UserRole]: R;
};

/**
 * The only role sets a user may hold, each in canonical order: a dual-role user is
 * exactly [BUYER, APPROVER]. ADMIN is never combined with another role.
 */
export const ROLE_SETS = [
  [],
  [ROLE.BUYER],
  [ROLE.APPROVER],
  [ROLE.BUYER, ROLE.APPROVER],
  [ROLE.ADMIN],
] as const satisfies readonly (readonly UserRole[])[];
export type RoleSet = (typeof ROLE_SETS)[number];

export const USER_STATUSES = ['UNVERIFIED', 'ACTIVE', 'DEACTIVATED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Each status by name, e.g. USER_STATUS.ACTIVE. */
export const USER_STATUS = Object.fromEntries(USER_STATUSES.map((status) => [status, status])) as {
  readonly [S in UserStatus]: S;
};
