import type { Logger } from 'pino';
import { afterAll, expect } from 'vitest';
import { createLogger } from '../../src/observability/logger.js';

export type LogLine = Record<string, unknown>;

/**
 * A 256-bit token in base64url is 43 characters. Ids (UUIDs are 36), hostnames and path
 * segments are shorter, so a longer run of these characters is treated as a token.
 */
export const TOKEN_SHAPED = /[A-Za-z0-9_-]{43,}/;

/** A logger with the application's options whose lines are kept in memory. */
export function createCapture(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger = createLogger('trace', {
    write: (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line) lines.push(JSON.parse(line) as LogLine);
      }
    },
  });
  return { logger, lines };
}

/** Lines with a token-shaped value outside the one-time link channel (SC-003). */
export function findTokenLeaks(lines: readonly LogLine[]): LogLine[] {
  return lines.filter(
    (line) => line['oneTimeLink'] !== true && TOKEN_SHAPED.test(JSON.stringify(line)),
  );
}

// One capture per test file. Apps under test log here, and the file fails if any line
// leaks a token.
const shared = createCapture();

export function testLogger(): Logger {
  return shared.logger;
}

export function capturedLines(): readonly LogLine[] {
  return shared.lines;
}

afterAll(() => {
  expect(findTokenLeaks(shared.lines), 'log lines with a token-shaped value').toEqual([]);
});
