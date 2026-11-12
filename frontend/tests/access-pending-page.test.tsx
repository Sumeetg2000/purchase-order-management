import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noRoleAssigned } from '../src/auth/session-events';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem } from './support/fake-api';
import { renderApp } from './support/render-app';

// The Access pending screen (ADR-0018; spec US2 scenarios 7–9).

const NO_ROLE = { ...ME, roles: [] };

afterEach(() => {
  vi.unstubAllGlobals();
});

const request = (extra: Record<string, unknown> = {}) => ({
  status: 'OPEN',
  message: 'Please add me as a buyer',
  updatedAt: '2026-11-02T06:30:00.000Z',
  adminNote: null,
  ...extra,
});

describe('[NFR-FE-08] Access pending', () => {
  it('[FR-ACC-08] a user with no role is sent to Access pending, which explains why and shows the signup date', async () => {
    fakeApi({
      'GET /me': () => json(200, NO_ROLE),
      'GET /me/access-request': () => problem(404, 'NOT_FOUND'),
    });
    const { router } = renderApp('/');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Access pending' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/access-pending');
    expect(
      screen.getByText(
        "Your account is active, but an administrator hasn't assigned you a role yet. You can't raise or approve orders until then.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('You signed up on 1 November 2026.')).toBeInTheDocument();
  });

  it('[FR-ACC-09] sending a message shows when the request was sent', async () => {
    let sent = false;
    const seen = fakeApi({
      'GET /me': () => json(200, NO_ROLE),
      'GET /me/access-request': () => (sent ? json(200, request()) : problem(404, 'NOT_FOUND')),
      'POST /me/access-request': () => {
        sent = true;
        return json(200, request());
      },
    });
    const { user } = renderApp('/access-pending');
    await user.type(
      await screen.findByLabelText('Message the administrator'),
      'Please add me as a buyer',
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Request sent on 2 November 2026.')).toBeInTheDocument();
    const post = seen.find((r) => r.method === 'POST');
    expect(await post?.json()).toEqual({ message: 'Please add me as a buyer' });
  });

  it("[FR-ACC-09] a dismissed request shows the admin's note as text, and another can be sent", async () => {
    fakeApi({
      'GET /me': () => json(200, NO_ROLE),
      'GET /me/access-request': () =>
        json(
          200,
          request({
            status: 'DISMISSED',
            adminNote: '<b>Ask your manager</b> first',
          }),
        ),
    });
    renderApp('/access-pending');
    expect(await screen.findByText('Your request was dismissed.')).toBeInTheDocument();
    expect(screen.getByText('<b>Ask your manager</b> first')).toBeInTheDocument();
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByLabelText('Message the administrator')).toBeInTheDocument();
  });

  it('[FR-ACC-09] too many messages says how long to wait', async () => {
    fakeApi({
      'GET /me': () => json(200, NO_ROLE),
      'GET /me/access-request': () => json(200, request()),
      'POST /me/access-request': () =>
        problem(429, 'RATE_LIMITED', { headers: { 'Retry-After': '7200' } }),
    });
    const { user } = renderApp('/access-pending');
    await user.type(await screen.findByLabelText('Message the administrator'), 'again');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in 120 minutes.',
    );
  });

  it('[FR-ACC-08] a user with a role is sent home from Access pending', async () => {
    fakeApi({ 'GET /me': () => json(200, ME) });
    const { router } = renderApp('/access-pending');
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });

  it('[NFR-FE-08] has no accessibility violations', async () => {
    fakeApi({
      'GET /me': () => json(200, NO_ROLE),
      'GET /me/access-request': () => json(200, request()),
    });
    renderApp('/access-pending');
    await screen.findByText('Request sent on 2 November 2026.');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});

describe('[FR-ACC-08] role changes while the app is open', () => {
  it('[FR-ACC-08] NO_ROLE_ASSIGNED re-reads the user, so a user who lost their roles lands on Access pending', async () => {
    let roles: string[] = ['BUYER'];
    fakeApi({
      'GET /me': () => json(200, { ...ME, roles }),
      'GET /me/access-request': () => problem(404, 'NOT_FOUND'),
    });
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Welcome' });
    roles = [];
    act(() => {
      noRoleAssigned();
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Access pending' }),
    ).toBeInTheDocument();
  });

  it('[FR-ACC-08] once a role is granted, Access pending re-reads the user and goes home', async () => {
    let roles: string[] = [];
    fakeApi({
      'GET /me': () => json(200, { ...ME, roles }),
      'GET /me/access-request': () => {
        // The role arrived: the no-role route now refuses this user.
        roles = ['BUYER'];
        return problem(403, 'FORBIDDEN');
      },
    });
    renderApp('/access-pending');
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome' })).toBeInTheDocument();
  });
});
