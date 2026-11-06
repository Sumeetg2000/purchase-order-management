import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { createAccessTokens } from '../../src/auth/access-token.js';
import { ACCESS_TOKEN_LIFETIME_SECONDS } from '../../src/auth/constants.js';
import { testClock } from '../support/clock.js';

// The access JWT (ADR-0017, research R2): HS256 with a kid, sub and sid only, 15 minutes.
// An expired token is ACCESS_TOKEN_EXPIRED; anything else wrong is UNAUTHENTICATED.

const key = Buffer.alloc(32, 7).toString('base64url');
const otherKey = Buffer.alloc(32, 8).toString('base64url');
const subject = { userId: randomUUID(), sessionId: randomUUID() };

function tokens(clock = testClock(), keyId = 'k1', signingKey = key) {
  return { clock, tokens: createAccessTokens({ signingKey, keyId, clock }) };
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('[NFR-SEC-01] access tokens', () => {
  it('[NFR-SEC-01] signs HS256 with the key id, carrying only sub, sid, iat and exp', async () => {
    const { clock, tokens: t } = tokens();
    const jwt = await t.sign(subject);
    const [header = '', payload = ''] = jwt.split('.');
    expect(decode(header)).toEqual({ alg: 'HS256', kid: 'k1' });
    const issuedAt = Math.floor(clock.now().getTime() / 1_000);
    expect(decode(payload)).toEqual({
      sub: subject.userId,
      sid: subject.sessionId,
      iat: issuedAt,
      exp: issuedAt + ACCESS_TOKEN_LIFETIME_SECONDS,
    });
  });

  it('[NFR-SEC-01] verifies its own token and returns the user and session', async () => {
    const { tokens: t } = tokens();
    expect(await t.verify(await t.sign(subject))).toEqual({ ok: true, ...subject });
  });

  it('[NFR-SEC-01] a token is valid until its last second, then ACCESS_TOKEN_EXPIRED', async () => {
    const { clock, tokens: t } = tokens();
    const jwt = await t.sign(subject);
    clock.advance(ACCESS_TOKEN_LIFETIME_SECONDS * 1_000 - 1_000);
    expect(await t.verify(jwt)).toMatchObject({ ok: true });
    clock.advance(1_000);
    expect(await t.verify(jwt)).toEqual({ ok: false, code: 'ACCESS_TOKEN_EXPIRED' });
  });

  it('[NFR-AUTH-01] a malformed, foreign-key, wrong-kid or unsigned token is UNAUTHENTICATED', async () => {
    const { clock, tokens: t } = tokens();
    const foreign = await tokens(clock, 'k1', otherKey).tokens.sign(subject);
    const otherKid = await tokens(clock, 'k2').tokens.sign(subject);
    const [, payload = ''] = (await t.sign(subject)).split('.');
    const unsigned = `${Buffer.from('{"alg":"none","kid":"k1"}').toString('base64url')}.${payload}.`;
    for (const jwt of ['', 'not.a.jwt', foreign, otherKid, unsigned]) {
      expect(await t.verify(jwt), jwt).toEqual({ ok: false, code: 'UNAUTHENTICATED' });
    }
  });

  it('[NFR-AUTH-01] a correctly signed token without a valid sub and sid is UNAUTHENTICATED', async () => {
    const { clock, tokens: t } = tokens();
    const now = Math.floor(clock.now().getTime() / 1_000);
    const secret = Buffer.from(key, 'base64url');
    const sign = (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .sign(secret);
    for (const claims of [
      { sub: subject.userId },
      { sid: subject.sessionId },
      { sub: 'x', sid: 'y' },
    ]) {
      expect(await t.verify(await sign(claims)), JSON.stringify(claims)).toEqual({
        ok: false,
        code: 'UNAUTHENTICATED',
      });
    }
  });
});
