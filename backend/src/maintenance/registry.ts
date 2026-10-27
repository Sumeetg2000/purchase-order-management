import { auditEntriesTask, oneTimeTokensTask, type PurgeTask } from './purge.js';

export type { PurgeTask } from './purge.js';

/** Every purge task the maintenance loop runs, in order. Later slices add theirs here. */
export const purgeTasks: readonly PurgeTask[] = [auditEntriesTask, oneTimeTokensTask];
