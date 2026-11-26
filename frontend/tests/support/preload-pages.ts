import type { RouteObject } from 'react-router';
import { buildRoutes } from '../../src/app/router';

// Every page is a lazy route (one chunk each). In a test, the first render of a page
// imports its module tree on demand, and Vite transforms it then; under load that took
// longer than a findBy's wait, so a file's first test failed while its others passed.
// Loading every page once, before any test runs, takes that out of the tests' time.

async function loadAll(routes: readonly RouteObject[]): Promise<void> {
  await Promise.all(
    routes.map(async (route) => {
      if (typeof route.lazy === 'function') await route.lazy();
      if (route.children) await loadAll(route.children);
    }),
  );
}

/** Imports every page the app's routes load lazily, through the routes' own loaders. */
export function preloadPages(): Promise<void> {
  return loadAll(buildRoutes({ includeDemo: false }));
}
