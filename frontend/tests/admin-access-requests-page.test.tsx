import { API_PATH_PREFIX } from '@po/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem, type Handler } from './support/fake-api';
import { renderApp } from './support/render-app';

// The Access requests tab and the Users badge (ADR-0018; spec US3 scenario 8).

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ADMIN = {
  ...ME,
  id: '0192e4a0-0000-7000-8000-00000000000a',
  name: 'Ada Admin',
  roles: ['ADMIN'],
};
const NIA_ID = '0192e4a0-0000-7000-8000-0000000000e1';

const request = (extra: Record<string, unknown> = {}) => ({
  id: '0192e4a0-0000-7000-8000-0000000000f1',
  status: 'OPEN',
  message: '<b>Please</b> add me as a buyer',
  updatedAt: '2026-11-02T06:30:00.000Z',
  adminNote: null,
  user: {
    id: NIA_ID,
    name: 'Nia New',
    email: 'nia@example.local',
    createdAt: '2026-11-01T06:30:00.000Z',
  },
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
    'GET /admin/access-requests': () => json(200, page([request()])),
    'GET /admin/users': () => json(200, page([])),
    ...handlers,
  });
}

describe('[NFR-FE-08] admin Access requests tab', () => {
  it('[FR-ADM-06] lists requests with the user, dates and message as text', async () => {
    adminApi();
    renderApp('/admin/users/access-requests');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Access requests' }),
    ).toBeInTheDocument();
    const row = (await screen.findByRole('cell', { name: /Nia New/ })).closest('tr') as HTMLElement;
    expect(within(row).getByText('nia@example.local')).toBeInTheDocument();
    expect(within(row).getByText('<b>Please</b> add me as a buyer')).toBeInTheDocument();
    expect(within(row).getByRole('cell', { name: 'Open' })).toBeInTheDocument();
    expect(within(row).getByRole('cell', { name: '1 November 2026' })).toBeInTheDocument();
  });

  it('[FR-ADM-06] the status filter lives in the URL', async () => {
    const seen = adminApi();
    const { user, router } = renderApp('/admin/users/access-requests');
    await user.selectOptions(await screen.findByLabelText('Status'), 'DISMISSED');
    expect(router.state.location.search).toBe('?status=DISMISSED');
    await waitFor(() => {
      expect(
        seen.some((r) =>
          r.url.endsWith(`${API_PATH_PREFIX}/admin/access-requests?status=DISMISSED`),
        ),
      ).toBe(true);
    });
  });

  it("[FR-ADM-06] a dismissed request shows the admin's note and no actions", async () => {
    adminApi({
      'GET /admin/access-requests': () =>
        json(
          200,
          page([
            request({
              status: 'DISMISSED',
              adminNote: 'Ask your manager',
            }),
          ]),
        ),
    });
    renderApp('/admin/users/access-requests');
    expect(await screen.findByText('Ask your manager')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Dismiss/ })).not.toBeInTheDocument();
  });

  it('[FR-ADM-06] dismissing sends the note and refreshes the list', async () => {
    let dismissed = false;
    const seen = adminApi({
      'GET /admin/access-requests': () => json(200, page(dismissed ? [] : [request()])),
      [`POST /admin/access-requests/${request().id}/dismiss`]: () => {
        dismissed = true;
        return json(200, request({ status: 'DISMISSED', adminNote: 'Not yet' }));
      },
    });
    const { user } = renderApp('/admin/users/access-requests');
    await user.click(await screen.findByRole('button', { name: 'Dismiss request from Nia New' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Dismiss the request from Nia New?',
    });
    await user.type(within(dialog).getByLabelText('Note for Nia New (optional)'), '  Not yet ');
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss request' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Request from Nia New dismissed.');
    const post = seen.find((r) => r.method === 'POST');
    expect(await post?.json()).toEqual({ note: 'Not yet' });
    expect(await screen.findByRole('heading', { name: 'No access requests' })).toBeInTheDocument();
  });

  it('[FR-ADM-06] a request already handled says so inside the dialog, and the list is read again', async () => {
    let lists = 0;
    adminApi({
      'GET /admin/access-requests': (r) => {
        // The list itself, not the badge's count.
        if (new URL(r.url).searchParams.get('pageSize') !== '1') lists += 1;
        return json(200, page([request()]));
      },
      [`POST /admin/access-requests/${request().id}/dismiss`]: () =>
        problem(409, 'ACCESS_REQUEST_NOT_OPEN'),
    });
    const { user } = renderApp('/admin/users/access-requests');
    await user.click(await screen.findByRole('button', { name: 'Dismiss request from Nia New' }));
    const before = lists;
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss request' }));
    expect(
      await within(dialog).findByText('This request has already been handled.'),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(lists).toBeGreaterThan(before);
    });
  });

  it('[FR-ADM-06] assign role opens the role dialog for the requester', async () => {
    adminApi({
      [`GET /admin/users/${NIA_ID}`]: () =>
        json(
          200,
          {
            id: NIA_ID,
            name: 'Nia New',
            email: 'nia@example.local',
            roles: [],
            status: 'ACTIVE',
            lastLoginAt: null,
            createdAt: '2026-11-01T06:30:00.000Z',
            version: 2,
          },
          { ETag: '"2"' },
        ),
    });
    const { user } = renderApp('/admin/users/access-requests');
    await user.click(await screen.findByRole('button', { name: 'Assign role to Nia New' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Change role for Nia New?' });
    expect(
      await within(dialog).findByText('This also resolves their access request.'),
    ).toBeInTheDocument();
  });

  it('[NFR-FE-08] the tab has no axe violations', async () => {
    adminApi();
    renderApp('/admin/users/access-requests');
    await screen.findByRole('cell', { name: /Nia New/ });
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe('[NFR-FE-08] open access-request badge', () => {
  const badgeApi = (count: () => number) =>
    adminApi({
      'GET /admin/access-requests': (r) =>
        new URL(r.url).searchParams.get('pageSize') === '1'
          ? json(200, page([], { pageSize: 1, total: count() }))
          : json(200, page([request()])),
    });

  it('[FR-ADM-06] admins see the open count on Users, read with status=OPEN&pageSize=1', async () => {
    const seen = badgeApi(() => 2);
    renderApp('/');
    expect(
      await screen.findByRole('link', { name: 'Users, 2 open access requests' }),
    ).toBeInTheDocument();
    expect(
      seen.some((r) =>
        r.url.endsWith(`${API_PATH_PREFIX}/admin/access-requests?status=OPEN&pageSize=1`),
      ),
    ).toBe(true);
  });

  it('[FR-ADM-06] the count updates after a dismissal', async () => {
    let open = 1;
    adminApi({
      'GET /admin/access-requests': (r) =>
        new URL(r.url).searchParams.get('pageSize') === '1'
          ? json(200, page([], { pageSize: 1, total: open }))
          : json(200, page(open > 0 ? [request()] : [])),
      [`POST /admin/access-requests/${request().id}/dismiss`]: () => {
        open = 0;
        return json(200, request({ status: 'DISMISSED' }));
      },
    });
    const { user } = renderApp('/admin/users/access-requests');
    expect(
      await screen.findByRole('link', { name: 'Users, 1 open access request' }),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Dismiss request from Nia New' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Dismiss request',
      }),
    );
    const main = screen.getByRole('navigation', { name: 'Main' });
    expect(await within(main).findByRole('link', { name: 'Users' })).toBeInTheDocument();
  });

  it('[FR-ADM-06] the count is read again when the window regains focus', async () => {
    let open = 1;
    adminApi({
      'GET /admin/access-requests': () => json(200, page([], { pageSize: 1, total: open })),
    });
    renderApp('/');
    expect(
      await screen.findByRole('link', { name: 'Users, 1 open access request' }),
    ).toBeInTheDocument();
    open = 2;
    act(() => {
      window.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(
      await screen.findByRole('link', { name: 'Users, 2 open access requests' }),
    ).toBeInTheDocument();
  });

  it('[FR-ADM-06] the count refreshes every 60 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let count = 1;
    badgeApi(() => count);
    renderApp('/');
    expect(
      await screen.findByRole('link', { name: 'Users, 1 open access request' }),
    ).toBeInTheDocument();
    count = 3;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(
      await screen.findByRole('link', { name: 'Users, 3 open access requests' }),
    ).toBeInTheDocument();
  });

  it('[FR-ADM-06] with no open request the link is just Users', async () => {
    badgeApi(() => 0);
    renderApp('/');
    expect(await screen.findByRole('link', { name: 'Users' })).toBeInTheDocument();
  });

  it('[NFR-FE-08] a Buyer has no Users link and no count request', async () => {
    const seen = fakeApi({ 'GET /me': () => json(200, ME) });
    renderApp('/');
    expect(await screen.findByRole('link', { name: 'Home' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Users/ })).not.toBeInTheDocument();
    expect(seen.some((r) => r.url.includes('/admin/'))).toBe(false);
  });
});
