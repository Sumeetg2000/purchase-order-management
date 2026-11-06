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

/** The role sets an admin may assign: never none (that's signup's) and never Admin. */
export const ASSIGNABLE_ROLE_SETS = [
  [ROLE.BUYER],
  [ROLE.APPROVER],
  [ROLE.BUYER, ROLE.APPROVER],
] as const satisfies readonly RoleSet[];
export type AssignableRoleSet = (typeof ASSIGNABLE_ROLE_SETS)[number];

/**
 * The assignable set holding exactly these roles, in canonical order, or undefined: any
 * order is accepted, a repeated role is not.
 */
export function assignableRoleSet(roles: readonly UserRole[]): AssignableRoleSet | undefined {
  return ASSIGNABLE_ROLE_SETS.find(
    (set) => set.length === roles.length && set.every((role) => roles.includes(role)),
  );
}

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

export const USER_STATUSES = ['UNVERIFIED', 'ACTIVE', 'DEACTIVATED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Each status by name, e.g. USER_STATUS.ACTIVE. */
export const USER_STATUS = Object.fromEntries(USER_STATUSES.map((status) => [status, status])) as {
  readonly [S in UserStatus]: S;
};

/** The acting role of a user acting on their own account: signup, verification, profile. */
export const SELF_ACTING_ROLE = 'SELF';

/** What a user may act as in an audit entry: a role, or SELF for their own account. */
export const ACTING_ROLES = [...USER_ROLES, SELF_ACTING_ROLE] as const;
export type ActingRole = (typeof ACTING_ROLES)[number];

/** A user's name: 1 to 100 characters (ADR-0007). */
export const USER_NAME_MAX_LENGTH = 100;

/** Password length bounds (ADR-0017). */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
