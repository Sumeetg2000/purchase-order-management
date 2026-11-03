import { z } from 'zod';
import { USER_NAME_MAX_LENGTH, USER_ROLES, USER_STATUSES } from '../users.js';
import { pageQueryShape } from './pagination.js';

// Admin user management (ADR-0016).

/** The role filter of the user list: a role, or NONE for users with no role. */
export const ROLE_FILTERS = [...USER_ROLES, 'NONE'] as const;
export type RoleFilter = (typeof ROLE_FILTERS)[number];

/** Any list of roles; the service checks it is one of ASSIGNABLE_ROLE_SETS. */
export const roleSet = z.array(z.enum(USER_ROLES));

export const userListQuery = z.strictObject({
  ...pageQueryShape,
  role: z.enum(ROLE_FILTERS).optional(),
  status: z.enum(USER_STATUSES).optional(),
  /** A case-insensitive prefix of the name or email. */
  q: z.string().trim().min(1).max(USER_NAME_MAX_LENGTH).optional(),
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
