import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, problem } from './support/fake-api';
import { renderApp } from './support/render-app';

// The signup page (ADR-0018 "Account pages"; spec US2 scenarios 1–4).

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fill(
  user: ReturnType<typeof renderApp>['user'],
  password = 'a fresh signup passphrase',
) {
  await user.type(await screen.findByLabelText('Name'), 'Ravi Kumar');
  await user.type(screen.getByLabelText('Work email'), 'ravi@example.local');
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign up' }));
}

describe('[NFR-FE-08] signup page', () => {
  it('[NFR-FE-08] states the password rule', async () => {
    fakeApi({});
    renderApp('/signup');
    expect(
      await screen.findByText('Use 12 to 128 characters. Common passwords are refused.'),
    ).toBeInTheDocument();
  });

  it('[NFR-FE-08] posts name, email and password, then says to check the inbox', async () => {
    const seen = fakeApi({ 'POST /auth/signup': () => new Response(null, { status: 202 }) });
    const { user } = renderApp('/signup');
    await fill(user);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Check your email. We sent a verification link to ravi@example.local.',
    );
    expect(await seen[0]?.json()).toEqual({
      name: 'Ravi Kumar',
      email: 'ravi@example.local',
      password: 'a fresh signup passphrase',
    });
  });

  it.each([
    ['SIGNUP_DOMAIN_NOT_ALLOWED', 400, 'Use your company email address to sign up.'],
    ['EMAIL_IN_USE', 409, 'An account with this email already exists.'],
  ])('[NFR-FE-08] %s shows its own message', async (code, status, message) => {
    fakeApi({ 'POST /auth/signup': () => problem(status, code) });
    const { user } = renderApp('/signup');
    await fill(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('[FR-ACC-05] EMAIL_IN_USE offers a password reset', async () => {
    fakeApi({ 'POST /auth/signup': () => problem(409, 'EMAIL_IN_USE') });
    const { user } = renderApp('/signup');
    await fill(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^An account with this email already exists\. Reset your password$/,
    );
    await user.click(screen.getByRole('link', { name: 'Reset your password' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Reset your password' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('ravi@example.local');
  });

  it('[FR-ACC-04] a refused password shows the field message from its code', async () => {
    fakeApi({
      'POST /auth/signup': () =>
        problem(400, 'VALIDATION_FAILED', {
          details: [{ path: 'body.password', code: 'PASSWORD_TOO_COMMON' }],
        }),
    });
    const { user } = renderApp('/signup');
    await fill(user, 'password1234');
    expect(
      await screen.findByText('This password is too common. Choose another.'),
    ).toBeInTheDocument();
  });

  it('[NFR-FE-08] too many signups says how long to wait', async () => {
    fakeApi({
      'POST /auth/signup': () =>
        problem(429, 'RATE_LIMITED', { headers: { 'Retry-After': '1800' } }),
    });
    const { user } = renderApp('/signup');
    await fill(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "You've made too many requests in a short time. Try again in 30 minutes.",
    );
  });

  it('[NFR-FE-08] has no accessibility violations', async () => {
    fakeApi({});
    renderApp('/signup');
    await screen.findByRole('heading', { level: 1, name: 'Sign up' });
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
