import { API_PATH_PREFIX } from '@po/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorMessages } from '../src/errors/messages';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem, type Handler } from './support/fake-api';
import { renderApp } from './support/render-app';

// The admin Users screen and its dialogs (ADR-0018; spec US3 scenarios 1–7).

afterEach(() => {
  vi.unstubAllGlobals();
});

const ADMIN = {
  ...ME,
  id: '0192e4a0-0000-7000-8000-00000000000a',
  name: 'Ada Admin',
  roles: ['ADMIN'],
};

const user = (extra: Record<string, unknown> = {}) => ({
  id: '0192e4a0-0000-7000-8000-0000000000b1',
  name: 'Bea Buyer',
  email: 'bea@example.local',
  roles: ['BUYER'],
  status: 'ACTIVE',
  lastLoginAt: '2026-11-02T06:30:00.000Z',
  ...extra,
});

const detail = (extra: Record<string, unknown> = {}) => ({
  ...user(extra),
  createdAt: '2026-10-01T06:30:00.000Z',
  version: 3,
  ...extra,
});

const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  items,
  page: 1,
  pageSize: 20,
  total: items.length,
  ...extra,
});

function adminApi(handlers: Record<string, Handler> = {}) {
  return fakeApi({
    'GET /me': () => json(200, ADMIN),
    'GET /admin/access-requests': () => json(200, page([], { pageSize: 1, total: 0 })),
    'GET /admin/users': () =>
      json(
        200,
        page([
          { ...ADMIN, lastLoginAt: null },
          user(),
          user({
            id: '0192e4a0-0000-7000-8000-0000000000c1',
            name: 'Other Admin',
            roles: ['ADMIN'],
          }),
        ]),
      ),
    [`GET /admin/users/${user().id}`]: () => json(200, detail(), { ETag: '"3"' }),
    ...handlers,
  });
}

const NOT_FOUND_MESSAGE = errorMessages.NOT_FOUND.message;

const rowOf = async (name: string) =>
  (await screen.findByRole('cell', { name })).closest('tr') as HTMLElement;

