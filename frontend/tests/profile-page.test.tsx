import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem, type Handler } from './support/fake-api';
import { renderApp } from './support/render-app';

// The profile page: name, password and sessions (ADR-0018 "Profile"; spec US4).

afterEach(() => {
  vi.unstubAllGlobals();
});

const CHROME =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0';

const session = (extra: Record<string, unknown> = {}) => ({
  id: '0192e4a0-0000-7000-8000-0000000000a1',
  createdAt: '2026-11-01T06:30:00.000Z',
  lastUsedAt: '2026-11-04T06:30:00.000Z',
  userAgent: CHROME,
  ip: '10.0.0.1',
  current: true,
  ...extra,
});
const OTHER = session({
  id: '0192e4a0-0000-7000-8000-0000000000a2',
  userAgent: FIREFOX,
  ip: '10.0.0.2',
  lastUsedAt: '2026-11-03T06:30:00.000Z',
  current: false,
});

const page = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  items,
  page: 1,
  pageSize: 20,
  total: items.length,
  ...extra,
});

function profileApi(handlers: Record<string, Handler> = {}) {
  return fakeApi({
    'GET /me': () => json(200, ME),
    'GET /auth/sessions': () => json(200, page([session(), OTHER])),
    ...handlers,
  });
}

describe('[NFR-FE-08] profile details', () => {
  it('[FR-USR-01] shows the name to edit, and email, roles and signup date read-only', async () => {
    profileApi();
    renderApp('/profile');
    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Asha Rao');
    const details = screen.getByRole('list', { name: 'Account' });
    expect(within(details).getByText('asha@example.local')).toBeInTheDocument();
    expect(within(details).getByText('Buyer')).toBeInTheDocument();
    // No status: only an active user can see their profile.
    expect(within(details).queryByText('Status')).toBeNull();
    expect(within(details).getByText('1 November 2026')).toBeInTheDocument();
  });

  it('[FR-USR-01] saves the name with no dialog, and the header shows it', async () => {
    const seen = profileApi({
      'PATCH /me': () => json(200, { ...ME, name: 'Asha R. Rao' }),
    });
    const { user } = renderApp('/profile');
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Asha R. Rao');
    await user.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Your name is saved.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await seen.find((r) => r.method === 'PATCH')?.json()).toEqual({ name: 'Asha R. Rao' });
    expect(within(screen.getByRole('banner')).getByText('Asha R. Rao')).toBeInTheDocument();
  });

  it('[NFR-FE-09] leaving with an unsaved name asks to discard it', async () => {
    profileApi();
    const { user } = renderApp('/profile');
    const name = await screen.findByLabelText('Name');
    await user.type(name, ' Jr');
    await user.click(screen.getByRole('link', { name: 'Home' }));
    expect(
      await screen.findByRole('alertdialog', { name: 'Discard your unsaved changes?' }),
    ).toBeInTheDocument();
  });

  it('[NFR-FE-09] logging out everywhere with an unsaved name goes straight to login', async () => {
    profileApi({ 'POST /auth/logout-all': () => new Response(null, { status: 204 }) });
    const { user, router } = renderApp('/profile');
    await user.type(await screen.findByLabelText('Name'), ' Jr');
    await user.click(screen.getByRole('button', { name: 'Log out everywhere' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Log out everywhere?' });
    await user.click(within(dialog).getByRole('button', { name: 'Log out everywhere' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('[NFR-FE-08] a user with no role reaches their profile from Access pending', async () => {
    profileApi({
      'GET /me': () => json(200, { ...ME, roles: [] }),
      'GET /me/access-request': () => problem(404, 'NOT_FOUND'),
    });
    const { user, router } = renderApp('/access-pending');
    await user.click(await screen.findByRole('link', { name: 'Profile' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Profile' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/profile');
  });
});

describe('[NFR-FE-09] change password', () => {
  async function fillAndConfirm(handlers: Record<string, Handler>, current = 'old passphrase 1') {
    const seen = profileApi(handlers);
    const { user } = renderApp('/profile');
    await user.type(await screen.findByLabelText('Current password'), current);
    await user.type(screen.getByLabelText('New password'), 'a brand new passphrase');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Change your password?' });
    expect(within(dialog).getByText('Your other sessions will be logged out.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }));
    return { seen, dialog };
  }

  it('[FR-ACC-04] confirms, then sends both passwords and says the others were logged out', async () => {
    const { seen } = await fillAndConfirm({
      'POST /auth/change-password': () => new Response(null, { status: 204 }),
    });
    expect(
      await screen.findByText('Your password is changed. Your other sessions were logged out.'),
    ).toBeInTheDocument();
    expect(await seen.find((r) => r.url.endsWith('/change-password'))?.json()).toEqual({
      currentPassword: 'old passphrase 1',
      newPassword: 'a brand new passphrase',
    });
    expect(screen.getByLabelText('Current password')).toHaveValue('');
  });

  it('[FR-ACC-04] a wrong current password is shown on that field', async () => {
    await fillAndConfirm({
      'POST /auth/change-password': () =>
        problem(400, 'VALIDATION_FAILED', {
          details: [{ path: 'body.currentPassword', code: 'INCORRECT_PASSWORD' }],
        }),
    });
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText('Current password')).toHaveAccessibleDescription(
      expect.stringContaining('Incorrect password.') as string,
    );
  });

  it('[FR-ACC-04] a refused new password shows its field message', async () => {
    await fillAndConfirm({
      'POST /auth/change-password': () =>
        problem(400, 'VALIDATION_FAILED', {
          details: [{ path: 'body.newPassword', code: 'PASSWORD_TOO_COMMON' }],
        }),
    });
    expect(await screen.findByText(/This password is too common/)).toBeInTheDocument();
  });

  it('[FR-ACC-04] a new password equal to the current one is shown on the new-password field', async () => {
    await fillAndConfirm({
      'POST /auth/change-password': () =>
        problem(400, 'VALIDATION_FAILED', {
          details: [{ path: 'body.newPassword', code: 'PASSWORD_UNCHANGED' }],
        }),
    });
    await waitFor(() => {
      expect(screen.getByLabelText('New password')).toHaveAccessibleDescription(
        expect.stringContaining(
          'Your new password must be different from your current one.',
        ) as string,
      );
    });
  });

  it('[FR-ACC-04] a field error clears once its field is edited', async () => {
    let answers = 0;
    const seen = profileApi({
      'POST /auth/change-password': () => {
        answers += 1;
        return answers === 1
          ? problem(400, 'VALIDATION_FAILED', {
              details: [{ path: 'body.currentPassword', code: 'INCORRECT_PASSWORD' }],
            })
          : problem(429, 'RATE_LIMITED', { headers: { 'Retry-After': '60' } });
      },
    });
    const { user } = renderApp('/profile');
    await user.type(await screen.findByLabelText('Current password'), 'wrong one');
    await user.type(screen.getByLabelText('New password'), 'a brand new passphrase');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Change password',
      }),
    );
    expect(await screen.findByText('Incorrect password.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Current password'), '2');
    expect(screen.queryByText('Incorrect password.')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Change password',
      }),
    );
    expect(await screen.findByText(/Too many attempts/)).toBeInTheDocument();
    expect(screen.queryByText('Incorrect password.')).not.toBeInTheDocument();
    expect(seen.filter((r) => r.url.endsWith('/change-password'))).toHaveLength(2);
  });

  it('[FR-ACC-04] a lockout is shown inside the dialog, in minutes', async () => {
    const { dialog } = await fillAndConfirm({
      'POST /auth/change-password': () =>
        problem(423, 'ACCOUNT_LOCKED', { headers: { 'Retry-After': '600' } }),
    });
    expect(await within(dialog).findByText(/Try again in 10 minutes/)).toBeInTheDocument();
  });
});

describe('[NFR-FE-08] sessions', () => {
  it('[FR-ACC-06] lists the sessions by device, address and last use, marking this device', async () => {
    profileApi();
    renderApp('/profile');
    const table = await screen.findByRole('table', { name: 'Sessions' });
    const here = within(table)
      .getByRole('cell', { name: /Chrome on Linux/ })
      .closest('tr') as HTMLElement;
    expect(within(here).getByText('This device')).toBeInTheDocument();
    expect(within(here).getByRole('cell', { name: '10.0.0.1' })).toBeInTheDocument();
    const there = within(table)
      .getByRole('cell', { name: /Firefox on Windows/ })
      .closest('tr') as HTMLElement;
    expect(within(there).getByRole('cell', { name: '3 November 2026' })).toBeInTheDocument();
  });

  it('[FR-ACC-06] revoking another session confirms with its device and last use, then refreshes the list', async () => {
    let revoked = false;
    const seen = profileApi({
      'GET /auth/sessions': () => json(200, page(revoked ? [session()] : [session(), OTHER])),
      [`DELETE /auth/sessions/${OTHER.id}`]: () => {
        revoked = true;
        return new Response(null, { status: 204 });
      },
    });
    const { user } = renderApp('/profile');
    await user.click(
      await screen.findByRole('button', { name: 'Revoke Firefox on Windows (10.0.0.2)' }),
    );
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke this session?' });
    expect(
      within(dialog).getByText('Firefox on Windows, last used 3 November 2026.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Revoke session' }));
    expect(await screen.findByText('Session revoked.')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('cell', { name: /Firefox on Windows/ })).not.toBeInTheDocument();
    });
    expect(seen.some((r) => r.method === 'DELETE')).toBe(true);
  });

  it('[FR-ACC-06] revoking this device says it logs you out, then goes to login', async () => {
    const { user, router } = (() => {
      profileApi({
        [`DELETE /auth/sessions/${session().id}`]: () => new Response(null, { status: 204 }),
      });
      return renderApp('/profile');
    })();
    await user.click(
      await screen.findByRole('button', { name: 'Revoke Chrome on Linux (10.0.0.1)' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText("This is the session you're using: revoking it logs you out here."),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Revoke session' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('[FR-ACC-06] a session that already ended says so inside the dialog', async () => {
    profileApi({
      [`DELETE /auth/sessions/${OTHER.id}`]: () => problem(404, 'NOT_FOUND'),
    });
    const { user } = renderApp('/profile');
    await user.click(
      await screen.findByRole('button', { name: 'Revoke Firefox on Windows (10.0.0.2)' }),
    );
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke session' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/couldn't find/);
  });

  it('[FR-ACC-06] revoking the only session on a later page goes back a page', async () => {
    let revoked = false;
    profileApi({
      'GET /auth/sessions': (request) => {
        const pageNo = Number(new URL(request.url).searchParams.get('page') ?? '1');
        const total = revoked ? 20 : 21;
        return json(
          200,
          pageNo === 1
            ? page([session()], { total })
            : page(revoked ? [] : [OTHER], { page: pageNo, total }),
        );
      },
      [`DELETE /auth/sessions/${OTHER.id}`]: () => {
        revoked = true;
        return new Response(null, { status: 204 });
      },
    });
    const { user } = renderApp('/profile');
    await user.click(await screen.findByRole('button', { name: 'Next page' }));
    await user.click(
      await screen.findByRole('button', { name: 'Revoke Firefox on Windows (10.0.0.2)' }),
    );
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Revoke session',
      }),
    );
    expect(
      await screen.findByRole('button', { name: 'Revoke Chrome on Linux (10.0.0.1)' }),
    ).toBeInTheDocument();
  });

  it('[NFR-SEC-03] log out everywhere confirms, ends every session and goes to login', async () => {
    const seen = profileApi({
      'POST /auth/logout-all': () => new Response(null, { status: 204 }),
    });
    const { user } = renderApp('/profile');
    await user.click(await screen.findByRole('button', { name: 'Log out everywhere' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Log out everywhere?' });
    expect(
      within(dialog).getByText('Every device, including this one, will be logged out.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Log out everywhere' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();
    expect(seen.some((r) => r.url.endsWith('/auth/logout-all'))).toBe(true);
  });

  it('[NFR-FE-08] the page has no axe violations', async () => {
    profileApi();
    renderApp('/profile');
    await screen.findByRole('table', { name: 'Sessions' });
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
