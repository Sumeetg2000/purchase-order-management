import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { isRetryable } from '../errors/messages';
import { problemFrom } from '../errors/problem';

/**
 * Retries are automatic only for temporary failures (an unreachable API, 503-class codes);
 * anything else is shown at once.
 */
const MAX_AUTOMATIC_RETRIES = 2;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failures, error) =>
          failures < MAX_AUTOMATIC_RETRIES && isRetryable(problemFrom(error).code),
      },
    },
  });
}

/** App-wide providers: the TanStack Query client. */
export function AppProviders({ children }: { children: ReactNode }) {
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
