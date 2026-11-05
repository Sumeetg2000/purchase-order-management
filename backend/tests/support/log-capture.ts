import type { Logger } from 'pino';
import { afterAll, expect } from 'vitest';
import { createLogger } from '../../src/observability/logger.js';
import { secretsIn } from './secrets.js';

export { TOKEN_SHAPED } from './secrets.js';

export type LogLine = Record<string, unknown>;

// Every capture created in this test file, so the response audit can find a request's log
// lines whichever logger the app under test was given.
const captures: LogLine[][] = [];
// The captures the end-of-file check scans: all but those that leak on purpose.
const checked: LogLine[][] = [];

/**
 * A logger with the application's options whose lines are kept in memory. Its lines must
 * hold no secret, checked when the test file ends, unless `leaksExpected` (a test of the
 * check itself).
 */
export function createCapture({ leaksExpected = false }: { leaksExpected?: boolean } = {}): {
  logger: Logger;
  lines: LogLine[];
} {
  const lines: LogLine[] = [];
  captures.push(lines);
  if (!leaksExpected) checked.push(lines);
  const logger = createLogger('trace', {
    write: (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line) lines.push(JSON.parse(line) as LogLine);
      }
    },
  });
  return { logger, lines };
}

/**
 * Lines with a secret (a token-shaped value, a password hash or the test password),
 * except a token on the one-time link channel (SC-003, SC-007).
 */
export function findTokenLeaks(lines: readonly LogLine[]): LogLine[] {
  return lines.filter((line) => {
    const found = secretsIn(line);
    return line['oneTimeLink'] === true ? found.some((kind) => kind !== 'token') : found.length > 0;
  });
}

// One capture per test file that apps under test log to by default.
const shared = createCapture();

export function testLogger(): Logger {
  return shared.logger;
}

/** Lines from every capture in this test file, the shared one first. */
export function capturedLines(): readonly LogLine[] {
  return captures.flat();
}

afterAll(() => {
  expect(findTokenLeaks(checked.flat()), 'log lines with a token or password').toEqual([]);
});
