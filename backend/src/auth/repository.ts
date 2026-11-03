import type { AppPrismaClient } from '../db/client.js';

// Sessions and refresh tokens (migration 0008_sessions). Slice 1's later stories add the
// writes: login, rotation, revocation.

/**
 * The session a refresh token belongs to, whatever the token's or session's state, or
 * null when no token has this hash. Only the hash is ever looked up or stored.
 */
export async function findSessionIdByRefreshToken(
  prisma: AppPrismaClient,
  tokenHash: Buffer,
): Promise<string | null> {
  const token = await prisma.refreshToken.findUnique({
    where: { tokenHash: new Uint8Array(tokenHash) },
    select: { sessionId: true },
  });
  return token?.sessionId ?? null;
}
