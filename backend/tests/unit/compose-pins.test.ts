import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DRAIN_TIMEOUT_MS, MIN_MAIL_SETTLE_MS } from '../../src/http/shutdown.js';

// Copies of backend constants that compose must also hold (CLAUDE.md constants rule).
const compose = parse(
  readFileSync(new URL('../../../docker-compose.yml', import.meta.url), 'utf8'),
) as { services: Record<string, { stop_grace_period?: string }> };

/** Time after the drain for closing the pool and exiting, before Docker sends SIGKILL. */
const EXIT_MARGIN_MS = 2_000;

function durationMs(value: string): number {
  const match = /^(\d+)(ms|s|m)$/.exec(value);
  if (!match) throw new Error(`unsupported compose duration: ${value}`);
  const unit = { ms: 1, s: 1_000, m: 60_000 }[match[2] as 'ms' | 's' | 'm'];
  return Number(match[1]) * unit;
}

describe('[NFR-OPS-02] compose values pinned to the API constants', () => {
  it('[NFR-OPS-02] the api stop grace period outlasts the request drain and the mail settle', () => {
    const grace = compose.services['api']?.stop_grace_period;
    expect(grace).toBeDefined();
    expect(durationMs(grace ?? '')).toBeGreaterThanOrEqual(
      DRAIN_TIMEOUT_MS + MIN_MAIL_SETTLE_MS + EXIT_MARGIN_MS,
    );
  });
});
