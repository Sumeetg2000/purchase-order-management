import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../src/app/providers';
import { buildRoutes } from '../src/app/router';
import { fakeApi, json, ME } from './support/fake-api';
import { ACME_ID, page, vendor } from './support/vendors';

// The vendor routes and nav item (specs/003-vendors/contracts/ui.md): every role holder
// reads vendors; adding and editing are for Buyers, and anyone else sees the 403 page.

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderAt(path: string, roles: readonly string[]) {
  fakeApi({
    'GET /me': () => json(200, { ...ME, roles }),
    'GET /vendors': () => json(200, page([vendor()])),
    [`GET /vendors/${ACME_ID}`]: () => json(200, vendor(), { ETag: '"1"' }),
  });
  const router = createMemoryRouter(buildRoutes({ includeDemo: false }), {
    initialEntries: [path],
  });
  render(
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>,
  );
}

const FORBIDDEN = "You don't have access to this page";

describe('[FR-VEN-01] vendor routes', () => {
  it.each([['BUYER'], ['APPROVER'], ['ADMIN']])(
    '[FR-VEN-01] %s sees the Vendors nav item and the vendor list',
    async (role) => {
      renderAt('/vendors', [role]);
      expect(await screen.findByRole('heading', { level: 1, name: 'Vendors' })).toBeVisible();
      const nav = screen.getByRole('navigation', { name: 'Main' });
      expect(within(nav).getByRole('link', { name: 'Vendors' })).toHaveAttribute(
        'aria-current',
        'page',
      );
    },
  );

  it('[FR-VEN-01] every role reads a vendor', async () => {
    renderAt(`/vendors/${ACME_ID}`, ['APPROVER']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Acme Supplies' })).toBeVisible();
  });

  it.each([
    ['/vendors/new', 'Add vendor'],
    ['/vendors/0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f/edit', 'Edit vendor'],
  ])('[FR-VEN-01] %s is for Buyers only', async (path, heading) => {
    renderAt(path, ['BUYER', 'APPROVER']);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeVisible();
  });

  it.each([
    ['/vendors/new', 'APPROVER'],
    ['/vendors/new', 'ADMIN'],
    ['/vendors/0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f/edit', 'APPROVER'],
    ['/vendors/0192e4a0-7b1c-7cc0-8a4e-1f2b3c4d5e6f/edit', 'ADMIN'],
  ])('[FR-VEN-01] %s shows %s the 403 page', async (path, role) => {
    renderAt(path, [role]);
    expect(await screen.findByRole('heading', { level: 1, name: FORBIDDEN })).toBeVisible();
  });

  it('[FR-VEN-01] a user with no role has no Vendors nav item', async () => {
    renderAt('/profile', []);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { name: 'Vendors' })).toBeNull();
  });
});
