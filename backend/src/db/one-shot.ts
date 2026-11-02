// Database timeouts for the one-shot processes: migrate (with the bootstrap), the
// operator CLI and the maintenance service. The API takes its own from DB_TX_TIMEOUT_MS
// and DB_TX_MAX_WAIT_MS (contracts/config.md).
export const ONE_SHOT = {
  /** How long to wait for a pool connection. */
  connectionTimeoutMs: 5_000,
  /** How long one transaction may run. */
  transactionTimeoutMs: 10_000,
  /** How long a transaction waits to start. */
  transactionMaxWaitMs: 5_000,
  /**
   * How long to wait for ADMIN_LOCK. Below transactionTimeoutMs: a blocked query never
   * returns to Prisma, so only lock_timeout can end the wait (db/locks.ts).
   */
  adminLockTimeoutMs: 5_000,
} as const;
