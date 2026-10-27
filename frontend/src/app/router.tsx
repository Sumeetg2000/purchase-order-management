import { createBrowserRouter, type RouteObject } from 'react-router';
import { RouteErrorBoundary } from '../components/RouteErrorBoundary';
import { Shell } from './Shell';

// Pages load lazily, one chunk each (ADR-0012's per-route budget).

// Defined behind a literal import.meta.env.DEV, so a production build drops the demo
// page's chunk entirely, not just its route (contracts/ui-components.md).
const demoRoutes: RouteObject[] = import.meta.env.DEV
  ? [
      {
        path: '__demo',
        lazy: () => import('../pages/__demo/Demo').then((m) => ({ Component: m.Demo })),
      },
    ]
  : [];

export function buildRoutes({ includeDemo }: { includeDemo: boolean }): RouteObject[] {
  const pages: RouteObject[] = [
    { index: true, lazy: () => import('../pages/Home').then((m) => ({ Component: m.Home })) },
    ...(includeDemo ? demoRoutes : []),
    {
      path: '*',
      lazy: () => import('../pages/NotFound').then((m) => ({ Component: m.NotFound })),
    },
  ];
  return [
    {
      path: '/',
      element: <Shell />,
      errorElement: <RouteErrorBoundary />,
      // Each page has its own boundary, so a failing page keeps the shell working.
      children: pages.map((page) => ({ ...page, errorElement: <RouteErrorBoundary /> })),
    },
  ];
}

export function createAppRouter() {
  return createBrowserRouter(buildRoutes({ includeDemo: import.meta.env.DEV }));
}
