import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../src/app/providers';
import { buildRoutes } from '../src/app/router';
import { axeViolations } from './support/axe';
import { fakeApi, problem } from './support/fake-api';

// The reset / set-password page (ADR-0017 links, ADR-0018; spec US1 scenario 11).

const TOKEN = 'A'.repeat(43);

beforeEach(() => {
  // The link's fragment, as the browser holds it.
  window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPage() {
  const router = createMemoryRouter(buildRoutes({ includeDemo: false }), {
    initialEntries: [`/reset-password#token=${TOKEN}`],
  });
  render(
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>,
  );
  return { user: userEvent.setup(), router };
}

async function choose(user: ReturnType<typeof userEvent.setup>, password: string) {
  await user.type(await screen.findByLabelText('New password'), password);
  await user.click(screen.getByRole('button', { name: 'Set password' }));
}

describe('[NFR-FE-08] reset-password page', () => {
  it('[NFR-FE-08] removes the token from the address bar as soon as it is read', async () => {
    fakeApi({});
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Set a new password' });
    expect(window.location.hash).toBe('');
  });

  it('[NFR-FE-08] posts the token with the new password, then offers login', async () => {
    const seen = fakeApi({
      'POST /auth/reset-password': () => new Response(null, { status: 204 }),
    });
    const { user } = renderPage();
    await choose(user, 'a brand new passphrase');
    expect(await screen.findByRole('status')).toHaveTextContent('Your password is set.');
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    expect(await seen[0]?.json()).toEqual({ token: TOKEN, newPassword: 'a brand new passphrase' });
  });

  it('[NFR-FE-08] states the password rule', async () => {
    fakeApi({});
    renderPage();
    expect(
      await screen.findByText('Use 12 to 128 characters. Common passwords are refused.'),
    ).toBeInTheDocument();
  });

  it.each([
    ['TOKEN_EXPIRED', 'This link has expired. Request a new one.'],
    ['TOKEN_USED', 'This link has already been used.'],
    ['TOKEN_SUPERSEDED', 'A newer link was sent. Use the latest email.'],
    ['INVALID_TOKEN', "This link isn't valid."],
  ])('[FR-ACC-03] %s shows its own message', async (code, message) => {
    fakeApi({ 'POST /auth/reset-password': () => problem(400, code) });
    const { user } = renderPage();
    await choose(user, 'a brand new passphrase');
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('[FR-ACC-05] a link for a deactivated account says so, with its next step', async () => {
    fakeApi({ 'POST /auth/reset-password': () => problem(401, 'ACCOUNT_DEACTIVATED') });
    const { user } = renderPage();
    await choose(user, 'a brand new passphrase');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This account has been deactivated. Contact an admin.',
    );
  });

  it('[FR-ACC-04] a refused password shows the field message from its code', async () => {
    fakeApi({
      'POST /auth/reset-password': () =>
        problem(400, 'VALIDATION_FAILED', {
          details: [{ path: 'body.newPassword', code: 'PASSWORD_TOO_COMMON' }],
        }),
    });
    const { user } = renderPage();
    await choose(user, 'password1234');
    expect(
      await screen.findByText('This password is too common. Choose another.'),
    ).toBeInTheDocument();
  });

  it('[NFR-FE-08] without a token in the link, says the link is invalid', async () => {
    window.history.replaceState(null, '', '/reset-password');
    fakeApi({});
    const router = createMemoryRouter(buildRoutes({ includeDemo: false }), {
      initialEntries: ['/reset-password'],
    });
    render(
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent("This link isn't valid.");
  });

  it('[NFR-FE-01] an unreachable API says so, and the form can be sent again', async () => {
    fakeApi({
      'POST /auth/reset-password': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const { user } = renderPage();
    await choose(user, 'a brand new passphrase');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The service is temporarily unavailable.',
    );
    expect(screen.getByRole('button', { name: 'Set password' })).toBeEnabled();
  });

  it('[NFR-FE-08] has no accessibility violations', async () => {
    fakeApi({});
    renderPage();
    await screen.findByRole('heading', { level: 1, name: 'Set a new password' });
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
