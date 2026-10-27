import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ProblemError } from '../api/client';
import { isRetryable } from '../errors/messages';

/** Retries are automatic only for temporary failures; anything else is shown at once. */
const MAX_AUTOMATIC_RETRIES = 2;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failures, error) =>
          failures < MAX_AUTOMATIC_RETRIES &&
          error instanceof ProblemError &&
          isRetryable(error.problem.code),
      },
    },
  });
}

/** App-wide providers: the TanStack Query client. */
export function AppProviders({ children }: { children: ReactNode }) {
  const [client] = useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
