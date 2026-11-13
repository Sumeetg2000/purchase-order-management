import { BODY_LIMIT_BYTES, OPERATIONS, ORDER_BODY_LIMIT_BYTES } from '@po/contracts';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The edge's request-body limits equal the API's (slice 3 research R8, ADR-0020): order
// create and edit take ORDER_BODY_LIMIT_BYTES, everything else BODY_LIMIT_BYTES, so nginx
// never refuses a body the API would take, nor forwards one it would refuse.

/** The config without comments and quoted strings, whose braces would confuse the reader. */
const CONF = readFileSync(new URL('../../../deploy/nginx/default.conf', import.meta.url), 'utf8')
  .replace(/#.*$/gm, '')
  .replace(/'[^']*'/g, "''");

/** nginx size syntax: bytes, k or m. */
function bytes(size: string): number {
  const match = /^(\d+)([km]?)$/i.exec(size);
  if (!match) throw new Error(`unreadable size ${size}`);
  const unit = { '': 1, k: 1024, m: 1024 * 1024 }[(match[2] ?? '').toLowerCase()] ?? NaN;
  return Number(match[1]) * unit;
}

/** The body of the location block opened by `opener`, up to its closing brace. */
function block(opener: string): string {
  const start = CONF.indexOf(opener);
  if (start < 0) throw new Error(`no ${opener}`);
  let depth = 0;
  for (let i = CONF.indexOf('{', start); i < CONF.length; i++) {
    if (CONF[i] === '{') depth++;
    if (CONF[i] === '}' && --depth === 0) return CONF.slice(start, i + 1);
  }
  throw new Error(`unclosed ${opener}`);
}

function limitIn(text: string): number | undefined {
  const match = /client_max_body_size\s+(\S+);/.exec(text);
  return match?.[1] === undefined ? undefined : bytes(match[1]);
}

/** The server-level directive: outside every location block. */
function serverLimit(): number | undefined {
  const outside = CONF.replace(/location[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
  return limitIn(outside);
}

describe("[NFR-VAL-01] nginx body limits equal the API's", () => {
  it('[NFR-VAL-01] the server default and /api/ take BODY_LIMIT_BYTES', () => {
    expect(serverLimit()).toBe(BODY_LIMIT_BYTES);
    expect(limitIn(block('location /api/ {')) ?? serverLimit()).toBe(BODY_LIMIT_BYTES);
  });

  it('[NFR-VAL-01] order create and edit take ORDER_BODY_LIMIT_BYTES, and only they', () => {
    const opener = 'location ~ ^/api/orders(/[^/]+)?$ {';
    expect(limitIn(block(opener))).toBe(ORDER_BODY_LIMIT_BYTES);
    const pattern = /^\/api\/orders(\/[^/]+)?$/;
    const larger = Object.values(OPERATIONS).filter(
      (op) => (op.bodyLimitBytes ?? BODY_LIMIT_BYTES) > BODY_LIMIT_BYTES,
    );
    for (const op of larger) {
      expect(`/api${op.path.replace(/:[a-z]+/gi, 'x')}`, op.operationId).toMatch(pattern);
      expect(op.bodyLimitBytes, op.operationId).toBe(ORDER_BODY_LIMIT_BYTES);
    }
  });
});
