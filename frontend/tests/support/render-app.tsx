import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { AppProviders } from '../../src/app/providers';
import { buildRoutes } from '../../src/app/router';

/**
 * The whole app's routes in memory, at one path (with an optional hash). With fake timers,
 * pass `advanceTimers` (vi.advanceTimersByTime) so user events don't wait on frozen time.
 */
export function renderApp(
  path: string,
  { advanceTimers }: { advanceTimers?: (ms: number) => void } = {},
) {
  const router = createMemoryRouter(buildRoutes({ includeDemo: false }), {
    initialEntries: [path],
  });
  render(
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { user: userEvent.setup(advanceTimers ? { advanceTimers } : {}), router };
}
