import { z } from 'zod';
import { money, toMoney, UNIT_PRICE_INPUT_PATTERN } from '../money.js';
import {
  DELETE_REASON_MAX,
  LINE_DESCRIPTION_MAX,
  LINE_QUANTITY_MAX,
  ORDER_LINES_MAX,
  ORDER_LINES_MIN,
  ORDER_READ_ONLY_FIELDS,
  ORDER_STATUSES,
  PO_NUMBER_PATTERN,
} from '../orders.js';
import { VENDOR_STATUSES } from '../vendors.js';
import { pageQueryShape } from './pagination.js';
import { readOnlyGuarded } from './read-only.js';

// Draft orders (specs/004-draft-orders/contracts/api.md, research R6 and R9).

/**
 * Length in Unicode code points: an emoji counts once, not as two UTF-16 units. That is
 * the UTF-16 length less one per surrogate pair, as PostgreSQL's char_length counts.
 */
const codePoints = (s: string) => s.length - (s.match(SURROGATE_PAIR)?.length ?? 0);
const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

/**
 * Well-formed Unicode: no lone surrogate (an escaped JSON string can carry one, and
 * PostgreSQL can't store it). With the u flag a surrogate pair is one code point, so this
 * class matches only an unpaired half. String.prototype.isWellFormed is ES2024.
 */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

/** Trimmed, well-formed text of 1 to `max` code points; `allowed` control characters only. */
function plainText(max: number, allowedControls: RegExp | undefined) {
  return z
    .string()
    .trim()
    .refine((s) => !LONE_SURROGATE.test(s), { params: { fieldCode: 'INVALID_FORMAT' } })
    .refine((s) => !/\p{Cc}/u.test(allowedControls ? s.replace(allowedControls, '') : s), {
      params: { fieldCode: 'INVALID_FORMAT' },
    })
    .refine((s) => codePoints(s) >= 1, { params: { fieldCode: 'TOO_SHORT' } })
    .refine((s) => codePoints(s) <= max, { params: { fieldCode: 'TOO_LONG' } });
}

/** Single-line plain text: every control character, line breaks and tabs included, refused. */
const description = plainText(LINE_DESCRIPTION_MAX, undefined);

/** A decimal string (never a JSON number), normalised to Money; ≤ the max by its pattern. */
const unitPrice = z.string().regex(UNIT_PRICE_INPUT_PATTERN).transform(toMoney);

const quantity = z.int().min(1).max(LINE_QUANTITY_MAX);

const lineShape = { description, quantity, unitPrice };

/** A line of a create: no id, the server assigns one. */
const createLine = readOnlyGuarded(z.strictObject(lineShape), ORDER_READ_ONLY_FIELDS);

/** A line of an edit: with an id it updates that line, without one it is added (R6). */
const editLine = readOnlyGuarded(
  z.strictObject({ id: z.uuid().optional(), ...lineShape }),
  ORDER_READ_ONLY_FIELDS,
);

export const createOrderBody = readOnlyGuarded(
  z.strictObject({
    vendorId: z.uuid(),
    lines: z.array(createLine).min(ORDER_LINES_MIN).max(ORDER_LINES_MAX),
  }),
  ORDER_READ_ONLY_FIELDS,
).meta({ id: 'CreateOrderBody' });

/** The full intended state (ADR-0009): the vendor and the whole line set, in display order. */
export const editOrderBody = readOnlyGuarded(
  z.strictObject({
    vendorId: z.uuid(),
    lines: z.array(editLine).min(ORDER_LINES_MIN).max(ORDER_LINES_MAX),
  }),
  ORDER_READ_ONLY_FIELDS,
).meta({ id: 'EditOrderBody' });

/** An optional reason: plain text that may hold line breaks; null or absent for none. */
export const deleteOrderBody = z
  .strictObject({
    reason: plainText(DELETE_REASON_MAX, /\r?\n|\r/g)
      .nullable()
      .optional(),
  })
  .meta({ id: 'DeleteOrderBody' });

export const orderLine = z
  .strictObject({
    id: z.uuid(),
    description: z.string(),
    quantity: z.int(),
    unitPrice: money,
    lineTotal: money,
  })
  .meta({ id: 'OrderLine' });

export const order = z
  .strictObject({
    id: z.uuid(),
    poNumber: z.string().regex(PO_NUMBER_PATTERN),
    status: z.enum(ORDER_STATUSES),
    vendor: z.strictObject({ id: z.uuid(), name: z.string(), status: z.enum(VENDOR_STATUSES) }),
    owner: z.strictObject({ id: z.uuid(), name: z.string() }),
    total: money,
    lineCount: z.int(),
    lines: z.array(orderLine),
    version: z.int(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Order' });

export const orderListItem = order
  .omit({ lines: true, version: true, updatedAt: true })
  .extend({ vendor: z.strictObject({ id: z.uuid(), name: z.string() }) })
  .meta({ id: 'OrderListItem' });

export const orderListQuery = z
  .strictObject({
    ...pageQueryShape,
    status: z.enum(ORDER_STATUSES).optional(),
    vendorId: z.uuid().optional(),
    /** A PO-number prefix, case-insensitive: upper-cased before matching. */
    poNumber: z
      .string()
      .trim()
      .min(1)
      .max(30)
      .regex(/^[A-Za-z0-9-]+$/)
      .transform((s) => s.toUpperCase())
      .optional(),
    /** Inclusive calendar dates in Asia/Kolkata. */
    createdFrom: z.iso.date().optional(),
    createdTo: z.iso.date().optional(),
  })
  .refine((q) => !q.createdFrom || !q.createdTo || q.createdFrom <= q.createdTo, {
    path: ['createdTo'],
    params: { fieldCode: 'OUT_OF_RANGE' },
  });

export type CreateOrderBody = z.infer<typeof createOrderBody>;
export type EditOrderBody = z.infer<typeof editOrderBody>;
export type DeleteOrderBody = z.infer<typeof deleteOrderBody>;
export type OrderLine = z.infer<typeof orderLine>;
export type Order = z.infer<typeof order>;
export type OrderListItem = z.infer<typeof orderListItem>;
export type OrderListQuery = z.infer<typeof orderListQuery>;
