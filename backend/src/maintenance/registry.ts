import type { AppPrismaClient } from '../db/client.js';

/** One retention rule. `run` deletes what is past its limit and returns the row count. */
export interface PurgeTask {
  name: string;
  run: (db: AppPrismaClient) => Promise<number>;
}

// The purge tasks for audit entries and one-time tokens are registered by US8.
export const purgeTasks: readonly PurgeTask[] = [];
