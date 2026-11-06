import { screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, problem } from './support/fake-api';
import { renderApp } from './support/render-app';

// The verify-email page (ADR-0017 links, ADR-0018; spec US2 scenarios 5–6).

const TOKEN = 'B'.repeat(43);
const PASSWORD = 'the signup passphrase';

async function confirmWith(user: UserEvent, password: string) {
  await user.type(await screen.findByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Confirm email' }));
}

beforeEach(() => {
  window.history.replaceState(null, '', `/verify-email#token=${TOKEN}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[NFR-FE-08] verify-email page', () => {
  it('[FR-ACC-02] asks for the signup password, clears the token from the address bar, and posts nothing until sent', async () => {
    const seen = fakeApi({});
    renderApp(`/verify-email#token=${TOKEN}`);
    expect(
      await screen.findByText('Enter the password you chose to confirm your email'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    expect(window.location.hash).toBe('');
    expect(seen).toHaveLength(0);
  });

  it('[FR-ACC-02] posts the token and the password once, and offers login', async () => {
    const seen = fakeApi({ 'POST /auth/verify-email': () => new Response(null, { status: 204 }) });
    const { user } = renderApp(`/verify-email#token=${TOKEN}`);
    await confirmWith(user, PASSWORD);
    expect(await screen.findByText(/Your email is confirmed\./)).toHaveAttribute('role', 'status');
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    expect(seen).toHaveLength(1);
    expect(await seen[0]?.json()).toEqual({ token: TOKEN, password: PASSWORD });
  });

  it('[FR-ACC-02] a wrong password is shown on the field, and the user can try again', async () => {
    let calls = 0;
    const seen = fakeApi({
      'POST /auth/verify-email': () =>
        ++calls === 1
          ? problem(400, 'VALIDATION_FAILED', {
              details: [{ path: 'body.password', code: 'INCORRECT_PASSWORD' }],
            })
          : new Response(null, { status: 204 }),
    });
    const { user } = renderApp(`/verify-email#token=${TOKEN}`);
    await confirmWith(user, 'a wrong guess here');
    expect(await screen.findByText('Incorrect password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    await user.clear(screen.getByLabelText('Password'));
    await confirmWith(user, PASSWORD);
    expect(await screen.findByText(/Your email is confirmed\./)).toBeInTheDocument();
    expect(await seen[1]?.json()).toEqual({ token: TOKEN, password: PASSWORD });
  });

  it('[NFR-SEC-07] a locked account says to try again later', async () => {
    fakeApi({ 'POST /auth/verify-email': () => problem(423, 'ACCOUNT_LOCKED') });
    const { user } = renderApp(`/verify-email#token=${TOKEN}`);
    await confirmWith(user, PASSWORD);
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many failed attempts.');
  });

  it.each([
    ['TOKEN_USED', 'This link has already been used.'],
    ['TOKEN_SUPERSEDED', 'A newer link was sent. Use the latest email.'],
    ['INVALID_TOKEN', "This link isn't valid."],
  ])('[FR-ACC-03] %s shows its own message', async (code, message) => {
    fakeApi({ 'POST /auth/verify-email': () => problem(400, code) });
    const { user } = renderApp(`/verify-email#token=${TOKEN}`);
    await confirmWith(user, PASSWORD);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('[FR-ACC-02] an expired link offers a new one, sent to the address given', async () => {
    const seen = fakeApi({
      'POST /auth/verify-email': () => problem(400, 'TOKEN_EXPIRED'),
      'POST /auth/resend-verification': () => new Response(null, { status: 202 }),
    });
    const { user } = renderApp(`/verify-email#token=${TOKEN}`);
    await confirmWith(user, PASSWORD);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This link has expired. Request a new one.',
    );
    await user.type(screen.getByLabelText('Work email'), 'ravi@example.local');
    await user.click(screen.getByRole('button', { name: 'Send a new link' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'We sent a new verification link to ravi@example.local.',
    );
    expect(await seen[1]?.json()).toEqual({ email: 'ravi@example.local' });
  });

  it('[FR-ACC-02] a resend for an account already verified says so', async () => {
    fakeApi({
      'POST /auth/verify-email': () => problem(400, 'TOKEN_EXPIRED'),
      'POST /auth/resend-verification': () => problem(409, 'ACCOUNT_ALREADY_VERIFIED'),
    });
    const { user } = renderApp(`/verify-email#token=${TOKEN}`);
    await confirmWith(user, PASSWORD);
    await screen.findByRole('alert');
    await user.type(screen.getByLabelText('Work email'), 'ravi@example.local');
    await user.click(screen.getByRole('button', { name: 'Send a new link' }));
    expect(await screen.findByText(/This account is already verified\./)).toBeInTheDocument();
  });

  it('[NFR-FE-08] without a token in the link, says the link is invalid', async () => {
    window.history.replaceState(null, '', '/verify-email');
    fakeApi({});
    renderApp('/verify-email');
    expect(await screen.findByRole('alert')).toHaveTextContent("This link isn't valid.");
  });

  it('[NFR-FE-08] has no accessibility violations', async () => {
    fakeApi({ 'POST /auth/verify-email': () => problem(400, 'TOKEN_EXPIRED') });
    const { user } = renderApp(`/verify-email#token=${TOKEN}`);
    expect(await axeViolations(document.body)).toEqual([]);
    await confirmWith(user, PASSWORD);
    await screen.findByRole('alert');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
