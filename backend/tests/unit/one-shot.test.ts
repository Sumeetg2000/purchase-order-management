import { describe, expect, it } from 'vitest';
import { ONE_SHOT } from '../../src/db/one-shot.js';

describe('[FR-ADM-05] one-shot database timeouts', () => {
  it('[FR-ADM-05] the admin lock gives up before the transaction does, so a held lock never hangs a command', () => {
    expect(ONE_SHOT.adminLockTimeoutMs).toBeLessThan(ONE_SHOT.transactionTimeoutMs);
  });

  it('[FR-ADM-05] a transaction waits for a connection no longer than it may run', () => {
    expect(ONE_SHOT.transactionMaxWaitMs).toBeLessThanOrEqual(ONE_SHOT.transactionTimeoutMs);
    expect(ONE_SHOT.connectionTimeoutMs).toBeGreaterThan(0);
  });
});
