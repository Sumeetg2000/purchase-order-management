import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_COOKIE,
  clearSessionCookies,
  CSRF_COOKIE,
  readCookies,
  REFRESH_COOKIE,
  setSessionCookies,
} from '../../src/auth/cookies.js';
import { ACCESS_TOKEN_LIFETIME_SECONDS } from '../../src/auth/constants.js';

// Cookie names, flags, paths and lifetimes (ADR-0017 "Tokens and cookies", research R2).

const REFRESH_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function app() {
  const server = express();
  server.post('/set', (_req, res) => {
    setSessionCookies(res, {
      accessToken: 'access-jwt',
      refreshToken: 'refresh-opaque',
      csrfToken: 'csrf-hmac',
      refreshMaxAgeSeconds: REFRESH_MAX_AGE_SECONDS,
    });
    res.sendStatus(204);
  });
  server.post('/clear', (_req, res) => {
    clearSessionCookies(res);
    res.sendStatus(204);
  });
  server.get('/read', (req, res) => {
    res.json(readCookies(req));
  });
  return server;
}

function cookieNamed(header: string[] | undefined, name: string): string {
  const found = (header ?? []).find((c) => c.startsWith(`${name}=`));
  if (!found) throw new Error(`no ${name} cookie in ${JSON.stringify(header)}`);
  return found;
}

describe('[NFR-SEC-01] session cookies', () => {
  it('[NFR-SEC-01] names the three cookies po_access, po_refresh and po_csrf', () => {
    expect([ACCESS_COOKIE, REFRESH_COOKIE, CSRF_COOKIE]).toEqual([
      'po_access',
      'po_refresh',
      'po_csrf',
    ]);
  });

  it('[NFR-SEC-01] the access cookie is HttpOnly, Secure, SameSite=Strict, Path=/api, and lives as long as the refresh cookie', async () => {
    const res = await request(app()).post('/set');
    const access = cookieNamed(res.get('Set-Cookie'), ACCESS_COOKIE);
    expect(access).toMatch(/^po_access=access-jwt;/);
    expect(access).toContain('Path=/api;');
    // Not the JWT's 15 minutes: a cookie that expired with its token would vanish, and the
    // next request would be UNAUTHENTICATED instead of ACCESS_TOKEN_EXPIRED (ADR-0017).
    expect(access).toContain(`Max-Age=${String(REFRESH_MAX_AGE_SECONDS)};`);
    expect(REFRESH_MAX_AGE_SECONDS).toBeGreaterThan(ACCESS_TOKEN_LIFETIME_SECONDS);
    expect(access).toMatch(/HttpOnly/);
    expect(access).toMatch(/Secure/);
    expect(access).toMatch(/SameSite=Strict/);
  });

  it('[NFR-SEC-01] the refresh cookie is HttpOnly, Secure, SameSite=Strict, Path=/api/auth, with the given lifetime', async () => {
    const res = await request(app()).post('/set');
    const refresh = cookieNamed(res.get('Set-Cookie'), REFRESH_COOKIE);
    expect(refresh).toMatch(/^po_refresh=refresh-opaque;/);
    expect(refresh).toContain('Path=/api/auth;');
    expect(refresh).toContain(`Max-Age=${String(REFRESH_MAX_AGE_SECONDS)};`);
    expect(refresh).toMatch(/HttpOnly/);
    expect(refresh).toMatch(/Secure/);
    expect(refresh).toMatch(/SameSite=Strict/);
  });

  it('[NFR-SEC-04] the CSRF cookie is readable by the page, Path=/, and lives as long as the refresh cookie', async () => {
    const res = await request(app()).post('/set');
    const csrf = cookieNamed(res.get('Set-Cookie'), CSRF_COOKIE);
    expect(csrf).toMatch(/^po_csrf=csrf-hmac;/);
    expect(csrf).toContain('Path=/;');
    expect(csrf).toContain(`Max-Age=${String(REFRESH_MAX_AGE_SECONDS)};`);
    expect(csrf).not.toMatch(/HttpOnly/);
    expect(csrf).toMatch(/Secure/);
    expect(csrf).toMatch(/SameSite=Strict/);
  });

  it('[NFR-SEC-03] clearing expires all three cookies on their own paths', async () => {
    const res = await request(app()).post('/clear');
    const header = res.get('Set-Cookie');
    for (const [name, path] of [
      [ACCESS_COOKIE, '/api'],
      [REFRESH_COOKIE, '/api/auth'],
      [CSRF_COOKIE, '/'],
    ] as const) {
      const cookie = cookieNamed(header, name);
      expect(cookie).toContain(`Path=${path};`);
      expect(cookie).toMatch(/Expires=Thu, 01 Jan 1970/);
    }
  });

  it('[NFR-SEC-01] reads the session cookies from a request and ignores the rest', async () => {
    const res = await request(app())
      .get('/read')
      .set('Cookie', 'po_access=a.b.c; theme=dark; po_refresh=r%3D; po_csrf=x');
    expect(res.body).toEqual({ access: 'a.b.c', refresh: 'r=', csrf: 'x' });
    const none = await request(app()).get('/read');
    expect(none.body).toEqual({});
  });
});
