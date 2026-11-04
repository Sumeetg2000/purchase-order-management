import { z } from 'zod';
import { EMAIL_MAX_LENGTH } from '../email.js';
import { assignableRoleSet, USER_NAME_MAX_LENGTH, USER_ROLES, USER_STATUSES } from '../users.js';
import { pageQueryShape } from './pagination.js';

// Admin user management (ADR-0016).

/** The longest user search: a whole name or email address. */
export const USER_SEARCH_MAX_LENGTH = Math.max(USER_NAME_MAX_LENGTH, EMAIL_MAX_LENGTH);

/** The role filter of the user list: a role, or NONE for users with no role. */
export const ROLE_FILTERS = [...USER_ROLES, 'NONE'] as const;
export type RoleFilter = (typeof ROLE_FILTERS)[number];

/** One of ASSIGNABLE_ROLE_SETS, in any order; anything else is INVALID_ROLE_SET. */
export const roleSet = z
  .array(z.enum(USER_ROLES))
  .refine((roles) => assignableRoleSet(roles) !== undefined, {
    message: 'not an assignable role set',
    params: { fieldCode: 'INVALID_ROLE_SET' },
  });

export const userListQuery = z.strictObject({
  ...pageQueryShape,
  role: z.enum(ROLE_FILTERS).optional(),
  status: z.enum(USER_STATUSES).optional(),
  /** A case-insensitive prefix of the name or email: as long as either can be. */
  q: z.string().trim().min(1).max(USER_SEARCH_MAX_LENGTH).optional(),
});

export const adminUserItem = z
  .strictObject({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    roles: z.array(z.enum(USER_ROLES)),
    status: z.enum(USER_STATUSES),
    lastLoginAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'AdminUserItem' });

export const adminUserDetail = adminUserItem
  .extend({
    createdAt: z.iso.datetime(),
    version: z.int(),
    openOrders: z.strictObject({
      draft: z.int(),
      pending: z.int(),
      approvedWithOpenLines: z.int(),
    }),
  })
  .meta({ id: 'AdminUserDetail' });

export const updateUserBody = z
  .strictObject({ roles: roleSet.optional(), isActive: z.boolean().optional() })
  .refine((body) => body.roles !== undefined || body.isActive !== undefined, {
    message: 'set roles, isActive or both',
  });

export type UserListQuery = z.infer<typeof userListQuery>;
export type AdminUserItem = z.infer<typeof adminUserItem>;
export type AdminUserDetail = z.infer<typeof adminUserDetail>;
export type UpdateUserBody = z.infer<typeof updateUserBody>;