describe('[NFR-FE-08] admin Users list', () => {
  it('[FR-ADM-01] lists users with role, status and last login, with no actions on admin rows', async () => {
    adminApi();
    renderApp('/admin/users');
    expect(await screen.findByRole('heading', { level: 1, name: 'Users' })).toBeInTheDocument();
    const bea = await rowOf('Bea Buyer');
    expect(within(bea).getByRole('cell', { name: 'Buyer' })).toBeInTheDocument();
    expect(within(bea).getByRole('cell', { name: 'Active' })).toBeInTheDocument();
    expect(within(bea).getByRole('cell', { name: '2 November 2026' })).toBeInTheDocument();
    expect(
      within(bea).getByRole('button', { name: 'Change role for Bea Buyer' }),
    ).toBeInTheDocument();
    const own = await rowOf('Ada Admin');
    expect(within(own).queryAllByRole('button')).toEqual([]);
    expect(within(own).getByText('You')).toBeInTheDocument();
    const other = await rowOf('Other Admin');
    expect(within(other).getByRole('cell', { name: 'Procurement Admin' })).toBeInTheDocument();
    expect(within(other).queryAllByRole('button')).toEqual([]);
  });

  it('[FR-ADM-01] filters live in the URL and are sent to the API', async () => {
    const seen = adminApi();
    const { user: u, router } = renderApp('/admin/users?role=NONE&status=ACTIVE&page=2');
    expect(await screen.findByLabelText('Role')).toHaveValue('NONE');
    expect(screen.getByLabelText('Status')).toHaveValue('ACTIVE');
    await waitFor(() => {
      const list = seen.filter((r) => new URL(r.url).pathname === `${API_PATH_PREFIX}/admin/users`);
      expect(new URL(list.at(-1)?.url ?? '').search).toBe('?role=NONE&status=ACTIVE&page=2');
    });
    await u.type(screen.getByLabelText('Name or email starts with'), 'pri');
    await waitFor(() => {
      expect(router.state.location.search).toBe('?role=NONE&status=ACTIVE&q=pri');
    });
    await u.selectOptions(screen.getByLabelText('Role'), 'APPROVER');
    expect(router.state.location.search).toBe('?role=APPROVER&status=ACTIVE&q=pri');
  });

  it('[FR-ADM-01] the search box follows the URL, e.g. after going back', async () => {
    adminApi();
    const { router } = renderApp('/admin/users');
    expect(await screen.findByLabelText('Name or email starts with')).toHaveValue('');
    await act(async () => {
      await router.navigate('/admin/users?q=pri');
    });
    expect(screen.getByLabelText('Name or email starts with')).toHaveValue('pri');
    await act(async () => {
      await router.navigate(-1);
    });
    expect(router.state.location.search).toBe('');
    expect(screen.getByLabelText('Name or email starts with')).toHaveValue('');
  });

  it('[FR-ADM-01] pages through the results', async () => {
    adminApi({
      'GET /admin/users': (request) => {
        const pageNo = Number(new URL(request.url).searchParams.get('page') ?? '1');
        return json(200, page([user()], { page: pageNo, pageSize: 20, total: 45 }));
      },
    });
    const { user: u, router } = renderApp('/admin/users');
    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await u.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?page=2');
  });

  it('[FR-ADM-01] says when nothing matches', async () => {
    adminApi({ 'GET /admin/users': () => json(200, page([])) });
    renderApp('/admin/users?q=zz');
    expect(await screen.findByRole('heading', { name: 'No users match' })).toBeInTheDocument();
  });

  it('[NFR-FE-08] a Buyer who opens the page is told it is not for them', async () => {
    fakeApi({ 'GET /me': () => json(200, ME) });
    renderApp('/admin/users');
    expect(
      await screen.findByRole('heading', { level: 1, name: "You don't have access to this page" }),
    ).toBeInTheDocument();
  });

  it('[NFR-FE-08] the page has no axe violations', async () => {
    adminApi();
    renderApp('/admin/users');
    await rowOf('Bea Buyer');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe('[NFR-FE-09] change role dialog', () => {
  it('[FR-ADM-02] shows old and new role and that sessions end; sends the version', async () => {
    const seen = adminApi({
      [`PATCH /admin/users/${user().id}`]: () =>
        json(200, detail({ roles: ['APPROVER'], version: 4 }), { ETag: '"4"' }),
    });
    const { user: u } = renderApp('/admin/users');
    await u.click(await screen.findByRole('button', { name: 'Change role for Bea Buyer' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Change role for Bea Buyer?' });
    // Open-order counts arrive with orders (ADR-0019); until then the dialog states none.
    expect(await within(dialog).findByRole('radio', { name: 'Approver' })).toBeInTheDocument();
    expect(within(dialog).queryByText(/Open orders/)).not.toBeInTheDocument();
    expect(
      within(dialog).getByText("Their sessions will end and they'll need to log in again."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Change role' })).toBeDisabled();
    await u.click(within(dialog).getByRole('radio', { name: 'Approver' }));
    expect(within(dialog).getByText('Buyer → Approver')).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Change role' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      "Bea Buyer's role is now Approver.",
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    const patch = seen.find((r) => r.method === 'PATCH');
    expect(patch?.headers.get('If-Match')).toBe('"3"');
    expect(await patch?.json()).toEqual({ roles: ['APPROVER'] });
  });

  it('[FR-ADM-02] for a user with no role, it says the access request is resolved too', async () => {
    adminApi({
      [`GET /admin/users/${user().id}`]: () => json(200, detail({ roles: [] }), { ETag: '"3"' }),
      'GET /admin/users': () => json(200, page([user({ roles: [] })])),
    });
    const { user: u } = renderApp('/admin/users');
    await u.click(await screen.findByRole('button', { name: 'Change role for Bea Buyer' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(
      await within(dialog).findByText('This also resolves their access request.'),
    ).toBeInTheDocument();
  });

  it('[FR-ADM-02] warns when the only Approver also becomes a Buyer', async () => {
    const approver = user({ roles: ['APPROVER'] });
    adminApi({
      'GET /admin/users': (request) =>
        new URL(request.url).searchParams.get('role') === 'APPROVER'
          ? json(200, page([approver], { pageSize: 1, total: 1 }))
          : json(200, page([approver])),
      [`GET /admin/users/${user().id}`]: () =>
        json(200, detail({ roles: ['APPROVER'] }), { ETag: '"3"' }),
    });
    const { user: u } = renderApp('/admin/users');
    await u.click(await screen.findByRole('button', { name: 'Change role for Bea Buyer' }));
    const dialog = await screen.findByRole('alertdialog');
    await u.click(await within(dialog).findByRole('radio', { name: 'Buyer + Approver' }));
    expect(
      await within(dialog).findByText(
        "Bea Buyer is the only Approver, so their own orders above the approval threshold can't be approved.",
      ),
    ).toBeInTheDocument();
  });

  it('[FR-ADM-02] a version conflict is shown inside the dialog; after a reload the new version is sent', async () => {
    let reads = 0;
    let patches = 0;
    const seen = adminApi({
      [`GET /admin/users/${user().id}`]: () => {
        reads += 1;
        return json(200, detail({ version: 3 + reads }), { ETag: `"${String(3 + reads)}"` });
      },
      [`PATCH /admin/users/${user().id}`]: () => {
        patches += 1;
        return patches === 1
          ? problem(409, 'VERSION_CONFLICT')
          : json(200, detail({ roles: ['APPROVER'], version: 6 }), { ETag: '"6"' });
      },
    });
    const { user: u } = renderApp('/admin/users');
    await u.click(await screen.findByRole('button', { name: 'Change role for Bea Buyer' }));
    const dialog = await screen.findByRole('alertdialog');
    await u.click(await within(dialog).findByRole('radio', { name: 'Approver' }));
    await u.click(within(dialog).getByRole('button', { name: 'Change role' }));
    expect(await within(dialog).findByText('Someone else changed this.')).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() => {
      expect(reads).toBe(2);
    });
    expect(within(dialog).queryByText('Someone else changed this.')).not.toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Change role' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      "Bea Buyer's role is now Approver.",
    );
    const sent = seen.filter((r) => r.method === 'PATCH').map((r) => r.headers.get('If-Match'));
    expect(sent).toEqual(['"4"', '"5"']);
  });

  it('[NFR-FE-09] the dialog has no axe violations', async () => {
    adminApi();
    const { user: u } = renderApp('/admin/users');
    await u.click(await screen.findByRole('button', { name: 'Change role for Bea Buyer' }));
    const dialog = await screen.findByRole('alertdialog');
    await within(dialog).findByRole('radio', { name: 'Approver' });
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe('[NFR-FE-09] deactivate, reactivate and reset dialogs', () => {
  it("[FR-ADM-02] deactivating says they are logged out everywhere and can't log in", async () => {
    const seen = adminApi({
      [`PATCH /admin/users/${user().id}`]: () =>
        json(200, detail({ status: 'DEACTIVATED', version: 4 }), { ETag: '"4"' }),
    });
    const { user: u } = renderApp('/admin/users');
    await u.click(await screen.findByRole('button', { name: 'Deactivate Bea Buyer' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Deactivate Bea Buyer?' });
    expect(
      within(dialog).getByText("They'll be logged out everywhere and can't log in."),
    ).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Deactivate user' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Bea Buyer is deactivated.');
    const patch = seen.find((r) => r.method === 'PATCH');
    expect(await patch?.json()).toEqual({ isActive: false });
  });

  it('[FR-ADM-02] a deactivated user can be reactivated; an unverified one has neither action', async () => {
    const seen = adminApi({
      'GET /admin/users': () =>
        json(
          200,
          page([
            user({ status: 'DEACTIVATED' }),
            user({
              id: '0192e4a0-0000-7000-8000-0000000000d1',
              name: 'Una Unverified',
              roles: [],
              status: 'UNVERIFIED',
            }),
          ]),
        ),
      [`GET /admin/users/${user().id}`]: () =>
        json(200, detail({ status: 'DEACTIVATED' }), { ETag: '"3"' }),
      [`PATCH /admin/users/${user().id}`]: () => json(200, detail({ version: 4 }), { ETag: '"4"' }),
    });
    const { user: u } = renderApp('/admin/users');
    const una = await rowOf('Una Unverified');
    expect(within(una).queryByRole('button', { name: /activate/i })).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Reactivate Bea Buyer' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Reactivate Bea Buyer?' });
    await u.click(within(dialog).getByRole('button', { name: 'Reactivate user' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Bea Buyer is active again.');
    const patch = seen.find((r) => r.method === 'PATCH');
    expect(await patch?.json()).toEqual({ isActive: true });
  });

  it("[FR-ADM-02] the reactivate dialog says when the user can't be read, instead of waiting", async () => {
    adminApi({
      'GET /admin/users': () => json(200, page([user({ status: 'DEACTIVATED' })])),
      [`GET /admin/users/${user().id}`]: () => problem(404, 'NOT_FOUND'),
    });
    const { user: u } = renderApp('/admin/users');
    await u.click(await screen.findByRole('button', { name: 'Reactivate Bea Buyer' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(await within(dialog).findByText(NOT_FOUND_MESSAGE)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Reactivate user' })).toBeDisabled();
  });

  it('[FR-ADM-03] a deactivated user is offered no reset, since the API refuses one', async () => {
    adminApi({ 'GET /admin/users': () => json(200, page([user({ status: 'DEACTIVATED' })])) });
    renderApp('/admin/users');
    const bea = await rowOf('Bea Buyer');
    expect(within(bea).getByRole('button', { name: 'Reactivate Bea Buyer' })).toBeInTheDocument();
    expect(
      within(bea).queryByRole('button', { name: 'Send password reset to Bea Buyer' }),
    ).not.toBeInTheDocument();
  });

  it('[FR-ADM-03] sending a reset names the email and says the current password keeps working', async () => {
    const seen = adminApi({
      [`POST /admin/users/${user().id}/reset-password`]: () => new Response(null, { status: 202 }),
    });
    const { user: u } = renderApp('/admin/users');
    await u.click(await screen.findByRole('button', { name: 'Send password reset to Bea Buyer' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Send a password reset to Bea Buyer?',
    });
    expect(
      within(dialog).getByText(
        "We'll email a reset link to bea@example.local. Their current password keeps working until they complete the reset.",
      ),
    ).toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Send reset email' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Password reset email sent to Bea Buyer.',
    );
    expect(seen.some((r) => r.method === 'POST' && r.url.endsWith('/reset-password'))).toBe(true);
  });
});
