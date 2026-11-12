import { z } from 'zod';
import { AUDIT_ACTOR_TYPES } from '../audit.js';
import { emailAddressSchema } from '../email.js';
import { ACTING_ROLES } from '../users.js';
import {
  ADVANCE_PERCENT_MAX,
  ADVANCE_PERCENT_MIN,
  CONTACT_NAME_MAX,
  CONTACT_PHONE_MAX,
  CONTACT_PHONE_PATTERN,
  NET_DAYS_MAX,
  VENDOR_AUDIT_ACTIONS,
  VENDOR_NAME_MAX,
  VENDOR_STATUS_FILTER_DEFAULT,
  VENDOR_STATUS_FILTERS,
  VENDOR_STATUSES,
} from '../vendors.js';
import { pageQueryShape } from './pagination.js';

// Vendors (ADR-0005, specs/003-vendors/contracts/api.md).

const netDays = z.int().min(0).max(NET_DAYS_MAX);

/** One strict object per term type, so a field of another type is UNKNOWN_FIELD (R5). */
export const paymentTerms = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('NET'), netDays }),
    z.strictObject({ type: z.literal('ADVANCE') }),
    z.strictObject({
      type: z.literal('PARTIAL_ADVANCE'),
      advancePercent: z.int().min(ADVANCE_PERCENT_MIN).max(ADVANCE_PERCENT_MAX),
      netDays,
    }),
  ])
  .meta({ id: 'PaymentTerms' });

/** "" (or blanks) is TOO_SHORT: null or omission is the only "no phone" (R6). */
const contactPhone = z
  .string()
  .trim()
  .min(1)
  .max(CONTACT_PHONE_MAX)
  .regex(CONTACT_PHONE_PATTERN)
  .regex(/[0-9]/);

/** Create and full-replacement edit share one body (R7). */
export const vendorBody = z
  .strictObject({
    name: z.string().trim().min(1).max(VENDOR_NAME_MAX),
    contactName: z.string().trim().min(1).max(CONTACT_NAME_MAX),
    contactEmail: emailAddressSchema.transform((email) => email.toLowerCase()),
    /** Omitted or null: stored as NULL. */
    contactPhone: contactPhone.nullable().optional(),
    paymentTerms,
  })
  .meta({ id: 'VendorBody' });

export const vendor = z
  .strictObject({
    id: z.uuid(),
    name: z.string(),
    contactName: z.string(),
    contactEmail: z.string(),
    contactPhone: z.string().nullable(),
    paymentTerms,
    status: z.enum(VENDOR_STATUSES),
    deactivatedAt: z.iso.datetime().nullable(),
    version: z.int(),
  })
  .meta({ id: 'Vendor' });

export const vendorListQuery = z.strictObject({
  ...pageQueryShape,
  status: z.enum(VENDOR_STATUS_FILTERS).default(VENDOR_STATUS_FILTER_DEFAULT),
  /** A name prefix, case- and space-insensitive: compared in SQL by vendor_name_key. */
  q: z.string().trim().min(1).max(VENDOR_NAME_MAX).optional(),
});

/** A vendor as its audit entries record it (data-model.md). */
export const vendorSnapshot = vendor
  .pick({
    name: true,
    contactName: true,
    contactEmail: true,
    contactPhone: true,
    paymentTerms: true,
    status: true,
  })
  .meta({ id: 'VendorSnapshot' });

export const vendorHistoryItem = z
  .strictObject({
    /** The audit entry's id. */
    id: z.string(),
    action: z.enum(VENDOR_AUDIT_ACTIONS),
    occurredAt: z.iso.datetime(),
    actor: z.strictObject({
      type: z.enum(AUDIT_ACTOR_TYPES),
      name: z.string().nullable(),
      email: z.string().nullable(),
      role: z.enum(ACTING_ROLES).nullable(),
    }),
    before: vendorSnapshot.nullable(),
    after: vendorSnapshot,
  })
  .meta({ id: 'VendorHistoryItem' });

export type PaymentTerms = z.infer<typeof paymentTerms>;
export type VendorBody = z.infer<typeof vendorBody>;
export type Vendor = z.infer<typeof vendor>;
export type VendorListQuery = z.infer<typeof vendorListQuery>;
export type VendorSnapshot = z.infer<typeof vendorSnapshot>;
export type VendorHistoryItem = z.infer<typeof vendorHistoryItem>;
