import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { Clock } from '../lib/clock.js';
import { ACCESS_TOKEN_LIFETIME_SECONDS } from './constants.js';
import { SECOND_MS } from '../lib/time.js';

// The access JWT (ADR-0017, research R2): HS256 with a kid, carrying only the user id
// (sub) and the session id (sid). An expired but otherwise valid token is
// ACCESS_TOKEN_EXPIRED, so the web app refreshes; anything else wrong is UNAUTHENTICATED.

const ALGORITHM = 'HS256';

const claimsSchema = z.object({ sub: z.uuid(), sid: z.uuid() });

interface AccessTokenSubject {
  userId: string;
  sessionId: string;
}

type AccessTokenCheck =
  | ({ ok: true } & AccessTokenSubject)
  | { ok: false; code: 'ACCESS_TOKEN_EXPIRED' | 'UNAUTHENTICATED' };

export interface AccessTokens {
  sign(subject: AccessTokenSubject): Promise<string>;
  verify(token: string): Promise<AccessTokenCheck>;
}

export function createAccessTokens(options: {
  /** JWT_SIGNING_KEY: base64url, at least 32 bytes (validated by the config). */
  signingKey: string;
  keyId: string;
  clock: Clock;
}): AccessTokens {
  const key = Buffer.from(options.signingKey, 'base64url');
  const { keyId, clock } = options;
  const nowSeconds = () => Math.floor(clock.now().getTime() / SECOND_MS);

  return {
    sign: ({ userId, sessionId }) => {
      const issuedAt = nowSeconds();
      return new SignJWT({ sid: sessionId })
        .setProtectedHeader({ alg: ALGORITHM, kid: keyId })
        .setSubject(userId)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + ACCESS_TOKEN_LIFETIME_SECONDS)
        .sign(key);
    },

    verify: async (token) => {
      try {
        const { payload, protectedHeader } = await jwtVerify(token, key, {
          algorithms: [ALGORITHM],
          currentDate: clock.now(),
          requiredClaims: ['sub', 'sid', 'exp'],
        });
        // One key, one id: a token signed under another id is from a rotated-out key.
        if (protectedHeader.kid !== keyId) return { ok: false, code: 'UNAUTHENTICATED' };
        const claims = claimsSchema.safeParse(payload);
        if (!claims.success) return { ok: false, code: 'UNAUTHENTICATED' };
        return { ok: true, userId: claims.data.sub, sessionId: claims.data.sid };
      } catch (error) {
        // jose checks the signature before the expiry, so this token was genuine.
        if (error instanceof errors.JWTExpired) return { ok: false, code: 'ACCESS_TOKEN_EXPIRED' };
        return { ok: false, code: 'UNAUTHENTICATED' };
      }
    },
  };
}
