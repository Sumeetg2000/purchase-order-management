import { z } from 'zod';
import { money, toMoney, UNIT_PRICE_INPUT_PATTERN } from '../money.js';
import { AUDIT_ACTOR_TYPES } from '../audit.js';
import { ACTING_ROLES } from '../users.js';
import {
  DELETE_REASON_MAX,
  LINE_DESCRIPTION_MAX,
  LINE_QUANTITY_MAX,
  ORDER_LINES_MAX,
  ORDER_AUDIT_ACTIONS,
  ORDER_LINES_MIN,
  ORDER_READ_ONLY_FIELDS,
  ORDER_STATUSES,
  PO_NUMBER_PATTERN,
} from '../orders.js';
import { VENDOR_STATUSES } from '../vendors.js';
import { approvalRound, vendorOrderSnapshot } from './approvals.js';
import { extensibleEnum } from './extensible-enum.js';
import { pageQueryShape } from './pagination.js';
import { readOnlyGuarded } from './read-only.js';
import { receiptProgress } from './receipts.js';
import { plainText, poNumberPrefix } from './text.js';

// Draft orders (specs/004-draft-orders/contracts/api.md, research R6 and R9).

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
    /** The sum of the line's receipts (slice 6), and what is still to come. */
    receivedQuantity: z.int(),
    outstandingQuantity: z.int(),
  })
  .meta({ id: 'OrderLine' });

/** A cancelled order's record: the canceller by current name, the time and the reason. */
export const orderCancellation = z
  .strictObject({
    cancelledBy: z.strictObject({ id: z.uuid(), name: z.string() }),
    cancelledAt: z.iso.datetime(),
    reason: z.string(),
  })
  .meta({ id: 'OrderCancellation' });

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
    /** The current round's submission time; null on a draft (slice 4, research R4). */
    submittedAt: z.iso.datetime().nullable(),
    approvedAt: z.iso.datetime().nullable(),
    /** Whether the owner is active and still holds BUYER (ADR-0004 S5). */
    ownerCanAct: z.boolean(),
    /** The vendor as submitted; null on a draft, which shows the live vendor. */
    vendorSnapshot: vendorOrderSnapshot.nullable(),
    /** The current round (a withdrawn draft shows its withdrawn one); null if never submitted. */
    approval: approvalRound.nullable(),
    /** Who cancelled the order, when and why; null unless it is cancelled (slice 5, R6). */
    cancellation: orderCancellation.nullable(),
    /** Derived from the lines and receipts (slice 6, research R8). */
    receiptProgress,
  })
  .meta({ id: 'Order' });

export const orderListItem = order
  .omit({
    lines: true,
    version: true,
    updatedAt: true,
    submittedAt: true,
    approvedAt: true,
    ownerCanAct: true,
    vendorSnapshot: true,
    approval: true,
    cancellation: true,
    // The list's receipt badge comes with the lists' own change (research R9).
    receiptProgress: true,
  })
  .extend({ vendor: z.strictObject({ id: z.uuid(), name: z.string() }) })
  .meta({ id: 'OrderListItem' });

export const orderListQuery = z
  .strictObject({
    ...pageQueryShape,
    status: z.enum(ORDER_STATUSES).optional(),
    vendorId: z.uuid().optional(),
    /** A PO-number prefix, case-insensitive: upper-cased before matching. */
    poNumber: poNumberPrefix.optional(),
    /** Inclusive calendar dates in Asia/Kolkata. */
    createdFrom: z.iso.date().optional(),
    createdTo: z.iso.date().optional(),
  })
  .refine((q) => !q.createdFrom || !q.createdTo || q.createdFrom <= q.createdTo, {
    path: ['createdTo'],
    params: { fieldCode: 'OUT_OF_RANGE' },
  });

/** One entry of an order's timeline: who acted, in what capacity, when, and what changed. */
export const orderTimelineItem = z
  .strictObject({
    /** The audit entry's id. */
    id: z.string(),
    /** Grows as slices add order events: published as x-extensible-enum (ADR-0008). */
    action: z.enum(ORDER_AUDIT_ACTIONS).meta(extensibleEnum),
    occurredAt: z.iso.datetime(),
    actor: z.strictObject({
      type: z.enum(AUDIT_ACTOR_TYPES),
      name: z.string().nullable(),
      email: z.string().nullable(),
      role: z.enum(ACTING_ROLES).nullable(),
    }),
    /** As the action's catalogue entry records it (data-model.md); amounts as Money. */
    details: z.record(z.string(), z.unknown()),
  })
  .meta({ id: 'OrderTimelineItem' });

export type CreateOrderBody = z.infer<typeof createOrderBody>;
export type EditOrderBody = z.infer<typeof editOrderBody>;
export type DeleteOrderBody = z.infer<typeof deleteOrderBody>;
export type OrderLine = z.infer<typeof orderLine>;
export type Order = z.infer<typeof order>;
export type OrderListItem = z.infer<typeof orderListItem>;
export type OrderListQuery = z.infer<typeof orderListQuery>;
export type OrderTimelineItem = z.infer<typeof orderTimelineItem>;
