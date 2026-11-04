import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../src/app/providers';
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

  it('[NFR-FE-08] a locked account says how many minutes to wait, from Retry-After', async () => {
    fakeApi({
      'GET /me': () => problem(401, 'UNAUTHENTICATED'),
      'POST /auth/login': () =>
        problem(423, 'ACCOUNT_LOCKED', { headers: { 'Retry-After': '601' } }),
    });
    const { user } = renderAt('/login');
    await submit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many failed attempts. Try again in 11 minutes.',
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
});
