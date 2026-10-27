import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../src/app/providers';
import { lazyPage } from '../src/app/lazyPage';
import { buildRoutes } from '../src/app/router';
import { RouteErrorBoundary } from '../src/components/RouteErrorBoundary';
import { errorMessages } from '../src/errors/messages';
import { axeViolations } from './support/axe';

function paths(routes: readonly RouteObject[]): string[] {
  return routes.flatMap((route) => [route.path ?? '', ...paths(route.children ?? [])]);
}

function renderAt(path: string) {
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

describe('[NFR-FE-01] routing', () => {
  it('[NFR-FE-01] the home page renders inside the shell', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[NFR-FE-01] an unknown path renders the not-found page, and the shell still navigates', async () => {
    const { user } = renderAt('/no/such/page');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Page not found' }),
    ).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
    await user.click(screen.getByRole('link', { name: 'Go to the home page' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome' })).toBeInTheDocument();
  });

  it('[NFR-FE-01] the production route table has no demo route; the development one does', () => {
    expect(paths(buildRoutes({ includeDemo: false })).some((p) => p.includes('__demo'))).toBe(
      false,
    );
    expect(paths(buildRoutes({ includeDemo: true })).some((p) => p.includes('__demo'))).toBe(true);
  });

  it('[NFR-FE-01] a page whose code can no longer be loaded (after a deploy) offers a reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const router = createMemoryRouter(
      [
        {
          path: '/',
          errorElement: <RouteErrorBoundary />,
          lazy: lazyPage(() =>
            Promise.reject(new TypeError('Failed to fetch dynamically imported module')),
          ),
        },
      ],
      { initialEntries: ['/'] },
    );
    render(<RouterProvider router={router} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A newer version of the app is available');
    expect(alert).not.toHaveTextContent(errorMessages.INTERNAL_ERROR.message);
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });
});
