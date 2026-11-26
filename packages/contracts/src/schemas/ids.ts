import { z } from 'zod';

/** A resource id in the path; a non-UUID is 400 VALIDATION_FAILED (ADR-0007). */
export const idParams = z.strictObject({ id: z.uuid() });
/** An order's receipt in the path: the order's id and the receipt's. */
export const receiptParams = z.strictObject({ id: z.uuid(), receiptId: z.uuid() });
