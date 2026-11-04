import { createBrowserRouter, type RouteObject } from 'react-router';
import { RequireRole } from '../auth/RequireRole';
import { RequireUser } from '../auth/RequireUser';
import { SessionBoundary } from '../auth/SessionBoundary';
import { RouteErrorBoundary } from '../components/RouteErrorBoundary';
import { lazyPage } from './lazyPage';
import { Shell } from './Shell';

// Pages load lazily, one chunk each (ADR-0012's per-route budget).

// Defined behind a literal import.meta.env.DEV, so a production build drops the demo
// page's chunk entirely, not just its route (contracts/ui-components.md).
const demoRoutes: RouteObject[] = import.meta.env.DEV
  ? [
      {
        path: '__demo',
        lazy: lazyPage(() => import('../pages/__demo/Demo').then((m) => m.Demo)),
      },
    ]
  : [];

export function buildRoutes({ includeDemo }: { includeDemo: boolean }): RouteObject[] {
  const pages: RouteObject[] = [
    { index: true, lazy: lazyPage(() => import('../pages/Home').then((m) => m.Home)) },
    {
      path: 'admin/users',
      element: <RequireRole requires="ADMIN" />,
      children: [
        {
          index: true,
          lazy: lazyPage(() => import('../pages/admin/Users').then((m) => m.Users)),
          errorElement: <RouteErrorBoundary />,
        },
        {
          path: 'access-requests',
          lazy: lazyPage(() =>
            import('../pages/admin/AccessRequests').then((m) => m.AccessRequests),
          ),
          errorElement: <RouteErrorBoundary />,
        },
      ],
    },
    ...(includeDemo ? demoRoutes : []),
    {
      path: '*',
      lazy: lazyPage(() => import('../pages/NotFound').then((m) => m.NotFound)),
    },
  ];
  return [
    {
      path: '/',
      element: <SessionBoundary />,
      errorElement: <RouteErrorBoundary />,
      children: [
        // Account pages: no login needed, no app navigation.
        {
          path: 'login',
          lazy: lazyPage(() => import('../pages/account/Login').then((m) => m.Login)),
          errorElement: <RouteErrorBoundary />,
        },
        {
          path: 'signup',
          lazy: lazyPage(() => import('../pages/account/Signup').then((m) => m.Signup)),
          errorElement: <RouteErrorBoundary />,
        },
        {
          path: 'verify-email',
          lazy: lazyPage(() => import('../pages/account/VerifyEmail').then((m) => m.VerifyEmail)),
          errorElement: <RouteErrorBoundary />,
        },
        {
          path: 'reset-password',
          lazy: lazyPage(() =>
            import('../pages/account/ResetPassword').then((m) => m.ResetPassword),
          ),
          errorElement: <RouteErrorBoundary />,
        },
        {
          element: <RequireUser />,
          children: [
            {
              element: <Shell />,
              children: [
                // Every logged-in user, with or without a role (ADR-0018).
                {
                  path: 'profile',
                  lazy: lazyPage(() => import('../pages/profile/Profile').then((m) => m.Profile)),
                  errorElement: <RouteErrorBoundary />,
                },
                // A verified user with no role waits here (ADR-0018).
                {
                  path: 'access-pending',
                  lazy: lazyPage(() =>
                    import('../pages/AccessPending').then((m) => m.AccessPending),
                  ),
                  errorElement: <RouteErrorBoundary />,
                },
                {
                  element: <RequireRole />,
                  // Each page has its own boundary, so a failing page keeps the shell working.
                  children: pages.map((page) => ({
                    ...page,
                    errorElement: <RouteErrorBoundary />,
                  })),
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

export function createAppRouter() {
  return createBrowserRouter(buildRoutes({ includeDemo: import.meta.env.DEV }));
}
