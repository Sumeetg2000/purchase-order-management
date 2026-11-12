import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { AppProviders, createQueryClient } from '../src/app/providers';
import { buildRoutes } from '../src/app/router';
import { axeViolations } from './support/axe';
import { fakeApi, json, ME, problem } from './support/fake-api';

// The login page (ADR-0018 "Account pages", spec US1 scenarios 1–3, 7).

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderAt(path: string, state?: unknown) {
  const router = createMemoryRouter(buildRoutes({ includeDemo: false }), {
    initialEntries: [
      state === undefined
        ? path
        : {
            pathname: path.split('?')[0] ?? path,
            search: path.includes('?') ? `?${path.split('?')[1] ?? ''}` : '',
            state,
          },
    ],
  });
  render(
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { user: userEvent.setup(), router };
}

async function submit(
  user: ReturnType<typeof userEvent.setup>,
  password = 'correct horse battery',
) {
  await user.type(await screen.findByLabelText('Email'), 'asha@example.local');
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Log in' }));
}

describe('[NFR-FE-08] login page', () => {
  it('[NFR-FE-08] a visitor to a page that needs a login is sent to login with the page to return to', async () => {
    fakeApi({ 'GET /me': () => problem(401, 'UNAUTHENTICATED') });
    const { router } = renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?returnTo=%2F');
  });

  it('[NFR-FE-08] a successful login posts the credentials and returns to the page', async () => {
    let loggedIn = false;
    const seen = fakeApi({
      'GET /me': () => (loggedIn ? json(200, ME) : problem(401, 'UNAUTHENTICATED')),
      'POST /auth/login': () => {
        loggedIn = true;
        return json(200, ME);
      },
    });
    const { user, router } = renderAt('/login?returnTo=%2F');
    await submit(user);
    expect(await screen.findByRole('heading', { level: 1, name: 'Welcome' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    const login = seen.find((r) => r.url.endsWith('/auth/login'));
    expect(await login?.json()).toEqual({
      email: 'asha@example.local',
      password: 'correct horse battery',
    });
  });

  it('[NFR-FE-08] a login forgets everything cached for the previous user in this tab', async () => {
    fakeApi({
      'GET /me': () => json(200, ME),
      'POST /auth/login': () => json(200, ME),
    });
    const client = createQueryClient();
    // What the previous user's pages left behind: their sessions, request and admin lists.
    for (const key of [['own-sessions', 1], ['own-access-request'], ['admin', 'users', {}]]) {
      client.setQueryData(key, { previousUser: true });
    }
    const router = createMemoryRouter(buildRoutes({ includeDemo: false }), {
      initialEntries: ['/login'],
    });
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await submit(userEvent.setup());
    await screen.findByRole('heading', { level: 1, name: 'Welcome' });
    const leftovers = client
      .getQueryCache()
      .findAll()
      .filter(
        (query) => (query.state.data as { previousUser?: boolean } | undefined)?.previousUser,
      );
    expect(leftovers.map((query) => query.queryKey)).toEqual([]);
  });

  it('[NFR-FE-08] a returnTo outside the app is ignored', async () => {
    let loggedIn = false;
    fakeApi({
      'GET /me': () => (loggedIn ? json(200, ME) : problem(401, 'UNAUTHENTICATED')),
      'POST /auth/login': () => {
        loggedIn = true;
        return json(200, ME);
      },
    });
    const { user, router } = renderAt('/login?returnTo=%2F%2Fevil.example');
    await submit(user);
    await screen.findByRole('heading', { level: 1, name: 'Welcome' });
    expect(router.state.location.pathname).toBe('/');
  });

  it.each([
    ['ACCOUNT_NOT_FOUND', 404, 'No account found with this email.'],
    ['INCORRECT_PASSWORD', 401, 'Incorrect password.'],
    ['PASSWORD_NOT_SET', 401, 'No password is set for this account.'],
    ['ACCOUNT_NOT_VERIFIED', 401, 'Verify your email before logging in.'],
    ['ACCOUNT_DEACTIVATED', 401, 'This account has been deactivated.'],
  ])('[NFR-FE-08] %s shows its own message', async (code, status, message) => {
    fakeApi({
      'GET /me': () => problem(401, 'UNAUTHENTICATED'),
      'POST /auth/login': () => problem(status, code),
    });
    const { user } = renderAt('/login');
    await submit(user, 'a wrong password');
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it.each([
    ['ACCOUNT_NOT_FOUND', 404, 'Sign up', '/signup', 'Sign up instead.'],
    ['INCORRECT_PASSWORD', 401, 'Forgot your password?', '/forgot-password', undefined],
    [
      'PASSWORD_NOT_SET',
      401,
      'Reset your password',
      '/forgot-password',
      'Use your set-password link, or reset your password.',
    ],
  ])('[NFR-FE-08] %s links to its next step', async (code, status, link, href, action) => {
    fakeApi({
      'GET /me': () => problem(401, 'UNAUTHENTICATED'),
      'POST /auth/login': () => problem(status, code),
    });
    const { user } = renderAt('/login');
    await submit(user, 'a wrong password');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('link', { name: link })).toHaveAttribute('href', href);
    // The link is the next step, in place of the message's own.
    if (action) expect(alert).not.toHaveTextContent(action);
  });

  it('[FR-ACC-02] an unverified account can send a new verification email from the login', async () => {
    const seen = fakeApi({
      'GET /me': () => problem(401, 'UNAUTHENTICATED'),
      'POST /auth/login': () => problem(401, 'ACCOUNT_NOT_VERIFIED'),
      'POST /auth/resend-verification': () => new Response(null, { status: 202 }),
    });
    const { user } = renderAt('/login');
    await submit(user);
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('Send a new verification email if you need one.');
    await user.click(within(alert).getByRole('button', { name: 'Send a new verification email' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'We sent a new verification link to asha@example.local.',
    );
    const resend = seen.find((r) => r.url.endsWith('/auth/resend-verification'));
    expect(await resend?.json()).toEqual({ email: 'asha@example.local' });
  });

  it('[NFR-FE-01] a field error is said in the form-level message, since login highlights no field', async () => {
    fakeApi({
      'GET /me': () => problem(401, 'UNAUTHENTICATED'),
      'POST /auth/login': () =>
        problem(400, 'VALIDATION_FAILED', {
          details: [{ path: 'body.email', code: 'INVALID_FORMAT' }],
        }),
    });
    const { user } = renderAt('/login');
    await submit(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Some of the details are not valid. Email: This is not in the expected format. Correct them and try again.',
    );
    expect(alert).not.toHaveTextContent(/highlighted/);
  });

  it('[NFR-FE-08] a locked account says how many minutes to wait, from Retry-After', async () => {
    fakeApi({
      'GET /me': () => problem(401, 'UNAUTHENTICATED'),
      'POST /auth/login': () =>
        problem(423, 'ACCOUNT_LOCKED', { headers: { 'Retry-After': '601' } }),
    });
    const { user } = renderAt('/login');
    await submit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This account is locked after too many failed login attempts. Try again in 11 minutes.',
    );
  });

  it('[NFR-FE-02] shows why the session ended when sent here after a refresh failed', async () => {
    fakeApi({ 'GET /me': () => problem(401, 'UNAUTHENTICATED') });
    renderAt('/login', { ended: { code: 'SESSION_REVOKED', reason: 'PASSWORD_CHANGED' } });
    expect(await screen.findByRole('status')).toHaveTextContent(
      'You were logged out because your password was changed. Please log in again.',
    );
  });

  it('[NFR-FE-02] a page load whose first call ends the session still says why', async () => {
    fakeApi({
      'GET /me': () => problem(401, 'SESSION_REVOKED', { reason: 'ROLES_CHANGED' }),
    });
    renderAt('/admin/users');
    expect(await screen.findByRole('heading', { level: 1, name: 'Log in' })).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'You were logged out because your roles were changed. Please log in again.',
    );
  });

  it('[NFR-FE-01] an unreachable API says so, and the form can be sent again', async () => {
    fakeApi({
      'GET /me': () => problem(401, 'UNAUTHENTICATED'),
      'POST /auth/login': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const { user } = renderAt('/login');
    await submit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The service is temporarily unavailable.',
    );
    expect(screen.getByRole('button', { name: 'Log in' })).toBeEnabled();
  });

  it('[NFR-FE-08] has no accessibility violations', async () => {
    fakeApi({ 'GET /me': () => problem(401, 'UNAUTHENTICATED') });
    renderAt('/login');
    await screen.findByRole('heading', { level: 1, name: 'Log in' });
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('[FR-ACC-05] links to forgot-password, which starts with the email typed so far', async () => {
    fakeApi({ 'GET /me': () => problem(401, 'UNAUTHENTICATED') });
    const { user } = renderAt('/login');
    await user.type(await screen.findByLabelText('Email'), 'asha@example.local');
    await user.click(screen.getByRole('link', { name: 'Forgot your password?' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Reset your password' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('asha@example.local');
  });
});
