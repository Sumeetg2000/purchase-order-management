// The web app's CSP and security headers come from deploy/security-headers.mjs (research
// R18); nginx must send exactly those on every location that serves the app.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from '../../deploy/security-headers.mjs';

const conf = readFileSync(new URL('../../deploy/nginx/default.conf', import.meta.url), 'utf8')
  .split('\n')
  .map((line) => line.replace(/#.*/, ''))
  .join('\n');

/** The body of `location <match> { ... }`, braces balanced. */
function locationBody(match) {
  const start = conf.indexOf(`location ${match} {`);
  assert.notEqual(start, -1, `no location ${match}`);
  let depth = 0;
  for (let i = conf.indexOf('{', start); i < conf.length; i += 1) {
    if (conf[i] === '{') depth += 1;
    if (conf[i] === '}') depth -= 1;
    if (depth === 0) return conf.slice(conf.indexOf('{', start) + 1, i);
  }
  throw new Error(`unbalanced location ${match}`);
}

/** add_header name → value (always required), Cache-Control left out. */
function headers(body) {
  const found = {};
  for (const [, name, value, always] of body.matchAll(
    /add_header\s+(\S+)\s+"([^"]*)"(\s+always)?;/g,
  )) {
    if (name === 'Cache-Control') continue;
    assert.ok(always, `${name} must be sent with "always"`);
    found[name] = value;
  }
  return found;
}

describe('[NFR-FE-05] web app security headers', () => {
  it('[NFR-FE-05] the CSP is research R18 exactly', () => {
    assert.equal(
      CONTENT_SECURITY_POLICY,
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; " +
        "form-action 'self'",
    );
    assert.deepEqual(Object.keys(SECURITY_HEADERS).sort(), [
      'Content-Security-Policy',
      'Referrer-Policy',
      'X-Content-Type-Options',
    ]);
    assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
    assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  });

  for (const location of ['/', '/assets/']) {
    it(`[NFR-FE-05] nginx sends exactly those headers on location ${location}`, () => {
      assert.deepEqual(headers(locationBody(location)), SECURITY_HEADERS);
    });
  }

  it('[NFR-FE-05] the API location adds none of them (the API sends its own)', () => {
    assert.deepEqual(headers(locationBody('/api/')), {});
  });
});
