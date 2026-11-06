import { z } from 'zod';
import {
  ACCESS_REQUEST_MESSAGE_MAX_LENGTH,
  ACCESS_REQUEST_NOTE_MAX_LENGTH,
  ACCESS_REQUEST_STATUSES,
} from '../access-requests.js';
import { pageQueryShape } from './pagination.js';

// Access requests (ADR-0016): the user's own, and the admin view.

export const accessRequestBody = z.strictObject({
  message: z.string().trim().min(1).max(ACCESS_REQUEST_MESSAGE_MAX_LENGTH),
});

export const ownAccessRequest = z
  .strictObject({
    status: z.enum(ACCESS_REQUEST_STATUSES),
    message: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    decidedAt: z.iso.datetime().nullable(),
    adminNote: z.string().nullable(),
  })
  .meta({ id: 'OwnAccessRequest' });

export const adminAccessRequest = ownAccessRequest
  .extend({
    id: z.uuid(),
    user: z.strictObject({
      id: z.uuid(),
      name: z.string(),
      email: z.string(),
      signedUpAt: z.iso.datetime(),
    }),
  })
  .meta({ id: 'AdminAccessRequest' });

export const accessRequestListQuery = z.strictObject({
  ...pageQueryShape,
  status: z.enum(ACCESS_REQUEST_STATUSES).optional(),
});

export const dismissBody = z.strictObject({
  note: z.string().trim().max(ACCESS_REQUEST_NOTE_MAX_LENGTH).optional(),
});

export type AccessRequestBody = z.infer<typeof accessRequestBody>;
export type OwnAccessRequest = z.infer<typeof ownAccessRequest>;
export type AdminAccessRequest = z.infer<typeof adminAccessRequest>;
export type AccessRequestListQuery = z.infer<typeof accessRequestListQuery>;
export type DismissBody = z.infer<typeof dismissBody>;
