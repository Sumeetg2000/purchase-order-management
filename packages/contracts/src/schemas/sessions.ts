import { z } from 'zod';

/** One of the caller's active sessions, as the sessions list shows it (ADR-0017). */
export const sessionItem = z
  .strictObject({
    id: z.uuid(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime(),
    userAgent: z.string(),
    ip: z.string(),
    /** The session the request came from. */
    current: z.boolean(),
  })
  .meta({ id: 'SessionItem' });

export type SessionItem = z.infer<typeof sessionItem>;
