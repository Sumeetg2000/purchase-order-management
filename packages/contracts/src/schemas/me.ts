import { z } from 'zod';
import { USER_ROLES, USER_STATUSES } from '../users.js';
import { userName } from './auth.js';

/** The caller's own profile (ADR-0016). No phone: none is stored (amended 2026-11-03). */
export const me = z
  .strictObject({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    roles: z.array(z.enum(USER_ROLES)),
    status: z.enum(USER_STATUSES),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Me' });

/** The only editable profile field; anything else (phone included) is UNKNOWN_FIELD. */
export const updateMeBody = z.strictObject({ name: userName });
