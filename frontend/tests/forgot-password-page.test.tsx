import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, problem } from './support/fake-api';
import { renderApp } from './support/render-app';

// The forgot-password page (ADR-0018 "Account pages"; spec US5 scenarios 1, 4).

afterEach(() => {
  vi.unstubAllGlobals();
});

async function ask(user: ReturnType<typeof renderApp>['user'], email = 'asha@example.local') {
  await user.type(await screen.findByLabelText('Email'), email);
  await user.click(screen.getByRole('button', { name: 'Send reset link' }));
}

describe('[FR-ACC-05] forgot-password page', () => {
  it('[FR-ACC-05] posts the email and says where the link went', async () => {
    const seen = fakeApi({
      'POST /auth/forgot-password': () => new Response(null, { status: 202 }),
    });
    const { user } = renderApp('/forgot-password');
    await ask(user);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'We sent a password reset link to asha@example.local.',
    );
    expect(await seen[0]?.json()).toEqual({ email: 'asha@example.local' });
    expect(screen.queryByRole('button', { name: 'Send reset link' })).not.toBeInTheDocument();
  });

  it('[FR-ACC-05] an unknown email says so and offers signup', async () => {
    fakeApi({ 'POST /auth/forgot-password': () => problem(404, 'ACCOUNT_NOT_FOUND') });
    const { user } = renderApp('/forgot-password');
    await ask(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('No account found with this email.');
    expect(screen.getByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/signup');
  });

  it('[FR-ACC-05] a deactivated account says so, with its next step', async () => {
    fakeApi({ 'POST /auth/forgot-password': () => problem(401, 'ACCOUNT_DEACTIVATED') });
    const { user } = renderApp('/forgot-password');
    await ask(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This account has been deactivated. Contact an admin.',
    );
    expect(screen.queryByRole('link', { name: 'Sign up' })).not.toBeInTheDocument();
  });

  it('[NFR-SEC-08] the rate limit says how many minutes to wait', async () => {
    fakeApi({
      'POST /auth/forgot-password': () =>
        problem(429, 'RATE_LIMITED', { headers: { 'Retry-After': '1500' } }),
    });
    const { user } = renderApp('/forgot-password');
    await ask(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in 25 minutes.',
    );
    expect(screen.getByRole('button', { name: 'Send reset link' })).toBeEnabled();
  });

  it('[FR-ACC-05] links back to login', async () => {
    fakeApi({});
    renderApp('/forgot-password');
    expect(await screen.findByRole('link', { name: 'Back to log in' })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  it('[NFR-FE-08] has no accessibility violations', async () => {
    fakeApi({});
    renderApp('/forgot-password');
    await screen.findByRole('heading', { level: 1, name: 'Reset your password' });
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
