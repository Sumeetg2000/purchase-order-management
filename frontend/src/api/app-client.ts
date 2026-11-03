import { createRefresher, expiredAccessMiddleware } from '../auth/refresh';
import { endSession } from '../auth/session-events';
import { createApiClient } from './client';

/**
 * The app's API client: the CSRF header on every state change, and the silent refresh,
 * which ends the session through the session boundary when the API refuses it.
 */
export const api = createApiClient({
  middleware: ({ baseUrl, send, fetchOnce, cookies }) => [
    expiredAccessMiddleware({
      refresher: createRefresher({ baseUrl, fetch: send, cookies }),
      fetch: fetchOnce,
      onSessionEnded: endSession,
    }),
  ],
});
