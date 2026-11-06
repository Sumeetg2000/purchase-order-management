import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { AppProviders } from '../../src/app/providers';
import { buildRoutes } from '../../src/app/router';

/** The whole app's routes in memory, at one path (with an optional hash). */
export function renderApp(path: string) {
  const router = createMemoryRouter(buildRoutes({ includeDemo: false }), {
    initialEntries: [path],
  });
  render(
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { user: userEvent.setup(), router };
}
