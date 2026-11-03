import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axeViolations } from './support/axe';
import { fakeApi, problem } from './support/fake-api';
import { renderApp } from './support/render-app';

// The verify-email page (ADR-0017 links, ADR-0018; spec US2 scenarios 5–6).

const TOKEN = 'B'.repeat(43);

beforeEach(() => {
  window.history.replaceState(null, '', `/verify-email#token=${TOKEN}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[NFR-FE-08] verify-email page', () => {
  it('[NFR-FE-08] posts the token once, clears it from the address bar, and offers login', async () => {
    const seen = fakeApi({ 'POST /auth/verify-email': () => new Response(null, { status: 204 }) });
    renderApp(`/verify-email#token=${TOKEN}`);
    expect(await screen.findByRole('status')).toHaveTextContent('Your email is confirmed.');
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    expect(window.location.hash).toBe('');
    expect(seen).toHaveLength(1);
    expect(await seen[0]?.json()).toEqual({ token: TOKEN });
  });

  it.each([
    ['TOKEN_USED', 'This link has already been used.'],
    ['TOKEN_SUPERSEDED', 'A newer link was sent. Use the latest email.'],
    ['INVALID_TOKEN', "This link isn't valid."],
  ])('[FR-ACC-03] %s shows its own message', async (code, message) => {
    fakeApi({ 'POST /auth/verify-email': () => problem(400, code) });
    renderApp(`/verify-email#token=${TOKEN}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
  });

  it('[FR-ACC-02] an expired link offers a new one, sent to the address given', async () => {
    const seen = fakeApi({
      'POST /auth/verify-email': () => problem(400, 'TOKEN_EXPIRED'),
      'POST /auth/resend-verification': () => new Response(null, { status: 202 }),
    });
    const { user } = renderApp(`/verify-email#token=${TOKEN}`);
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
    renderApp(`/verify-email#token=${TOKEN}`);
    await screen.findByRole('alert');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
