import {
  auditEntriesTask,
  idempotencyKeysTask,
  oneTimeTokensTask,
  rateLimitCountersTask,
  sessionsTask,
  type PurgeTask,
} from './purge.js';

export type { PurgeTask } from './purge.js';

/** Every purge task the maintenance loop runs, in order. Later slices add theirs here. */
export const purgeTasks: readonly PurgeTask[] = [
  auditEntriesTask,
  oneTimeTokensTask,
  sessionsTask,
  rateLimitCountersTask,
  idempotencyKeysTask,
];
