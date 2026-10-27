import { z } from 'zod';

/** GET /healthz: the process is up. */
export const healthSchema = z.strictObject({ status: z.literal('ok') });

/** GET /readyz: the database answers and every shipped migration is applied. */
export const readinessSchema = z
  .strictObject({
    status: z.literal('ready'),
    checks: z.strictObject({ database: z.literal('ok'), migrations: z.literal('ok') }),
  })
  .meta({ id: 'Readiness' });
